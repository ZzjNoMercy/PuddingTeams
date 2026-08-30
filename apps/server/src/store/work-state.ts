import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionWorkStatus = "active" | "resolved" | "cancelled";
export type GoalExecutionStatus = "idle" | "running" | "waiting_human" | "interrupted" | "recovering" | "reviewing";
export type CompletionReviewMode = "manager" | "independent";
export type CompletionReviewVerdict = "satisfied" | "not_satisfied" | "needs_human";
export type WorkItemStatus = "planned" | "ready" | "in_progress" | "waiting_admission" | "waiting_input" | "submitted" | "revision" | "accepted" | "blocked" | "cancelled";
export type VerificationMode = "manager_review" | "independent_evidence_review" | "environment_verified";
export type VerificationTrigger = "manager_request" | "auto_on_submission";
export type VerificationStatus = "pending" | "running" | "waiting_input" | "passed" | "failed" | "blocked" | "stale";
export type WorkspaceAccessMode = "read_only_shared" | "exclusive_write" | "isolated_worktree";
export type WorkspaceExecutionClass = "read_only" | "git_write" | "non_git_write";

export interface VerificationPolicy {
	mode: VerificationMode;
	trigger: VerificationTrigger;
	source: "user" | "goal_default" | "manager_derived";
	reason: string;
}
export interface GoalVerificationPolicy {
	minimumWorkItemMode: VerificationMode;
	finalGoalMode: VerificationMode;
	trigger: VerificationTrigger;
	source: "user" | "harness_default" | "manager_derived";
	reason: string;
}
export interface WorkItemVerificationPolicy extends VerificationPolicy {
	frozenAtRevision?: number;
}
export interface WorkspaceExecutionPolicy {
	mode: WorkspaceAccessMode;
	source: "harness_default" | "manager_derived" | "user";
	reason: string;
	baselineStrategy: "git_tree" | "filesystem_manifest" | "external_snapshot";
	promoteOnAcceptance: boolean;
}
export interface WorkspaceChangeSet {
	id: string;
	executionScopeId: string;
	delegationIds: string[];
	workspaceId?: string;
	mode: WorkspaceAccessMode;
	baselineFingerprint: string;
	outputFingerprint: string;
	changedPaths: string[];
	diffArtifactId?: string;
	diffHash?: string;
	promotionState: "not_required" | "pending" | "applied" | "conflict" | "failed";
	createdAt: string;
	promotedAt?: string;
}
export interface ExecutionReceipt {
	id: string;
	delegationId: string;
	goalId?: string;
	workPlanId?: string;
	workItemId?: string;
	attempt?: number;
	goalRevision?: number;
	workItemRevision?: number;
	goalEpoch?: number;
	taskContractHash?: string;
	contractHash: string;
	inputFingerprint?: string;
	reportedOutcome: "completed" | "failed" | "cancelled" | "blocked" | "input_required";
	requirementResults: Array<{ requirement: string; status: "provided" | "missing" | "unavailable"; evidenceRefs: string[] }>;
	artifactCapture: Array<{ reportedPath: string; artifactId?: string; contentHash?: string; status: "captured" | "rejected" | "missing" | "failed"; issue?: string }>;
	collectionStatus: "complete" | "partial" | "failed";
	workspaceExecutionScopeId?: string;
	workspaceChangeSetId?: string;
	integrity: "clean" | "suspect" | "violation";
	issues: string[];
	sealedAt: string;
}
export interface VerificationCriterionResult {
	criterion: string;
	status: "satisfied" | "unsatisfied" | "uncertain";
	evidenceRefs: string[];
	explanation: string;
}
export interface VerificationRecord {
	id: string;
	goalId: string;
	workPlanId?: string;
	workItemId?: string;
	submissionId?: string;
	goalRevision: number;
	workItemRevision?: number;
	goalEpoch: number;
	mode: VerificationMode;
	status: VerificationStatus;
	verifierAgentId?: string;
	verifierDelegationId?: string;
	reviewerModel?: string;
	reviewerSessionId?: string;
	environmentProfileId?: string;
	environmentMode: "none" | "isolated_copy" | "same_target_guarded";
	inputFingerprint: string;
	outputFingerprint?: string;
	criteria: VerificationCriterionResult[];
	evidenceRefs: string[];
	observations?: Array<{ id: string; delegationId: string; kind: "tool" | "file" | "search"; title: string; contentHash: string; itemId?: string }>;
	integrity: "unknown" | "clean" | "suspect" | "violation";
	failureReason?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface CompletionReviewCriterion {
	criterion: string;
	status: "satisfied" | "unsatisfied" | "uncertain";
	evidenceRefs: string[];
	explanation: string;
}
export interface CompletionReview {
	id: string;
	goalRevision: number;
	mode: "manager" | "independent";
	verdict: CompletionReviewVerdict;
	criteria: CompletionReviewCriterion[];
	gaps: string[];
	reviewerModel?: string;
	reviewerSessionId: string;
	reviewedAt: string;
}
export interface GoalContractProvenance {
	criteriaOrigin: "user_input" | "manager_derived";
	sourceMessageIds: string[];
	authoredByAgentId?: "manager";
}
export interface GoalInterruption {
	id: string;
	kind: "user" | "server_restart" | "manager_interrupted" | "effect_unknown";
	fingerprint: string;
	delegationIds: string[];
	interruptedAt: string;
}
export interface GoalExecution {
	epoch: number;
	status: GoalExecutionStatus;
	interruption?: GoalInterruption;
	resumeLease?: { ownerId: string; token: string; expiresAt: string };
}
export interface WorkItemSubmission {
	id: string;
	attempt: number;
	source: "delegation" | "manager";
	delegationId?: string;
	resultRef:
		| { kind: "delegation_result"; delegationId: string }
		| { kind: "manager_summary"; evidenceRefs: string[] };
	artifactIds: string[];
	/** Worker execution submissions carry the sealed receipt; manager read-only submissions do not. */
	executionReceiptId?: string;
	executionReceipt?: ExecutionReceipt;
	workspaceChangeSetId?: string;
	workspaceChangeSet?: WorkspaceChangeSet;
	goalRevision: number;
	workItemRevision: number;
	inputFingerprint: string;
	verifications: VerificationRecord[];
	acceptanceIntent?: { verdict: "accepted"; summary: string; evidenceRefs: string[]; requestedAt: string };
	summary?: string;
	submittedAt: string;
	review?: {
		verdict: "accepted" | "revision" | "blocked";
		summary: string;
		evidenceRefs: string[];
		reviewedAt: string;
	};
}
export interface WorkItem {
	id: string;
	title: string;
	description?: string;
	assignedAgentId?: string;
	dependsOn: string[];
	acceptanceCriteria: string[];
	sourceGoalCriteria: string[];
	status: WorkItemStatus;
	verificationPolicy: WorkItemVerificationPolicy;
	workspaceExecutionPolicy: WorkspaceExecutionPolicy;
	delegationIds: string[];
	activeDelegationId?: string;
	submissions: WorkItemSubmission[];
	acceptedSubmissionId?: string;
	lastChange?: { reason: string; changedAt: string; previousRevision: number };
	revision: number;
	createdAt: string;
	updatedAt: string;
}
export interface GoalWorkPlan {
	id: string;
	title?: string;
	coveredGoalRevision: number;
	needsReconcile: boolean;
	revision: number;
	items: Record<string, WorkItem>;
	createdAt: string;
	updatedAt: string;
}
export interface SessionWorkState {
	goalId: string;
	sessionId: string;
	goal: string;
	contractProvenance: GoalContractProvenance;
	responsibleAgentId: string;
	participantAgentIds: string[];
	currentBrief: string;
	waitingOn?: string;
	nextAction?: string;
	completionBoundary: string;
	goalRevision: number;
	reviewMode: CompletionReviewMode;
	reviewerModel?: string;
	verificationPolicy: GoalVerificationPolicy;
	completionReviews: CompletionReview[];
	goalVerifications: VerificationRecord[];
	status: SessionWorkStatus;
	execution: GoalExecution;
	plan?: GoalWorkPlan;
	artifactIds: string[];
	revision: number;
	createdAt: string;
	updatedAt: string;
}
export interface DecisionOption { id: string; label: string }
export interface DecisionRequest {
	id: string;
	goalId: string;
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
export interface GoalOperation {
	id: string;
	goalId?: string;
	sessionId: string;
	epoch: number;
	kind: string;
	payloadHash: string;
	status: "committed";
	resultRevision?: number;
	result: unknown;
	createdAt: string;
	updatedAt: string;
}
export interface GoalOutboxEvent {
	id: string;
	goalId: string;
	sessionId: string;
	epoch: number;
	kind: "goal_changed" | "decision_answered" | "goal_recovery" | "goal_interrupted";
	payload: Record<string, unknown>;
	status: "pending" | "delivered";
	createdAt: string;
	deliveredAt?: string;
}
interface WorkStateFile {
	version: 6;
	states: Record<string, SessionWorkState>;
	decisions: Record<string, DecisionRequest>;
	operations: Record<string, GoalOperation>;
	outbox: Record<string, GoalOutboxEvent>;
}

export class WorkStateConflictError extends Error {
	constructor(readonly current: SessionWorkState, message = `目标状态刚刚发生变化（当前 revision ${current.revision}）。请基于最新状态串行执行下一步`) {
		super(message);
		this.name = "WorkStateConflictError";
	}
}
export class WorkStateOperationConflictError extends Error {
	constructor(message: string, readonly code: "idempotency_conflict" | "stale_goal_state") {
		super(message);
		this.name = "WorkStateOperationConflictError";
	}
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
	if (value.trim().length > 30_000) throw new Error(`${field} 过长`);
	return value.trim();
}
function optionalText(value: unknown, field: string): string | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
	if (value.trim().length > 30_000) throw new Error(`${field} 过长`);
	return value.trim() || undefined;
}
function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} 必须是字符串数组`);
	return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
function hash(value: unknown): string {
	return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}
function copy<T>(value: T): T { return structuredClone(value) }
function now(): string { return new Date().toISOString() }
const verificationRank: Record<VerificationMode, number> = { manager_review: 0, independent_evidence_review: 1, environment_verified: 2 };
function stricterMode(a: VerificationMode, b: VerificationMode): VerificationMode { return verificationRank[a] >= verificationRank[b] ? a : b }
function validVerificationMode(value: unknown, field: string): VerificationMode {
	if (value !== "manager_review" && value !== "independent_evidence_review" && value !== "environment_verified") throw new Error(`${field} 无效`);
	return value;
}
function validTrigger(value: unknown, field: string): VerificationTrigger {
	if (value !== "manager_request" && value !== "auto_on_submission") throw new Error(`${field} 无效`);
	return value;
}
function defaultGoalVerificationPolicy(): GoalVerificationPolicy {
	return { minimumWorkItemMode: "manager_review", finalGoalMode: "independent_evidence_review", trigger: "manager_request", source: "harness_default", reason: "Harness 默认验收策略" };
}
function defaultWorkItemVerificationPolicy(): WorkItemVerificationPolicy {
	return { mode: "manager_review", trigger: "manager_request", source: "goal_default", reason: "继承 Goal 验收策略" };
}
function defaultWorkspaceExecutionPolicy(): WorkspaceExecutionPolicy {
	return { mode: "read_only_shared", source: "harness_default", reason: "Harness 默认 Workspace 策略", baselineStrategy: "git_tree", promoteOnAcceptance: false };
}
export function workItemContractHash(state: Pick<SessionWorkState, "goalId" | "goalRevision" | "execution">, plan: Pick<GoalWorkPlan, "id">, item: Pick<WorkItem, "id" | "revision" | "title" | "description" | "acceptanceCriteria" | "sourceGoalCriteria" | "verificationPolicy" | "workspaceExecutionPolicy">): string {
	const { frozenAtRevision: _runtimeFreeze, ...verificationContract } = item.verificationPolicy;
	return hash({ goalId: state.goalId, goalRevision: state.goalRevision, goalEpoch: state.execution.epoch, workPlanId: plan.id, workItemId: item.id, workItemRevision: item.revision, title: item.title, description: item.description, acceptanceCriteria: item.acceptanceCriteria, sourceGoalCriteria: item.sourceGoalCriteria, verificationPolicy: verificationContract, workspaceExecutionPolicy: item.workspaceExecutionPolicy });
}

export function goalCriterionRefs(state: Pick<SessionWorkState, "goalRevision" | "completionBoundary">): Array<{ id: string; text: string }> {
	return state.completionBoundary.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
		.map((item, index) => ({ id: `goal:${state.goalRevision}:${index + 1}`, text: item }));
}
function assertDag(items: Record<string, WorkItem>): void {
	for (const item of Object.values(items)) {
		if (item.dependsOn.includes(item.id)) throw new Error(`WorkItem ${item.id} 不能依赖自身`);
		for (const id of item.dependsOn) if (!items[id]) throw new Error(`WorkItem ${item.id} 引用了不存在或跨 Plan 的依赖 ${id}`);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string) => {
		if (visiting.has(id)) throw new Error("WorkPlan dependsOn 必须是无环 DAG");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const parent of items[id]?.dependsOn ?? []) visit(parent);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of Object.keys(items)) visit(id);
}
function deriveReady(plan: GoalWorkPlan): void {
	for (const item of Object.values(plan.items)) {
		if (item.status === "planned" || item.status === "ready") {
			item.status = item.dependsOn.every((id) => plan.items[id]?.status === "accepted") ? "ready" : "planned";
		}
	}
}

export class WorkStateStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();
	private operationRetentionDays = 30;
	private maxOperationsPerSession = 512;
	private goalVerificationDefaults = defaultGoalVerificationPolicy();
	private workspaceExecutionDefaults = defaultWorkspaceExecutionPolicy();
	private gitWriteExecutionDefaults: WorkspaceExecutionPolicy = { mode: "isolated_worktree", source: "harness_default", reason: "Harness Git 写任务默认策略", baselineStrategy: "git_tree", promoteOnAcceptance: true };
	private nonGitWriteExecutionDefaults: WorkspaceExecutionPolicy = { mode: "exclusive_write", source: "harness_default", reason: "Harness 非 Git 写任务默认策略", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false };
	constructor(private readonly stateDir: string) { this.file = path.join(stateDir, "work-states.json") }
	async init(): Promise<void> { await mkdir(this.stateDir, { recursive: true }) }
	configureOperationLedger(input: { operationRetentionDays: number; maxOperationsPerSession: number }): void {
		this.operationRetentionDays = Math.max(7, Math.min(input.operationRetentionDays, 365));
		this.maxOperationsPerSession = Math.max(128, Math.min(input.maxOperationsPerSession, 4096));
	}
	configureVerificationDefaults(input: {
		minimumWorkItemMode?: VerificationMode;
		finalGoalMode?: VerificationMode;
		trigger?: VerificationTrigger;
		workspaceExecution?: { readOnlyMode?: "read_only_shared"; gitWriteMode?: "isolated_worktree" | "exclusive_write"; nonGitWriteMode?: "exclusive_write" };
	}): void {
		const current = this.goalVerificationDefaults;
		const minimumWorkItemMode = input.minimumWorkItemMode === undefined ? current.minimumWorkItemMode : validVerificationMode(input.minimumWorkItemMode, "minimumWorkItemMode");
		const finalGoalMode = input.finalGoalMode === undefined ? current.finalGoalMode : validVerificationMode(input.finalGoalMode, "finalGoalMode");
		const trigger = input.trigger === undefined ? current.trigger : validTrigger(input.trigger, "trigger");
		this.goalVerificationDefaults = { ...current, minimumWorkItemMode, finalGoalMode: stricterMode(finalGoalMode, minimumWorkItemMode), trigger, source: "harness_default", reason: "Harness 默认验收策略" };
		if (input.workspaceExecution) {
			this.workspaceExecutionDefaults = { ...this.workspaceExecutionDefaults, mode: input.workspaceExecution.readOnlyMode ?? "read_only_shared" };
			this.gitWriteExecutionDefaults = { ...this.gitWriteExecutionDefaults, mode: input.workspaceExecution.gitWriteMode ?? this.gitWriteExecutionDefaults.mode };
			this.nonGitWriteExecutionDefaults = { ...this.nonGitWriteExecutionDefaults, mode: input.workspaceExecution.nonGitWriteMode ?? "exclusive_write" };
		}
	}
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}
	private async load(): Promise<WorkStateFile> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<WorkStateFile>;
			if (parsed.version !== 6) throw new Error(`work-states.json 必须使用 v6（${this.file}）；项目未上线，不读取旧结构，请移走旧文件后重启`);
			return { version: 6, states: parsed.states ?? {}, decisions: parsed.decisions ?? {}, operations: parsed.operations ?? {}, outbox: parsed.outbox ?? {} };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { version: 6, states: {}, decisions: {}, operations: {}, outbox: {} };
		}
	}
	private async write(data: WorkStateFile): Promise<void> {
		const temp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
		await rename(temp, this.file);
	}
	private opKey(sessionId: string, operationId: string, goalId?: string): string { return `${goalId ?? sessionId}:${operationId}` }
	private replay<T>(data: WorkStateFile, sessionId: string, operationId: string, kind: string, payload: unknown, goalId?: string): T | undefined {
		const operation = data.operations[this.opKey(sessionId, operationId, goalId)];
		if (!operation) return undefined;
		if (operation.kind !== kind || operation.payloadHash !== hash(payload)) {
			throw new WorkStateOperationConflictError("同一 Idempotency-Key 被用于不同请求", "idempotency_conflict");
		}
		return copy(operation.result as T);
	}
	private commit<T>(data: WorkStateFile, sessionId: string, operationId: string, epoch: number, kind: string, payload: unknown, result: T, revision?: number, goalId?: string, scope: "session" | "goal" = goalId ? "goal" : "session"): void {
		const timestamp = now();
		data.operations[this.opKey(sessionId, operationId, scope === "goal" ? goalId : undefined)] = {
			id: operationId, sessionId, ...(goalId ? { goalId } : {}), epoch, kind, payloadHash: hash(payload), status: "committed",
			...(revision === undefined ? {} : { resultRevision: revision }), result: copy(result), createdAt: timestamp, updatedAt: timestamp,
		};
		const cutoff = Date.now() - this.operationRetentionDays * 24 * 60 * 60 * 1000;
		const operations = Object.entries(data.operations)
			.filter(([, item]) => item.sessionId === sessionId)
			.sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt));
		for (const [index, [key, item]] of operations.entries()) {
			if (index < this.maxOperationsPerSession || new Date(item.updatedAt).getTime() >= cutoff) continue;
			delete data.operations[key];
		}
	}
	private event(data: WorkStateFile, event: Omit<GoalOutboxEvent, "status" | "createdAt">): void {
		if (!data.outbox[event.id]) data.outbox[event.id] = { ...event, status: "pending", createdAt: now() };
	}
	private current(state: SessionWorkState, revision: number, epoch?: number, goalId?: string): void {
		if (!Number.isInteger(revision) || revision < 0) throw new Error("revision 必须是非负整数");
		if (goalId !== undefined && state.goalId !== goalId) throw new WorkStateOperationConflictError("当前 Goal 已变化，请重新读取目标状态", "stale_goal_state");
		if (state.revision !== revision) throw new WorkStateConflictError(state);
		if (epoch !== undefined && state.execution.epoch !== epoch) throw new WorkStateOperationConflictError("Goal execution epoch 已变化", "stale_goal_state");
	}
	private sessionGoals(data: WorkStateFile, sessionId: string): SessionWorkState[] {
		return Object.values(data.states).filter((state) => state.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
	private active(data: WorkStateFile, sessionId: string): SessionWorkState | undefined {
		const active = this.sessionGoals(data, sessionId).filter((state) => state.status === "active");
		if (active.length > 1) throw new Error(`Session ${sessionId} 存在多个 active Goal`);
		return active[0];
	}
	private byGoalId(data: WorkStateFile, sessionId: string, goalId: string): SessionWorkState | undefined {
		const state = data.states[goalId];
		return state?.sessionId === sessionId ? state : undefined;
	}
	private cancelPendingDecisions(data: WorkStateFile, goalId: string, timestamp: string): void {
		for (const [id, decision] of Object.entries(data.decisions)) {
			if (decision.goalId === goalId && decision.status === "pending") data.decisions[id] = { ...decision, status: "cancelled", updatedAt: timestamp };
		}
	}
	async get(sessionId: string): Promise<SessionWorkState | undefined> {
		const data = await this.load();
		const state = this.active(data, sessionId) ?? this.sessionGoals(data, sessionId)[0];
		return state ? copy(state) : undefined;
	}
	async getActive(sessionId: string): Promise<SessionWorkState | undefined> {
		const state = this.active(await this.load(), sessionId);
		return state ? copy(state) : undefined;
	}
	async getGoal(sessionId: string, goalId: string): Promise<SessionWorkState | undefined> {
		const state = this.byGoalId(await this.load(), sessionId, goalId);
		return state ? copy(state) : undefined;
	}
	async listSessionGoals(sessionId: string): Promise<SessionWorkState[]> {
		return this.sessionGoals(await this.load(), sessionId).map(copy);
	}
	async listActive(): Promise<SessionWorkState[]> {
		const data = await this.load();
		for (const sessionId of new Set(Object.values(data.states).map((state) => state.sessionId))) this.active(data, sessionId);
		return Object.values(data.states).filter((state) => state.status === "active").map(copy);
	}
	async findGoalCreationOperation(operationId: string): Promise<SessionWorkState | undefined> {
		const operation = Object.values((await this.load()).operations).find((item) => item.id === operationId && item.kind === "create_goal");
		return operation ? copy(operation.result as SessionWorkState) : undefined;
	}
	async create(input: {
		sessionId: string; goal: string; completionBoundary: string; reviewMode?: CompletionReviewMode;
		reviewerModel?: string; participantAgentIds?: string[]; contractProvenance?: GoalContractProvenance; operationId?: string;
		verificationPolicy?: Partial<GoalVerificationPolicy>;
	}): Promise<SessionWorkState> {
		const goal = requiredText(input.goal, "goal");
		const completionBoundary = requiredText(input.completionBoundary, "completionBoundary");
		const operationId = input.operationId ?? randomUUID();
		const payload = { ...input, operationId: undefined, goal, completionBoundary };
		return this.serialize(async () => {
			const data = await this.load();
			const replay = this.replay<SessionWorkState>(data, input.sessionId, operationId, "create_goal", payload);
			if (replay) return replay;
			if (Object.values(data.operations).some((item) => item.id === operationId)) {
				throw new WorkStateOperationConflictError("同一 Goal 创建 operationId 已属于另一 Session", "idempotency_conflict");
			}
			if (this.active(data, input.sessionId)) throw new Error("该 Session 已有正在进行的 Goal；请先完成或取消当前 Goal");
			const provenance = input.contractProvenance ?? { criteriaOrigin: "user_input" as const, sourceMessageIds: [] };
			if (provenance.criteriaOrigin === "manager_derived" && provenance.sourceMessageIds.length === 0) throw new Error("Manager 自动创建 Goal 必须引用至少一条来源消息");
			const timestamp = now();
			const goalId = randomUUID();
			const requestedPolicy = input.verificationPolicy ?? {};
			const verificationPolicy: GoalVerificationPolicy = {
				...this.goalVerificationDefaults,
				...requestedPolicy,
				minimumWorkItemMode: validVerificationMode(requestedPolicy.minimumWorkItemMode ?? this.goalVerificationDefaults.minimumWorkItemMode, "verificationPolicy.minimumWorkItemMode"),
				finalGoalMode: validVerificationMode(requestedPolicy.finalGoalMode ?? this.goalVerificationDefaults.finalGoalMode, "verificationPolicy.finalGoalMode"),
				trigger: validTrigger(requestedPolicy.trigger ?? this.goalVerificationDefaults.trigger, "verificationPolicy.trigger"),
				source: requestedPolicy.source ?? this.goalVerificationDefaults.source,
				reason: requiredText(requestedPolicy.reason ?? this.goalVerificationDefaults.reason, "verificationPolicy.reason"),
			};
			if (!["user", "harness_default", "manager_derived"].includes(verificationPolicy.source)) throw new Error("verificationPolicy.source 无效");
			verificationPolicy.finalGoalMode = stricterMode(verificationPolicy.finalGoalMode, verificationPolicy.minimumWorkItemMode);
			const state: SessionWorkState = {
				goalId, sessionId: input.sessionId, goal,
				contractProvenance: {
					criteriaOrigin: provenance.criteriaOrigin,
					sourceMessageIds: strings(provenance.sourceMessageIds, "sourceMessageIds"),
					...(provenance.criteriaOrigin === "manager_derived" ? { authoredByAgentId: "manager" as const } : {}),
				},
				responsibleAgentId: "manager", participantAgentIds: [...new Set(input.participantAgentIds ?? [])],
				currentBrief: "", completionBoundary, goalRevision: 1, reviewMode: input.reviewMode ?? "independent",
				verificationPolicy, goalVerifications: [],
				...(optionalText(input.reviewerModel, "reviewerModel") ? { reviewerModel: input.reviewerModel!.trim() } : {}),
				completionReviews: [], status: "active", execution: { epoch: 1, status: "idle" },
				artifactIds: [], revision: 0, createdAt: timestamp, updatedAt: timestamp,
			};
			data.states[goalId] = state;
			this.event(data, { id: `goal-created:${goalId}`, goalId, sessionId: input.sessionId, epoch: 1, kind: "goal_changed", payload: { action: "created" } });
			this.commit(data, input.sessionId, operationId, 1, "create_goal", payload, state, 0, goalId, "session");
			await this.write(data);
			return copy(state);
		});
	}
	async update(
		sessionId: string, expectedRevision: number,
		patch: {
			goal?: string; participantAgentIds?: string[]; currentBrief?: string; waitingOn?: string; nextAction?: string;
			completionBoundary?: string; reviewMode?: CompletionReviewMode; reviewerModel?: string; status?: SessionWorkStatus;
			executionStatus?: GoalExecutionStatus; artifactIds?: string[];
		},
		operationId: string = randomUUID(), expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { expectedGoalId, expectedRevision, expectedEpoch, patch };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state) throw new Error("Session Goal 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "update_goal", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			const goal = patch.goal === undefined ? state.goal : requiredText(patch.goal, "goal");
			const boundary = patch.completionBoundary === undefined ? state.completionBoundary : requiredText(patch.completionBoundary, "completionBoundary");
			const currentBrief = patch.currentBrief === undefined ? state.currentBrief : (patch.currentBrief.trim() ? requiredText(patch.currentBrief, "currentBrief") : "");
			const requestedStatus = patch.status ?? state.status;
			if (patch.status === "resolved") throw new Error("Goal 只能通过完成复核置为 resolved；Manager 使用 applyManagerCompletion，独立复核使用 applyCompletionReview");
			const contractChanged = goal !== state.goal || boundary !== state.completionBoundary;
			const status: SessionWorkStatus = contractChanged ? "active" : requestedStatus;
			const next: SessionWorkState = {
				...state, goal, completionBoundary: boundary, currentBrief, status,
				goalRevision: contractChanged ? state.goalRevision + 1 : state.goalRevision,
				...(patch.participantAgentIds === undefined ? {} : { participantAgentIds: strings(patch.participantAgentIds, "participantAgentIds") }),
				...(patch.reviewMode === undefined ? {} : { reviewMode: patch.reviewMode }),
				...(patch.artifactIds === undefined ? {} : { artifactIds: strings(patch.artifactIds, "artifactIds") }),
				execution: { ...state.execution, ...(status !== "active" ? { status: "idle" as const } : patch.executionStatus ? { status: patch.executionStatus } : {}) },
				revision: state.revision + 1, updatedAt: now(),
			};
			const waitingOn = optionalText(patch.waitingOn, "waitingOn");
			const nextAction = optionalText(patch.nextAction, "nextAction");
			if (patch.waitingOn !== undefined) waitingOn ? next.waitingOn = waitingOn : delete next.waitingOn;
			if (patch.nextAction !== undefined) nextAction ? next.nextAction = nextAction : delete next.nextAction;
			if (patch.reviewerModel !== undefined) {
				const model = optionalText(patch.reviewerModel, "reviewerModel");
				model ? next.reviewerModel = model : delete next.reviewerModel;
			}
			if (contractChanged) {
				if (next.plan) next.plan = { ...next.plan, needsReconcile: true };
				next.nextAction = "Goal 契约已变化，重新对账 WorkPlan 与完成条件";
			}
			if (next.status !== "active") this.cancelPendingDecisions(data, state.goalId, next.updatedAt);
			data.states[state.goalId] = next;
			this.event(data, { id: `goal-change:${state.goalId}:${next.revision}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "updated", revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "update_goal", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async updatePlan(
		sessionId: string, expectedRevision: number,
		input: {
			title?: string;
			upsertItems: Array<{ id?: string; title: string; description?: string; assignedAgentId?: string; dependsOn?: string[]; acceptanceCriteria: string[]; sourceGoalCriteria?: string[]; verificationPolicy?: Partial<WorkItemVerificationPolicy>; workspaceExecutionClass?: WorkspaceExecutionClass; workspaceExecutionPolicy?: Partial<WorkspaceExecutionPolicy> }>;
			removeItemIds?: string[]; cancelItemIds?: string[]; reopenItemIds?: string[]; reason: string;
		},
		operationId: string, expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { expectedGoalId, expectedRevision, expectedEpoch, input };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state) throw new Error("Session Goal 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "update_work_plan", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			const reason = requiredText(input.reason, "reason");
			const timestamp = now();
			const plan: GoalWorkPlan = state.plan ? copy(state.plan) : { id: randomUUID(), coveredGoalRevision: state.goalRevision, needsReconcile: false, revision: 0, items: {}, createdAt: timestamp, updatedAt: timestamp };
			const allowedRefs = new Set(goalCriterionRefs(state).map((item) => item.id));
			let ordinal = Object.keys(plan.items).length;
			for (const raw of input.upsertItems) {
				const id = raw.id?.trim() || `W${++ordinal}`;
				const existing = plan.items[id];
				const acceptanceCriteria = strings(raw.acceptanceCriteria, `${id}.acceptanceCriteria`);
				if (!acceptanceCriteria.length) throw new Error(`WorkItem ${id} 至少需要一项验收条件`);
				const sourceGoalCriteria = strings(raw.sourceGoalCriteria ?? [], `${id}.sourceGoalCriteria`);
				const unknown = sourceGoalCriteria.filter((ref) => !allowedRefs.has(ref));
				if (unknown.length) throw new Error(`WorkItem ${id} 引用了未知 Goal 条件：${unknown.join("、")}`);
				const requestedVerification = raw.verificationPolicy ?? {};
				const existingVerification = existing?.verificationPolicy ?? { ...defaultWorkItemVerificationPolicy(), mode: state.verificationPolicy.minimumWorkItemMode, trigger: state.verificationPolicy.trigger };
				const verificationPolicy: WorkItemVerificationPolicy = {
					...existingVerification,
					...requestedVerification,
					mode: stricterMode(validVerificationMode(requestedVerification.mode ?? existingVerification.mode, `${id}.verificationPolicy.mode`), state.verificationPolicy.minimumWorkItemMode),
					trigger: validTrigger(requestedVerification.trigger ?? existingVerification.trigger, `${id}.verificationPolicy.trigger`),
					source: requestedVerification.source ?? existingVerification.source,
					reason: requiredText(requestedVerification.reason ?? existingVerification.reason, `${id}.verificationPolicy.reason`),
				};
				if (!["user", "goal_default", "manager_derived"].includes(verificationPolicy.source)) throw new Error(`${id}.verificationPolicy.source 无效`);
				if (existingVerification.frozenAtRevision !== undefined && verificationRank[verificationPolicy.mode] < verificationRank[existingVerification.mode]) throw new Error(`${id} 已冻结验证策略，不能降低验收等级`);
				const requestedWorkspace = raw.workspaceExecutionPolicy ?? {};
				if (raw.workspaceExecutionClass !== undefined && !["read_only", "git_write", "non_git_write"].includes(raw.workspaceExecutionClass)) throw new Error(`${id}.workspaceExecutionClass 无效`);
				const classifiedDefault = raw.workspaceExecutionClass === "git_write"
					? this.gitWriteExecutionDefaults
					: raw.workspaceExecutionClass === "non_git_write"
						? this.nonGitWriteExecutionDefaults
						: this.workspaceExecutionDefaults;
				const workspaceExecutionPolicy: WorkspaceExecutionPolicy = {
					...(existing?.workspaceExecutionPolicy ?? classifiedDefault),
					...requestedWorkspace,
					mode: (requestedWorkspace.mode ?? existing?.workspaceExecutionPolicy?.mode ?? classifiedDefault.mode) as WorkspaceAccessMode,
					source: (requestedWorkspace.source ?? existing?.workspaceExecutionPolicy?.source ?? classifiedDefault.source) as WorkspaceExecutionPolicy["source"],
					reason: requiredText(requestedWorkspace.reason ?? existing?.workspaceExecutionPolicy?.reason ?? classifiedDefault.reason, `${id}.workspaceExecutionPolicy.reason`),
					baselineStrategy: (requestedWorkspace.baselineStrategy ?? existing?.workspaceExecutionPolicy?.baselineStrategy ?? classifiedDefault.baselineStrategy) as WorkspaceExecutionPolicy["baselineStrategy"],
					promoteOnAcceptance: requestedWorkspace.promoteOnAcceptance ?? existing?.workspaceExecutionPolicy?.promoteOnAcceptance ?? classifiedDefault.promoteOnAcceptance,
				};
				if (!["read_only_shared", "exclusive_write", "isolated_worktree"].includes(workspaceExecutionPolicy.mode)) throw new Error(`${id}.workspaceExecutionPolicy.mode 无效`);
				if (!["harness_default", "manager_derived", "user"].includes(workspaceExecutionPolicy.source)) throw new Error(`${id}.workspaceExecutionPolicy.source 无效`);
				if (!["git_tree", "filesystem_manifest", "external_snapshot"].includes(workspaceExecutionPolicy.baselineStrategy)) throw new Error(`${id}.workspaceExecutionPolicy.baselineStrategy 无效`);
				if (typeof workspaceExecutionPolicy.promoteOnAcceptance !== "boolean") throw new Error(`${id}.workspaceExecutionPolicy.promoteOnAcceptance 必须是布尔值`);
				const candidate = {
					...(existing ?? { id, status: "planned" as const, delegationIds: [], submissions: [], revision: 0, createdAt: timestamp }),
					title: requiredText(raw.title, `${id}.title`),
					...(optionalText(raw.description, `${id}.description`) ? { description: raw.description!.trim() } : {}),
					...(optionalText(raw.assignedAgentId, `${id}.assignedAgentId`) ? { assignedAgentId: raw.assignedAgentId!.trim() } : {}),
					dependsOn: strings(raw.dependsOn ?? [], `${id}.dependsOn`), acceptanceCriteria, sourceGoalCriteria,
					verificationPolicy, workspaceExecutionPolicy,
					updatedAt: timestamp,
				};
				const materiallyChanged = Boolean(existing && stable({
					title: existing.title, description: existing.description, assignedAgentId: existing.assignedAgentId,
					dependsOn: existing.dependsOn, acceptanceCriteria: existing.acceptanceCriteria, sourceGoalCriteria: existing.sourceGoalCriteria, verificationPolicy: existing.verificationPolicy, workspaceExecutionPolicy: existing.workspaceExecutionPolicy,
				}) !== stable({
					title: candidate.title, description: candidate.description, assignedAgentId: candidate.assignedAgentId,
					dependsOn: candidate.dependsOn, acceptanceCriteria: candidate.acceptanceCriteria, sourceGoalCriteria: candidate.sourceGoalCriteria, verificationPolicy: candidate.verificationPolicy, workspaceExecutionPolicy: candidate.workspaceExecutionPolicy,
				}));
				const acceptanceContractChanged = Boolean(existing && stable({
					dependsOn: existing.dependsOn, acceptanceCriteria: existing.acceptanceCriteria, sourceGoalCriteria: existing.sourceGoalCriteria, verificationPolicy: existing.verificationPolicy, workspaceExecutionPolicy: existing.workspaceExecutionPolicy,
				}) !== stable({
					dependsOn: candidate.dependsOn, acceptanceCriteria: candidate.acceptanceCriteria, sourceGoalCriteria: candidate.sourceGoalCriteria, verificationPolicy: candidate.verificationPolicy, workspaceExecutionPolicy: candidate.workspaceExecutionPolicy,
				}));
				if (existing?.status === "accepted" && acceptanceContractChanged) {
					const activeDependents = Object.values(plan.items).filter((item) => item.dependsOn.includes(id) && !["planned", "ready", "cancelled"].includes(item.status));
					if (activeDependents.length) throw new Error(`WorkItem ${id} 的验收契约已被下游使用，先处理：${activeDependents.map((item) => item.id).join("、")}`);
				}
				const nextItem: WorkItem = {
					...candidate,
					revision: existing ? existing.revision + (materiallyChanged ? 1 : 0) : 0,
					...(materiallyChanged && existing ? { lastChange: { reason, changedAt: timestamp, previousRevision: existing.revision } } : {}),
				};
				if (existing?.status === "accepted" && acceptanceContractChanged) {
					nextItem.status = "revision";
					delete nextItem.acceptedSubmissionId;
				}
				plan.items[id] = nextItem;
			}
			for (const id of strings(input.removeItemIds ?? [], "removeItemIds")) {
				const item = plan.items[id];
				if (!item) continue;
				if (Object.values(plan.items).some((item) => item.id !== id && item.dependsOn.includes(id))) throw new Error(`WorkItem ${id} 仍被依赖`);
				if (!["planned", "ready"].includes(item.status)) throw new Error(`WorkItem ${id} 已经开始，不能删除；如不再需要请取消并保留执行历史`);
				if (item.delegationIds.length || item.submissions.length) throw new Error(`WorkItem ${id} 已有执行事实，不能删除`);
				delete plan.items[id];
			}
			for (const id of strings(input.cancelItemIds ?? [], "cancelItemIds")) {
				const item = plan.items[id];
				if (!item) throw new Error(`WorkItem ${id} 不存在`);
				if (item.activeDelegationId) throw new Error(`WorkItem ${id} 仍有活动 Delegation，必须先终止该 Worker 任务`);
				if (item.status === "cancelled") continue;
				const previousRevision = item.revision;
				item.status = "cancelled";
				item.revision += 1;
				item.updatedAt = timestamp;
				item.lastChange = { reason, changedAt: timestamp, previousRevision };
			}
			for (const id of strings(input.reopenItemIds ?? [], "reopenItemIds")) {
				const item = plan.items[id];
				if (!item) throw new Error(`WorkItem ${id} 不存在`);
				if (item.status !== "blocked") throw new Error(`只有 blocked WorkItem 可以重新打开：${id}`);
				const previousRevision = item.revision;
				item.status = "revision";
				item.revision += 1;
				item.updatedAt = timestamp;
				item.lastChange = { reason, changedAt: timestamp, previousRevision };
			}
			for (const item of Object.values(plan.items)) {
				if (item.status === "cancelled") continue;
				const unknownGoalRefs = item.sourceGoalCriteria.filter((ref) => !allowedRefs.has(ref));
				if (unknownGoalRefs.length) throw new Error(`WorkItem ${item.id} 尚未对账当前 Goal 条件：${unknownGoalRefs.join("、")}`);
				const cancelledDependencies = item.dependsOn.filter((id) => plan.items[id]?.status === "cancelled");
				if (cancelledDependencies.length) throw new Error(`WorkItem ${item.id} 仍依赖已取消项：${cancelledDependencies.join("、")}`);
			}
			assertDag(plan.items);
			plan.coveredGoalRevision = state.goalRevision;
			plan.needsReconcile = false;
			plan.revision += 1;
			plan.updatedAt = timestamp;
			if (input.title?.trim()) plan.title = input.title.trim();
			deriveReady(plan);
			const next = { ...state, plan, revision: state.revision + 1, updatedAt: timestamp };
			data.states[state.goalId] = next;
			this.event(data, { id: `work-plan:${state.goalId}:${plan.revision}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "plan_updated", workPlanId: plan.id, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "update_work_plan", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	/** Atomically move a WorkItem's active slot from a pre-start admission to its
	 * replacement. The Driver start hook may proceed only after this CAS commits. */
	async reserveReplacementDelegation(input: {
		sessionId: string;
		goalId: string;
		workItemId: string;
		goalEpoch: number;
		goalRevision?: number;
		workItemRevision?: number;
		originalDelegationId: string;
		replacementDelegationId: string;
	}): Promise<SessionWorkState> {
		const operationId = `replacement-reservation:${input.originalDelegationId}:${input.replacementDelegationId}`;
		return this.serialize(async () => {
			const data = await this.load();
			const replay = this.replay<SessionWorkState>(data, input.sessionId, operationId, "replacement_reservation", input, input.goalId);
			if (replay) return replay;
			const state = this.byGoalId(data, input.sessionId, input.goalId);
			if (!state?.plan || state.status !== "active") throw new WorkStateOperationConflictError("改派所属 Goal 已结束", "stale_goal_state");
			if (state.execution.epoch !== input.goalEpoch || (input.goalRevision !== undefined && state.goalRevision !== input.goalRevision)) {
				throw new WorkStateOperationConflictError("改派期间 Goal 已变化", "stale_goal_state");
			}
			const plan = copy(state.plan);
			const item = plan.items[input.workItemId];
			if (!item || (input.workItemRevision !== undefined && item.revision !== input.workItemRevision)) {
				throw new WorkStateOperationConflictError("改派期间 WorkItem 已变化", "stale_goal_state");
			}
			if (item.activeDelegationId !== input.originalDelegationId || item.status !== "waiting_admission") {
				throw new WorkStateOperationConflictError("原 Delegation 已不再占用该 WorkItem", "stale_goal_state");
			}
			if (!item.delegationIds.includes(input.replacementDelegationId)) item.delegationIds.push(input.replacementDelegationId);
			item.activeDelegationId = input.replacementDelegationId;
			item.status = "in_progress";
			item.updatedAt = now();
			plan.revision += 1;
			plan.updatedAt = item.updatedAt;
			const next: SessionWorkState = { ...state, plan, execution: { ...state.execution, status: "running" }, revision: state.revision + 1, updatedAt: item.updatedAt };
			data.states[state.goalId] = next;
			this.event(data, { id: `work-item-replacement:${state.goalId}:${input.originalDelegationId}:${input.replacementDelegationId}`, goalId: state.goalId, sessionId: input.sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "delegation_replaced", workPlanId: plan.id, workItemId: item.id, status: item.status, revision: next.revision } });
			this.commit(data, input.sessionId, operationId, input.goalEpoch, "replacement_reservation", input, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}

	async noteDelegation(
		sessionId: string,
		input: { goalId: string; workItemId: string; delegationId: string; delegationStatus: "running" | "waiting_admission" | "waiting_input" | "completed" | "failed" | "cancelled"; goalEpoch: number; artifactIds?: string[]; summary?: string; submittedAt?: string; executionReceipt?: ExecutionReceipt; workspaceChangeSet?: WorkspaceChangeSet },
		operationId: string,
	): Promise<SessionWorkState> {
		return this.serialize(async () => {
			const data = await this.load();
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "delegation_boundary", input, input.goalId);
			if (replay) return replay;
			const state = this.byGoalId(data, sessionId, input.goalId);
			if (!state?.plan) throw new Error("WorkPlan 不存在");
			if (state.status !== "active") throw new WorkStateOperationConflictError("历史 Goal 的 Delegation 只保留审计", "stale_goal_state");
			if (state.execution.epoch !== input.goalEpoch) throw new WorkStateOperationConflictError("旧 epoch Delegation 只保留审计", "stale_goal_state");
			const plan = copy(state.plan);
			const item = plan.items[input.workItemId];
			if (!item) throw new Error("WorkItem 不存在");
			if (["accepted", "cancelled"].includes(item.status)) {
				// Startup reconciliation and late terminal callbacks are allowed to
				// observe an already-final WorkItem, but can never regress acceptance.
				this.commit(data, sessionId, operationId, input.goalEpoch, "delegation_boundary", input, state, state.revision, state.goalId);
				await this.write(data);
				return copy(state);
			}
			if (!item.delegationIds.includes(input.delegationId)) item.delegationIds.push(input.delegationId);
			const timestamp = input.submittedAt ?? now();
			if (input.delegationStatus === "running") {
				if (item.activeDelegationId && item.activeDelegationId !== input.delegationId) throw new Error(`WorkItem ${item.id} 已有活动 Delegation ${item.activeDelegationId}，写入必须串行`);
				if (!["ready", "revision", "in_progress", "waiting_admission", "waiting_input"].includes(item.status)) throw new Error(`WorkItem ${item.id} 当前不能开始委托`);
				if (item.verificationPolicy.frozenAtRevision === undefined) item.verificationPolicy.frozenAtRevision = item.revision;
				item.status = "in_progress"; item.activeDelegationId = input.delegationId;
			} else if (input.delegationStatus === "waiting_input" || input.delegationStatus === "waiting_admission") {
				if (item.activeDelegationId && item.activeDelegationId !== input.delegationId) throw new Error(`WorkItem ${item.id} 的 ${input.delegationStatus} 不属于当前活动 Delegation`);
				item.status = input.delegationStatus; item.activeDelegationId = input.delegationId;
			} else {
				// A replacement may already own the active slot when the original
				// admission's cancelled boundary is replayed. Keep the late terminal as
				// audit only; it must never clear or regress the newer Delegation.
				const delegationIndex = item.delegationIds.indexOf(input.delegationId);
				const hasNewerDelegation = delegationIndex >= 0 && delegationIndex < item.delegationIds.length - 1;
				const superseded = hasNewerDelegation || Boolean(item.activeDelegationId && item.activeDelegationId !== input.delegationId);
				if (!superseded) delete item.activeDelegationId;
				if (input.delegationStatus === "completed" && !superseded) {
					if (!item.submissions.some((entry) => entry.delegationId === input.delegationId)) {
						const receipt = input.executionReceipt;
						if (!receipt) throw new Error("completed Delegation 必须提供 sealed ExecutionReceipt");
						if (!receipt.sealedAt || !receipt.id || receipt.delegationId !== input.delegationId || receipt.reportedOutcome !== "completed") throw new Error("ExecutionReceipt 必须已封存且匹配 completed Delegation");
						if (receipt.goalId !== undefined && receipt.goalId !== state.goalId) throw new Error("ExecutionReceipt goalId 不匹配");
						if (receipt.workItemId !== undefined && receipt.workItemId !== item.id) throw new Error("ExecutionReceipt workItemId 不匹配");
						const contractHash = workItemContractHash(state, plan, item);
						if (receipt.taskContractHash !== contractHash) throw new Error("ExecutionReceipt taskContractHash 不匹配当前 WorkItem 契约");
						item.submissions.push({
							id: randomUUID(), attempt: item.delegationIds.indexOf(input.delegationId) + 1,
							source: "delegation", delegationId: input.delegationId, resultRef: { kind: "delegation_result", delegationId: input.delegationId },
							artifactIds: strings(input.artifactIds ?? [], "artifactIds"),
							executionReceiptId: receipt.id,
							executionReceipt: copy(receipt),
							...(input.workspaceChangeSet ? { workspaceChangeSetId: input.workspaceChangeSet.id, workspaceChangeSet: copy(input.workspaceChangeSet) } : receipt.workspaceChangeSetId ? { workspaceChangeSetId: receipt.workspaceChangeSetId } : {}),
							goalRevision: state.goalRevision, workItemRevision: item.revision,
							inputFingerprint: receipt.inputFingerprint ?? hash({ receiptId: receipt.id, contractHash: receipt.contractHash, artifactCapture: receipt.artifactCapture, workspaceChangeSetId: receipt.workspaceChangeSetId }),
							verifications: [],
							...(input.summary?.trim() ? { summary: input.summary.trim() } : {}), submittedAt: timestamp,
						});
					}
					item.status = "submitted";
				} else if (!superseded && !["accepted", "cancelled"].includes(item.status)) item.status = "revision";
			}
			// WorkItem.revision is the frozen execution/acceptance contract revision.
			// Runtime lifecycle changes advance the plan and state revisions, but must
			// not invalidate the contract hash captured before delegation starts.
			item.updatedAt = timestamp; plan.revision += 1; plan.updatedAt = timestamp; deriveReady(plan);
			const waiting = Object.values(plan.items).some((entry) => entry.status === "waiting_input" || entry.status === "waiting_admission");
			const active = Object.values(plan.items).some((entry) => ["in_progress", "waiting_admission", "waiting_input"].includes(entry.status));
			const next: SessionWorkState = { ...state, plan, execution: { ...state.execution, status: waiting ? "waiting_human" : active ? "running" : "idle" }, revision: state.revision + 1, updatedAt: timestamp };
			data.states[state.goalId] = next;
			this.event(data, { id: `work-item-boundary:${state.goalId}:${input.delegationId}:${input.delegationStatus}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "delegation_boundary", workPlanId: plan.id, workItemId: item.id, status: item.status, revision: next.revision } });
			this.commit(data, sessionId, operationId, input.goalEpoch, "delegation_boundary", input, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async advanceManagerWorkItem(
		sessionId: string, workItemId: string, expectedRevision: number,
		input: { status: "in_progress" | "submitted"; summary?: string; evidenceRefs?: string[] },
		operationId: string, expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { expectedGoalId, workItemId, expectedRevision, input, expectedEpoch };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state?.plan) throw new Error("WorkPlan 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "advance_manager_work_item", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			const plan = copy(state.plan);
			const item = plan.items[workItemId];
			if (!item) throw new Error("WorkItem 不存在");
			if (item.assignedAgentId !== state.responsibleAgentId) throw new Error(`WorkItem ${workItemId} 不是 Manager 自己的工作项`);
			if (item.workspaceExecutionPolicy.mode !== "read_only_shared") throw new Error(`WorkItem ${workItemId} 需要写入或副作用，必须走 Worker Delegation`);
			if (item.activeDelegationId) throw new Error(`WorkItem ${workItemId} 已有活动 Delegation，不能按 Manager 工作项推进`);
			const timestamp = now();
			if (input.status === "in_progress") {
				if (!["ready", "revision", "in_progress"].includes(item.status)) throw new Error(`WorkItem ${workItemId} 当前状态 ${item.status}，不能开始`);
				if (item.verificationPolicy.frozenAtRevision === undefined) item.verificationPolicy.frozenAtRevision = item.revision;
				item.status = "in_progress";
			} else {
				if (!["ready", "revision", "in_progress"].includes(item.status)) throw new Error(`WorkItem ${workItemId} 当前状态 ${item.status}，不能提交`);
				const summary = requiredText(input.summary, "summary");
				const evidenceRefs = strings(input.evidenceRefs ?? [], "evidenceRefs");
				item.submissions.push({
					id: randomUUID(), attempt: item.submissions.length + 1, source: "manager",
					resultRef: { kind: "manager_summary", evidenceRefs }, artifactIds: [], summary, submittedAt: timestamp,
					goalRevision: state.goalRevision, workItemRevision: item.revision, inputFingerprint: hash({ goalId: state.goalId, workPlanId: plan.id, workItemId: item.id, revision: item.revision, summary, evidenceRefs }), verifications: [],
				});
				item.status = "submitted";
			}
			// Starting/submitting manager work is lifecycle state, not a contract edit.
			item.updatedAt = timestamp; plan.revision += 1; plan.updatedAt = timestamp; deriveReady(plan);
			const active = Object.values(plan.items).some((entry) => entry.status === "in_progress");
			const next: SessionWorkState = { ...state, plan, execution: { ...state.execution, status: active ? "running" : "idle" }, revision: state.revision + 1, updatedAt: timestamp };
			data.states[state.goalId] = next;
			this.event(data, { id: `manager-work-item:${state.goalId}:${workItemId}:${item.revision}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "manager_work_item", workPlanId: plan.id, workItemId, status: item.status, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "advance_manager_work_item", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	private assertSubmissionCanAccept(state: SessionWorkState, plan: GoalWorkPlan, item: WorkItem, submission: WorkItemSubmission, ignorePromotion = false): void {
		if (submission.goalRevision !== state.goalRevision || submission.workItemRevision > item.revision) throw new Error("Submission revision 已过期，不能验收");
		if (submission.source === "delegation") {
			const receipt = submission.executionReceipt;
			if (!receipt || !submission.executionReceiptId || receipt.id !== submission.executionReceiptId || !receipt.sealedAt) throw new Error("Submission 缺少 sealed ExecutionReceipt");
			if (receipt.delegationId !== submission.delegationId || receipt.goalId !== state.goalId || receipt.workItemId !== item.id || receipt.goalRevision !== undefined && receipt.goalRevision !== state.goalRevision || receipt.workItemRevision !== undefined && receipt.workItemRevision !== submission.workItemRevision || receipt.reportedOutcome !== "completed") throw new Error("ExecutionReceipt 与当前 Submission/契约不匹配");
			if (!receipt.taskContractHash || receipt.taskContractHash !== workItemContractHash(state, plan, { ...item, revision: submission.workItemRevision })) throw new Error("ExecutionReceipt taskContractHash 不匹配当前 WorkItem 契约");
			if (receipt.integrity === "violation") throw new Error("ExecutionReceipt integrity violation，不能验收");
			for (const criterion of item.acceptanceCriteria) {
				const result = receipt.requirementResults.find((entry) => entry.requirement === criterion);
				if (!result || result.status !== "provided" || !result.evidenceRefs.length) throw new Error(`缺少验收条件证据：${criterion}`);
			}
		} else if (item.workspaceExecutionPolicy.mode !== "read_only_shared") {
			throw new Error("Manager Submission 只能来自 read_only_shared WorkItem");
		}
		const mode = item.verificationPolicy.mode;
		if (verificationRank[mode] > verificationRank.manager_review) {
			const verification = [...submission.verifications].reverse().find((entry) => entry.status === "passed");
			if (!verification || verification.mode !== mode || verification.integrity !== "clean" || verification.goalId !== state.goalId || verification.goalRevision !== state.goalRevision || verification.workItemId !== item.id || verification.workItemRevision !== submission.workItemRevision || verification.goalEpoch !== state.execution.epoch || verification.inputFingerprint !== submission.inputFingerprint) throw new Error(`当前 WorkItem 需要匹配的 ${mode} VerificationRecord`);
			const expected = item.acceptanceCriteria;
			if (verification.criteria.length !== expected.length || verification.criteria.some((criterion, index) => criterion.criterion !== expected[index] || criterion.status !== "satisfied" || !criterion.evidenceRefs.length)) throw new Error("VerificationRecord 未逐项覆盖全部验收条件");
		}
		// The runtime may safely strengthen an unenforceable read-only request to
		// isolated_worktree. Settlement follows the observed change-set, not only
		// the requested policy, so that no isolated changes can bypass promotion.
		const isolatedChangeSet = submission.workspaceChangeSet?.mode === "isolated_worktree";
		if (!ignorePromotion && ((item.workspaceExecutionPolicy.mode === "isolated_worktree" && item.workspaceExecutionPolicy.promoteOnAcceptance) || isolatedChangeSet)) {
			if (!submission.acceptanceIntent) throw new Error("isolated_worktree 提升前缺少 Manager accepted 意图记录");
			if (!submission.workspaceChangeSet || submission.workspaceChangeSetId !== submission.workspaceChangeSet.id || submission.workspaceChangeSet.promotionState !== "applied") throw new Error("isolated_worktree 的 change-set 尚未成功提升");
		}
	}
	async recordAcceptanceIntent(
		sessionId: string, workItemId: string, expectedRevision: number,
		input: { summary: string; evidenceRefs?: string[] }, operationId: string,
		expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { workItemId, expectedRevision, input, expectedEpoch, expectedGoalId };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state?.plan) throw new Error("WorkPlan 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "acceptance_intent", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			const next = copy(state);
			const item = next.plan!.items[workItemId];
			if (!item || item.status !== "submitted") throw new Error("只有 submitted WorkItem 可以请求 accepted");
			const submission = [...item.submissions].reverse().find((entry) => !entry.review);
			if (!submission) throw new Error("没有待验收 Submission");
			this.assertSubmissionCanAccept(state, state.plan, state.plan.items[workItemId]!, submission, true);
			if (submission.acceptanceIntent) throw new Error("当前 Submission 已冻结 Manager accepted 意图，不允许覆盖");
			const timestamp = now();
			submission.acceptanceIntent = { verdict: "accepted", summary: requiredText(input.summary, "summary"), evidenceRefs: strings(input.evidenceRefs ?? [], "evidenceRefs"), requestedAt: timestamp };
			item.updatedAt = timestamp; next.plan!.revision += 1; next.plan!.updatedAt = timestamp; next.revision += 1; next.updatedAt = timestamp;
			data.states[state.goalId] = next;
			this.event(data, { id: `acceptance-intent:${state.goalId}:${submission.id}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "acceptance_intent", workItemId, submissionId: submission.id, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "acceptance_intent", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	private assertGoalVerificationForCompletion(state: SessionWorkState): void {
		const mode = state.verificationPolicy.finalGoalMode;
		if (mode === "manager_review") return;
		const record = [...state.goalVerifications].reverse().find((entry) => entry.mode === mode && entry.status === "passed");
		if (!record || record.goalRevision !== state.goalRevision || record.goalEpoch !== state.execution.epoch || record.integrity !== "clean") throw new Error(`Goal 完成需要当前 revision/epoch 的 ${mode} VerificationRecord`);
		const expected = goalCriterionRefs(state).map((entry) => entry.text);
		if (record.criteria.length !== expected.length || record.criteria.some((entry, index) => entry.criterion !== expected[index] || entry.status !== "satisfied" || !entry.evidenceRefs.length)) throw new Error("Goal VerificationRecord 未逐项覆盖全部完成条件");
	}
	async recordVerification(
		sessionId: string, expectedRevision: number, record: VerificationRecord, operationId: string = `verification:${record.id}`,
		expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { expectedGoalId, expectedRevision, expectedEpoch, record };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state) throw new Error("Session Goal 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "record_verification", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			if (record.goalId !== state.goalId || record.goalRevision !== state.goalRevision || record.goalEpoch !== state.execution.epoch) throw new Error("VerificationRecord 不属于当前 Goal revision/epoch");
			validVerificationMode(record.mode, "verification.mode");
			if (record.status === "passed") {
				if (record.integrity !== "clean") throw new Error("passed VerificationRecord 必须 integrity=clean");
				if (record.criteria.some((criterion) => criterion.status !== "satisfied" || !criterion.evidenceRefs.length)) throw new Error("passed VerificationRecord 必须逐项满足并引用证据");
			}
			const next = copy(state);
			if (record.workItemId) {
				if (!next.plan || record.workPlanId !== next.plan.id) throw new Error("VerificationRecord workPlanId 不匹配");
				const item = next.plan.items[record.workItemId];
				if (!item) throw new Error("VerificationRecord WorkItem 不存在");
				if (!record.submissionId) throw new Error("WorkItem VerificationRecord 必须绑定 Submission");
				const submission = item.submissions.find((entry) => entry.id === record.submissionId);
				if (!submission || submission.goalRevision !== record.goalRevision || submission.workItemRevision !== record.workItemRevision) throw new Error("VerificationRecord Submission/revision 不匹配");
				if (record.inputFingerprint !== submission.inputFingerprint) throw new Error("VerificationRecord inputFingerprint 不匹配 Submission");
				item.submissions = item.submissions.map((entry) => entry.id === record.submissionId ? { ...entry, verifications: [...entry.verifications.filter((old) => old.id !== record.id), copy(record)] } : entry);
				next.plan.updatedAt = now(); next.plan.revision += 1; item.updatedAt = now();
			} else {
				next.goalVerifications = [...next.goalVerifications.filter((old) => old.id !== record.id), copy(record)];
			}
			next.revision += 1; next.updatedAt = now();
			data.states[state.goalId] = next;
			this.event(data, { id: `verification:${state.goalId}:${record.id}:${next.revision}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "verification_recorded", verificationId: record.id, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "record_verification", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async recordWorkspaceChangeSet(
		sessionId: string,
		workItemId: string,
		expectedRevision: number,
		changeSet: WorkspaceChangeSet,
		operationId: string,
		expectedEpoch?: number,
		expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { workItemId, expectedRevision, changeSet, expectedEpoch, expectedGoalId };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state?.plan) throw new Error("WorkPlan 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "workspace_promotion", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			const next = copy(state);
			const item = next.plan!.items[workItemId];
			if (!item || item.status !== "submitted") throw new Error("只有 submitted WorkItem 可以结算 change-set");
			const submission = [...item.submissions].reverse().find((entry) => !entry.review);
			if (!submission?.workspaceChangeSetId || submission.workspaceChangeSetId !== changeSet.id || changeSet.executionScopeId !== submission.executionReceipt?.workspaceExecutionScopeId) throw new Error("WorkspaceChangeSet 与当前 Submission/Receipt 不匹配");
			submission.workspaceChangeSet = copy(changeSet);
			item.updatedAt = now(); next.plan!.updatedAt = item.updatedAt; next.plan!.revision += 1; next.revision += 1; next.updatedAt = item.updatedAt;
			data.states[state.goalId] = next;
			this.event(data, { id: `workspace-promotion:${state.goalId}:${changeSet.id}:${changeSet.promotionState}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "workspace_promotion", workItemId, changeSetId: changeSet.id, promotionState: changeSet.promotionState, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "workspace_promotion", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async reviewWorkItem(
		sessionId: string, workItemId: string, expectedRevision: number,
		input: { verdict: "accepted" | "revision" | "blocked"; summary: string; evidenceRefs?: string[] },
		operationId: string, expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { expectedGoalId, workItemId, expectedRevision, input, expectedEpoch };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state?.plan) throw new Error("WorkPlan 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "review_work_item", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			const plan = copy(state.plan);
			const item = plan.items[workItemId];
			if (!item || item.status !== "submitted") throw new Error("只有 submitted WorkItem 可以验收");
			const submission = [...item.submissions].reverse().find((entry) => !entry.review);
			if (!submission) throw new Error("没有待验收 Submission");
			if (input.verdict === "accepted") this.assertSubmissionCanAccept(state, plan, item, submission);
			const timestamp = now();
			submission.review = { verdict: input.verdict, summary: requiredText(input.summary, "summary"), evidenceRefs: strings(input.evidenceRefs ?? [], "evidenceRefs"), reviewedAt: timestamp };
			item.status = input.verdict;
			input.verdict === "accepted" ? item.acceptedSubmissionId = submission.id : delete item.acceptedSubmissionId;
			item.revision += 1; item.updatedAt = timestamp; plan.revision += 1; plan.updatedAt = timestamp; deriveReady(plan);
			const next = { ...state, plan, revision: state.revision + 1, updatedAt: timestamp };
			data.states[state.goalId] = next;
			this.event(data, { id: `work-item-review:${state.goalId}:${submission.id}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "work_item_reviewed", workPlanId: plan.id, workItemId: item.id, status: item.status, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "review_work_item", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async applyCompletionReview(
		sessionId: string, expectedRevision: number,
		input: { currentBrief: string; artifactIds?: string[]; review: CompletionReview },
		operationId: string = `review:${sessionId}:${input.review.goalRevision}:${input.review.id}`, expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { expectedGoalId, expectedRevision, input, expectedEpoch };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state) throw new Error("Session Goal 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "completion_review", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			if (state.reviewMode !== "independent" || input.review.goalRevision !== state.goalRevision) throw new Error("reviewer 判定不属于当前 Goal");
			this.assertGoalVerificationForCompletion(state);
			if (state.plan && (state.plan.needsReconcile || state.plan.coveredGoalRevision !== state.goalRevision || Object.values(state.plan.items).some((item) => !["accepted", "cancelled"].includes(item.status)))) throw new Error("WorkPlan 未覆盖当前 Goal 或仍有未验收项");
			if (Object.values(data.decisions).some((item) => item.goalId === state.goalId && item.status === "pending")) throw new Error("仍有待回答的人类决策");
			const satisfied = input.review.verdict === "satisfied";
			const next: SessionWorkState = {
				...state, currentBrief: requiredText(input.currentBrief, "currentBrief"),
				completionReviews: state.completionReviews.some((item) => item.id === input.review.id) ? state.completionReviews : [...state.completionReviews, input.review],
				status: satisfied ? "resolved" : "active",
				execution: { ...state.execution, status: satisfied ? "idle" : input.review.verdict === "needs_human" ? "waiting_human" : "idle" },
				...(input.artifactIds === undefined ? {} : { artifactIds: strings(input.artifactIds, "artifactIds") }),
				revision: state.revision + 1, updatedAt: now(),
			};
			if (satisfied) { delete next.waitingOn; delete next.nextAction }
			else next.nextAction = input.review.verdict === "needs_human" ? "根据复核结果请求人类确认" : input.review.gaps.join("；") || "补齐未满足条件";
			if (satisfied) this.cancelPendingDecisions(data, state.goalId, next.updatedAt);
			data.states[state.goalId] = next;
			this.event(data, { id: `completion-review:${state.goalId}:${input.review.id}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "completion_reviewed", verdict: input.review.verdict, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "completion_review", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async applyManagerCompletion(
		sessionId: string, expectedRevision: number,
		input: { currentBrief: string; artifactIds?: string[]; criteria: CompletionReviewCriterion[] },
		operationId: string, expectedEpoch?: number, expectedGoalId?: string,
	): Promise<SessionWorkState> {
		const payload = { expectedGoalId, expectedRevision, input, expectedEpoch };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state) throw new Error("Session Goal 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "manager_completion", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, expectedEpoch, goalId);
			if (state.reviewMode !== "manager") throw new Error("当前 Goal 必须通过独立 reviewer 完成复核");
			this.assertGoalVerificationForCompletion(state);
			if (state.plan && (state.plan.needsReconcile || state.plan.coveredGoalRevision !== state.goalRevision || Object.values(state.plan.items).some((item) => !["accepted", "cancelled"].includes(item.status)))) throw new Error("WorkPlan 未覆盖当前 Goal 或仍有未验收项");
			if (Object.values(data.decisions).some((item) => item.goalId === state.goalId && item.status === "pending")) throw new Error("仍有待回答的人类决策");
			const expected = goalCriterionRefs(state).map((item) => item.text);
			if (input.criteria.length !== expected.length) throw new Error(`必须逐项复核全部 ${expected.length} 条 Goal 完成条件`);
			const criteria = input.criteria.map((criterion, index) => {
				if (requiredText(criterion.criterion, `criteria[${index}].criterion`) !== expected[index]) throw new Error(`第 ${index + 1} 条复核条件必须与冻结 Goal 条件一致`);
				if (criterion.status !== "satisfied") throw new Error(`第 ${index + 1} 条 Goal 完成条件尚未满足，不能完成 Goal`);
				const evidenceRefs = strings(criterion.evidenceRefs, `criteria[${index}].evidenceRefs`);
				if (!evidenceRefs.length) throw new Error(`第 ${index + 1} 条 Goal 完成条件必须引用至少一条证据`);
				return {
					criterion: expected[index]!, status: "satisfied" as const,
					evidenceRefs,
					explanation: requiredText(criterion.explanation, `criteria[${index}].explanation`),
				};
			});
			const timestamp = now();
			const review: CompletionReview = {
				id: randomUUID(), goalRevision: state.goalRevision, mode: "manager", verdict: "satisfied",
				criteria, gaps: [], reviewerSessionId: sessionId, reviewedAt: timestamp,
			};
			const next: SessionWorkState = {
				...state, currentBrief: requiredText(input.currentBrief, "currentBrief"),
				completionReviews: [...state.completionReviews, review], status: "resolved",
				execution: { ...state.execution, status: "idle" },
				...(input.artifactIds === undefined ? {} : { artifactIds: strings(input.artifactIds, "artifactIds") }),
				revision: state.revision + 1, updatedAt: timestamp,
			};
			delete next.waitingOn; delete next.nextAction;
			this.cancelPendingDecisions(data, state.goalId, timestamp);
			data.states[state.goalId] = next;
			this.event(data, { id: `manager-completion:${state.goalId}:${review.id}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_changed", payload: { action: "completion_reviewed", verdict: review.verdict, revision: next.revision } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "manager_completion", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async interruptGoal(sessionId: string, expectedRevision: number, input: { kind: GoalInterruption["kind"]; fingerprint: string; delegationIds: string[] }, operationId: string, expectedGoalId?: string): Promise<SessionWorkState> {
		const payload = { expectedGoalId, expectedRevision, input };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state) throw new Error("Session Goal 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "interrupt_goal", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, undefined, goalId);
			if (state.execution.interruption?.fingerprint === input.fingerprint) return copy(state);
			const epoch = state.execution.epoch + 1;
			const interruption: GoalInterruption = { id: randomUUID(), kind: input.kind, fingerprint: requiredText(input.fingerprint, "fingerprint"), delegationIds: strings(input.delegationIds, "delegationIds"), interruptedAt: now() };
			const next: SessionWorkState = { ...state, execution: { epoch, status: "interrupted", interruption }, revision: state.revision + 1, updatedAt: now() };
			data.states[state.goalId] = next;
			this.event(data, { id: `goal-interrupted:${state.goalId}:${epoch}`, goalId: state.goalId, sessionId, epoch, kind: "goal_interrupted", payload: { interruption } });
			this.commit(data, sessionId, operationId, epoch, "interrupt_goal", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async resumeGoal(sessionId: string, expectedRevision: number, input: { ownerId: string; leaseMs?: number }, operationId: string, expectedGoalId?: string): Promise<SessionWorkState> {
		const payload = { expectedGoalId, expectedRevision, input };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, sessionId);
			if (!state) throw new Error("Session Goal 不存在");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<SessionWorkState>(data, sessionId, operationId, "resume_goal", payload, goalId);
			if (replay) return replay;
			this.current(state, expectedRevision, undefined, goalId);
			if (!["interrupted", "recovering"].includes(state.execution.status)) throw new Error("只有 interrupted Goal 可以恢复");
			const timestamp = Date.now();
			const existing = state.execution.resumeLease;
			if (existing && new Date(existing.expiresAt).getTime() > timestamp) throw new WorkStateOperationConflictError("Goal 已有有效恢复 lease；相同请求必须重放原 operationId", "stale_goal_state");
			const leaseMs = Math.max(5_000, Math.min(input.leaseMs ?? 30_000, 300_000));
			const lease = { ownerId: requiredText(input.ownerId, "ownerId"), token: randomUUID(), expiresAt: new Date(timestamp + leaseMs).toISOString() };
			const next: SessionWorkState = { ...state, execution: { ...state.execution, status: "recovering", resumeLease: lease }, revision: state.revision + 1, updatedAt: now() };
			data.states[state.goalId] = next;
			this.event(data, { id: `goal-recovery:${state.goalId}:${next.execution.epoch}`, goalId: state.goalId, sessionId, epoch: next.execution.epoch, kind: "goal_recovery", payload: { lease, interruption: next.execution.interruption } });
			this.commit(data, sessionId, operationId, next.execution.epoch, "resume_goal", payload, next, next.revision, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async reconcileDelegations(delegations: Array<{
		id: string; managerSessionId: string; goalId?: string; workItemId?: string; goalEpoch?: number;
		executionState: "admitted" | "waiting_admission" | "running" | "waiting_input" | "reported_completed" | "reported_failed" | "cancel_requested" | "reconciling" | "cancelled" | "observation_lost"; revision: number; updatedAt: string;
		receipt?: ExecutionReceipt;
		result?: unknown;
	}>): Promise<{ projected: number; interrupted: number }> {
		let projected = 0;
		for (const item of delegations) {
			if (item.goalId && item.workItemId && item.goalEpoch !== undefined && (item.executionState === "waiting_admission" || item.executionState === "waiting_input" || item.executionState === "running" || item.executionState === "reconciling")) {
				const state = await this.getGoal(item.managerSessionId, item.goalId);
				if (state?.plan?.items[item.workItemId] && state.execution.epoch === item.goalEpoch) {
					try {
						await this.noteDelegation(item.managerSessionId, { goalId: item.goalId, workItemId: item.workItemId, delegationId: item.id, delegationStatus: item.executionState === "waiting_admission" ? "waiting_admission" : item.executionState === "waiting_input" ? "waiting_input" : "running", goalEpoch: item.goalEpoch }, `reconcile-delegation-active:${item.id}:${item.revision}`);
						projected++;
					} catch (error) { if (!(error instanceof WorkStateOperationConflictError)) throw error }
				}
			}
			if (!item.goalId || !item.workItemId || item.goalEpoch === undefined || !["reported_completed", "reported_failed", "cancelled"].includes(item.executionState)) continue;
			const state = await this.getGoal(item.managerSessionId, item.goalId);
			if (!state?.plan?.items[item.workItemId] || state.execution.epoch !== item.goalEpoch) continue;
			const delegationStatus = item.executionState === "reported_completed" ? "completed" : item.executionState === "cancelled" ? "cancelled" : "failed";
			try {
				await this.noteDelegation(item.managerSessionId, {
					goalId: item.goalId, workItemId: item.workItemId, delegationId: item.id, delegationStatus, goalEpoch: item.goalEpoch,
					artifactIds: [], submittedAt: item.updatedAt, executionReceipt: item.receipt,
				}, `reconcile-delegation-boundary:${item.id}:${item.revision}`);
				projected++;
			} catch (error) { if (!(error instanceof WorkStateOperationConflictError)) throw error }
		}
		let interrupted = 0;
		const sessions = new Map<string, typeof delegations>();
		for (const item of delegations) {
			if (!item.result || typeof item.result !== "object" || (item.result as { errorCode?: unknown }).errorCode !== "server_restart" || item.goalEpoch === undefined) continue;
			const list = sessions.get(item.managerSessionId) ?? [];
			list.push(item); sessions.set(item.managerSessionId, list);
		}
		for (const [sessionId, items] of sessions) {
			const state = await this.getActive(sessionId);
			if (!state) continue;
			const ids = items.filter((item) => item.goalId === state.goalId && item.goalEpoch === state.execution.epoch).map((item) => item.id).sort();
			if (!ids.length) continue;
			const fingerprint = `server_restart:${hash(ids)}`;
			await this.interruptGoal(sessionId, state.revision, { kind: "server_restart", fingerprint, delegationIds: ids }, `reconcile:${fingerprint}`, state.goalId);
			interrupted++;
		}
		for (const item of delegations) {
			if (item.executionState !== "observation_lost" || item.goalEpoch === undefined) continue;
			const state = await this.getActive(item.managerSessionId);
			if (!state || item.goalId !== state.goalId || state.execution.epoch !== item.goalEpoch || state.execution.status === "interrupted") continue;
			await this.interruptGoal(
				item.managerSessionId,
				state.revision,
				{ kind: "effect_unknown", fingerprint: "effect_unknown:" + item.id + ":" + item.revision, delegationIds: [item.id] },
				"effect-unknown:" + item.id + ":" + item.revision,
				state.goalId,
			);
			interrupted++;
		}
		return { projected, interrupted };
	}
	async removeSession(sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.load();
			for (const [goalId, state] of Object.entries(data.states)) if (state.sessionId === sessionId) delete data.states[goalId];
			for (const [id, item] of Object.entries(data.decisions)) if (item.sessionId === sessionId) delete data.decisions[id];
			for (const [id, item] of Object.entries(data.operations)) if (item.sessionId === sessionId) delete data.operations[id];
			for (const [id, item] of Object.entries(data.outbox)) if (item.sessionId === sessionId) delete data.outbox[id];
			await this.write(data);
		});
	}
	async createDecision(input: Omit<DecisionRequest, "id" | "goalId" | "status" | "createdAt" | "updatedAt">, operationId: string = randomUUID(), expectedRevision?: number, expectedGoalId?: string): Promise<DecisionRequest> {
		const payload = { input, expectedRevision, expectedGoalId };
		return this.serialize(async () => {
			const data = await this.load();
			const state = this.active(data, input.sessionId);
			if (!state) throw new Error("DecisionRequest 必须属于有 Goal 的 Session");
			const goalId = expectedGoalId ?? state.goalId;
			const replay = this.replay<DecisionRequest>(data, input.sessionId, operationId, "create_decision", payload, goalId);
			if (replay) return replay;
			if (expectedRevision !== undefined) this.current(state, expectedRevision, undefined, goalId);
			else if (state.goalId !== goalId) throw new WorkStateOperationConflictError("当前 Goal 已变化，请重新读取目标状态", "stale_goal_state");
			const timestamp = now();
			const decision: DecisionRequest = {
				...input, goalId: state.goalId, question: requiredText(input.question, "question"), context: optionalText(input.context, "context") ?? "",
				blockedAction: requiredText(input.blockedAction, "blockedAction"), resumeHint: requiredText(input.resumeHint, "resumeHint"),
				id: randomUUID(), status: "pending", createdAt: timestamp, updatedAt: timestamp,
			};
			data.decisions[decision.id] = decision;
			const next = { ...state, waitingOn: decision.question, nextAction: decision.resumeHint, execution: { ...state.execution, status: "waiting_human" as const }, revision: state.revision + 1, updatedAt: timestamp };
			data.states[state.goalId] = next;
			this.commit(data, input.sessionId, operationId, state.execution.epoch, "create_decision", payload, decision, next.revision, state.goalId);
			await this.write(data);
			return copy(decision);
		});
	}
	async listDecisions(sessionId: string, goalId?: string): Promise<DecisionRequest[]> {
		const data = await this.load();
		const selectedGoalId = goalId ?? this.active(data, sessionId)?.goalId;
		if (!selectedGoalId) return [];
		return Object.values(data.decisions).filter((item) => item.sessionId === sessionId && item.goalId === selectedGoalId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(copy);
	}
	async getDecision(id: string): Promise<DecisionRequest | undefined> {
		const decision = (await this.load()).decisions[id];
		return decision ? copy(decision) : undefined;
	}
	async answerDecision(id: string, answer: string, grantedAuthorizationScope?: string, operationId: string = randomUUID()): Promise<DecisionRequest> {
		return this.serialize(async () => {
			const data = await this.load();
			const decision = data.decisions[id];
			if (!decision) throw new Error("DecisionRequest 不存在");
			const payload = { id, answer: requiredText(answer, "answer"), grantedAuthorizationScope };
			const replay = this.replay<DecisionRequest>(data, decision.sessionId, operationId, "answer_decision", payload, decision.goalId);
			if (replay) return replay;
			if (decision.status !== "pending") throw new Error("DecisionRequest 已处理");
			const timestamp = now();
			const next: DecisionRequest = { ...decision, status: "answered", answer: payload.answer, ...(grantedAuthorizationScope?.trim() ? { grantedAuthorizationScope: grantedAuthorizationScope.trim() } : {}), updatedAt: timestamp };
			data.decisions[id] = next;
			const state = this.byGoalId(data, decision.sessionId, decision.goalId);
			if (!state || state.status !== "active") throw new WorkStateOperationConflictError("历史 Goal 的决策不能再回答", "stale_goal_state");
			if (state) {
				const pending = Object.values(data.decisions).some((item) => item.goalId === decision.goalId && item.status === "pending");
				data.states[state.goalId] = { ...state, waitingOn: pending ? state.waitingOn : undefined, nextAction: decision.resumeHint, execution: { ...state.execution, status: pending ? "waiting_human" : "running" }, revision: state.revision + 1, updatedAt: timestamp };
				this.event(data, { id: `decision-answered:${decision.goalId}:${id}`, goalId: decision.goalId, sessionId: decision.sessionId, epoch: state.execution.epoch, kind: "decision_answered", payload: { decision: next } });
			}
			this.commit(data, decision.sessionId, operationId, state.execution.epoch, "answer_decision", payload, next, state.revision + 1, state.goalId);
			await this.write(data);
			return copy(next);
		});
	}
	async pendingOutbox(): Promise<GoalOutboxEvent[]> {
		return Object.values((await this.load()).outbox).filter((item) => item.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(copy);
	}
	async markOutboxDelivered(eventId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.load();
			const event = data.outbox[eventId];
			if (!event || event.status === "delivered") return;
			data.outbox[eventId] = { ...event, status: "delivered", deliveredAt: now() };
			await this.write(data);
		});
	}
}
