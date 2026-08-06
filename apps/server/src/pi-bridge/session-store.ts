import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";
import type { TeamsStore, WindowType } from "../store/teams.js";
import { createTeamTaskTool } from "./team-task.js";

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
	private runtimePromise: Promise<ModelRuntime> | null = null;

	constructor(
		private readonly cwd: string,
		private readonly sessionDir: string,
		private readonly teamsStore?: TeamsStore,
	) {}

	/** Custom tools registered into every manager session (team_task). `solo`
	 * decides whether the tool routes tasks to direct windows (§4) — the
	 * caller already resolved the window context for guidance shaping. */
	private customToolsFor(
		getSessionId: () => string,
		ctx?: { type: WindowType; members: string[] },
	): CreateAgentSessionOptions["customTools"] {
		return this.teamsStore
			? [createTeamTaskTool(this.teamsStore, this, getSessionId, { solo: !ctx || ctx.type === "solo" })]
			: undefined;
	}

	/**
	 * System-prompt shaping for a window's manager sessions. solo → no
	 * shaping (manager answers freely and may delegate); direct/group → the
	 * manager is a relay: it must hand every user message to a worker via
	 * team_task and never do the work itself. A user-edited window prompt
	 * (`WindowConfig.prompt`) replaces the built-in relay guidance entirely.
	 */
	private guidanceFor(ctx?: { type: WindowType; members: string[]; prompt?: string }): string | undefined {
		if (!ctx || ctx.type === "solo") return undefined;
		const members = ctx.members.filter(Boolean);
		if (members.length === 0) return undefined;
		if (ctx.prompt?.trim()) return ctx.prompt.trim();
		if (ctx.type === "direct") {
			const w = members[0]!;
			return [
				`当前是单聊窗口，用户的消息是发给 worker「${w}」的。`,
				"规则：",
				`1. 用户的每一条请求都用 team_task 工具委托给 worker「${w}」（worker 参数填 ${w}），不要自己动手执行，也不要直接作答。`,
				"2. 拿到 worker 结果后把结果转述给用户（可简要概括），不要额外发挥。",
				"3. 若 worker 需要更多输入（如选择分析模型），把可选内容转述给用户，等用户回复后再用 team_task 重试。",
			].join("\n");
		}
		return [
			`当前是群聊窗口，pi manager 是调度者，成员：${members.join("、")}。多个 worker 需要配合完成用户的整体目标。`,
			"规则：",
			"1. 把用户的整体目标拆解成可执行的子任务，逐个用 team_task 委托给最合适的 worker（可调用多个 worker、可分多步执行）。",
			"2. 用户指名 worker 时，优先把相关子任务委托给它。",
			"3. 结合之前 worker 返回的结果决定下一步：后续子任务可引用/续接先前结果，需要接力时安排好 worker 之间的顺序。",
			"4. 需求或关键参数模糊时先向用户澄清，不要自行臆测。",
			"5. 所有子任务完成后，把综合结论汇报给用户；调度与决策由你负责，但任务执行一律交给 worker，不要自己动手执行任务本身。",
		].join("\n");
	}

	/** Resource loader that appends the window relay guidance to the manager's
	 * system prompt. Only built when a session belongs to a direct/group window. */
	private async relayLoader(guidance: string): Promise<DefaultResourceLoader> {
		const agentDir = getAgentDir();
		const loader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir,
			settingsManager: SettingsManager.create(this.cwd, agentDir),
			systemPromptOverride: (base) => `${base ?? ""}\n\n${guidance}`,
		});
		await loader.reload();
		return loader;
	}

	/** Window context for a session, resolved from the window store. */
	private async windowContextOf(
		sessionId: string,
	): Promise<{ type: WindowType; members: string[]; prompt?: string } | undefined> {
		if (!this.teamsStore) return undefined;
		const w = await this.teamsStore.windowForSession(sessionId);
		if (!w) return undefined;
		return { type: w.type, members: w.members, prompt: w.prompt };
	}

	/** Shared model runtime (auth + model catalog), created on first use. */
	private runtime(): Promise<ModelRuntime> {
		this.runtimePromise ??= ModelRuntime.create();
		return this.runtimePromise;
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
		window?: { type: WindowType; members: string[]; prompt?: string },
	): Promise<SessionSummary> {
		const model = modelRef ? await this.resolveModel(modelRef) : undefined;
		const guidance = this.guidanceFor(window);
		const binding: { sessionId: string } = { sessionId: "" };
		const { session } = await createAgentSession({
			cwd: this.cwd,
			sessionManager: SessionManager.create(this.cwd, this.sessionDir),
			...(model ? { model } : {}),
			// 单聊/群聊：manager 只保留 team_task（relay），不能自己动手。
			...(guidance ? { resourceLoader: await this.relayLoader(guidance), noTools: "builtin" as const } : {}),
			customTools: this.customToolsFor(() => binding.sessionId, window),
		});
		binding.sessionId = session.sessionId;
		return this.summarize(session);
	}

	async list(): Promise<SessionSummary[]> {
		const sessions = await SessionManager.list(this.cwd, this.sessionDir);
		return sessions.map((info) => ({
			id: info.id,
			sessionFile: info.path,
			firstMessage: info.firstMessage,
			name: info.name,
			modifiedAt: info.modified.toISOString(),
			active: this.active.has(info.id),
		}));
	}

	/** Return the live AgentSession for a session id, opening it from file if needed. */
	async open(id: string): Promise<AgentSession> {
		const existing = this.active.get(id);
		if (existing) return existing;

		const info = (await SessionManager.list(this.cwd, this.sessionDir)).find((s) => s.id === id);
		if (!info) throw new Error(`Session not found: ${id}`);

		const ctx = await this.windowContextOf(id);
		const guidance = this.guidanceFor(ctx);
		const { session } = await createAgentSession({
			cwd: this.cwd,
			sessionManager: SessionManager.open(info.path, this.sessionDir),
			...(guidance ? { resourceLoader: await this.relayLoader(guidance), noTools: "builtin" as const } : {}),
			customTools: this.customToolsFor(() => id, ctx),
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

	/** Dispose the session (aborting an in-flight run) and delete its JSONL file. */
	async remove(id: string): Promise<boolean> {
		const session = this.active.get(id);
		if (session?.isStreaming) {
			await session.abort().catch(() => undefined);
		}
		await this.dispose(id);
		const info = (await SessionManager.list(this.cwd, this.sessionDir)).find((s) => s.id === id);
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
	}

	/** True when the session is currently open in this process (even if it has
	 * no file on disk yet — pi persists lazily on the first assistant message). */
	isOpen(id: string): boolean {
		return this.active.has(id);
	}

	async disposeAll(): Promise<void> {
		for (const [id, session] of this.active) {
			session.dispose();
			this.active.delete(id);
		}
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
