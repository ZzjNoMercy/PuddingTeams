import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";
import type { TeamsStore } from "../store/teams.js";
import { createTeamTaskTool } from "./team-task.js";

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

	/** Custom tools registered into every manager session (team_task). */
	private customToolsFor(getSessionId: () => string): CreateAgentSessionOptions["customTools"] {
		return this.teamsStore ? [createTeamTaskTool(this.teamsStore, getSessionId)] : undefined;
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

	async create(modelRef?: string): Promise<SessionSummary> {
		const model = modelRef ? await this.resolveModel(modelRef) : undefined;
		const binding: { sessionId: string } = { sessionId: "" };
		const { session } = await createAgentSession({
			cwd: this.cwd,
			sessionManager: SessionManager.create(this.cwd, this.sessionDir),
			...(model ? { model } : {}),
			customTools: this.customToolsFor(() => binding.sessionId),
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

		const { session } = await createAgentSession({
			cwd: this.cwd,
			sessionManager: SessionManager.open(info.path, this.sessionDir),
			customTools: this.customToolsFor(() => id),
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
			modifiedAt: new Date().toISOString(),
			active: true,
		};
	}
}
