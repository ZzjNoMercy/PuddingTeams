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
	scope?: "once" | "run" | "session";
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
	options?: Array<"once" | "run" | "session" | "reject">;
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

export interface ResultBase {
	agentId: string;
	sessionHandle?: string;
	runHandle?: string;
	content?: string;
	artifacts?: ArtifactRef[];
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

export interface DriverCapabilities {
	operations: Array<"run" | "continue" | "respond" | "cancel">;
	interactionKinds: Array<"permission" | "question" | "confirmation">;
	progress: "none" | "coarse" | "stream";
	transport: "spawn" | "http" | "rpc" | "acp";
}

export interface InvocationContext {
	/** Agent 工作目录（workspace root 或平台默认）。 */
	cwd: string;
	/** 已注入凭证的环境变量。 */
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** 启动超时 / 活跃超时等配置。 */
	timeouts?: { startupMs?: number; activeMs?: number };
	/** 进度回调（由 Runtime 转成 progress 事件）。 */
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
	transport?: "spawn" | "http" | "rpc" | "acp";
	capabilities: DriverCapabilities;
	issues: Array<{ code: string; message: string; fixAction?: string }>;
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
	probe(ctx: InvocationContext): Promise<ProbeResult>;
}
