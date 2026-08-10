import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionWorkStatus = "active" | "waiting_human" | "resolved" | "cancelled";
export type CompletionReviewMode = "manager" | "independent";
export type CompletionReviewVerdict = "satisfied" | "not_satisfied" | "needs_human";

export interface CompletionReviewCriterion {
	criterion: string;
	status: "satisfied" | "unsatisfied" | "uncertain";
	evidenceRefs: string[];
	explanation: string;
}

export interface CompletionReview {
	id: string;
	goalRevision: number;
	mode: "independent";
	verdict: CompletionReviewVerdict;
	criteria: CompletionReviewCriterion[];
	gaps: string[];
	reviewerModel: string;
	reviewerSessionId: string;
	reviewedAt: string;
}

export interface SessionWorkState {
	sessionId: string;
	goal: string;
	responsibleAgentId: string;
	participantAgentIds: string[];
	currentBrief: string;
	waitingOn?: string;
	nextAction?: string;
	completionBoundary: string;
	/** 只在 goal / completionBoundary 改变时递增；进度更新不使验收契约漂移。 */
	goalRevision: number;
	reviewMode: CompletionReviewMode;
	reviewerModel?: string;
	/** 按提交时间追加的独立复核轨迹；旧 Goal revision 的记录也保留用于审计。 */
	completionReviews: CompletionReview[];
	status: SessionWorkStatus;
	artifactIds: string[];
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface DecisionOption {
	id: string;
	label: string;
}

export interface DecisionRequest {
	id: string;
	sessionId: string;
	requestedBy: string;
	question: string;
	context: string;
	options?: DecisionOption[];
	blockedAction: string;
	resumeHint: string;
	authorizationScope?: string;
	status: "pending" | "answered" | "cancelled";
	answer?: string;
	grantedAuthorizationScope?: string;
	createdAt: string;
	updatedAt: string;
}

interface WorkStateFile {
	version: 3;
	states: Record<string, SessionWorkState>;
	decisions: Record<string, DecisionRequest>;
}

export class WorkStateConflictError extends Error {
	constructor(readonly current: SessionWorkState, message = "work state revision conflict") {
		super(message);
		this.name = "WorkStateConflictError";
	}
}

function text(value: unknown, field: string, required = false): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
	const trimmed = value.trim();
	if (required && !trimmed) throw new Error(`${field} 不能为空`);
	if (trimmed.length > 30_000) throw new Error(`${field} 过长`);
	return trimmed || undefined;
}

function stringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${field} 必须是字符串数组`);
	}
	return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

/** Session Goal、业务决策与当前版本的单机原子存储。 */
export class WorkStateStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly teamsDir: string) {
		this.file = path.join(teamsDir, "work-states.json");
	}

	async init(): Promise<void> {
		await mkdir(this.teamsDir, { recursive: true });
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async load(): Promise<WorkStateFile> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<WorkStateFile>;
			return { version: 3, states: parsed.states ?? {}, decisions: parsed.decisions ?? {} };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { version: 3, states: {}, decisions: {} };
		}
	}

	private async write(data: WorkStateFile): Promise<void> {
		const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, this.file);
	}

	async get(sessionId: string): Promise<SessionWorkState | undefined> {
		return (await this.load()).states[sessionId];
	}

	async create(input: {
		sessionId: string;
		goal: string;
		completionBoundary: string;
		reviewMode?: CompletionReviewMode;
		reviewerModel?: string;
		participantAgentIds?: string[];
	}): Promise<SessionWorkState> {
		const goal = text(input.goal, "goal", true)!;
		const completionBoundary = text(input.completionBoundary, "completionBoundary", true)!;
		const reviewerModel = text(input.reviewerModel, "reviewerModel");
		return this.serialize(async () => {
			const data = await this.load();
			if (data.states[input.sessionId]) throw new Error("该 Session 已有 Goal 状态");
			const now = new Date().toISOString();
			const state: SessionWorkState = {
				sessionId: input.sessionId,
				goal,
				responsibleAgentId: "manager",
				participantAgentIds: [...new Set(input.participantAgentIds ?? [])],
				currentBrief: "",
				completionBoundary,
				goalRevision: 0,
				reviewMode: input.reviewMode ?? "independent",
				...(reviewerModel ? { reviewerModel } : {}),
				completionReviews: [],
				status: "active",
				artifactIds: [],
				revision: 0,
				createdAt: now,
				updatedAt: now,
			};
			data.states[input.sessionId] = state;
			await this.write(data);
			return state;
		});
	}

	async update(
		sessionId: string,
		expectedRevision: number,
		patch: {
			goal?: string;
			participantAgentIds?: string[];
			currentBrief?: string;
			waitingOn?: string;
			nextAction?: string;
			completionBoundary?: string;
			reviewMode?: CompletionReviewMode;
			reviewerModel?: string;
			status?: SessionWorkStatus;
			artifactIds?: string[];
		},
	): Promise<SessionWorkState> {
		if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("revision 必须是非负整数");
		return this.serialize(async () => {
			const data = await this.load();
			const current = data.states[sessionId];
			if (!current) throw new Error("Session Goal 不存在");
			if (current.revision !== expectedRevision) throw new WorkStateConflictError(current);
			const status = patch.status ?? current.status;
			const completionBoundary = text(patch.completionBoundary, "completionBoundary") ?? current.completionBoundary;
			const currentBrief = text(patch.currentBrief, "currentBrief") ?? (patch.currentBrief === "" ? "" : current.currentBrief);
			if (status === "resolved" && current.reviewMode === "independent" && current.status !== "resolved") {
				throw new Error("独立复核 Goal 必须通过 reviewer 完成申请，不能直接设为 resolved");
			}
			if (status === "resolved" && (!completionBoundary || !currentBrief)) {
				throw new Error("resolved 前必须填写 completionBoundary 与 currentBrief");
			}
			const goal = patch.goal !== undefined ? text(patch.goal, "goal", true)! : current.goal;
			const contractChanged = goal !== current.goal || completionBoundary !== current.completionBoundary;
			const reviewerModel = patch.reviewerModel !== undefined ? text(patch.reviewerModel, "reviewerModel") : current.reviewerModel;
			const next: SessionWorkState = {
				...current,
				goal,
				...(patch.participantAgentIds !== undefined ? { participantAgentIds: stringList(patch.participantAgentIds, "participantAgentIds")! } : {}),
				currentBrief,
				...(patch.waitingOn !== undefined ? { waitingOn: text(patch.waitingOn, "waitingOn") } : {}),
				...(patch.nextAction !== undefined ? { nextAction: text(patch.nextAction, "nextAction") } : {}),
				completionBoundary,
				goalRevision: contractChanged ? current.goalRevision + 1 : current.goalRevision,
				...(patch.reviewMode !== undefined ? { reviewMode: patch.reviewMode } : {}),
				status,
				...(patch.artifactIds !== undefined ? { artifactIds: stringList(patch.artifactIds, "artifactIds")! } : {}),
				revision: current.revision + 1,
				updatedAt: new Date().toISOString(),
			};
			if (reviewerModel) next.reviewerModel = reviewerModel;
			else delete next.reviewerModel;
			if (!next.waitingOn) delete next.waitingOn;
			if (!next.nextAction) delete next.nextAction;
			data.states[sessionId] = next;
			await this.write(data);
			return next;
		});
	}

	/**
	 * 独立 reviewer 的唯一完成入口。复核期间若状态 revision 变化则拒绝提交，
	 * 防止把旧证据的判定应用到更新后的当前工作。
	 */
	async applyCompletionReview(
		sessionId: string,
		expectedRevision: number,
		input: {
			currentBrief: string;
			artifactIds?: string[];
			review: CompletionReview;
		},
	): Promise<SessionWorkState> {
		const currentBrief = text(input.currentBrief, "currentBrief", true)!;
		return this.serialize(async () => {
			const data = await this.load();
			const current = data.states[sessionId];
			if (!current) throw new Error("Session Goal 不存在");
			if (current.revision !== expectedRevision) throw new WorkStateConflictError(current);
			if (current.reviewMode !== "independent") throw new Error("当前 Goal 未启用独立复核");
			if (input.review.goalRevision !== current.goalRevision) throw new Error("reviewer 判定对应的 Goal 版本已失效");
			if (Object.values(data.decisions).some((item) => item.sessionId === sessionId && item.status === "pending")) {
				throw new Error("仍有待回答的人类决策，不能完成 Goal");
			}
			const satisfied = input.review.verdict === "satisfied";
			const next: SessionWorkState = {
				...current,
				currentBrief,
				completionReviews: [...current.completionReviews, input.review],
				status: satisfied ? "resolved" : "active",
				...(input.artifactIds !== undefined ? { artifactIds: stringList(input.artifactIds, "artifactIds")! } : {}),
				revision: current.revision + 1,
				updatedAt: new Date().toISOString(),
			};
			if (satisfied) {
				delete next.waitingOn;
				delete next.nextAction;
			} else {
				next.nextAction = input.review.verdict === "needs_human"
					? "根据独立复核结果请求必要的人类确认"
					: input.review.gaps.join("；") || "根据独立复核结果补齐未满足条件";
			}
			data.states[sessionId] = next;
			await this.write(data);
			return next;
		});
	}

	async removeSession(sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.load();
			delete data.states[sessionId];
			for (const [id, decision] of Object.entries(data.decisions)) {
				if (decision.sessionId === sessionId) delete data.decisions[id];
			}
			await this.write(data);
		});
	}

	async createDecision(input: Omit<DecisionRequest, "id" | "status" | "createdAt" | "updatedAt">): Promise<DecisionRequest> {
		const question = text(input.question, "question", true)!;
		const blockedAction = text(input.blockedAction, "blockedAction", true)!;
		const resumeHint = text(input.resumeHint, "resumeHint", true)!;
		return this.serialize(async () => {
			const data = await this.load();
			if (!data.states[input.sessionId]) throw new Error("DecisionRequest 必须属于有 Goal 的 Session");
			const now = new Date().toISOString();
			const decision: DecisionRequest = {
				...input,
				question,
				context: text(input.context, "context") ?? "",
				blockedAction,
				resumeHint,
				id: randomUUID(),
				status: "pending",
				createdAt: now,
				updatedAt: now,
			};
			data.decisions[decision.id] = decision;
			await this.write(data);
			return decision;
		});
	}

	async listDecisions(sessionId: string): Promise<DecisionRequest[]> {
		return Object.values((await this.load()).decisions)
			.filter((item) => item.sessionId === sessionId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async answerDecision(id: string, answer: string, grantedAuthorizationScope?: string): Promise<DecisionRequest> {
		const normalizedAnswer = text(answer, "answer", true)!;
		return this.serialize(async () => {
			const data = await this.load();
			const current = data.decisions[id];
			if (!current) throw new Error("DecisionRequest 不存在");
			if (current.status !== "pending") throw new Error("DecisionRequest 已处理");
			const next: DecisionRequest = {
				...current,
				status: "answered",
				answer: normalizedAnswer,
				...(grantedAuthorizationScope?.trim() ? { grantedAuthorizationScope: grantedAuthorizationScope.trim() } : {}),
				updatedAt: new Date().toISOString(),
			};
			data.decisions[id] = next;
			await this.write(data);
			return next;
		});
	}
}
