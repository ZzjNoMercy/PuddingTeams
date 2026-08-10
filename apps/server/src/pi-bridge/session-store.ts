import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PiManagerSettings, PiResourceConfig, TeamsStore } from "../store/teams.js";
import type { WorkStateStore } from "../store/work-state.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import type { ArtifactStore } from "../agent-runtime/artifact-store.js";
import { ExtensionCatalog, delegateToolName, toolSafeId } from "../agent-runtime/extensions.js";
import {
	planManagerTools,
	buildManagerExtensionFactories,
	CORE_TOOL_SEARCH,
	CORE_TOOL_UPDATE_WORK_STATE,
	CORE_TOOL_REQUEST_DECISION,
	type ManagedToolPlan,
	type ManagerWindowContext,
} from "./agent-extensions.js";
import { sharedModelRuntime } from "./model-runtime.js";
import { combinePiPrompt, piResourceLoaderOptions } from "./pi-resources.js";
import {
	buildCompletionReviewPrompt,
	COMPLETION_REVIEWER_SYSTEM_PROMPT,
	parseCompletionReview,
	type CompletionReviewInput,
} from "./completion-review.js";
import type { CompletionReview } from "../store/work-state.js";

export interface SessionSummary {
	id: string;
	sessionFile: string;
	firstMessage: string;
	/** LLM-generated title (set on the first user query). */
	name?: string;
	modifiedAt: string;
	active: boolean;
}

export interface ModelSummary {
	/** Opaque reference: `${provider}/${modelId}` — pass back to set/create. */
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
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

type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

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
	private unsubscribeTeams?: () => void;

	constructor(
		private readonly cwd: string,
		private readonly sessionDir: string,
		private readonly teamsStore?: TeamsStore,
		private readonly invoker?: AgentInvoker,
		catalog?: ExtensionCatalog,
		private readonly workStates?: WorkStateStore,
		private readonly artifacts?: ArtifactStore,
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

	/**
	 * System-prompt shaping for a window's manager sessions（§10.5 优先级：
	 * window.prompt > manager 全局 prompt > 内置 relay guidance；solo 从此
	 * 也有 prompt 入口——manager settings 的 prompt）。direct/group → the
	 * manager is a relay: it must hand every user message to a worker via the
	 * per-agent delegate tool and never do the work itself. A user-edited
	 * window prompt (`WindowConfig.prompt`) replaces the built-in relay
	 * guidance entirely.
	 */
	static resolveGuidance(ctx: ManagerWindowContext | undefined, _legacySettings?: PiManagerSettings): string | undefined {
		if (!ctx || ctx.type === "solo") return undefined;
		const members = ctx.members.filter(Boolean);
		if (members.length === 0) return undefined;
		if (ctx.prompt?.trim()) return ctx.prompt.trim();
		if (ctx.type === "direct") {
			const w = members[0]!;
			const tool = delegateToolName(w);
			return [
				`当前是单聊窗口，用户的消息是发给 worker「${w}」的。`,
				"规则：",
				`1. 用户的每一条请求都用 ${tool} 工具委托给 worker「${w}」，不要自己动手执行，也不要直接作答。`,
				"2. 拿到 worker 结果后把结果转述给用户（可简要概括），不要额外发挥。",
				`3. 若 worker 需要更多输入（如选择分析模型），把可选内容转述给用户，等用户回复后再用 ${tool} 续接。`,
			].join("\n");
		}
		return [
			`当前是群聊窗口，pi manager 是调度者，成员：${members.join("、")}。多个 worker 需要配合完成用户的整体目标。`,
			"规则：",
			`1. 把用户的整体目标拆解成可执行的子任务；成员的委托工具默认未激活，先用 ${CORE_TOOL_SEARCH} 按 worker 名激活对应的 agent_<id>__delegate 工具，再逐个委托给最合适的 worker（可调用多个 worker、可分多步执行）。`,
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
	): Promise<{ loader: DefaultResourceLoader; plan: ManagedToolPlan }> {
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
				getSessionId,
				ctx,
				resolveContext: () => this.windowContextOf(getSessionId()),
				log: (msg) => this.debugLog?.(msg),
			});
		}
		const guidance = PiSessionStore.resolveGuidance(ctx);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			extensionFactories: factories,
			...piResourceLoaderOptions(resources, cwd, agentDir),
			// noExtensions 只控制 pi-native Extension；平台 inline core/delegation
			// factories 不受影响。Skills/templates/context 全部由 piResources 决定。
			...(settings?.noExtensions ? { noExtensions: true } : {}),
			systemPromptOverride: (base) => combinePiPrompt(base, resources, guidance),
		});
		await loader.reload();
		return { loader, plan };
	}

	/** create()/open() 共用的会话装配：loader + 初始 active tools 策略。 */
	private async assembleSession(opts: {
		sessionManager: SessionManager;
		model?: PiModel;
		ctx?: ManagerWindowContext;
		cwd: string;
		getSessionId: () => string;
	}): Promise<AgentSession> {
		const settings = await this.managerSettings();
		const resources = await this.managerResources();
		const { loader, plan } = await this.managerResourceLoader(opts.ctx, opts.getSessionId, opts.cwd, settings, resources);
		const guidance = PiSessionStore.resolveGuidance(opts.ctx);
		// 单聊/群聊 relay：manager 只保留委托工具，不能自己动手。solo 的
		// manager prompt 只是人格/规则，不影响内置工具；§10.5 的
		// builtinTools:false 则在任何窗口都关闭内置工具。
		const isRelay = opts.ctx !== undefined && opts.ctx.type !== "solo";
		const stripBuiltin = (isRelay && guidance !== undefined) || settings?.builtinTools === false;
		// §10.5 默认模型：显式选择的模型优先，否则用 manager 配置的默认模型
		// （解析失败不阻断建会话，回退 SDK 默认）。
		let model = opts.model;
		if (!model && settings?.model) {
			model = await this.resolveModel(settings.model).catch((err: unknown) => {
				this.debugLog?.(`manager 默认模型解析失败：${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			});
		}
		const { session } = await createAgentSession({
			cwd: opts.cwd,
			sessionManager: opts.sessionManager,
			...(model ? { model } : {}),
			...(settings?.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {}),
			resourceLoader: loader,
			...(stripBuiltin ? { noTools: "builtin" as const } : {}),
		});
		// 激活策略（§3.3）：direct 默认激活该 Agent 的基础委托工具 + always
		// 工具；solo/group 默认只激活 core search 工具，其余预注册但
		// inactive，由 search_agent_tools 按需纯加法激活。
		const current = session.getActiveToolNames();
		session.setActiveToolsByName(current.filter((n) => !plan.managed.has(n) || plan.active.has(n)));
		this.assembledManaged.set(session.sessionId, plan.managed);
		return session;
	}

	/**
	 * 立即撤权（§3.3.6）：配置变化后，活跃会话里不再允许的工具立刻从
	 * active tools 移除（新增 Agent 的工具要等空闲重建才会出现）；所有活跃
	 * 会话标记 runtimeDirty，下次空闲 open 时彻底重建。
	 * §10.5：manager 的 thinking level 是运行时即改项，这里同步应用到
	 * 所有活跃会话。
	 */
	private async revokeChangedTools(): Promise<void> {
		if (!this.teamsStore) return;
		const thinkingLevel = (await this.managerSettings())?.thinkingLevel;
		for (const [id, session] of this.active) {
			const ctx = await this.windowContextOf(id);
			const plan = await planManagerTools(this.teamsStore, this.catalog, ctx);
			const assembled = this.assembledManaged.get(id) ?? new Set<string>();
			const active = session.getActiveToolNames();
			const next = active.filter((n) => !assembled.has(n) || plan.active.has(n));
			if (next.length !== active.length) session.setActiveToolsByName(next);
			if (thinkingLevel && session.thinkingLevel !== thinkingLevel) {
				session.setThinkingLevel(thinkingLevel);
			}
			this.runtimeDirty.add(id);
		}
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
		for (const id of this.active.keys()) this.runtimeDirty.add(id);
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
			if (![...assembled].some((n) => n.startsWith(prefix))) continue;
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
		const w = await this.teamsStore.windowForSession(sessionId);
		if (!w) return undefined;
		const cwd = await this.teamsStore.workspaceFor(w.id);
		return { type: w.type, members: w.members, prompt: w.prompt, workspaceId: w.workspaceId, cwd };
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
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		};
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

	/**
	 * Store a provider API key: in-memory runtime override (no network
	 * validation in the SDK — the key is trusted as-is) plus durable in pi's
	 * auth.json via the runtime's own credential store. Writing through
	 * `credentials.modify` is required: the SDK's AuthStorage keeps an
	 * in-memory snapshot of auth.json, so direct file writes are invisible to
	 * availability refreshes until the process restarts.
	 */
	async setProviderKey(providerId: string, apiKey: string): Promise<{ availableCount: number }> {
		const rt = await this.runtime();
		await rt.setRuntimeApiKey(providerId, apiKey);
		await PiSessionStore.credentialsOf(rt).modify(providerId, async () => ({
			type: "api_key",
			key: apiKey,
		}));
		return { availableCount: (await rt.getAvailable(providerId)).length };
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

	/**
	 * Access the runtime's credential overlay. `ModelRuntime.credentials` is
	 * not part of the public type surface, but it is the only write path that
	 * keeps auth.json and AuthStorage's cache coherent (see setProviderKey).
	 */
	private static credentialsOf(rt: ModelRuntime): {
		modify(providerId: string, fn: (current: unknown) => Promise<unknown>): Promise<unknown>;
		delete(providerId: string): Promise<void>;
	} {
		return (
			rt as unknown as {
				credentials: {
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
	): Promise<SessionSummary> {
		const model = modelRef ? await this.resolveModel(modelRef) : undefined;
		const cwd = window?.cwd ?? this.cwd;
		const binding: { sessionId: string } = { sessionId: "" };
		const session = await this.assembleSession({
			sessionManager: SessionManager.create(cwd, this.sessionDir),
			model,
			ctx: window,
			cwd,
			getSessionId: () => binding.sessionId,
		});
		binding.sessionId = session.sessionId;
		return this.summarize(session);
	}

	async list(): Promise<SessionSummary[]> {
		// `sessionDir` is shared by every manager Window, including Windows that
		// belong to different Workspaces. SessionManager.list(cwd, sessionDir)
		// filters that directory by one cwd, which makes sessions from other
		// Workspaces invisible after restart (and can also miss macOS /tmp ->
		// /private/tmp canonical-path aliases). Discover by the owned directory;
		// Window ownership remains the authority when a session is opened.
		const sessions = await SessionManager.listAll(this.sessionDir);
		const summaries = sessions.map((info) => ({
			id: info.id,
			sessionFile: info.path,
			firstMessage: info.firstMessage,
			name: info.name,
			modifiedAt: info.modified.toISOString(),
			active: this.active.has(info.id),
		}));
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
			});
		}
		return summaries;
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
		const session = await this.assembleSession({
			sessionManager: SessionManager.open(info.path, this.sessionDir),
			ctx,
			cwd,
			getSessionId: () => id,
		});
		this.active.set(session.sessionId, session);
		return session;
	}

	async abort(id: string): Promise<boolean> {
		const session = this.active.get(id);
		if (!session) return false;
		await session.abort();
		return true;
	}

	/** Switch the model of a live session (pi SDK supports runtime setModel). */
	async setModel(id: string, modelRef: string): Promise<ModelSummary> {
		const session = await this.open(id);
		const model = await this.resolveModel(modelRef);
		await session.setModel(model);
		return PiSessionStore.summarizeModel(model);
	}

	/** Set the user-facing session name and persist it as a session_info entry. */
	async rename(id: string, name: string): Promise<SessionSummary> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("会话名称不能为空");
		if (trimmed.length > 60) throw new Error("会话名称不能超过 60 个字符");
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

	async dispose(id: string): Promise<void> {
		const session = this.active.get(id);
		if (session) {
			session.dispose();
			this.active.delete(id);
		}
		this.assembledManaged.delete(id);
		this.runtimeDirty.delete(id);
	}

	/** True when the session is currently open in this process (even if it has
	 * no file on disk yet — pi persists lazily on the first assistant message). */
	isOpen(id: string): boolean {
		return this.active.has(id);
	}

	/**
	 * Send a custom message into a manager session and optionally trigger a new
	 * LLM turn (§6.3). Best-effort: the session may be busy streaming; failures
	 * are swallowed so an approval can never block the caller. `deliverAs:
	 * "followUp"` queues instead of steering when the session is mid-stream.
	 */
	async sendCustomMessage(
		id: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
		options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		try {
			const session = await this.open(id);
			await session.sendCustomMessage(
				{
					customType: message.customType,
					content: message.content,
					display: true,
					details: message.details,
				},
				{ ...options, deliverAs: options.deliverAs ?? "followUp" },
			);
		} catch (err) {
			this.debugLog?.(`sendCustomMessage failed: ${err instanceof Error ? err.message : String(err)}`);
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
			managerEvidence: PiSessionStore.toolEvidence(manager),
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
				resourceLoader: loader,
				noTools: "all",
			});
			return session;
		})();
	}

	/** Reviewer 使用完全空白的只读上下文；唯一输入由 completion snapshot 提供。 */
	private completionReviewerSession(model: PiModel): Promise<AgentSession> {
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
				systemPromptOverride: () => COMPLETION_REVIEWER_SYSTEM_PROMPT,
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: this.cwd,
				sessionManager: SessionManager.inMemory(this.cwd),
				model,
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
