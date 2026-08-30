/**
 * PWCP（Pudding Worker Coordination Protocol）核心类型。
 *
 * 参考 docs/2026-08-06-通用-agent-接入-底层与扩展方案.md §1、§4：
 * - run：创建新 Session 并启动第一条 Run；
 * - continue：在已有 Session 中创建下一条 Run；
 * - respond：给当前仍在等待输入的同一条 Run 提交审批或回答；
 * - cancel：取消当前 Run，不删除 Session。
 *
 * 统一的是语义，不是命令名。Driver 是唯一理解 Agent 私有协议的层。
 */

/** 四种统一操作语义。 */
export type AgentOperation = "run" | "continue" | "respond" | "cancel";

export interface RunInput {
	message: string;
	/** 幂等键：同一 requestId 重复提交不重复执行。 */
	requestId: string;
	options?: Record<string, unknown>;
}

export interface ContinueInput extends RunInput {
	/** 不透明 Session handle，Driver 负责生成与消费。 */
	sessionHandle: string;
}

export interface RespondInput {
	/** 恢复的原 Run handle。 */
	runHandle: string;
	/** 仅 Runtime/Driver 可见的交互句柄（可能含 bearer token）。 */
	interactionHandle: string;
	/** 本次提交的幂等键。 */
	requestId: string;
	responses: InteractionResponse[];
}

export interface InteractionResponse {
	requestId: string;
	action: "approve" | "reject" | "answer" | "confirm";
	/** permission 类是授权范围（once/run/session）；question 类是用户所选
	 * 选项的原文（如分析模型名）——question options 复用此字段回传。 */
	scope?: string;
	value?: unknown;
	message?: string;
}

export interface InteractionRequest {
	requestId: string;
	prompt: string;
	permissionType?: string;
	toolName?: string;
	command?: string;
	path?: string;
	paths?: string[];
	risk?: string;
	reason?: string;
	/** permission 类是授权范围选项（once/run/session/reject）；question 类是
	 * 答案选项原文清单（如可选分析模型），用户选择经 InteractionResponse.scope 回传。 */
	options?: string[];
}

export interface ArtifactRef {
	name: string;
	/** workspace 内相对路径。 */
	path: string;
	kind?: string;
	size?: number;
	/** agent 主动导出 / Driver 观察收集。 */
	origin: "push" | "observe";
}

/** Worker/Driver 对某一条冻结证据要求的上游报告；平台仍需校验引用存在性和归属。 */
export interface ReportedEvidence {
	requirement: string;
	evidenceRefs: string[];
}

export interface ResultBase {
	agentId: string;
	sessionHandle?: string;
	runHandle?: string;
	content?: string;
	artifacts?: ArtifactRef[];
	/** 上游报告的证据映射，不代表已经独立验证。 */
	reportedEvidence?: ReportedEvidence[];
	usage?: {
		turns?: number;
		inputTokens?: number;
		outputTokens?: number;
		cost?: number;
	};
	meta?: Record<string, unknown>;
}

export interface CompletedResult extends ResultBase {
	status: "completed";
}

export interface NeedsInputResult extends ResultBase {
	status: "needs_input";
	interaction: {
		/** PuddingTeams 本地公开 id（浏览器只拿这个）。 */
		id: string;
		kind: "permission" | "question" | "confirmation";
		requests: InteractionRequest[];
		expiresAt?: string;
	};
}

export interface FailedResult extends ResultBase {
	status: "failed" | "blocked" | "cancelled";
	errorCode: string;
	error: string;
	recoverable: boolean;
}

export type NormalizedResult = CompletedResult | NeedsInputResult | FailedResult;

/** Connector-neutral immutable payload sealed by the host Runtime after a terminal boundary. */
export interface ExecutionReceiptPayload {
	schemaVersion: 1;
	operationId: string;
	reportedOutcome: "completed" | "failed" | "blocked" | "cancelled";
	upstream: {
		sessionHandle?: string;
		runHandle?: string;
	};
	reportedEvidence: ReportedEvidence[];
	reportedArtifacts: ArtifactRef[];
	startedAt: string;
	observedAt: string;
	observer: {
		connectorId: string;
		transport: DriverTransport;
	};
}

/** 事件输出：每次操作必须恰好到达一个边界（input_required/completed/failed）。 */
export type AgentEvent =
	| { type: "started"; sessionHandle?: string; runHandle?: string }
	| { type: "progress"; stage?: string; message: string; percent?: number }
	| {
			type: "input_required";
			result: NeedsInputResult;
			/**
			 * Runtime 私有：Driver 从私有协议提取的 provider state（continuation
			 * token）。不进公开记录、不进 pi JSONL、不下发浏览器；Runtime 落盘到
			 * InteractionSecretStore 加密存储，respond 时原样回注给 Driver。
			 */
			providerState?: Record<string, unknown>;
	  }
	| { type: "completed"; result: CompletedResult }
	| { type: "failed"; result: FailedResult };

/**
 * Connector-neutral worker activity projected from an upstream event stream.
 *
 * Drivers emit these through `InvocationContext.onUpdate(..., { activity })`.
 * PuddingTeams assigns delegation-local id/seq/timestamp and persists every
 * activity as an append-only timeline entry. `sourceEvent` remains diagnostic;
 * consumers render `kind`/`status` instead of depending on provider names.
 */
export interface WorkerActivity {
	source: string;
	sourceEvent: string;
	kind: "lifecycle" | "assistant" | "reasoning" | "tool" | "file" | "search" | "plan" | "approval" | "error";
	status: "started" | "running" | "updated" | "completed" | "failed" | "waiting" | "resolved";
	title: string;
	/** Visible assistant text, command/tool summary, output excerpt, or error. */
	content?: string;
	/** Stable upstream item/call id when the spawn protocol exposes one. */
	itemId?: string;
	/** Upstream sequence when exposed; PuddingTeams always adds its own seq. */
	sourceSeq?: number;
	/** Small, already-redacted provider-neutral facts for richer rendering. */
	metadata?: Record<string, unknown>;
}

export interface WorkerActivityUpdateDetails {
	activity: WorkerActivity;
	[k: string]: unknown;
}

/** Connector execution boundary selected for one concrete Agent binding. */
export type DriverTransport = "spawn" | "http" | "rpc" | "acp" | "sdk";

export type DriverReconciliation = "none" | "query_run" | "reattach_stream";
export type DriverCancelConfirmation = "none" | "acknowledged" | "observable";

export interface DriverWorkspaceCapabilities {
	honorsInvocationCwd: boolean;
	readOnlyEnforcement: "none" | "sandbox" | "remote_policy";
	/** True only when every controlled Workspace mutation is intercepted before the side effect and the same Run can resume through respond(). */
	mutationInterception?: "none" | "pre_mutation";
	mutationObservation: Array<"event_stream" | "git_diff" | "filesystem_diff">;
}

export interface DriverVerificationCapabilities {
	modalities: Array<"cli" | "gui">;
	freshSession: boolean;
	workspaceIsolation: Array<"none" | "mutation_guard" | "isolated_copy">;
	commandExecution: boolean;
	guiObservation: boolean;
	networkObservation: boolean;
}

/** Runtime-resolved, auditable constraints for a verification-purpose Run. */
export interface VerificationInvocationProfile {
	profileId: string;
	environmentId: string;
	sourceBinding: "goal_workspace";
	executionRoot: string;
	workspaceBoundary: "platform_isolated_copy" | "platform_mutation_guard";
	mutationPolicy: "isolated_changes_only" | "block_on_change";
	/** First release does not claim network isolation; Connector/account policy remains authoritative. */
	networkPolicy: "inherit_connector_policy";
}

export interface DriverCapabilities {
	operations: Array<"run" | "continue" | "respond" | "cancel">;
	interactionKinds: Array<"permission" | "question" | "confirmation">;
	progress: "none" | "coarse" | "stream";
	/** spawn=子进程 CLI；http/rpc/acp=网络协议；sdk=进程内 SDK（如本地 pi）。 */
	transport: DriverTransport;
	/** 缺省按 none 处理；Connector 只能声明上游真实支持的对账能力。 */
	reconciliation?: DriverReconciliation;
	/** 缺省按 none 处理；发出 cancel 不等于确认远端已经停止。 */
	cancelConfirmation?: DriverCancelConfirmation;
	workspace?: DriverWorkspaceCapabilities;
	verification?: DriverVerificationCapabilities;
}

export interface InvocationContext {
	/** Agent 工作目录（workspace root 或平台默认）。 */
	cwd: string;
	/** 本次委托的 delegation id（Runtime 注入）：Driver 据此生成 handoff 导出目录（§15.3）。 */
	delegationId?: string;
	/** 窗口的显式 workspaceId（Runtime 注入）：进程内 Driver 的信任门资源判定用（迁移方案 §7.2）。 */
	workspaceId?: string;
	/** Stable local operation identity; Connectors may pass it to upstream idempotency facilities. */
	operationId?: string;
	/** Alias for upstream HTTP/RPC APIs that use an idempotency-key convention. */
	idempotencyKey?: string;
	/** Present only for purpose=verification; resolved by Harness, never accepted from a prompt. */
	verificationProfile?: VerificationInvocationProfile;
	/** 已注入凭证的环境变量。 */
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** 启动超时 / 活跃超时等配置。 */
	timeouts?: { startupMs?: number; activeMs?: number };
	/**
	 * 进度回调（由 Runtime 转成 progress 事件）。Driver 可在 details.activity
	 * 携带结构化 WorkerActivity；Runtime 会追加落盘后再供执行过程时间线订阅。
	 */
	onUpdate?: (content: string, details?: unknown) => void;
	/**
	 * 仅 Runtime 在 respond 时注入的私有 provider state（continuation token）。
	 * 只出现在 Runtime→Driver 的进程内通道，不进 LLM/浏览器/Session 历史。
	 */
	providerState?: Record<string, unknown>;
}

export interface ProbeResult {
	extensionInstalled: boolean;
	extensionVersion?: string;
	detected: boolean;
	configured: boolean;
	authenticated: boolean | "unknown";
	enabled: boolean;
	compatibility: "supported" | "untested" | "incompatible" | "unknown";
	upstreamVersion?: string;
	version?: string;
	transport?: DriverTransport;
	capabilities: DriverCapabilities;
	issues: Array<{ code: string; message: string; fixAction?: string }>;
}

export type ReconciledRun =
	| { state: "running"; sessionHandle?: string; runHandle: string }
	| { state: "needs_input"; result: NeedsInputResult; providerState?: Record<string, unknown> }
	| { state: "completed"; result: CompletedResult }
	| { state: "failed" | "cancelled"; result: FailedResult }
	| { state: "unknown"; reason: string };

/** Driver-owned dynamic choices for one Connector config field. */
export interface DriverConfigOption {
	value: string;
	label: string;
	description?: string;
	isDefault?: boolean;
}

/**
 * AgentDriver SPI：PuddingTeams 核心只内置 SPI 和 Registry，具体 Agent 的
 * 协议映射由 Connector Extension 注册到 Driver Registry。
 */
export interface AgentDriver {
	id: string;
	capabilities(): Promise<DriverCapabilities>;
	run(input: RunInput, ctx: InvocationContext): AsyncIterable<AgentEvent>;
	continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent>;
	respond(input: RespondInput, ctx: InvocationContext): AsyncIterable<AgentEvent>;
	cancel?(input: { runHandle: string }, ctx: InvocationContext): Promise<void>;
	/** Runtime-only control-plane reconciliation; not a Manager-visible AgentOperation. */
	reconcileRun?(input: { runHandle: string; lastObservedAt?: string }, ctx: InvocationContext): Promise<ReconciledRun>;
	/** Reattach to the same upstream Run and continue emitting normalized events. */
	reattachRun?(input: { runHandle: string; afterCursor?: string }, ctx: InvocationContext): AsyncIterable<AgentEvent>;
	probe(ctx: InvocationContext): Promise<ProbeResult>;
	/** Optional provider-native option discovery (for example Codex model/list). */
	listConfigOptions?(field: string, ctx: InvocationContext): Promise<DriverConfigOption[]>;
}
