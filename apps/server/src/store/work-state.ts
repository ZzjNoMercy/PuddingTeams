import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionWorkStatus = "active" | "waiting_human" | "resolved" | "cancelled";

export interface SessionWorkState {
	sessionId: string;
	goal: string;
	responsibleAgentId: string;
	participantAgentIds: string[];
	currentBrief: string;
	waitingOn?: string;
	nextAction?: string;
	completionBoundary: string;
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
	version: 1;
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
			return { version: 1, states: parsed.states ?? {}, decisions: parsed.decisions ?? {} };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { version: 1, states: {}, decisions: {} };
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
		participantAgentIds?: string[];
	}): Promise<SessionWorkState> {
		const goal = text(input.goal, "goal", true)!;
		const completionBoundary = text(input.completionBoundary, "completionBoundary", true)!;
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
			if (status === "resolved" && (!completionBoundary || !currentBrief)) {
				throw new Error("resolved 前必须填写 completionBoundary 与 currentBrief");
			}
			const next: SessionWorkState = {
				...current,
				...(patch.goal !== undefined ? { goal: text(patch.goal, "goal", true)! } : {}),
				...(patch.participantAgentIds !== undefined ? { participantAgentIds: stringList(patch.participantAgentIds, "participantAgentIds")! } : {}),
				currentBrief,
				...(patch.waitingOn !== undefined ? { waitingOn: text(patch.waitingOn, "waitingOn") } : {}),
				...(patch.nextAction !== undefined ? { nextAction: text(patch.nextAction, "nextAction") } : {}),
				completionBoundary,
				status,
				...(patch.artifactIds !== undefined ? { artifactIds: stringList(patch.artifactIds, "artifactIds")! } : {}),
				revision: current.revision + 1,
				updatedAt: new Date().toISOString(),
			};
			if (!next.waitingOn) delete next.waitingOn;
			if (!next.nextAction) delete next.nextAction;
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
