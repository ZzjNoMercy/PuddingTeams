import {
	createAgentSession,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { readFile, realpath, unlink } from "node:fs/promises";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { agentDisplayName, MANAGER_AGENT_NAME } from "../store/teams.js";
import type { PiManagerSettings, PiResourceConfig, TeamsStore } from "../store/teams.js";
import type { WorkStateStore } from "../store/work-state.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import type { DelegationRecord } from "../agent-runtime/delegation-store.js";
import type { ArtifactStore } from "../agent-runtime/artifact-store.js";
import {
	ExtensionCatalog,
	delegateToolName,
	resolveAgentCapabilityRuntime,
	toolSafeId,
} from "../agent-runtime/extensions.js";
import {
	planManagerTools,
	buildManagerExtensionFactories,
	CORE_TOOL_SEARCH,
	CORE_TOOL_UPDATE_WORK_STATE,
	CORE_TOOL_REQUEST_DECISION,
	type ManagedToolPlan,
	type ManagerWindowContext,
} from "./agent-extensions.js";
import { managerHumanWait } from "./manager-human-wait.js";
import { sharedModelRuntime } from "./model-runtime.js";
import { appendPiPrompts, piResourceLoaderOptions } from "./pi-resources.js";
import {
	buildCompletionReviewPrompt,
	COMPLETION_REVIEWER_SYSTEM_PROMPT,
	parseCompletionReview,
	type CompletionReviewInput,
} from "./completion-review.js";
import type { CompletionReview } from "../store/work-state.js";
import type { VerificationRecord } from "../store/work-state.js";
import {
	buildVerificationPrompt,
	parseVerificationOutput,
	VERIFICATION_REVIEWER_SYSTEM_PROMPT,
	type VerificationReviewInput,
} from "../agent-runtime/verification-review.js";
import type { LargeWorkerResultStore } from "../store/large-worker-result.js";
import type { ProductSettingsStore } from "../store/product-settings.js";
import {
	buildWorkspaceFffExtension,
	stripUnmanagedPiFff,
	type ManagerCodeSearchProvider,
} from "./code-search.js";
import type { McpServerStore } from "../store/mcp-servers.js";
import { buildManagedMcpExtension } from "./mcp-runtime.js";

export interface SessionSummary {
	id: string;
	sessionFile: string;
	firstMessage: string;
	/** LLM-generated title (set on the first user query). */
	name?: string;
	modifiedAt: string;
	active: boolean;
	/** 会话当前模型的 opaque ref（`${provider}/${modelId}`），取自最后一条 model_change。 */
	model?: string;
	/** 会话当前 thinking level，取自最后一条 thinking_level_change。 */
	thinkingLevel?: string;
}

export interface ModelSummary {
	/** Opaque reference: `${provider}/${modelId}` — pass back to set/create. */
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	/** 该模型支持的 thinking 档位（`thinkingLevelMap` 归一化后的可用集）；非推理模型为 ["off"]。 */
	thinkingLevels: string[];
	/**
	 * 档位是否真正分级：选不同档位会改变上游请求。若为 false，说明该模型只支持
	 * 思考开/关，菜单上的多档在链路上无差别，UI 需如实告知而非暗示强度刻度。
	 */
	thinkingGraded: boolean;
	contextWindow: number;
	maxTokens: number;
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

export type DurableCustomMessageDisposition = "delivered" | "duplicate" | "deferred";

export interface SessionSkillCommand {
	name: string;
	description: string;
	source: "skill";
}

export interface RecoveredToolResult {
	toolCallId: string;
	toolName: string;
	text: string;
	details?: Record<string, unknown>;
	isError: boolean;
}

export interface AbortSessionResult {
	aborted: boolean;
	reconciledToolResults: number;
}

export interface RecoveredToolCallState {
	runningToolCallIds: string[];
	recoveredToolResults: RecoveredToolResult[];
}

interface CapturedToolExecution {
	toolCallId: string;
	toolName: string;
	ended?: boolean;
	result?: unknown;
	isError?: boolean;
}

type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** pi SDK 归一化思考档位；与 manager.thinkingLevel / JSONL thinking_level_change 同域。 */
type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
	return typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

/** 纯展示 custom message 等待 run 落定的上限（超时降级 nextTurn）。 */

function stringifyUnknown(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function capturedToolResult(execution: CapturedToolExecution): RecoveredToolResult | undefined {
	if (execution.ended !== true) return undefined;
	const result = execution.result;
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const record = result as { content?: unknown; details?: unknown };
		const blocks = Array.isArray(record.content) ? record.content : undefined;
		const text = blocks
			?.filter((block): block is { type: "text"; text: string } =>
				Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text)
			.join("\n");
		return {
			toolCallId: execution.toolCallId,
			toolName: execution.toolName,
			text: text || stringifyUnknown(result),
			...(record.details && typeof record.details === "object" && !Array.isArray(record.details)
				? { details: record.details as Record<string, unknown> }
				: {}),
			isError: execution.isError === true,
		};
	}
	return {
		toolCallId: execution.toolCallId,
		toolName: execution.toolName,
		text: stringifyUnknown(result),
		isError: execution.isError === true,
	};
}

function delegationToolResult(delegation: DelegationRecord): RecoveredToolResult {
	if (delegation.executionState === "waiting_admission") {
		return {
			toolCallId: delegation.managerToolCallId!,
			toolName: delegateToolName(delegation.agentId),
			text: `Teams 无法验证 worker「${delegation.agentId}」满足本任务的只读预期；Worker 尚未启动，正在等待用户决定。`,
			details: {
				worker: delegation.agentId,
				status: "needs_input",
				source: "platform_policy",
				workerStarted: false,
				interactionId: delegation.admissionInteractionId,
				delegationId: delegation.id,
				executionState: delegation.executionState,
				...(delegation.goalId ? { goalId: delegation.goalId } : {}),
				...(delegation.workPlanId ? { workPlanId: delegation.workPlanId } : {}),
				...(delegation.workItemId ? { workItemId: delegation.workItemId } : {}),
			},
			isError: false,
		};
	}
	const result = delegation.result;
	const completed = delegation.executionState === "reported_completed";
	const cancelled = delegation.executionState === "cancelled" || result?.status === "cancelled";
	const resultError = result && "error" in result ? result.error : undefined;
	const resultContent = result?.status === "completed" ? result.content : undefined;
	const text = completed
		? (resultContent || `worker「${delegation.agentId}」已完成任务。`)
		: cancelled
			? `worker「${delegation.agentId}」任务已取消${resultError ? `：${resultError}` : "。"}`
			: delegation.executionState === "observation_lost"
				? `worker「${delegation.agentId}」的执行观测已丢失，当前效果未知，请先对账原 Run。`
				: `worker「${delegation.agentId}」执行出错${resultError ? `：${resultError}` : "。"}`;
	const reportedStatus = result?.status ?? (completed ? "completed" : cancelled ? "cancelled" : "failed");
	return {
		toolCallId: delegation.managerToolCallId!,
		toolName: delegateToolName(delegation.agentId),
		text,
		details: {
			worker: delegation.agentId,
			status: completed ? "completed" : cancelled ? "cancelled" : "failed",
			reportedStatus,
			delegationId: delegation.id,
			executionState: delegation.executionState,
			workerStarted: delegation.workerStarted,
			readOnlyAssessment: delegation.readOnlyAssessment,
			waitingInput: false,
			processView: true,
			...(delegation.sessionHandle ? { sessionHandle: delegation.sessionHandle } : {}),
			...(delegation.goalId ? { goalId: delegation.goalId } : {}),
			...(delegation.workPlanId ? { workPlanId: delegation.workPlanId } : {}),
			...(delegation.workItemId ? { workItemId: delegation.workItemId } : {}),
			...(result && "errorCode" in result
				? { errorCode: result.errorCode }
				: delegation.executionState === "observation_lost"
					? { errorCode: "observation_lost" }
					: {}),
		},
		isError: !completed,
	};
}

/**
 * Owns the pi AgentSession lifecycle for a single backend process.
 *
 * Sessions are persisted as pi session JSONL files under `sessionDir`; the
 * store keeps an in-memory cache of currently open AgentSessions so an
 * active conversation streams without re-opening the file every message.
 * On backend restart, sessions are re-materialized from the JSONL files.
 */
export class PiSessionStore {
	private active = new Map<string, AgentSession>();
	private readonly catalog: ExtensionCatalog;
	/** 装配时已注册到会话的受管工具名（撤权时据此识别“该会话自己的”工具）。 */
	private assembledManaged = new Map<string, Set<string>>();
	/** 配置变化标记（§3.3.5）：Session 空闲时重建 ResourceLoader/AgentSession。 */
	private runtimeDirty = new Set<string>();
	/** 装配跨越配置变更时重试，避免尚未进入 active 的实例漏掉撤权。 */
	private configEpoch = 0;
	/** 会话级 thinking level（用户对该 Session 的显式选择，§10.6 thinking binding）：
	 *  manager 配置变更不得广播覆盖。session.setThinkingLevel 已把档位写进
	 *  JSONL，重启后由 preferRecordedThinkingLevel 恢复。 */
	private thinkingOverrides = new Map<string, PiThinkingLevel>();
	/** 长生命周期事件订阅（WS 推送）：挂在 store 上而非单个 AgentSession
	 *  实例——runtimeDirty 空闲重建会换掉实例，实例级 subscribe 会静默断流
	 *  （socket 还连着，事件却发到了已 dispose 的旧实例）。 */
	private listeners = new Map<string, Set<(event: AgentSessionEvent) => void>>();
	/** 已挂过转发器的实例，避免重复 subscribe 导致事件翻倍。 */
	private forwarded = new WeakSet<AgentSession>();
	/**
	 * Parallel tool results are emitted live in completion order, but pi only
	 * appends their toolResult messages later in assistant source order.  Keep
	 * the completed live outcomes until their durable message arrives so abort
	 * can close every toolCall without losing an already-observed error.
	 */
	private toolExecutions = new Map<string, Map<string, CapturedToolExecution>>();
	/** Serializes platform-authored repairs for one Session. */
	private toolRepairQueues = new Map<string, Promise<unknown>>();
	/** Serializes receiver-side eventId checks with their JSONL append. */
	private customEventQueue: Promise<unknown> = Promise.resolve();
	private deliveredCustomEvents = new Set<string>();
	private unsubscribeTeams?: () => void;
	private serializeCustomEvent<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.customEventQueue.then(fn, fn);
		this.customEventQueue = run.then(() => undefined, () => undefined);
		return run;
	}
	private serializeToolRepair<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.toolRepairQueues.get(sessionId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const tail = run.then(() => undefined, () => undefined);
		this.toolRepairQueues.set(sessionId, tail);
		void tail.finally(() => {
			if (this.toolRepairQueues.get(sessionId) === tail) this.toolRepairQueues.delete(sessionId);
		});
		return run;
	}

	constructor(
		private readonly cwd: string,
		private readonly sessionDir: string,
		private readonly teamsStore?: TeamsStore,
		private readonly invoker?: AgentInvoker,
		catalog?: ExtensionCatalog,
		private readonly workStates?: WorkStateStore,
		private readonly artifacts?: ArtifactStore,
		private readonly largeResults?: LargeWorkerResultStore,
		private readonly productSettings?: ProductSettingsStore,
		private readonly capabilityStateRoot?: string,
		private readonly fffStateRoot?: string,
		private readonly mcpServers?: McpServerStore,
	) {
		this.catalog = catalog ?? new ExtensionCatalog();
		if (this.teamsStore && this.invoker) {
			// 撤权（§3.3.6）：Agent/绑定/窗口成员变化后立即收紧活跃会话的
			// active tools 并标记 runtimeDirty。
			this.unsubscribeTeams = this.teamsStore.onChange(() => {
				void this.revokeChangedTools().catch((err) =>
					this.debugLog?.(`revokeChangedTools failed: ${err instanceof Error ? err.message : String(err)}`),
				);
			});
		}
	}
	private knowledgeRuntime: import("../knowledge/runtime-service.js").KnowledgeRuntimeService | undefined;
	setKnowledgeRuntime(service: import("../knowledge/runtime-service.js").KnowledgeRuntimeService): void { this.knowledgeRuntime = service; }
	private webResearchExtension?: (agentId: string) => InlineExtension;
	setWebResearchExtension(factory: (agentId: string) => InlineExtension): void { this.webResearchExtension = factory; }

	/**
	 * System-prompt shaping for a window's manager sessions（提示词管理方案 §5）：
	 * solo 无协作段；direct 只有平台固定、不可编辑的 relay 协议（§5.2，忽略
	 * ctx.prompt，防御历史数据）；group 才允许用户编辑的协作提示词覆盖内置
	 * guidance（§5.3）。所有输出经 appendSystemPromptOverride 追加，不覆盖
	 * pi 内嵌默认提示词。
	 */
	static resolveGuidance(ctx: ManagerWindowContext | undefined, _legacySettings?: PiManagerSettings): string | undefined {
		if (!ctx || ctx.type === "solo") return undefined;
		const members = ctx.members.filter(Boolean);
		if (members.length === 0) return undefined;
		if (ctx.type === "group" && ctx.prompt?.trim()) return ctx.prompt.trim();
		// 成员在提示词里渲染显示名（id → displayName 快照，缺省回退 id）；
		// 工具名仍含 id，与 roster 段的工具清单一一对应。
		const label = (id: string) => ctx.displayNames?.[id] ?? id;
		if (ctx.type === "direct") {
			const w = members[0]!;
			const tool = delegateToolName(w);
			return [
				`当前是单聊窗口，用户的消息是发给 worker「${label(w)}」的。`,
				"规则：",
				`1. 用户的每一条请求都用 ${tool} 工具委托给 worker「${label(w)}」，不要自己动手执行，也不要直接作答。`,
				"2. 拿到 worker 结果后把结果转述给用户（可简要概括），不要额外发挥。",
				`3. 若 worker 需要更多输入（如选择分析模型），把可选内容转述给用户，等用户回复后再用 ${tool} 续接。`,
			].join("\n");
		}
		return [
			`当前是群聊窗口，pi manager 是调度者，成员：${members.map(label).join("、")}。多个 worker 需要配合完成用户的整体目标。`,
			"规则：",
			`1. 把用户的整体目标拆解成可执行的子任务；成员的委托工具（agent_<id>__delegate）默认已激活，直接按 roster 里的工具名逐个委托给最合适的 worker（可调用多个 worker、可分多步执行）。`,
			"2. 用户指名 worker 时，优先把相关子任务委托给它。",
			"3. 结合之前 worker 返回的结果决定下一步：后续子任务可引用/续接先前结果，需要接力时安排好 worker 之间的顺序。",
			"4. 需求或关键参数模糊时先向用户澄清，不要自行臆测。",
			"5. 所有子任务完成后，把综合结论汇报给用户；调度与决策由你负责，但任务执行一律交给 worker，不要自己动手执行任务本身。",
		].join("\n");
	}

	/** pinned manager 的可编辑配置（§10.5）；未配置 TeamsStore 时为空。 */
	private async managerSettings(): Promise<PiManagerSettings | undefined> {
		return (await this.teamsStore?.getManager())?.manager;
	}

	private async managerResources(): Promise<PiResourceConfig | undefined> {
		return (await this.teamsStore?.getManager())?.piResources;
	}

	/**
	 * manager Session 的统一装配（§3.3）：对 solo/direct/group 创建同一类
	 * ResourceLoader——组合窗口 relay guidance、core Extension（roster prompt
	 * 注入 + search_agent_tools）以及 roster Agent 的基础/专属 Extension
	 * factories。`create()` 与从 JSONL `open()` 都走这里，保证重启前后
	 * Extension 集合一致。
	 */
	private async managerResourceLoader(
		ctx: ManagerWindowContext | undefined,
		getSessionId: () => string,
		cwd: string,
		settings?: PiManagerSettings,
		resources?: PiResourceConfig,
	): Promise<{
		loader: DefaultResourceLoader;
		plan: ManagedToolPlan;
		capabilityRuntime: Awaited<ReturnType<typeof resolveAgentCapabilityRuntime>> | undefined;
		codeSearch: ManagerCodeSearchProvider;
	}> {
		const agentDir = getAgentDir();
		let plan: ManagedToolPlan = { managed: new Set(), active: new Set(), agents: [] };
		let factories: InlineExtension[] = [];
		if (this.teamsStore && this.invoker) {
			plan = await planManagerTools(this.teamsStore, this.catalog, ctx);
			factories = buildManagerExtensionFactories(plan, {
				store: this.teamsStore,
				sessions: this,
				invoker: this.invoker,
				catalog: this.catalog,
				workStates: this.workStates,
				artifacts: this.artifacts,
				largeResults: this.largeResults,
				productSettings: this.productSettings,
				getSessionId,
				ctx,
				resolveContext: () => this.windowContextOf(getSessionId()),
				log: (msg) => this.debugLog?.(msg),
			});
		}
		const guidance = PiSessionStore.resolveGuidance(ctx);
		if (this.webResearchExtension && (!ctx || ctx.type === "solo")) factories.push(this.webResearchExtension((await this.teamsStore?.getManager())?.name ?? "manager"));
		// 信任门（§7.2/§6.3）：服务端按窗口 workspaceId 计算三类放行，
		// 与 manager 自己的资源开关取与；无 workspaceId = 全关。
		const workspaceAccess = this.teamsStore
			? await this.teamsStore.workspaces.resourceAccessFor(ctx?.workspaceId)
			: undefined;
		// Manager 搜索仅在 solo 生效；direct/group 的 relay 权限边界始终只有委托工具。
		const codeSearch: ManagerCodeSearchProvider = ctx?.type === "solo"
			? (settings?.codeSearch ?? "off")
			: "off";
		if (codeSearch === "fff" && ctx?.workspaceId && this.teamsStore && this.fffStateRoot) {
			const workspace = await this.teamsStore.workspaces.get(ctx.workspaceId);
			if (workspace?.trust.state === "trusted") {
				factories.push(await buildWorkspaceFffExtension({
					stateRoot: this.fffStateRoot,
					workspace: {
						id: workspace.id,
						canonicalPath: workspace.canonicalPath,
						trusted: true,
					},
				}));
			}
		}
		const manager = await this.teamsStore?.getManager();
		if (manager && this.mcpServers) {
			factories.push(await buildManagedMcpExtension(this.mcpServers, manager.mcpServerIds ?? []));
		}
		const capabilityRuntime = manager && this.capabilityStateRoot
			? await resolveAgentCapabilityRuntime({
				agent: manager,
				catalog: this.catalog,
				stateRoot: this.capabilityStateRoot,
				cwd,
				env: process.env,
			})
			: undefined;
		for (const issue of capabilityRuntime?.issues ?? []) {
			this.debugLog?.(`manager Capability runtime: ${issue.message} (${issue.code})`);
		}
		const sessionResources: PiResourceConfig | undefined = capabilityRuntime?.skillPaths.length
			? {
					...(resources ?? {}),
					skillPaths: [...new Set([...(resources?.skillPaths ?? []), ...capabilityRuntime.skillPaths])],
				}
			: resources;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			extensionFactories: [...factories, ...(this.knowledgeRuntime ? [this.knowledgeRuntime.managerExtension(getSessionId)] : [])],
			...piResourceLoaderOptions(sessionResources, cwd, agentDir, workspaceAccess),
			// noExtensions 只控制 pi-native Extension；平台 inline core/delegation
			// factories 不受影响。Skills/templates/context 全部由 piResources 决定。
			...(settings?.noExtensions ? { noExtensions: true } : {}),
			extensionsOverride: stripUnmanagedPiFff,
			// append-only（提示词管理方案 §3）：manager 运行指令与窗口 guidance
			// 追加到 pi 原生 append 之后，不覆盖 pi 内嵌默认提示词。
			appendSystemPromptOverride: (base) => appendPiPrompts(base, sessionResources, guidance),
		});
		await loader.reload();
		return { loader, plan, capabilityRuntime, codeSearch };
	}

	/** create()/open() 共用的会话装配：loader + 初始 active tools 策略。 */
	private async assembleSession(opts: {
		sessionManager: SessionManager;
		model?: PiModel;
		ctx?: ManagerWindowContext;
		cwd: string;
		getSessionId: () => string;
		/** open() 重开已有会话：模型以 JSONL 最后一条 model_change 为准，
		 *  不用 manager 默认模型覆盖用户的选择。 */
		preferRecordedModel?: boolean;
		/** open() 重开已有会话：thinking level 以 JSONL 最后一条
		 *  thinking_level_change 为准，不用 manager 默认档位覆盖（§10.6）。 */
		preferRecordedThinkingLevel?: boolean;
	}): Promise<AgentSession> {
		const settings = await this.managerSettings();
		const resources = await this.managerResources();
		const { loader, plan, capabilityRuntime, codeSearch } = await this.managerResourceLoader(
			opts.ctx,
			opts.getSessionId,
			opts.cwd,
			settings,
			resources,
		);
		// Manager is an orchestrator, never a Workspace writer. Pi's builtin set
		// couples read with bash/edit/write, so remove it in every window and add
		// back only bounded read-only tools for solo inspection. This is an
		// execution boundary, not a prompt convention: Goal and non-Goal turns
		// receive the same no-mutation surface.
		const isRelay = opts.ctx !== undefined && opts.ctx.type !== "solo";
		const readOnlyManagerTools = !isRelay && settings?.builtinTools !== false
			? [
					createReadToolDefinition(opts.cwd),
					createLsToolDefinition(opts.cwd),
					...(codeSearch === "builtin" ? [createGrepToolDefinition(opts.cwd), createFindToolDefinition(opts.cwd)] : []),
				]
			: [];
		// §10.5 默认模型：显式选择的模型优先，否则用 manager 配置的默认模型
		// （解析失败不阻断建会话，回退 SDK 默认）。重开会话会把 JSONL 中
		// 最后一条 model_change 显式解析后传入；preferRecordedModel 仅禁止
		// manager 默认值在该解析失败时覆盖用户记录。
		let model = opts.model;
		if (!model && !opts.preferRecordedModel && settings?.model) {
			model = await this.resolveModel(settings.model).catch((err: unknown) => {
				this.debugLog?.(`manager 默认模型解析失败：${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			});
		}
		// thinking level 与模型同构（§10.6 binding）：默认档位只喂新建会话；
		// 重开已有会话必须不传，让 SDK 从 JSONL thinking_level_change 恢复。
		const thinkingLevel = opts.preferRecordedThinkingLevel ? undefined : settings?.thinkingLevel;
		const { session } = await createAgentSession({
			cwd: opts.cwd,
			sessionManager: opts.sessionManager,
			...(model ? { model } : {}),
			modelRuntime: await this.runtime(),
			...(thinkingLevel ? { thinkingLevel } : {}),
			resourceLoader: loader,
			noTools: "builtin" as const,
			excludeTools: ["bash", "edit", "write"],
			...(readOnlyManagerTools.length
				? { customTools: readOnlyManagerTools as NonNullable<CreateAgentSessionOptions["customTools"]> }
				: {}),
		});
		// createAgentSession() only constructs registered extensions. Embedded
		// hosts must bind them explicitly so session_start receives this Session's
		// cwd (FFF uses it as the index root).
		await session.bindExtensions({ mode: "rpc" });
		this.knowledgeRuntime?.guardManagerSession(session);
		// Stop at the completed tool batch, after toolResults/cards are persisted.
		// Aborting the Session here would also signal in-flight Worker operations;
		// a human wait must preserve the pending Interaction and its original Run.
		const previousStop = session.agent.shouldStopAfterTurn;
		session.agent.shouldStopAfterTurn = async (context, signal) => {
			if (await managerHumanWait(session.sessionId, this.invoker, this.workStates)) return true;
			return await previousStop?.(context, signal) ?? false;
		};
		// 激活策略（§3.3）：基础委托工具全窗口默认激活（省掉 search 轮次）；
		// capability 扩展工具按绑定策略预注册，searchable 的保持 inactive，
		// 由 search_agent_tools 按需纯加法激活。
		// 激活态回放（§3.3.7）：active tools 只在内存，重启/空闲重建会清零，
		// 但 JSONL 历史里留着直接调用成功的记录，模型会模仿历史跳过 search
		// 导致 "Tool not found"。SDK 会把"激活了新工具"的 toolResult 标注
		// addedToolNames（只写不读），这里从当前分支历史回放，恢复重建前的
		// 激活集合；回放仍受 plan 约束——已禁用/移出窗口的 worker 不进
		// plan.managed，其工具自然被过滤，撤权语义不变。
		const replayed = new Set<string>();
		for (const entry of opts.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; addedToolNames?: unknown };
			if (message.role !== "toolResult" || !Array.isArray(message.addedToolNames)) continue;
			for (const name of message.addedToolNames) {
				if (typeof name === "string") replayed.add(name);
			}
		}
		const current = session.getActiveToolNames();
		const next = current.filter((n) => !plan.managed.has(n) || plan.active.has(n) || replayed.has(n));
		session.setActiveToolsByName([...new Set(next)]);
		this.assembledManaged.set(session.sessionId, plan.managed);
		this.attachForwarder(session);
		return session;
	}

	/** 把实例事件桥接到 store 级订阅者；每个实例只挂一次。 */
	private attachForwarder(session: AgentSession): void {
		if (this.forwarded.has(session)) return;
		this.forwarded.add(session);
		session.subscribe((event) => this.forwardEvent(session.sessionId, event));
	}

	/** Forward SDK and platform-authored projection events through the same WS bus. */
	private forwardEvent(id: string, event: AgentSessionEvent): void {
		this.captureToolExecutionEvent(id, event);
		this.emitEvent(id, event);
	}

	/** Notify subscribers without feeding a platform-authored repair back into the live ledger. */
	private emitEvent(id: string, event: AgentSessionEvent): void {
		const set = this.listeners.get(id);
		if (!set) return;
		for (const listener of set) listener(event);
	}

	private captureToolExecutionEvent(id: string, event: AgentSessionEvent): void {
		if (event.type === "tool_execution_start") {
			let executions = this.toolExecutions.get(id);
			if (!executions) {
				executions = new Map();
				this.toolExecutions.set(id, executions);
			}
			executions.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName });
			return;
		}
		if (event.type === "tool_execution_end") {
			let executions = this.toolExecutions.get(id);
			if (!executions) {
				executions = new Map();
				this.toolExecutions.set(id, executions);
			}
			executions.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				ended: true,
				result: event.result,
				isError: event.isError,
			});
			return;
		}
		if (event.type === "message_start" && event.message.role === "toolResult") {
			const executions = this.toolExecutions.get(id);
			executions?.delete(event.message.toolCallId);
			if (executions?.size === 0) this.toolExecutions.delete(id);
		}
	}

	/**
	 * 订阅会话事件（跨实例重建存活）：listener 挂在 sessionId 上，装配新
	 * 实例时自动接力。返回退订函数。
	 */
	subscribe(id: string, listener: (event: AgentSessionEvent) => void): () => void {
		let set = this.listeners.get(id);
		if (!set) {
			set = new Set();
			this.listeners.set(id, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(id);
		};
	}

	/**
	 * 立即撤权（§3.3.6）：配置变化后，活跃会话里不再允许的工具立刻从
	 * active tools 移除（新增 Agent 的工具要等空闲重建才会出现）；所有活跃
	 * 会话标记 runtimeDirty，下次空闲 open 时彻底重建。
	 * §10.5/§10.6：manager 的 thinking level 是运行时即改项，但只刷新**没有
	 * 会话级选择**的会话；thinkingOverrides 里的 Session 跳过，清除配置
	 * （null）时按 SDK 默认链（per-model override → 全局默认 → medium）
	 * 回退，不允许 `if (level && ...)` 判空吃掉清除语义。
	 */
	private async revokeChangedTools(): Promise<void> {
		this.configEpoch++;
		if (!this.teamsStore) return;
		const settings = await this.managerSettings();
		for (const [id, session] of this.active) {
			const ctx = await this.windowContextOf(id);
			const plan = await planManagerTools(this.teamsStore, this.catalog, ctx);
			const assembled = this.assembledManaged.get(id) ?? new Set<string>();
			const active = session.getActiveToolNames();
			const next = active.filter((n) => !assembled.has(n) || plan.active.has(n));
			if (next.length !== active.length) session.setActiveToolsByName(next);
			if (!this.thinkingOverrides.has(id)) {
				const fallback = this.sdkDefaultThinkingLevel(session);
				const target = (settings?.thinkingLevel ?? fallback) as PiThinkingLevel;
				if (target && session.thinkingLevel !== target) {
					session.setThinkingLevel(target);
				}
			}
			this.runtimeDirty.add(id);
		}
	}

	/** 该 Session 在 SDK 默认链下的 thinking level（不含 manager 配置）。 */
	private sdkDefaultThinkingLevel(session: AgentSession): PiThinkingLevel {
		const model = session.model as PiModel | undefined;
		const settingsManager = session.settingsManager;
		const perModel = model ? settingsManager?.getModelThinkingLevel(model.provider, model.id) : undefined;
		const resolved = perModel ?? settingsManager?.getDefaultThinkingLevel() ?? "medium";
		return isPiThinkingLevel(resolved) ? resolved : "medium";
	}

	/**
	 * 配置写操作后的同步入口（路由调用）：等待撤权/标记完成再计算统计，
	 * 保证 API 响应里的 affectedSessions 是确定值而不是竞态快照。
	 */
	async syncAgentConfigChange(): Promise<void> {
		await this.revokeChangedTools();
	}

	/** Extension 包更新/卸载后，所有活跃会话空闲时重建装配。 */
	markAllDirty(): void {
		this.configEpoch++;
		for (const id of this.active.keys()) this.runtimeDirty.add(id);
	}

	/**
	 * 信任撤销（§7.3）：引用该 workspace 的活跃窗口 Session 标
	 * runtimeDirty，当前轮结束后空闲重建；返回受影响会话数。
	 */
	async markWorkspaceDirty(workspaceId: string): Promise<number> {
		if (!this.teamsStore) return 0;
		let marked = 0;
		for (const id of this.active.keys()) {
			const context = await this.teamsStore.contextForSession(id);
			if (context?.workspaceId !== workspaceId) continue;
			this.runtimeDirty.add(id);
			marked++;
		}
		return marked;
	}

	/**
	 * 受影响 manager Session 统计（§10.1 响应字段）：该 Agent 的工具出现在
	 * 多少活跃会话的装配里（active_now=已立即撤权）、其中多少已标
	 * runtimeDirty 等空闲重建（reload_pending）。
	 */
	agentSessionStats(agentName: string): { affectedSessions: number; activeNow: number; reloadPending: number } {
		const prefix = `agent_${toolSafeId(agentName)}__`;
		let affectedSessions = 0;
		let reloadPending = 0;
		for (const [id, assembled] of this.assembledManaged) {
			if (!this.active.has(id)) continue;
			// Manager 自身的 Session runtime（Skills/CLI 环境）不产生 agent_*
			// 命名空间工具，但其 Capability 变更仍影响所有活跃 manager Session。
			if (agentName !== MANAGER_AGENT_NAME && ![...assembled].some((n) => n.startsWith(prefix))) continue;
			affectedSessions++;
			if (this.runtimeDirty.has(id)) reloadPending++;
		}
		return { affectedSessions, activeNow: affectedSessions, reloadPending };
	}

	/** Window context for a session, resolved from the window store. */
	private async windowContextOf(
		sessionId: string,
	): Promise<ManagerWindowContext | undefined> {
		if (!this.teamsStore) return undefined;
		const context = await this.teamsStore.contextForSession(sessionId);
		if (!context) return undefined;
		const w = context.window;
		const cwd = await this.teamsStore.workspaceForSession(sessionId);
		// 显示名快照：提示词（guidance/roster）渲染显示名，members 仍是内部 id。
		const displayNames: Record<string, string> = {};
		for (const a of await this.teamsStore.listAgents()) displayNames[a.name] = agentDisplayName(a);
		return { type: w.type, members: w.members, displayNames, prompt: w.prompt, workspaceId: context.workspaceId, cwd };
	}

	/** Shared model runtime (auth + model catalog)：进程级单例（model-runtime.ts），
	 * models.json/auth.json 变更后由写路径 reset，这里永远取最新装配。 */
	private runtime(): Promise<ModelRuntime> {
		return sharedModelRuntime();
	}

	private static summarizeModel(model: PiModel): ModelSummary {
		return {
			id: `${model.provider}/${model.id}`,
			name: model.name,
			provider: model.provider,
			reasoning: model.reasoning,
			thinkingLevels: PiSessionStore.supportedThinkingLevels(model),
			thinkingGraded: PiSessionStore.thinkingGraded(model),
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		};
	}

	/** 与 pi-ai getSupportedThinkingLevels 同规则：null=禁用；xhigh/max 须显式声明；非推理=仅 off。 */
	private static supportedThinkingLevels(model: PiModel): string[] {
		if (!model.reasoning) return ["off"];
		const map = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
		return PI_THINKING_LEVELS.filter((level) => {
			const mapped = map?.[level];
			if (mapped === null) return false;
			if (level === "xhigh" || level === "max") return mapped !== undefined;
			return true;
		});
	}

	/**
	 * 档位是否真正分级：把每个非 off 档位经 clamp 归一后，映射到该 api 实际会
	 * 发出的字段（effort 值），去重后多于一种即为分级。
	 *
	 * 判定复刻 pi-ai adapter 的出参逻辑（openai-completions 的
	 * zai/qwen/deepseek 三个方言都受 `compat.supportsReasoningEffort` 门控），
	 * 不发请求即可得出结论。仅用于 UI 如实标注，不参与请求构造。
	 */
	private static thinkingGraded(model: PiModel): boolean {
		if (!model.reasoning) return false;
		const compat = (model as { compat?: Record<string, unknown> }).compat ?? {};
		const map = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
		const levels = PiSessionStore.supportedThinkingLevels(model);
		const onLevels = levels.filter((level) => PiSessionStore.clampLevel(level, levels) !== "off");
		if (onLevels.length === 0) return false;
		// 只在受 supportsReasoningEffort 门控的方言上，档位才可能落到线上字段。
		const gated = compat.thinkingFormat === "zai" || compat.thinkingFormat === "qwen" || compat.thinkingFormat === "deepseek";
		const effective = onLevels.map((level) => {
			const eff = PiSessionStore.clampLevel(level, levels);
			return gated && compat.supportsReasoningEffort !== true ? "on" : String(map?.[eff] ?? eff);
		});
		return new Set(effective).size > 1;
	}

	/** 在给定可用集合内钳制到最近档（与 pi-ai clampThinkingLevel 同序：先向上再向下）。 */
	private static clampLevel(level: string, available: string[]): string {
		if (available.includes(level)) return level;
		const index = PI_THINKING_LEVELS.indexOf(level as PiThinkingLevel);
		for (let i = index; i < PI_THINKING_LEVELS.length; i++) {
			if (available.includes(PI_THINKING_LEVELS[i]!)) return PI_THINKING_LEVELS[i]!;
		}
		for (let i = index - 1; i >= 0; i--) {
			if (available.includes(PI_THINKING_LEVELS[i]!)) return PI_THINKING_LEVELS[i]!;
		}
		return available[0] ?? "off";
	}

	/** Models the user can pick: available (auth configured), else full catalog. */
	async listModels(): Promise<ModelSummary[]> {
		const rt = await this.runtime();
		let models: readonly PiModel[];
		try {
			models = await rt.getAvailable();
		} catch {
			models = rt.getModels();
		}
		if (models.length === 0) models = rt.getModels();
		return models.map((m) => PiSessionStore.summarizeModel(m as PiModel));
	}

	/** Full provider catalog with per-provider auth status. */
	async listProviders(): Promise<ProviderSummary[]> {
		const rt = await this.runtime();
		return rt
			.getProviders()
			.map((p) => ({
				id: p.id,
				name: p.name,
				modelCount: rt.getModels(p.id).length,
				configured: rt.hasConfiguredAuth(p.id),
				oauth: rt.isUsingOAuth(p.id),
				baseUrl: p.baseUrl,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Full catalog models for one provider (no auth required), matching listProviders().modelCount. */
	async listProviderModels(providerId: string): Promise<ModelSummary[]> {
		const rt = await this.runtime();
		return rt.getModels(providerId).map((m) => PiSessionStore.summarizeModel(m as PiModel));
	}

	async hasProvider(providerId: string): Promise<boolean> {
		return (await this.runtime()).getProvider(providerId) !== undefined;
	}

	/** Check the selected model before accepting a new work's first message. */
	async hasModelAuth(providerId: string): Promise<boolean> {
		return (await this.runtime()).hasConfiguredAuth(providerId);
	}

	/**
	 * Store a provider API key: in-memory runtime override (no network
	 * validation in the SDK — the key is trusted as-is) plus durable in the
	 * platform's own auth.json（<home>/secrets/auth.json，与 pi CLI 解耦
	 * §10.6）via the runtime's own credential store. Writing through
	 * `credentials.modify` is required: the SDK's AuthStorage keeps an
	 * in-memory snapshot of auth.json, so direct file writes are invisible to
	 * availability refreshes until the process restarts.
	 */
	async setProviderKey(providerId: string, apiKey: string): Promise<{ availableCount: number }> {
		const rt = await this.runtime();
		try {
			await rt.setRuntimeApiKey(providerId, apiKey);
			await PiSessionStore.credentialsOf(rt).modify(providerId, async () => ({
				type: "api_key",
				key: apiKey,
			}));
		} catch (err) {
			// SDK 先安装运行时 override；若持久写入失败，不能让本进程继续
			// 使用一个重启后就会消失、而页面又收到失败响应的新 key。
			await rt.removeRuntimeApiKey(providerId).catch((cleanupErr: unknown) => {
				this.debugLog?.(`Provider key 失败清理运行时 override：${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
			});
			throw err;
		}
		const availableCount = (await rt.getAvailable(providerId)).length;
		// 自愈不阻断写 key 的主流程。
		await this.healPlaceholderModelSessions(providerId).catch((err: unknown) => {
			this.debugLog?.(`占位模型会话自愈失败：${err instanceof Error ? err.message : String(err)}`);
		});
		return { availableCount };
	}

	/**
	 * 全新部署未 init/未配 key 时建起的会话（首屏 solo 必然如此）会被 SDK
	 * 装配 provider="unknown" 的占位模型；之后配好 key 它也不会自愈，prompt
	 * 永远报 "No API key found for the selected model."。key 写入后把这类
	 * 存活会话重新装配：manager 默认模型可用则用，否则用刚配置的 provider
	 * 的首个可用模型（作用域内查询，避免全目录 getAvailable 的网络探测）。
	 */
	private async healPlaceholderModelSessions(providerId: string): Promise<void> {
		const targets = [...this.active.values()].filter((s) => {
			const m = s.model as PiModel | undefined;
			return !m || m.provider === "unknown";
		});
		if (targets.length === 0) return;
		const rt = await this.runtime();
		let model: PiModel | undefined;
		const preferredRef = (await this.managerSettings())?.model;
		if (preferredRef) {
			const resolved = await this.resolveModel(preferredRef).catch(() => undefined);
			if (resolved && rt.hasConfiguredAuth(resolved.provider)) model = resolved;
		}
		model ??= (await rt.getAvailable(providerId))[0] as PiModel | undefined;
		if (!model) return;
		await Promise.all(
			targets.map((s) =>
				s.setModel(model as PiModel).catch((err: unknown) => {
					this.debugLog?.(`会话 ${s.sessionId} 模型自愈失败：${err instanceof Error ? err.message : String(err)}`);
				}),
			),
		);
	}

	/**
	 * Remove a provider API key. `credentials.delete` clears the runtime
	 * override, the auth.json entry and AuthStorage's in-memory snapshot in one
	 * step; removeRuntimeApiKey then triggers the availability refresh over
	 * that updated state.
	 */
	async removeProviderKey(providerId: string): Promise<void> {
		const rt = await this.runtime();
		await PiSessionStore.credentialsOf(rt).delete(providerId);
		await rt.removeRuntimeApiKey(providerId);
	}

	/** Preserve the exact credential shape for same-process Provider deletion compensation. */
	async snapshotProviderCredential(providerId: string): Promise<unknown> {
		return PiSessionStore.credentialsOf(await this.runtime()).read(providerId);
	}

	async restoreProviderCredential(providerId: string, credential: unknown): Promise<void> {
		const rt = await this.runtime();
		if (credential === undefined) await PiSessionStore.credentialsOf(rt).delete(providerId);
		else await PiSessionStore.credentialsOf(rt).modify(providerId, async () => credential);
		await rt.removeRuntimeApiKey(providerId);
	}

	/**
	 * Access the runtime's credential overlay. `ModelRuntime.credentials` is
	 * not part of the public type surface, but it is the only write path that
	 * keeps auth.json and AuthStorage's cache coherent (see setProviderKey).
	 */
	private static credentialsOf(rt: ModelRuntime): {
		read(providerId: string): Promise<unknown>;
		modify(providerId: string, fn: (current: unknown) => Promise<unknown>): Promise<unknown>;
		delete(providerId: string): Promise<void>;
	} {
		return (
			rt as unknown as {
				credentials: {
					read(providerId: string): Promise<unknown>;
					modify(providerId: string, fn: (current: unknown) => Promise<unknown>): Promise<unknown>;
					delete(providerId: string): Promise<void>;
				};
			}
		).credentials;
	}

	/** Resolve a `${provider}/${modelId}` reference (or bare model id) to a pi Model. */
	private async resolveModel(ref: string): Promise<PiModel> {
		const rt = await this.runtime();
		const slash = ref.indexOf("/");
		// Model ids themselves may contain "/" (e.g. openrouter), so split on the first.
		const model =
			slash > 0
				? rt.getModel(ref.slice(0, slash), ref.slice(slash + 1))
				: rt.getModels().find((m) => m.id === ref);
		if (!model) throw new Error(`Unknown model: ${ref}`);
		return model as PiModel;
	}

	async create(
		modelRef?: string,
		window?: ManagerWindowContext,
		sessionId?: string,
	): Promise<SessionSummary> {
		if (sessionId && (await this.list()).some((item) => item.id === sessionId)) {
			throw new Error(`Session already exists: ${sessionId}`);
		}
		const model = modelRef ? await this.resolveModel(modelRef) : undefined;
		const cwd = window?.cwd ?? this.cwd;
		const binding: { sessionId: string } = { sessionId: "" };
		const sessionManager = SessionManager.create(cwd, this.sessionDir, sessionId ? { id: sessionId } : undefined);
		let session: AgentSession | undefined;
		for (let attempt = 0; attempt < 4; attempt++) {
			const epoch = this.configEpoch;
			const candidate = await this.assembleSession({ sessionManager, model, ctx: window, cwd, getSessionId: () => binding.sessionId });
			if (epoch === this.configEpoch) { session = candidate; break; }
			candidate.dispose();
			this.assembledManaged.delete(candidate.sessionId);
		}
		if (!session) throw new Error("Manager 配置在会话装配期间持续变化，请重试");
		binding.sessionId = session.sessionId;
		const summary = await this.summarize(session);
		// A newly created Session is already a durable product identity even before
		// its first assistant message. Materialize the header immediately so an
		// Agent/Extension mutation can rebuild this idle Session before its first
		// user turn. Otherwise runtimeDirty remains stuck on a fileless instance and
		// newly added Worker tools are absent from that first provider schema.
		await this.ensureSessionFile(summary.id);
		return { ...summary, sessionFile: session.sessionFile ?? summary.sessionFile };
	}

	async list(): Promise<SessionSummary[]> {
		// `sessionDir` is shared by every manager Window, including Windows that
		// belong to different Workspaces. SessionManager.list(cwd, sessionDir)
		// filters that directory by one cwd, which makes sessions from other
		// Workspaces invisible after restart (and can also miss macOS /tmp ->
		// /private/tmp canonical-path aliases). Discover by the owned directory;
		// Window ownership remains the authority when a session is opened.
		const sessions = await SessionManager.listAll(this.sessionDir);
		const summaries = await Promise.all(
			sessions.map(async (info) => ({
				id: info.id,
				sessionFile: info.path,
				firstMessage: info.firstMessage,
				name: info.name,
				modifiedAt: info.modified.toISOString(),
				active: this.active.has(info.id),
				model: this.active.has(info.id)
					? PiSessionStore.modelRefOf(this.active.get(info.id)!)
					: await PiSessionStore.modelRefOfFile(info.path),
				thinkingLevel: this.active.has(info.id)
					? PiSessionStore.thinkingLevelOf(this.active.get(info.id)!)
					: await PiSessionStore.thinkingLevelOfFile(info.path),
			})),
		);
		const byId = new Map(summaries.map((summary) => [summary.id, summary]));
		for (const session of this.active.values()) {
			const existing = byId.get(session.sessionId);
			if (existing) {
				// 内存中的名称可能比尚未 flush 的磁盘 session_info 更新。
				existing.name = session.sessionName;
				existing.active = true;
				continue;
			}
			summaries.push({
				id: session.sessionId,
				sessionFile: session.sessionFile ?? "",
				firstMessage: "",
				name: session.sessionName,
				modifiedAt: new Date().toISOString(),
				active: true,
				model: PiSessionStore.modelRefOf(session),
				thinkingLevel: PiSessionStore.thinkingLevelOf(session),
			});
		}
		return summaries;
	}

	/** 存活会话的当前模型 ref。 */
	private static modelRefOf(session: AgentSession): string | undefined {
		const model = session.model as PiModel | undefined;
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	/** 磁盘会话的当前模型 ref：JSONL 最后一条 model_change（best-effort）。 */
	private static async modelRefOfFile(sessionFile: string): Promise<string | undefined> {
		try {
			const content = await readFile(sessionFile, "utf8");
			const lines = content.split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i]!;
				if (!line.includes('"model_change"')) continue;
				const parsed = JSON.parse(line) as { type?: string; provider?: string; modelId?: string };
				if (parsed.type === "model_change" && parsed.provider && parsed.modelId) {
					return `${parsed.provider}/${parsed.modelId}`;
				}
			}
		} catch {
			// 读取失败不影响列表主流程。
		}
		return undefined;
	}

	/** 存活会话的当前 thinking level。 */
	private static thinkingLevelOf(session: AgentSession): string | undefined {
		const level = session.thinkingLevel;
		return typeof level === "string" && level ? level : undefined;
	}

	/** 磁盘会话的当前 thinking level：JSONL 最后一条 thinking_level_change（best-effort）。 */
	private static async thinkingLevelOfFile(sessionFile: string): Promise<string | undefined> {
		try {
			const content = await readFile(sessionFile, "utf8");
			const lines = content.split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i]!;
				if (!line.includes('"thinking_level_change"')) continue;
				const parsed = JSON.parse(line) as { type?: string; thinkingLevel?: string };
				if (parsed.type === "thinking_level_change" && typeof parsed.thinkingLevel === "string" && parsed.thinkingLevel) {
					return parsed.thinkingLevel;
				}
			}
		} catch {
			// 读取失败不影响列表主流程。
		}
		return undefined;
	}

	/** Return the live AgentSession for a session id, opening it from file if needed. */
	async open(id: string): Promise<AgentSession> {
		const existing = this.active.get(id);
		if (existing) {
			// 空闲安全 reload（§3.3.6）：配置变化标记过 runtimeDirty 的会话在
			// 空闲时重建 ResourceLoader/AgentSession，彻底移除遗留 hooks；原
			// JSONL 历史不动，重建只改变运行时装配。文件尚未落盘的会话（从未
			// 收到消息）无法从 JSONL 重建——撤权已由 active tools 收紧完成，
			// 保持内存会话，等首次落盘后的下次 open 再重建。
			const rebuildable =
				this.runtimeDirty.has(id) &&
				existing.isIdle &&
				Boolean(existing.sessionFile) &&
				existsSync(existing.sessionFile!);
			if (!rebuildable) return existing;
			existing.dispose();
			this.active.delete(id);
			this.assembledManaged.delete(id);
		}
		this.runtimeDirty.delete(id);

		const info = (await SessionManager.listAll(this.sessionDir)).find((s) => s.id === id);
		if (!info) throw new Error(`Session not found: ${id}`);

		const ctx = await this.windowContextOf(id);
		if (this.teamsStore && !ctx) {
			throw new Error(`Session has no Window owner: ${id}`);
		}
		const cwd = ctx?.cwd ?? this.cwd;
		const sessionManager = SessionManager.open(info.path, this.sessionDir);
		const [recordedCwd, expectedCwd] = await Promise.all([
			realpath(sessionManager.getCwd()).catch(() => sessionManager.getCwd()),
			realpath(cwd).catch(() => cwd),
		]);
		if (recordedCwd !== expectedCwd) {
			throw new Error(`Session cwd does not match its Window context: ${id}`);
		}
		const recordedModelRef = await PiSessionStore.modelRefOfFile(info.path);
		const recordedModel = recordedModelRef
			? await this.resolveModel(recordedModelRef).catch((err: unknown) => {
					this.debugLog?.(`会话 ${id} 的记录模型解析失败：${err instanceof Error ? err.message : String(err)}`);
					return undefined;
				})
			: undefined;
		let session: AgentSession | undefined;
		for (let attempt = 0; attempt < 4; attempt++) {
			const epoch = this.configEpoch;
			const candidate = await this.assembleSession({
				sessionManager, model: recordedModel, ctx, cwd, getSessionId: () => id, preferRecordedModel: true, preferRecordedThinkingLevel: true,
			});
			if (epoch === this.configEpoch) { session = candidate; break; }
			candidate.dispose();
			this.assembledManaged.delete(candidate.sessionId);
		}
		if (!session) throw new Error("Manager 配置在会话装配期间持续变化，请重试");
		this.active.set(session.sessionId, session);
		// §10.6：重启后恢复会话级 thinking 选择。SDK 恢复的是 JSONL 落盘档位，
		// 与「manager 默认档位按当前模型 clamp 后」不一致即视为用户选择，
		// 登记 thinkingOverrides——否则进程重启后 thinkingOverrides 为空，
		// 下一次 manager 配置变更会把用户的选择广播覆盖掉。
		await this.registerThinkingOverrideIfDiverged(id, session);
		return session;
	}

	/** 落盘档位与默认链不一致时登记会话级 thinking 选择（best-effort 发散判定）。 */
	private async registerThinkingOverrideIfDiverged(id: string, session: AgentSession): Promise<void> {
		if (this.thinkingOverrides.has(id)) return;
		const recorded = PiSessionStore.thinkingLevelOf(session);
		if (!recorded || !isPiThinkingLevel(recorded)) return;
		const settings = await this.managerSettings();
		const expectedDefault: PiThinkingLevel = settings?.thinkingLevel ?? this.sdkDefaultThinkingLevel(session);
		const expected = PiSessionStore.clampThinkingLevel(session, expectedDefault);
		if (recorded !== expected) this.thinkingOverrides.set(id, recorded);
	}

	/** 与 pi-ai clampThinkingLevel 同序：可用集合内先向上、再向下取最近可用档。 */
	private static clampThinkingLevel(session: AgentSession, level: PiThinkingLevel): PiThinkingLevel {
		const available = session.getAvailableThinkingLevels().filter(isPiThinkingLevel);
		if (available.length === 0 || available.includes(level)) return available.includes(level) ? level : (available[0] ?? "off");
		const requestedIndex = PI_THINKING_LEVELS.indexOf(level);
		for (let i = requestedIndex; i < PI_THINKING_LEVELS.length; i++) {
			const candidate = PI_THINKING_LEVELS[i]!;
			if (available.includes(candidate)) return candidate;
		}
		for (let i = requestedIndex - 1; i >= 0; i--) {
			const candidate = PI_THINKING_LEVELS[i]!;
			if (available.includes(candidate)) return candidate;
		}
		return available[0] ?? "off";
	}

	private pendingToolCalls(session: AgentSession): Array<{ id: string; name: string }> {
		const calls: Array<{ id: string; name: string }> = [];
		const seen = new Set<string>();
		const settled = new Set<string>();
		for (const entry of session.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as {
				role?: string;
				toolCallId?: string;
				content?: Array<{ type?: string; id?: string; name?: string }>;
			};
			if (message.role === "toolResult" && message.toolCallId) {
				settled.add(message.toolCallId);
				continue;
			}
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type !== "toolCall" || !block.id || seen.has(block.id)) continue;
				seen.add(block.id);
				calls.push({ id: block.id, name: block.name ?? "unknown" });
			}
		}
		return calls.filter((call) => !settled.has(call.id));
	}

	private appendRecoveredToolResult(session: AgentSession, result: RecoveredToolResult): boolean {
		if (!this.pendingToolCalls(session).some((call) => call.id === result.toolCallId)) return false;
		const timestamp = Date.now();
		const message = {
			role: "toolResult" as const,
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			content: [{ type: "text" as const, text: result.text }],
			details: result.details,
			isError: result.isError,
			timestamp,
		};
		session.sessionManager.appendMessage(message);
		// SessionManager is the durable source; the resident AgentSession state is
		// the HTTP replay source.  Update both at the same write boundary.
		session.state.messages.push(message);
		this.toolExecutions.get(session.sessionId)?.delete(result.toolCallId);
		this.emitEvent(session.sessionId, {
			type: "tool_execution_end",
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			result: { content: message.content, details: result.details },
			isError: result.isError,
		} as AgentSessionEvent);
		return true;
	}

	private async terminalDelegationResults(
		managerSessionId: string,
		pendingCalls: Map<string, string>,
	): Promise<Map<string, RecoveredToolResult>> {
		const recovered = new Map<string, RecoveredToolResult>();
		if (!this.invoker || pendingCalls.size === 0) return recovered;
		const recoverableStates = new Set(["waiting_admission", "reported_completed", "reported_failed", "cancelled", "observation_lost"]);
		const grouped = new Map<string, DelegationRecord[]>();
		for (const delegation of await this.invoker.delegationsForManagerSession(managerSessionId)) {
			const callId = delegation.managerToolCallId;
			const expectedName = callId ? pendingCalls.get(callId) : undefined;
			if (!callId || !expectedName || expectedName !== delegateToolName(delegation.agentId) || !recoverableStates.has(delegation.executionState)) continue;
			const group = grouped.get(callId) ?? [];
			group.push(delegation);
			grouped.set(callId, group);
		}
		for (const [callId, delegations] of grouped) {
			if (delegations.length === 1) {
				const delegation = delegations[0]!;
				let result = delegationToolResult(delegation);
				if (delegation.executionState === "reported_completed" && delegation.result?.status === "completed" && this.largeResults && this.productSettings) {
					const projection = await this.largeResults.project(
						delegation.id,
						delegation.result.content ?? "",
						(await this.productSettings.get()).harness.workerResults,
					);
					result = {
						...result,
						text: `${projection.text}\n\n（delegationId：${delegation.id}——需要该 worker 接力/追问时，用 handoffKind="followup" 并把它填进 parentDelegationId）`,
						details: { ...(result.details ?? {}), ...projection },
					};
				}
				recovered.set(callId, result);
				continue;
			}
			recovered.set(callId, {
				toolCallId: callId,
				toolName: pendingCalls.get(callId)!,
				text: "检测到多个 Delegation 绑定同一个 manager 工具调用，无法安全选择结果。",
				details: {
					status: "failed",
					errorCode: "delegation_projection_conflict",
					delegationIds: delegations.map((delegation) => delegation.id),
				},
				isError: true,
			});
		}
		return recovered;
	}

	/**
	 * Refresh recovery: terminal Delegations are authoritative even when the pi
	 * turn lost its native toolResult.  While the SDK is still streaming we only
	 * return an overlay (physical append would race its later native result); once
	 * idle, append the missing result idempotently to the Session JSONL.
	 */
	async recoverToolCallState(id: string): Promise<RecoveredToolCallState> {
		return this.serializeToolRepair(id, async () => {
			const session = await this.open(id);
			const pending = this.pendingToolCalls(session);
			const pendingCalls = new Map(pending.map((call) => [call.id, call.name]));
			const delegationResults = await this.terminalDelegationResults(id, pendingCalls);
			const captured = this.toolExecutions.get(id);
			const results = pending.flatMap((call) => {
				const observed = capturedToolResult(captured?.get(call.id) ?? { toolCallId: call.id, toolName: call.name });
				const result = observed ?? delegationResults.get(call.id);
				return result ? [{ ...result, toolName: call.name || result.toolName }] : [];
			});
			if (!session.isStreaming) {
				let wrote = false;
				for (const result of results) wrote = this.appendRecoveredToolResult(session, result) || wrote;
				if (wrote) await this.ensureSessionFile(id);
			}
			const terminalIds = new Set(results.map((result) => result.toolCallId));
			const running = new Set(
				pending
					.filter((call) => !terminalIds.has(call.id) && captured?.get(call.id)?.ended !== true && captured?.has(call.id))
					.map((call) => call.id),
			);
			if (this.invoker) {
				for (const callId of await this.invoker.runningDelegateToolCallIds(id)) {
					if (pendingCalls.has(callId) && !terminalIds.has(callId)) running.add(callId);
				}
			}
			return { recoveredToolResults: results, runningToolCallIds: [...running] };
		});
	}

	/** Compatibility helper for callers that only need terminal overlays. */
	async recoverTerminalToolResults(id: string): Promise<RecoveredToolResult[]> {
		return (await this.recoverToolCallState(id)).recoveredToolResults;
	}

	/**
	 * Stop external execution before entering the short JSONL repair critical
	 * section. AgentSession/Driver cancellation is bounded: an uncooperative tool
	 * must not monopolize the repair queue and make refresh hang behind Stop.
	 */
	isRunning(id: string): boolean {
		const session = this.active.get(id);
		return Boolean(session && (session.isStreaming || !session.isIdle));
	}

	async abort(id: string): Promise<AbortSessionResult> {
		const session = this.active.get(id);
		const wasRunning = Boolean(session && (session.isStreaming || !session.isIdle));
		let abortError: unknown;
		const bounded = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
			let timer: NodeJS.Timeout | undefined;
			try {
				return await Promise.race([
					promise,
					new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};
		const cancelPromise = this.invoker
			? bounded(this.invoker.cancelManagerSession(id), 8_000, "停止 Worker/Teams 准入超时；执行效果可能未知")
			: Promise.resolve(0);
		const managerAbortPromise = wasRunning && session
			? bounded(session.abort(), 5_000, "停止 Manager 超时；未结束工具的执行效果未知").then(() => undefined)
			: Promise.resolve();
		const [cancelResult, managerAbortResult] = await Promise.allSettled([cancelPromise, managerAbortPromise]);
		const cancelledDelegations = cancelResult.status === "fulfilled" ? cancelResult.value : 0;
		if (cancelResult.status === "rejected") abortError = cancelResult.reason;
		if (managerAbortResult.status === "rejected") abortError ??= managerAbortResult.reason;

		if (!session) {
			const recovered = cancelledDelegations > 0 ? await this.recoverToolCallState(id) : undefined;
			if (abortError) throw abortError;
			return { aborted: cancelledDelegations > 0, reconciledToolResults: recovered?.recoveredToolResults.length ?? 0 };
		}

		return this.serializeToolRepair(id, async () => {

			const pending = this.pendingToolCalls(session);
			const pendingCalls = new Map(pending.map((call) => [call.id, call.name]));
			const delegationResults = await this.terminalDelegationResults(id, pendingCalls);
			const captured = this.toolExecutions.get(id);
			let reconciledToolResults = 0;
			for (const call of pending) {
				const delegationResult = delegationResults.get(call.id);
				const observedResult = capturedToolResult(captured?.get(call.id) ?? { toolCallId: call.id, toolName: call.name });
				const result = observedResult
					? { ...observedResult, toolName: call.name || observedResult.toolName }
					: delegationResult
						? { ...delegationResult, toolName: call.name || delegationResult.toolName }
						: {
							toolCallId: call.id,
							toolName: call.name,
							text: "Manager 已停止等待该工具调用；中断前未观测到执行面的终态，实际效果未知。",
							details: { status: "interrupted", errorCode: "manager_aborted_effect_unknown" },
							isError: true,
						};
				if (this.appendRecoveredToolResult(session, result)) reconciledToolResults++;
			}
			if (reconciledToolResults > 0) await this.ensureSessionFile(id);
			if (abortError) throw abortError;
			return { aborted: wasRunning || cancelledDelegations > 0, reconciledToolResults };
		});
	}

	/** Switch the model of a live session (pi SDK supports runtime setModel). */
	async setModel(id: string, modelRef: string): Promise<ModelSummary> {
		await this.requireActiveContext(id);
		const session = await this.open(id);
		const model = await this.resolveModel(modelRef);
		await session.setModel(model);
		return PiSessionStore.summarizeModel(model);
	}

	/**
	 * Switch the thinking level of a live session（§10.6 thinking binding 的会话级层）。
	 * SDK 会写 thinking_level_change 持久化并 clamp 到当前模型能力；平台记录
	 * thinkingOverrides，使后续 manager 配置变更不再广播覆盖该 Session。
	 * 返回会话实际生效的档位（clamp 后的值）。
	 */
	async setThinkingLevel(id: string, level: string): Promise<string> {
		await this.requireActiveContext(id);
		if (!isPiThinkingLevel(level)) {
			throw new Error(`thinkingLevel 必须是 ${PI_THINKING_LEVELS.join(" | ")}`);
		}
		const session = await this.open(id);
		session.setThinkingLevel(level);
		this.thinkingOverrides.set(id, level);
		return PiSessionStore.thinkingLevelOf(session) ?? level;
	}

	/** 会话当前 thinking level（会话级真值，composer 用；内存会话优先，磁盘回退 JSONL）。 */
	async thinkingLevelOf(id: string): Promise<string | undefined> {
		const session = this.active.get(id);
		if (session) return PiSessionStore.thinkingLevelOf(session);
		const info = (await SessionManager.listAll(this.sessionDir)).find((s) => s.id === id);
		return info ? PiSessionStore.thinkingLevelOfFile(info.path) : undefined;
	}

	/** 当前 manager Session 真实装配的 Skill 命令；与 pi 的 /skill:name 展开清单同源。 */
	async listSkillCommands(id: string): Promise<SessionSkillCommand[]> {
		const session = await this.open(id);
		return session.resourceLoader.getSkills().skills
			.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" as const }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 会话当前名称（未命名返回 ""）；direct 窗口首条消息自动起名前查它。 */
	async sessionName(id: string): Promise<string> {
		const session = await this.open(id);
		return session.sessionName ?? "";
	}

	/** Set the user-facing session name and persist it as a session_info entry. */
	async rename(id: string, name: string): Promise<SessionSummary> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("会话名称不能为空");
		if (trimmed.length > 60) throw new Error("会话名称不能超过 60 个字符");
		await this.requireActiveContext(id);
		const session = await this.open(id);
		session.setSessionName(trimmed);
		return this.summarize(session);
	}

	/** Dispose the session (aborting an in-flight run) and delete its JSONL file. */
	async remove(id: string): Promise<boolean> {		const session = this.active.get(id);
		if (session?.isStreaming) {
			await session.abort().catch(() => undefined);
		}
		await this.dispose(id);
		const info = (await SessionManager.listAll(this.sessionDir)).find((s) => s.id === id);
		const file = info?.path ?? session?.sessionFile;
		if (!file) return false;
		// A session with no messages yet may never have been written to disk.
		await unlink(file).catch((err: NodeJS.ErrnoException) => {
			if (err.code !== "ENOENT") throw err;
		});
		return true;
	}

	/** Stop and unload a Session while preserving its JSONL for workspace restoration. */
	async suspend(id: string): Promise<void> {
		const session = this.active.get(id);
		if (session?.isStreaming) await session.abort().catch(() => undefined);
		await this.dispose(id);
	}

	private async requireActiveContext(id: string): Promise<void> {
		const context = await this.teamsStore?.contextForSession(id);
		if (context && !context.active) throw new Error("该会话所属项目未激活，请先切换回对应项目");
	}

	/** Run a state-changing operation under the same lifecycle gate as workspace switching. */
	async withActiveContextLifecycle<T>(id: string, action: () => Promise<T>): Promise<T> {
		if (this.invoker) return this.invoker.withActiveSessionLifecycle(id, action);
		await this.requireActiveContext(id);
		return action();
	}

	/** Persist a possibly fileless live Session before its context is parked. */
	async prepareForParking(id: string): Promise<void> {
		await this.requireActiveContext(id);
		const session = await this.open(id);
		if (session.isStreaming) await session.abort();
		await this.ensureSessionFile(id);
		const persisted = (await SessionManager.listAll(this.sessionDir)).some((session) => session.id === id);
		if (!persisted) throw new Error(`Session could not be persisted before workspace switch: ${id}`);
	}

	/** Open once to verify that a parked JSONL exists and its recorded cwd matches its frozen context. */
	async validateStoredContext(id: string): Promise<void> {
		const context = await this.teamsStore?.contextForSession(id);
		if (!context) throw new Error(`Session has no Window owner: ${id}`);
		const info = (await SessionManager.listAll(this.sessionDir)).find((session) => session.id === id);
		if (!info) throw new Error(`Session not found: ${id}`);
		const stored = SessionManager.open(info.path, this.sessionDir);
		const [recordedCwd, expectedCwd] = await Promise.all([
			realpath(stored.getCwd()).catch(() => stored.getCwd()),
			realpath(context.cwdSnapshot).catch(() => context.cwdSnapshot),
		]);
		if (recordedCwd !== expectedCwd) throw new Error(`Session cwd does not match its Window context: ${id}`);
	}

	async dispose(id: string): Promise<void> {
		const session = this.active.get(id);
		if (session) {
			session.dispose();
			this.active.delete(id);
		}
		this.assembledManaged.delete(id);
		this.runtimeDirty.delete(id);
		this.toolExecutions.delete(id);
	}

	/** True when the session is currently open in this process (even if it has
	 * no file on disk yet — pi persists lazily on the first assistant message). */
	isOpen(id: string): boolean {
		return this.active.has(id);
	}

	private hasCustomEvent(session: { messages: unknown }, eventId: string): boolean {
		return this.deliveredCustomEvents.has(eventId) || (session.messages as Array<{ role?: string; details?: unknown }>).some((entry) =>
			entry.role === "custom" &&
			entry.details !== null &&
			typeof entry.details === "object" &&
			(entry.details as { eventId?: unknown }).eventId === eventId
		);
	}

	private async deliverCustomMessage(
		id: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
		options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		if (!options.triggerTurn || !this.invoker) {
			return this.deliverCustomMessageUnlocked(id, message, options);
		}
		try {
			// The lifecycle gate protects only the active-context check plus the
			// synchronous prompt admission boundary. AgentSession.sendCustomMessage
			// resolves after the whole model turn; awaiting that promise inside the
			// gate blocks message history, new-session initialization, and workspace
			// switching for the entire run (notably during startup Goal recovery).
			const started = await this.invoker.withActiveSessionLifecycle(id, async () => ({
				completion: this.deliverCustomMessageUnlocked(id, message, options),
			}));
			return await started.completion;
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("所属项目未激活")) throw err;
			// The switch won the lifecycle race. Keep the terminal fact as audit,
			// but never enqueue a model turn into the parked context.
			return this.deliverCustomMessageUnlocked(id, message, { triggerTurn: false });
		}
	}

	private async deliverCustomMessageUnlocked(
		id: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
		options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const context = await this.teamsStore?.contextForSession(id);
		const parked = Boolean(context && !context.active);
		// Terminal/audit projections may finish after a switch. Preserve those
		// facts in the old JSONL, but a parked context must never wake the model.
		const effectiveOptions: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } = parked
			? { triggerTurn: false }
			: options;
		const session = await this.open(id);
		try {
			if (!effectiveOptions.triggerTurn && !session.isIdle) {
				// Display-only projections must be durable while the manager is still
				// inside the delegate tool call. Enqueuing one as an SDK nextTurn can
				// leave an approval card memory-only forever, while inserting a visible
				// custom entry into the unfinished assistant/tool sequence corrupts model
				// ordering. Persist a hidden audit projection; the web reducer promotes
				// interaction_required to a visible card without feeding it to the model.
				const timestamp = this.appendProjectionToSession(session, message);
				await this.ensureSessionFile(id);
				this.forwardEvent(id, {
					type: "message_start",
					message: {
						role: "custom",
						customType: message.customType,
						content: message.content,
						display: false,
						details: message.details,
						timestamp,
					},
				} as AgentSessionEvent);
				return;
			}
			const deliverAs = effectiveOptions.triggerTurn
				? (effectiveOptions.deliverAs ?? "followUp")
				: session.isIdle
					? undefined
					: "nextTurn";
			await session.sendCustomMessage(
				{ customType: message.customType, content: message.content, display: true, details: message.details },
				{ ...effectiveOptions, deliverAs },
			);
			await this.ensureSessionFile(id);
		} finally {
			if (parked) await this.dispose(id);
		}
	}

	/**
	 * Send a custom message into a manager session and optionally trigger a new
	 * LLM turn (§6.3). Best-effort: the session may be busy streaming; failures
	 * are swallowed so an approval can never block the caller.
	 *
	 * triggerTurn:false 是「纯展示」语义：pi SDK 在流式中会无视 triggerTurn
	 * 直接 followUp/steer 进模型队列，所以这里先等 run 落定再追加（有界），
	 * 仍在跑则降级 nextTurn，绝不把通知变成 manager 的复读轮。
	 */
	async sendCustomMessage(
		id: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
		options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		try {
			await this.deliverCustomMessage(id, message, options);
		} catch (err) {
			this.debugLog?.(`sendCustomMessage failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Audit-only metadata; never sent to a model or rendered as a chat message. */
	async workerRuntimeModel(id: string): Promise<import("../agent-runtime/types.js").RuntimeModelSettings> {
		const session = await this.open(id);
		if (!session.sessionFile || !existsSync(session.sessionFile)) return {};
		const branchIds = new Set(session.sessionManager.getBranch().map((entry) => entry.id));
		for (const line of readFileSync(session.sessionFile, "utf8").split("\n").reverse()) {
			if (!line) continue;
			const entry = JSON.parse(line) as { id: string; type: string; customType?: string; data?: { model?: unknown; effort?: unknown } };
			if (entry.type !== "custom" || entry.customType !== "pudding:worker-runtime-model" || !branchIds.has(entry.id)) continue;
			return { ...(typeof entry.data?.model === "string" ? { model: entry.data.model } : {}), ...(typeof entry.data?.effort === "string" ? { effort: entry.data.effort } : {}) };
		}
		return {};
	}

	async setWorkerRuntimeModel(id: string, settings: import("../agent-runtime/types.js").RuntimeModelSettings): Promise<void> {
		const session = await this.open(id);
		await this.ensureSessionFile(id);
		if (!session.sessionFile || !existsSync(session.sessionFile)) throw new Error("会话文件不可用，不能保存模型设置");
		const entryId = session.sessionManager.appendCustomEntry("pudding:worker-runtime-model", { ...settings });
		if (!session.sessionFile) throw new Error("会话设置未落盘");
		const descriptor = openSync(session.sessionFile, "r");
		try {
			fsyncSync(descriptor);
			if (!readFileSync(session.sessionFile, "utf8").split("\n").some((line) => {
				try { return (JSON.parse(line) as { id?: string }).id === entryId; } catch { return false; }
			})) throw new Error("会话设置未落盘");
		} finally { closeSync(descriptor); }
	}

	/** Direct user/assignment cards are admission facts: never swallow or accept a memory-only write. */
	async sendCustomMessageDurable(
		id: string,
		message: { customType: string; content: string; details: Record<string, unknown> & { operationId: string } },
	): Promise<void> {
		const session = await this.open(id);
		const priorIds = new Set(session.sessionManager.getBranch().map((entry) => entry.id));
		await this.deliverCustomMessage(id, message, { triggerTurn: false });
		await this.ensureSessionFile(id);
		const entry = session.sessionManager.getBranch().find((item) =>
			item.type === "custom_message" && !priorIds.has(item.id) &&
			item.display !== false && item.customType === message.customType && item.content === message.content &&
			(item.details as { operationId?: string } | undefined)?.operationId === message.details.operationId);
		if (!entry || !session.sessionFile) throw new Error("direct 消息卡未写入 Session，不能确认接收");
		const descriptor = openSync(session.sessionFile, "r");
		try {
			fsyncSync(descriptor);
			const persisted = readFileSync(session.sessionFile, "utf8").split("\n").some((line) => {
				if (!line) return false;
				try {
					const item = JSON.parse(line) as { id?: string; type?: string; display?: boolean; customType?: string; content?: string; details?: { operationId?: string } };
					return item.id === entry.id && item.type === "custom_message" && item.customType === message.customType &&
						item.display !== false && item.content === message.content && item.details?.operationId === message.details.operationId;
				} catch { return false; }
			});
			if (!persisted) throw new Error("direct 消息卡未写入 JSONL，不能确认接收");
		} finally { closeSync(descriptor); }
	}

	/** Bind a persisted pi user entry to the ordinary-message reservation after admission. */
	async appendMessageAdmission(
		id: string,
		facts: { operationId: string; requestHash: string; contextHash: string; userEntryId: string },
	): Promise<void> {
		const session = await this.open(id);
		if (!session.sessionFile) throw new Error("会话记录未落盘，不能写入消息接收凭据");
		const userPersisted = readFileSync(session.sessionFile, "utf8").split("\n").some((line) => {
			if (!line) return false;
			try {
				const entry = JSON.parse(line) as { id?: string; type?: string; message?: { role?: string } };
				return entry.id === facts.userEntryId && entry.type === "message" && entry.message?.role === "user";
			} catch { return false; }
		});
		if (!userPersisted) throw new Error("本次 user 未落盘，不能写入消息接收凭据");
		const priorIds = new Set(session.sessionManager.getBranch().map((entry) => entry.id));
		this.appendProjectionToSession(session, { customType: "pudding:message_admission", content: "", details: facts });
		await this.ensureSessionFile(id);
		const marker = session.sessionManager.getBranch().find((entry) =>
			entry.type === "custom_message" && !priorIds.has(entry.id) && entry.customType === "pudding:message_admission" &&
			(entry.details as { operationId?: string } | undefined)?.operationId === facts.operationId);
		if (!marker) throw new Error("消息接收凭据未进入会话记录");
		const descriptor = openSync(session.sessionFile, "r");
		try {
			fsyncSync(descriptor);
			const persisted = readFileSync(session.sessionFile, "utf8").split("\n").some((line) => {
				if (!line) return false;
				try {
					const entry = JSON.parse(line) as { id?: string; type?: string; customType?: string; display?: boolean; details?: typeof facts };
					return entry.id === marker.id && entry.type === "custom_message" && entry.customType === "pudding:message_admission" &&
						entry.display === false && entry.details?.operationId === facts.operationId && entry.details.requestHash === facts.requestHash &&
						entry.details.contextHash === facts.contextHash && entry.details.userEntryId === facts.userEntryId;
				} catch { return false; }
			});
			if (!persisted) throw new Error("消息接收凭据未落盘，不能确认接收");
		} finally { closeSync(descriptor); }
	}

	/**
	 * Append an audit-only custom entry directly to the SessionManager branch.
	 *
	 * This is used for a running delegate projection while the manager itself is
	 * still inside that delegate tool call. Going through AgentSession's
	 * sendCustomMessage would wait for idle (or enqueue a next turn), so a refresh
	 * during a long-running worker task could not recover the delegation id. The
	 * hidden entry is persisted immediately, does not enter the model queue, and
	 * is consumed by the web history reducer only to enrich the original tool card.
	 */
	private appendProjectionToSession(
		session: AgentSession,
		message: { customType: string; content: string; details?: Record<string, unknown> },
		display = false,
	): number {
		const entryId = session.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			display,
			message.details,
		);
		const entry = session.sessionManager.getEntry(entryId);
		const persistedAt = entry?.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
		const timestamp = Number.isNaN(persistedAt) ? Date.now() : persistedAt;

		// SessionManager 是持久化事实源；AgentSession.messages 是 HTTP/实时展示镜像。
		// 直写 SessionManager 不会像 sendCustomMessage 那样同步 agent state，若只
		// 广播事件，当前页面能看到元数据，但切换会话后的 /messages 会从驻留实例
		// 读到旧镜像，丢失 delegationId/processView。写入点同时更新两者，避免
		// 依赖刷新、重启或消费端猜测来修复分叉。
		session.state.messages.push({
			role: "custom",
			customType: message.customType,
			content: message.content,
			display,
			details: message.details,
			timestamp,
		});
		return timestamp;
	}

	async appendCustomMessageProjection(
		id: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
	): Promise<void> {
		try {
			const session = await this.open(id);
			const timestamp = this.appendProjectionToSession(session, message);
			await this.ensureSessionFile(id);
			// SessionManager direct appends do not emit AgentSession events. Mirror
			// this hidden projection onto the store subscription bus so an already
			// open manager page can enrich its delegate card immediately, not only
			// after a history reload.
			this.forwardEvent(id, {
				type: "message_start",
				message: {
					role: "custom",
					customType: message.customType,
					content: message.content,
					display: false,
					details: message.details,
					timestamp,
				},
			} as AgentSessionEvent);
		} catch (err) {
			this.debugLog?.(`appendCustomMessageProjection failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Outbox receiver-side dedupe. The event id lives in custom-message details,
	 * so a crash after JSONL append but before outbox acknowledgement is safe.
	 */
	async appendCustomMessageIfAbsent(
		id: string,
		eventId: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
		options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<DurableCustomMessageDisposition> {
		return this.serializeCustomEvent(async () => {
			const deliver = async (): Promise<DurableCustomMessageDisposition> => {
				const session = await this.open(id);
				if (this.hasCustomEvent(session, eventId)) return "duplicate";
				await this.deliverCustomMessageUnlocked(id, {
					...message,
					details: { ...(message.details ?? {}), eventId },
				}, options);
				this.deliveredCustomEvents.add(eventId);
				return "delivered";
			};
			if (!options.triggerTurn) return deliver();
			try {
				// As above, admit the durable wake-up while the active Window is
				// serialized, then release that short lock before awaiting the model
				// turn. The outer custom-event serializer still preserves eventId
				// dedupe until delivery is durably acknowledged.
				const started = await this.withActiveContextLifecycle(id, async () => ({ completion: deliver() }));
				return await started.completion;
			} catch (err) {
				if (!(err instanceof Error) || !err.message.includes("所属项目未激活")) throw err;
				// A durable wake-up that loses the workspace-switch race remains pending.
				// Preserve a separately-deduped audit fact, but never consume the real
				// eventId: reactivation must still be able to deliver the actual trigger.
				const auditEventId = `${eventId}:deferred-audit`;
				const parked = Boolean((await this.teamsStore?.contextForSession(id))?.active === false);
				try {
					const session = await this.open(id);
					if (!this.hasCustomEvent(session, auditEventId)) {
						await this.deliverCustomMessageUnlocked(id, {
							...message,
							details: { ...(message.details ?? {}), eventId: auditEventId, deferredEventId: eventId },
						}, { triggerTurn: false });
						this.deliveredCustomEvents.add(auditEventId);
					}
				} finally {
					if (parked) await this.dispose(id);
				}
				return "deferred";
			}
		});
	}

	/** Hidden outbox projection with the same receiver-side idempotency rule. */
	async appendCustomMessageProjectionIfAbsent(
		id: string,
		eventId: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
	): Promise<boolean> {
		return this.serializeCustomEvent(async () => {
			const parked = Boolean((await this.teamsStore?.contextForSession(id))?.active === false);
			try {
				const session = await this.open(id);
				if (this.hasCustomEvent(session, eventId)) return false;
				this.appendProjectionToSession(session, {
					...message,
					details: { ...(message.details ?? {}), eventId },
				});
				await this.ensureSessionFile(id);
				this.deliveredCustomEvents.add(eventId);
				return true;
			} finally {
				if (parked) await this.dispose(id);
			}
		});
	}

	/**
	 * 启动收割器补写：为孤儿委托的 manager 工具调用追加一条合成 toolResult，
	 * 让 manager 下次运行时能在上下文里看到失败原因并重新决策；前端历史重放
	 * 也会把它折成「失败」而不是「已中断」。仅在启动早期调用（会话尚未加载）。
	 * 返回 false 表示该会话里不存在匹配的 toolCall（如 direct 直派链路的
	 * managerToolCallId 其实是 taskId，没有工具调用），调用方应改用自定义卡。
	 */
	async appendToolResultIfPending(
		id: string,
		input: { toolCallId: string; toolName: string; text: string; details?: Record<string, unknown>; isError?: boolean },
	): Promise<boolean> {
		try {
			return await this.serializeToolRepair(id, async () => {
				const parked = Boolean((await this.teamsStore?.contextForSession(id))?.active === false);
				try {
					const session = await this.open(id);
					const messages = session.sessionManager.getBranch()
						.filter((entry) => entry.type === "message")
						.map((entry) => entry.message) as Array<{ role?: string; toolCallId?: string; content?: unknown }>;
					if (messages.some((message) => message.role === "toolResult" && message.toolCallId === input.toolCallId)) return true;
					let actualToolName: string | undefined;
					for (const message of messages) {
						if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
						const block = message.content.find((candidate) =>
							Boolean(candidate) && typeof candidate === "object" && (candidate as { type?: unknown }).type === "toolCall" && (candidate as { id?: unknown }).id === input.toolCallId,
						) as { name?: unknown } | undefined;
						if (typeof block?.name === "string") {
							actualToolName = block.name;
							break;
						}
					}
					if (!actualToolName) return false;
					const wrote = this.appendRecoveredToolResult(session, { ...input, toolName: actualToolName, isError: input.isError ?? true });
					if (wrote) await this.ensureSessionFile(id);
					return wrote;
				} finally {
					if (parked) await this.dispose(id);
				}
			});
		} catch (err) {
			this.debugLog?.(`appendToolResultIfPending failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/**
	 * SDK _persist writes nothing until the first assistant message exists, so
	 * platform-written custom messages on a fresh session would stay memory-only
	 * (lost on restart; a fileless session also makes ensureWindowAlive mint
	 * replacements). Replicate the SDK's first flush — header entry plus pending
	 * entries, `wx` so we never clobber — and mark the SessionManager flushed so
	 * later entries append normally. Best-effort: failure just means the session
	 * stays memory-only, as before.
	 */
	async ensureSessionFile(id: string): Promise<void> {
		const parked = Boolean((await this.teamsStore?.contextForSession(id))?.active === false);
		try {
			const session = await this.open(id);
			const sm = session.sessionManager as unknown as {
				flushed?: boolean;
				sessionFile?: string;
				fileEntries?: unknown[];
			};
			if (sm.sessionFile && !existsSync(sm.sessionFile) && Array.isArray(sm.fileEntries)) {
				writeFileSync(sm.sessionFile, sm.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", {
					encoding: "utf-8",
					flag: "wx",
				});
				sm.flushed = true;
			}
		} catch {
			// memory-only fallback
		} finally {
			if (parked) await this.dispose(id);
		}
	}

	/**
	 * 在全新的 Pi SDK in-memory Session 中执行只读完成复核。Reviewer 不装载
	 * Extension、Skill、项目上下文或任何工具，也不继承 manager 消息历史。
	 */
	async reviewGoalCompletion(
		managerSessionId: string,
		input: CompletionReviewInput,
		modelRef?: string,
	): Promise<CompletionReview> {
		const manager = this.active.get(managerSessionId) ?? await this.open(managerSessionId);
		const model = modelRef ? await this.resolveModel(modelRef) : manager.model as PiModel | undefined;
		if (!model) throw new Error("没有可用于独立复核的模型");
		const reviewInput: CompletionReviewInput = {
			...input,
			managerEvidence: [...input.managerEvidence, ...PiSessionStore.toolEvidence(manager)],
		};
		const reviewSession = await this.completionReviewerSession(model);
		try {
			await reviewSession.prompt(buildCompletionReviewPrompt(reviewInput));
			const output = PiSessionStore.assistantText(reviewSession);
			if (!output) throw new Error("独立 reviewer 没有返回判定");
			return parseCompletionReview(output, reviewInput, {
				reviewerModel: `${model.provider}/${model.id}`,
				reviewerSessionId: reviewSession.sessionId,
			});
		} finally {
			reviewSession.dispose();
		}
	}

	async reviewWorkItemVerification(
		managerSessionId: string,
		input: VerificationReviewInput,
		meta: Omit<VerificationRecord, "criteria" | "evidenceRefs" | "status" | "integrity" | "failureReason" | "reviewerModel" | "reviewerSessionId">,
		modelRef?: string,
	): Promise<VerificationRecord> {
		const manager = this.active.get(managerSessionId) ?? await this.open(managerSessionId);
		const model = modelRef ? await this.resolveModel(modelRef) : manager.model as PiModel | undefined;
		if (!model) throw new Error("没有可用于 WorkItem 独立复核的模型");
		const reviewSession = await this.reviewerSession(model, VERIFICATION_REVIEWER_SYSTEM_PROMPT);
		try {
			await reviewSession.prompt(buildVerificationPrompt(input));
			const output = PiSessionStore.assistantText(reviewSession);
			if (!output) throw new Error("独立 Verifier 没有返回判定");
			return parseVerificationOutput(output, input, {
				...meta,
				reviewerModel: `${model.provider}/${model.id}`,
				reviewerSessionId: reviewSession.sessionId,
			});
		} finally {
			reviewSession.dispose();
		}
	}

	/** 只投影可复核 ToolResult，不把 manager 的推理或完整聊天历史交给 reviewer。 */
	private static toolEvidence(session: AgentSession): Array<Record<string, unknown>> {
		const messages = session.messages as unknown as Array<{
			role?: string;
			toolCallId?: string;
			toolName?: string;
			content?: unknown;
			details?: unknown;
			isError?: boolean;
		}>;
		return messages
			.filter((message) =>
				message.role === "toolResult" &&
				typeof message.toolCallId === "string" &&
				message.toolName !== CORE_TOOL_UPDATE_WORK_STATE &&
				message.toolName !== CORE_TOOL_REQUEST_DECISION &&
				message.toolName !== CORE_TOOL_SEARCH,
			)
			.slice(-80)
			.map((message) => {
				const text = Array.isArray(message.content)
					? message.content
						.filter((item): item is { type: "text"; text: string } => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
						.map((item) => item.text)
						.join("\n")
					: typeof message.content === "string" ? message.content : "";
				return {
					id: message.toolCallId!,
					toolName: message.toolName,
					isError: message.isError === true,
					content: text.slice(0, 12_000),
					...(message.details !== undefined ? { details: JSON.stringify(message.details).slice(0, 8_000) } : {}),
				};
			});
	}

	private debugLog?: (msg: string) => void;
	setDebugLog(fn: (msg: string) => void): void {
		this.debugLog = fn;
	}

	async disposeAll(): Promise<void> {
		this.unsubscribeTeams?.();
		this.unsubscribeTeams = undefined;
		for (const [id, session] of this.active) {
			session.dispose();
			this.active.delete(id);
		}
		this.assembledManaged.clear();
		this.runtimeDirty.clear();
	}

	private async summarize(session: AgentSession): Promise<SessionSummary> {
		this.active.set(session.sessionId, session);
		return {
			id: session.sessionId,
			sessionFile: session.sessionFile ?? "",
			firstMessage: "",
			name: session.sessionName,
			modifiedAt: new Date().toISOString(),
			active: true,
			model: PiSessionStore.modelRefOf(session),
			thinkingLevel: PiSessionStore.thinkingLevelOf(session),
		};
	}

	// ---- auto title (LLM-generated on the first user query) ----

	/** Extract the last assistant text from an in-memory title session. */
	private static assistantText(session: AgentSession): string | undefined {
		// AgentMessage is a union (BashExecutionMessage has no `content`), so
		// read it structurally through a narrow projection.
		const messages = session.messages as unknown as Array<{
			role?: string;
			content?: unknown;
		}>;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (!m || m.role !== "assistant") continue;
			const content = m.content;
			if (typeof content === "string") return content.trim();
			if (Array.isArray(content)) {
				const text = content
					.filter(
						(b): b is { type: "text"; text: string } =>
							Boolean(b) && typeof b === "object" && (b as { type?: string }).type === "text",
					)
					.map((b) => (b as { text: string }).text)
					.join("");
				if (text.trim()) return text.trim();
			}
		}
		return undefined;
	}

	private static normalizeTitle(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const cleaned = text
			.replace(/^["'「」『』“”]+|["'「」『』“”]+$/g, "")
			.replace(/[。.!！?？…\n\r]/g, "")
			.trim();
		return cleaned.length ? cleaned.slice(0, 24) : undefined;
	}

	/** A disposable in-memory session shaped purely for title generation. */
	private titleSession(model: PiModel): Promise<AgentSession> {
		const agentDir = getAgentDir();
		return (async () => {
			const loader = new DefaultResourceLoader({
				cwd: this.cwd,
				agentDir,
				settingsManager: SettingsManager.create(this.cwd, agentDir),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPromptOverride: (base) =>
					`${base ?? ""}\n\n你是对话标题生成器，只输出标题，不做任何解释。`,
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: this.cwd,
				sessionManager: SessionManager.inMemory(this.cwd),
				model,
				modelRuntime: await this.runtime(),
				resourceLoader: loader,
				noTools: "all",
			});
			return session;
		})();
	}

	/** Reviewer 使用完全空白的只读上下文；唯一输入由 completion snapshot 提供。 */
	private completionReviewerSession(model: PiModel): Promise<AgentSession> {
		return this.reviewerSession(model, COMPLETION_REVIEWER_SYSTEM_PROMPT);
	}

	private reviewerSession(model: PiModel, systemPrompt: string): Promise<AgentSession> {
		const agentDir = getAgentDir();
		return (async () => {
			const loader = new DefaultResourceLoader({
				cwd: this.cwd,
				agentDir,
				settingsManager: SettingsManager.create(this.cwd, agentDir),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPromptOverride: () => systemPrompt,
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: this.cwd,
				sessionManager: SessionManager.inMemory(this.cwd),
				model,
				modelRuntime: await this.runtime(),
				resourceLoader: loader,
				noTools: "all",
			});
			return session;
		})();
	}

	/**
	 * Generate a short Chinese title for a conversation from its first user
	 * message and persist it as the pi session name (session_info entry). Runs
	 * in a separate in-memory session so the live conversation is untouched.
	 * Best-effort: returns undefined on any failure (no auth, model error…).
	 */
	async generateSessionTitle(sessionId: string, firstMessage: string): Promise<string | undefined> {
		try {
			const session = this.active.get(sessionId);
			if (!session) return undefined;
			// 手动重命名或已生成过标题时不再覆盖。
			if (session.sessionName?.trim()) return session.sessionName;
			const model = session.model as PiModel | undefined;
			if (!model || !firstMessage.trim()) return undefined;
			const titleSession = await this.titleSession(model);
			try {
				const instruction =
					"请为下面这段对话的第一条消息生成一个简洁的中文标题：不超过 12 个字，概括主题；只输出标题本身，不要引号、标点或解释。\n\n消息：";
				await titleSession.prompt(instruction + firstMessage.trim().slice(0, 300));
				const title = PiSessionStore.normalizeTitle(PiSessionStore.assistantText(titleSession));
				if (title) session.setSessionName(title);
				return title;
			} finally {
				titleSession.dispose();
			}
		} catch {
			return undefined;
		}
	}
}
