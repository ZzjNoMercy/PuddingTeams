// Types shared by the chat UI. The server forwards pi session events as JSON;
// we define structural subsets here so the UI never depends on pi packages.

export interface SessionSummary {
	id: string;
	sessionFile: string;
	firstMessage: string;
	modifiedAt: string;
	active: boolean;
}

export interface ModelSummary {
	/** Opaque reference: `${provider}/${modelId}` — pass back to set/create. */
	id: string;
	name: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ProviderSummary {
	id: string;
	name: string;
	modelCount: number;
	configured: boolean;
	oauth: boolean;
	/** API endpoint (base URL) the provider talks to, when it has one. */
	baseUrl?: string;
}

/** Current viewer boundary. Local mode maps the OS account into the same
 * user/tenant shape that a future authenticated multi-tenant provider uses. */
export interface ViewerIdentity {
	mode: "local" | "authenticated";
	user: {
		id: string;
		username: string;
		displayName: string;
	};
	tenant: {
		id: string;
		name: string;
	};
}

// ---- 自定义 Provider（models.json 控制面） ----

export interface CustomModelInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface CustomProviderInput {
	name: string;
	baseUrl: string;
	api: string;
	models: CustomModelInput[];
}

export interface CustomProviderRecord extends CustomProviderInput {
	id: string;
}

// ---- pi event subset (as received over the WS) ----

export interface PiTextBlock {
	type: "text";
	text: string;
}

export interface PiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface PiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

export interface PiUserMessage {
	role: "user";
	content: string | PiContentBlock[];
	timestamp?: number;
}

/** pi assistant 消息上的逐轮用量（provider 返回、pi-ai 归一化）；cost 由 pi 按模型价目表换算。 */
export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiAssistantMessage {
	role: "assistant";
	content: PiContentBlock[];
	provider?: string;
	model?: string;
	stopReason?: string;
	usage?: PiUsage;
	timestamp?: number;
}

export interface PiToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: PiContentBlock[];
	isError: boolean;
	/** Structured metadata from custom tools (delegate tool details). */
	details?: unknown;
	timestamp?: number;
}

/** pi custom_message (sendCustomMessage): persisted, replayed, no LLM turn. */
export interface PiCustomMessage {
	role: "custom";
	customType: string;
	content: string | PiContentBlock[];
	display?: boolean;
	details?: unknown;
	timestamp?: number;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiCustomMessage;

export type PiEvent =
	| { type: "session_ready"; sessionId: string }
	| { type: "error"; message: string }
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "turn_end"; message: PiAssistantMessage; toolResults: PiToolResultMessage[] }
	| { type: "message_start"; message: PiMessage }
	| { type: "message_update"; message: PiAssistantMessage; assistantMessageEvent: unknown }
	| { type: "message_end"; message: PiMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }
	| { type: "agent_end"; messages: PiMessage[]; willRetry: boolean }
	| { type: "agent_settled" }
	| { type: string; [key: string]: unknown };

// ---- chat model ----

export type ToolCallStatus = "pending" | "running" | "done" | "error" | "interrupted";

export interface ToolCallView {
	id: string;
	name: string;
	args?: unknown;
	status: ToolCallStatus;
	result?: string;
	isError?: boolean;
	/** Structured metadata folded from the tool result (delegate tool details). */
	details?: unknown;
}

export type ChatMessageRole = "user" | "assistant" | "toolResult" | "custom";

export interface ChatMessage {
	id: string;
	role: ChatMessageRole;
	content: string;
	thinking?: string;
	toolCalls: ToolCallView[];
	timestamp: number;
	streaming: boolean;
	error?: boolean;
	name?: string;
	isError?: boolean;
	/** role === "assistant"：该轮 usage（provider 计数 + pi 换算的 cost）。 */
	usage?: PiUsage;
	/** role === "custom": pi customType (e.g. pudding:task_assign) + details. */
	customType?: string;
	details?: unknown;
}

export type ChatStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error" | "gone";

// ---- teams / rooms (phase 2) ----

export interface CommandInvoke {
	type: "command";
	command: string;
	runArgs: string[];
	probeArgs?: string[];
}

/** pinned 内置 Pi manager 的保留 invoke 类型（§10.5）。 */
export interface PiInvoke {
	type: "pi";
}

export type AgentInvoke = CommandInvoke | PiInvoke;

// ---- §10：Extension / Connector / Capability ----

export type Transport = "spawn" | "http" | "rpc" | "acp" | "sdk";

export type ToolActivation = "always" | "searchable";

export interface SecretSchemaItem {
	key: string;
	label: string;
	required: boolean;
}

export interface ConnectorContribution {
	id: string;
	displayName: string;
	apiVersion: "1";
	defaultTransport: Transport;
	supportedTransports: Transport[];
	configSchema?: Record<string, unknown>;
	secretSchema?: SecretSchemaItem[];
	supportedUpstreamVersions?: string;
	versionProbe?: Record<string, unknown>;
}

export interface ExtensionToolContribution {
	name: string;
	activation: ToolActivation;
	description?: string;
}

export interface CapabilityContribution {
	id: string;
	displayName: string;
	apiVersion: "1";
	configSchema?: Record<string, unknown>;
	secretSchema?: SecretSchemaItem[];
	tools: ExtensionToolContribution[];
	/** “添加 Extension”只展示与当前 connectorId 兼容的 Capability（§10.1）。 */
	compatibleConnectors?: string[];
}

export type ExtensionPermission = "spawn" | "network" | "workspace" | "secrets";

export interface ExtensionManifestBase {
	id: string;
	publisher: string;
	displayName: string;
	version: string;
	source: "builtin" | "trusted" | "external";
	engines: { puddingteams: string };
	permissions?: ExtensionPermission[];
}

export interface ConnectorExtensionManifest extends ExtensionManifestBase {
	kind: "connector";
	connector: ConnectorContribution;
}

export interface CapabilityExtensionManifest extends ExtensionManifestBase {
	kind: "capability";
	capability: CapabilityContribution;
}

export type PuddingTeamsExtensionManifest = ConnectorExtensionManifest | CapabilityExtensionManifest;

/** GET /api/extensions/catalog 的目录项。 */
export interface CatalogEntry {
	manifest: PuddingTeamsExtensionManifest;
	installed: boolean;
	origin: "builtin" | "bundled" | "user" | "local-link";
	version: string;
	versionPin?: string;
	loaded: boolean;
	loadError?: string;
	/** local-link 源目录内容与登记 digest 不一致（漂移提示）。 */
	drifted?: boolean;
}

/** Agent 的 Connector 绑定（§10）；secret 明文只进 CredentialsStore。 */
export interface AgentConnectorBinding {
	extensionId: string;
	connectorId: string;
	config: Record<string, unknown>;
	secretRefs?: Record<string, string>;
	versionPin?: string;
}

/** Agent 的 Capability Extension 绑定（§10，替换旧的 extensionBindings）。 */
export interface AgentCapabilityBinding {
	id: string;
	extensionId: string;
	capabilityId: string;
	enabled: boolean;
	config: Record<string, unknown>;
	secretRefs?: Record<string, string>;
	activation?: ToolActivation;
	versionPin?: string;
}

/** Pi manager 的可编辑配置（§10.5，挂在 pinned 条目上）。 */
export interface PiManagerSettings {
	model?: string;
	builtinTools?: boolean;
	noExtensions?: boolean;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface PiResourceConfig {
	systemPrompt?: string;
	skillPaths?: string[];
	promptTemplatePaths?: string[];
	/** 库资源白名单（按 name）：缺省 = 不启用任何库技能/模板。 */
	enabledSkills?: string[];
	enabledPrompts?: string[];
	loadWorkspaceSkills?: boolean;
	loadWorkspacePrompts?: boolean;
	loadWorkspaceContext?: boolean;
}

/** preview 条目的来源：global=库（pi 全局目录）、workspace、extra=额外挂载路径。 */
export type PiResourceSource = "global" | "workspace" | "extra";

export interface PiPreviewResource {
	name: string;
	description: string;
	argumentHint?: string;
	path: string;
	source: PiResourceSource;
	/** extra 来源始终启用；global 库资源由白名单决定。 */
	enabled: boolean;
}

export interface PiResourcePreview {
	cwd: string;
	/** 显式 workspace 标识（含信任状态）；无 workspaceId 的窗口为 null（§6.3）。 */
	workspace: { id: string; trust: WorkspaceTrust } | null;
	/** 有效提示词分段，按最终真实装配顺序（提示词管理方案 §8.5）。 */
	segments: Array<{
		source:
			| "pi-base"
			| "pi-native-append"
			| "agent-instructions"
			| "window-collaboration"
			| "global-context"
			| "workspace-context";
		path?: string;
		content: string;
		collapsed: boolean;
	}>;
	effectivePrompt: string;
	estimatedCharacters: number;
	skills: PiPreviewResource[];
	prompts: PiPreviewResource[];
	contextFiles: string[];
	diagnostics: Array<{ type: string; message: string; path?: string }>;
}

// ---- pi 资源库（/api/resources/*，库根 = pi 全局目录） ----

export interface ResourceDiagnostic {
	type: string;
	message: string;
	path?: string;
}

export interface SkillEntry {
	name: string;
	description: string;
	disableModelInvocation: boolean;
	path: string;
}

export interface SkillDocument extends SkillEntry {
	/** SKILL.md 正文（frontmatter 之外的部分）。 */
	content: string;
}

/** zip 批量导入技能的响应（POST /api/resources/skills/import-zip 或 import 带 .zip 路径）。 */
export interface SkillsZipImportResult {
	imported: SkillEntry[];
	skipped: { name: string; reason: string }[];
	diagnostics: ResourceDiagnostic[];
}

export interface TemplateEntry {
	name: string;
	description: string;
	argumentHint?: string;
	path: string;
}

export interface TemplateDocument extends TemplateEntry {
	content: string;
}

export interface AgentResponsibilityProfile {
	identity?: string;
	domain: string;
	owns: string[];
	excludes: string[];
	escalateWhen?: string[];
}

export interface AgentConfig {
	/** Unique agent id (used in the delegate tool name agent_<id>__delegate). */
	name: string;
	description: string;
	/** worker 的 legacy command invoke；manager 为 { type: "pi" }；可缺省（Connector 接入）。 */
	invoke?: AgentInvoke;
	/** Connector 绑定（§10）：worker 的接入方式。 */
	connector?: AgentConnectorBinding;
	/** 绑定的 Capability Extension（§10，替换 Phase 4 的 extensionBindings）。 */
	capabilityExtensions?: AgentCapabilityBinding[];
	env?: Record<string, string>;
	enabled?: boolean;
	capabilities?: string[];
	responsibility?: AgentResponsibilityProfile;
	/** Avatar file name under server `.teams/avatars/` (§11); absent = default. */
	avatar?: string;
	/** server 装饰字段：未上传头像但 connector 声明了包内默认头像（§11）。 */
	hasDefaultAvatar?: boolean;
	/** pinned 内置条目（manager）：不可删除、不可禁用。 */
	pinned?: boolean;
	/** manager 条目的可编辑配置（§10.5）。 */
	manager?: PiManagerSettings;
	piResources?: PiResourceConfig;
	/** Extension 配置版本（§3.3.5）。 */
	extensionRevision?: number;
}

export interface WorkerProbeResult {
	name: string;
	command: string;
	ok: boolean;
	exitCode: number;
	error?: string;
	raw: Record<string, unknown>;
}

export interface DriverCapabilities {
	operations: Array<"run" | "continue" | "respond" | "cancel">;
	interactionKinds: Array<"permission" | "question" | "confirmation">;
	progress: "none" | "coarse" | "stream";
	transport: Transport;
}

/** Connector 接入 Agent 的 Driver.probe 结构化结果（§10 ProbeResult）。 */
export interface ConnectorProbeResult {
	extensionInstalled: boolean;
	extensionVersion?: string;
	detected: boolean;
	configured: boolean;
	authenticated: boolean | "unknown";
	enabled: boolean;
	compatibility: "supported" | "untested" | "incompatible" | "unknown";
	upstreamVersion?: string;
	version?: string;
	transport?: Transport;
	capabilities: DriverCapabilities;
	issues: Array<{ code: string; message: string; fixAction?: string }>;
}

/** POST /api/agents/:name/probe 的返回：Connector 结构化结果或 legacy 命令探测。 */
export type AgentProbeResult = ConnectorProbeResult | WorkerProbeResult;

/** 区分两种 probe 结果：Connector ProbeResult 必带 capabilities。 */
export function isConnectorProbe(probe: AgentProbeResult): probe is ConnectorProbeResult {
	return "capabilities" in probe;
}

/** Capability 绑定探测结果（POST .../extensions/:bindingId/probe）。 */
export interface BindingProbeResult {
	extensionInstalled: boolean;
	extensionVersion?: string;
	loaded: boolean;
	enabled: boolean;
	activation: string | null;
	tools: string[];
	issues: Array<{ code: string; message: string }>;
}

/** 写操作统一响应里的受影响 manager Session 统计（§10.1）。 */
export interface AffectedSessions {
	affectedSessions: number;
	activeNow: number;
	reloadPending: number;
}

/** Connector/Capability/manager/启停写操作的统一响应。 */
export interface MutationResponse {
	agent: AgentConfig;
	revision: number;
	affectedSessions: AffectedSessions;
	securityWarnings?: string[];
}

/** 启停/卸载 409 冲突里的进行中 Run 摘要。 */
export interface ConflictRun {
	delegationId: string;
	agentId?: string;
	status: string;
	windowId: string;
	managerSessionId?: string;
}

export interface RoomSession {
	id: string;
	/** LLM-generated title (set on first query), else firstMessage. */
	name?: string;
	firstMessage: string;
	modifiedAt: string;
	active: boolean;
}

export type SessionWorkStatus = "active" | "waiting_human" | "resolved" | "cancelled";
export type CompletionReviewMode = "manager" | "independent";

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
	verdict: "satisfied" | "not_satisfied" | "needs_human";
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
	goalRevision: number;
	reviewMode: CompletionReviewMode;
	reviewerModel?: string;
	completionReviews: CompletionReview[];
	status: SessionWorkStatus;
	artifactIds: string[];
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface DecisionRequest {
	id: string;
	sessionId: string;
	requestedBy: string;
	question: string;
	context: string;
	options?: Array<{ id: string; label: string }>;
	blockedAction: string;
	resumeHint: string;
	authorizationScope?: string;
	status: "pending" | "answered" | "cancelled";
	answer?: string;
	grantedAuthorizationScope?: string;
	createdAt: string;
	updatedAt: string;
}

export interface DelegationTrace {
	id: string;
	parentDelegationId?: string;
	handoffKind?: "request" | "followup";
	agentId: string;
	intent?: string;
	expectedOutcome?: string;
	evidenceRequirements?: string[];
	completionBoundary?: string;
	status: string;
	createdAt: string;
	updatedAt: string;
}

export type WindowType = "solo" | "direct" | "group";

export interface RoomSummary {
	/** Window id (not a pi session id). */
	id: string;
	type: WindowType;
	name: string;
	firstMessage: string;
	modifiedAt: string;
	members: AgentConfig[];
	/** pi sessions belonging to this window (newest first). */
	sessions: RoomSession[];
	/** The pi session currently shown in the chat. */
	activeSession: string;
	/** Solo only: pinned singleton, never deletable. */
	pinned: boolean;
	/** Per-worker last session handle (multi-turn continuity). */
	workerBindings: Record<string, { sessionHandle?: string; workspaceId?: string; cwdSnapshot: string; agentRevision: number; updatedAt: string }>;
	/** User-edited window system prompt ('' = default relay guidance). */
	prompt: string;
	/** Window 创建时冻结的实际运行目录；未选项目时用于保持上下文身份。 */
	cwdSnapshot: string;
	contextAvailable: boolean;
	/** null = 未选择项目，沿用平台默认运行目录。 */
	workspace: WorkspaceRecord | null;
}

export type WorkspaceTrustState = "pending" | "trusted" | "denied";
export type WorkspaceResourceKind = "context" | "skills" | "prompts";

/** Workspace 信任门（迁移方案 §7.1）：信任决定只保存在用户 Home。 */
export interface WorkspaceTrust {
	state: WorkspaceTrustState;
	decidedAt?: string;
	policyVersion: number;
	canonicalPathAtDecision?: string;
	/** 缺省 = 全三类都批准。 */
	approvedResources?: WorkspaceResourceKind[];
}

/** 可注入资源摘要（信任卡用）：只报类型与数量，不含正文（§7.2）。 */
export interface WorkspaceResourceSummary {
	contextFiles: number;
	skills: number;
	prompts: number;
}

export interface WorkspaceRecord {
	id: string;
	name: string;
	rootPath: string;
	canonicalPath: string;
	gitRoot?: string;
	managed: boolean;
	trust: WorkspaceTrust;
	resources: WorkspaceResourceSummary;
	createdAt: string;
	lastOpenedAt: string;
	available: boolean;
}

export interface WorkspaceDirectoryListing {
	path: string;
	parent: string;
	directories: Array<{ name: string; path: string }>;
}
