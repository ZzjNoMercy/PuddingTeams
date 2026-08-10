import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CredentialsStore } from "./credentials.js";
import { spawnWorker } from "../agent-runtime/transport/spawn.js";
import { ensureHandoffGuidance } from "../agent-runtime/handoff.js";
import type { AgentCapabilityBinding, AgentConnectorBinding } from "../agent-runtime/extensions.js";
import { WorkspaceStore } from "./workspaces.js";

export interface CommandInvoke {
	type: "command";
	/** Executable name/path spawned for every worker call. */
	command: string;
	/** Args appended for a run (stdin receives the task JSON). */
	runArgs: string[];
	/** Args for a health probe (default: `["doctor", "--json"]`). */
	probeArgs?: string[];
}

/** pinned 内置 Pi manager 的保留 invoke 类型（§10.5，仅限保留名 manager）。 */
export interface PiInvoke {
	type: "pi";
}

export type AgentInvoke = CommandInvoke | PiInvoke;

/** Pi manager 的可编辑配置（§10.5，挂在 pinned 条目上）。 */
export interface PiManagerSettings {
	/** 默认模型（"provider/modelId"）；新建会话时应用。 */
	model?: string;
	/** 内置工具开关（默认 true；false → noTools:"builtin"）。 */
	builtinTools?: boolean;
	noExtensions?: boolean;
	/** thinking level：运行时即改（setThinkingLevel）。 */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface PiResourceConfig {
	systemPrompt?: string;
	skillPaths?: string[];
	promptTemplatePaths?: string[];
	loadGlobalSkills?: boolean;
	loadWorkspaceSkills?: boolean;
	loadGlobalPrompts?: boolean;
	loadWorkspacePrompts?: boolean;
	loadWorkspaceContext?: boolean;
}

/** pinned 内置 Pi manager 的保留名（§10.5）。 */
export const MANAGER_AGENT_NAME = "manager";

export interface AgentResponsibilityProfile {
	identity?: string;
	domain: string;
	owns: string[];
	excludes: string[];
	escalateWhen?: string[];
}

export interface AgentConfig {
	/** Agent 的唯一 id（工具命名空间 agent_<agentId>__* 用）。 */
	name: string;
	description: string;
	/** worker 的 legacy command invoke；manager 为 { type: "pi" }。 */
	invoke?: AgentInvoke;
	/** Connector 绑定（§10）：worker 的接入方式。 */
	connector?: AgentConnectorBinding;
	/**
	 * 绑定的 Capability Extension（§10，替换 Phase 4 的 extensionBindings）。
	 * 基础 agent-delegation Extension 是运行时投影，不占绑定位。
	 */
	capabilityExtensions?: AgentCapabilityBinding[];
	/** Extra env vars merged over the process env for this worker. */
	env?: Record<string, string>;
	enabled?: boolean;
	capabilities?: string[];
	/** 长期责任与停止边界；用于 manager 路由，不是能力或权限证明。 */
	responsibility?: AgentResponsibilityProfile;
	/** Avatar image file name inside `.teams/avatars/` (§11); absent = default. */
	avatar?: string;
	/** pinned 内置条目（manager）：不可删除、不可禁用。 */
	pinned?: boolean;
	/** manager 条目的可编辑配置（§10.5）。 */
	manager?: PiManagerSettings;
	/** 仅 pinned manager 或 connectorId=pi 的 worker 使用。 */
	piResources?: PiResourceConfig;
	/**
	 * Extension 配置版本：Agent/绑定/启用状态每次变化递增（§3.3.5）。
	 * manager Session 据此判断自身装配是否陈旧（runtimeDirty）。
	 */
	extensionRevision?: number;
}

export type WindowType = "solo" | "direct" | "group";

/**
 * A chat window is a first-class sidebar entity (solo / direct / group), per
 * docs/2026-08-05-房间即群聊-产品模型方案.md §1–2. Sessions are resources
 * *inside* a window, not top-level entries.
 */
/** 会话绑定：每个 worker 不透明的 Session handle（Phase 1，替换旧 workerSessions）。 */
export interface WorkerBinding {
	sessionHandle?: string;
	/** 缺省表示未选择项目；此时 cwdSnapshot 是平台默认运行目录。 */
	workspaceId?: string;
	cwdSnapshot: string;
	agentRevision: number;
	updatedAt: string;
}

export interface WindowConfig {
	/** Stable window id. The solo singleton always uses "solo". */
	id: string;
	type: WindowType;
	/** Display name override; otherwise derived from type/members. */
	name?: string;
	/** Worker names in this window. solo=[], direct=[w], group=[w1,w2,…]. */
	members: string[];
	/** pi session ids in this window (newest first). Always ≥ 1. */
	sessions: string[];
	/** Currently active pi session. */
	activeSession: string;
	/**
	 * User-editable system prompt for this window's manager sessions
	 * (e.g. per-worker rules like "派活前先列模型"). Replaces the built-in
	 * relay guidance when set; empty = default relay guidance.
	 */
	prompt?: string;
	/** Per-worker last session handle, for multi-turn continuity (§7.1). */
	workerBindings?: Record<string, WorkerBinding>;
	/** 可选的平台项目身份；未选择时沿用平台原有默认 cwd。 */
	workspaceId?: string;
	/** Window 创建时冻结的 cwd；无项目模式也必须持久化。 */
	cwdSnapshot: string;
	/** Solo only: pinned singleton, never deletable. */
	pinned?: boolean;
	createdAt: string;
}

interface TeamsFile {
	version: number;
	agents: AgentConfig[];
}

interface WindowsFile {
	version: number;
	windows: Record<string, WindowConfig>;
}

export interface WorkerProbeResult {
	name: string;
	command: string;
	/** True when the probe command ran and parsed a JSON payload. */
	ok: boolean;
	raw: Record<string, unknown>;
	exitCode: number;
	error?: string;
}

export const DEFAULT_TEAMS: AgentConfig[] = [
	{
		// §10.5：pinned 内置 Pi manager，出现在智能体管理中，不可删除/禁用。
		name: MANAGER_AGENT_NAME,
		description: "负责理解用户消息、调度 Worker 并转述结果。",
		invoke: { type: "pi" },
		pinned: true,
		enabled: true,
		capabilities: [],
		manager: {},
	},
	{
		// 决策 20：旧结构直接替换——PuddingClaw 以第一方 Connector binding 接入。
		name: "puddingclaw",
		description:
			"企业数据分析 Worker（NL2SQL、数据查询、指标归因、知识查询）。执行前需要用户指定分析模型（analytics model），未指定时会返回可选模型列表。",
		capabilities: ["data.query", "data.analysis", "data.nl2sql", "knowledge.query"],
		connector: {
			extensionId: "puddingclaw",
			connectorId: "puddingclaw",
			config: { command: "puddingclaw" },
		},
		enabled: true,
	},
];

// ---- avatars (§11) ----

/** Uploaded avatar size cap (bytes, after base64 decode). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

interface AvatarType {
	ext: string;
	mime: string;
	/** Magic-bytes sniffing; the claimed mediaType is never trusted. */
	sniff: (b: Buffer) => boolean;
}

const AVATAR_TYPES: AvatarType[] = [
	{
		ext: "png",
		mime: "image/png",
		sniff: (b) =>
			b.length >= 8 &&
			b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
			b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
	},
	{ ext: "jpg", mime: "image/jpeg", sniff: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ ext: "gif", mime: "image/gif", sniff: (b) => b.length >= 6 && b.toString("ascii", 0, 4) === "GIF8" },
	{
		ext: "webp",
		mime: "image/webp",
		sniff: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
	},
];

/** Agent names become file names, so they must not carry path separators. */
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Registry + window store for phase 2. Owns `teams.json` (the worker registry)
 * and `windows.json` (chat windows: solo / direct / group). Worker subprocess
 * 的生命周期由 AgentRuntime/Driver 层负责，本类只承担注册表与窗口存储。
 *
 * Every mutation runs under an in-process mutex and re-reads the file fresh,
 * so concurrent writes cannot lose updates (all-or-nothing per mutation).
 */
export class TeamsStore {
	private agentsPromise: Promise<AgentConfig[]> | null = null;
	private windowsPromise: Promise<WindowsFile> | null = null;
	private readonly agentsFile: string;
	private readonly windowsFile: string;
	/** Serializes all registry/window mutations in this process. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Agent/窗口成员变化监听器（Phase 4：PiSessionStore 用它做立即撤权）。 */
	private changeListeners = new Set<() => void>();
	readonly workspaces: WorkspaceStore;
	private defaultCwdSnapshot = "";

	/** 订阅 Agent 注册表/窗口成员的撤权相关变化；返回退订函数。 */
	onChange(fn: () => void): () => void {
		this.changeListeners.add(fn);
		return () => this.changeListeners.delete(fn);
	}

	private emitChange(): void {
		for (const fn of this.changeListeners) {
			try {
				fn();
			} catch {
				// 监听器异常不影响存储主流程。
			}
		}
	}

	constructor(
		private readonly teamsDir: string,
		private readonly cwd: string,
		private readonly defaultTimeoutMs = 900_000,
		private readonly credentials?: CredentialsStore,
	) {
		this.agentsFile = path.join(teamsDir, "teams.json");
		this.windowsFile = path.join(teamsDir, "windows.json");
		this.workspaces = new WorkspaceStore(teamsDir);
	}

	/** Ensure the registry dir exists; seed teams.json with defaults on first run. */
	async init(): Promise<void> {
		await mkdir(this.teamsDir, { recursive: true });
		this.defaultCwdSnapshot = await realpath(path.resolve(this.cwd));
		await this.workspaces.init();
		if (!existsSync(this.agentsFile)) {
			await this.writeAgents(DEFAULT_TEAMS);
		}
		const agents = await this.loadAgentsFile();
		const manager = agents.find((agent) => agent.name === MANAGER_AGENT_NAME);
		if (!manager || !manager.pinned || manager.invoke?.type !== "pi") {
			throw new Error("teams.json uses pre-P3 data; pinned manager is required, clear development data");
		}
		// Workspace selection is optional. When present it must be a non-empty
		// identity; absence is the intentional legacy/default-cwd chat mode.
		const windows = await this.loadWindowsFile();
		const sessionOwners = new Map<string, string>();
		const directIdentities = new Map<string, string>();
		for (const window of Object.values(windows.windows)) {
			if (
				(window.workspaceId !== undefined && (typeof window.workspaceId !== "string" || !window.workspaceId)) ||
				typeof window.cwdSnapshot !== "string" ||
				!window.cwdSnapshot ||
				!Array.isArray(window.sessions) ||
				window.sessions.length === 0 ||
				!window.sessions.includes(window.activeSession)
			) {
				throw new Error(`window "${window.id ?? "unknown"}" uses pre-P3 data; clear development windows.json`);
			}
			if (window.workspaceId) {
				const workspace = await this.workspaces.get(window.workspaceId);
				if (!workspace) throw new Error(`workspace not found: ${window.workspaceId}`);
				if (workspace.canonicalPath !== window.cwdSnapshot) {
					throw new Error(`window "${window.id}" cwdSnapshot does not match workspaceId`);
				}
			}
			for (const sessionId of window.sessions) {
				const owner = sessionOwners.get(sessionId);
				if (owner) throw new Error(`session "${sessionId}" belongs to multiple windows: ${owner}, ${window.id}`);
				sessionOwners.set(sessionId, window.id);
			}
			if (window.type === "direct") {
				const identity = JSON.stringify([window.members[0], window.workspaceId ?? null, window.cwdSnapshot]);
				const duplicate = directIdentities.get(identity);
				if (duplicate) throw new Error(`duplicate direct window context: ${duplicate}, ${window.id}`);
				directIdentities.set(identity, window.id);
			}
		}
		this.windowsPromise = Promise.resolve(windows);
	}

	/** Run `fn` after all previously queued mutations, so they execute in order. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async writeJsonFile(file: string, data: unknown): Promise<void> {
		await mkdir(this.teamsDir, { recursive: true });
		const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, file);
	}

	// ---- agents registry ----

	private async loadAgentsFile(): Promise<AgentConfig[]> {
		try {
			const raw = await readFile(this.agentsFile, "utf-8");
			const parsed = JSON.parse(raw) as Partial<TeamsFile>;
			return Array.isArray(parsed.agents) ? parsed.agents : [];
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return [];
		}
	}

	private async agents(): Promise<AgentConfig[]> {
		this.agentsPromise ??= this.loadAgentsFile().catch((err: unknown) => {
			// Do not cache a rejected promise: a transient read error would
			// otherwise freeze the whole registry for the process lifetime.
			this.agentsPromise = null;
			throw err;
		});
		return this.agentsPromise;
	}

	private async writeAgents(agents: AgentConfig[]): Promise<void> {
		await this.writeJsonFile(this.agentsFile, { version: 1, agents });
		this.agentsPromise = Promise.resolve(agents);
	}

	async listAgents(): Promise<AgentConfig[]> {
		const agents = await this.agents();
		return [...agents].sort((a, b) => a.name.localeCompare(b.name));
	}

	async getAgent(name: string): Promise<AgentConfig | undefined> {
		return (await this.agents()).find((a) => a.name === name);
	}

	private normalizeResponsibility(input: AgentResponsibilityProfile | undefined): AgentResponsibilityProfile | undefined {
		if (input === undefined) return undefined;
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("responsibility 必须是对象");
		const domain = typeof input.domain === "string" ? input.domain.trim() : "";
		if (!domain) throw new Error("responsibility.domain 不能为空");
		const list = (value: unknown, field: string): string[] => {
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
				throw new Error(`responsibility.${field} 必须是字符串数组`);
			}
			return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
		};
		const identity = typeof input.identity === "string" ? input.identity.trim() : undefined;
		return {
			...(identity ? { identity } : {}),
			domain,
			owns: list(input.owns, "owns"),
			excludes: list(input.excludes, "excludes"),
			...(input.escalateWhen !== undefined ? { escalateWhen: list(input.escalateWhen, "escalateWhen") } : {}),
		};
	}

	private normalizePiResources(input: PiResourceConfig | undefined): PiResourceConfig | undefined {
		if (input === undefined) return undefined;
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("piResources 必须是对象");
		const result: PiResourceConfig = {};
		if (input.systemPrompt !== undefined) {
			if (typeof input.systemPrompt !== "string") throw new Error("piResources.systemPrompt 必须是字符串");
			const value = input.systemPrompt.trim();
			if (value) result.systemPrompt = value;
		}
		for (const key of ["skillPaths", "promptTemplatePaths"] as const) {
			const value = input[key];
			if (value !== undefined) {
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
					throw new Error(`piResources.${key} 必须是字符串数组`);
				}
				result[key] = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
			}
		}
		for (const key of ["loadGlobalSkills", "loadWorkspaceSkills", "loadGlobalPrompts", "loadWorkspacePrompts", "loadWorkspaceContext"] as const) {
			if (input[key] !== undefined) {
				if (typeof input[key] !== "boolean") throw new Error(`piResources.${key} 必须是布尔值`);
				result[key] = input[key];
			}
		}
		return Object.keys(result).length ? result : undefined;
	}

	async upsertAgent(input: AgentConfig): Promise<AgentConfig> {
		const agent: AgentConfig = {
			enabled: true,
			...input,
			name: input.name.trim(),
		};
		if (!agent.name) throw new Error("agent name is required");
		agent.responsibility = this.normalizeResponsibility(agent.responsibility);
		if (!agent.responsibility) delete agent.responsibility;
		agent.piResources = this.normalizePiResources(agent.piResources);
		if (!agent.piResources) delete agent.piResources;
		const invoke = agent.invoke;
		if (invoke?.type === "pi") {
			// §10.5：pi 类型只放开给 pinned 保留名 manager，且强制启用。
			if (agent.name !== MANAGER_AGENT_NAME) {
				throw new Error(`agent "${agent.name}": "pi" invoke 仅限保留名 "${MANAGER_AGENT_NAME}"`);
			}
			if (agent.connector || (agent.capabilityExtensions ?? []).length > 0) {
				throw new Error("manager 不绑定 Connector / Capability Extension");
			}
			agent.pinned = true;
			agent.enabled = true;
		} else if (agent.pinned) {
			throw new Error(`agent "${agent.name}": pinned 条目必须使用 "pi" invoke`);
		} else if (agent.name === MANAGER_AGENT_NAME) {
			throw new Error(`"${MANAGER_AGENT_NAME}" 是 pinned 内置 Agent 的保留名`);
		} else if (invoke?.type === "command") {
			if (!invoke.command?.trim()) {
				throw new Error(`agent "${agent.name}": invoke.command is required`);
			}
			const runArgs = invoke.runArgs ?? [];
			if (!Array.isArray(runArgs) || !runArgs.every((a) => typeof a === "string")) {
				throw new Error(`agent "${agent.name}": runArgs must be an array of strings`);
			}
			if (invoke.probeArgs !== undefined && !invoke.probeArgs.every((a) => typeof a === "string")) {
				throw new Error(`agent "${agent.name}": probeArgs must be an array of strings`);
			}
			agent.invoke = { ...invoke, runArgs };
		} else if (!agent.connector) {
			throw new Error(`agent "${agent.name}": 需要 command invoke 或 connector 绑定`);
		}
		if (agent.connector) {
			if (invoke?.type === "pi") throw new Error("manager 不绑定 Connector");
			const c = agent.connector;
			if (!c.extensionId?.trim() || !c.connectorId?.trim()) {
				throw new Error(`agent "${agent.name}": connector 需要 extensionId 与 connectorId`);
			}
			if (c.config === undefined || typeof c.config !== "object" || Array.isArray(c.config)) {
				throw new Error(`agent "${agent.name}": connector.config 必须是对象`);
			}
		}
		if (agent.piResources && !agent.pinned && agent.connector?.connectorId !== "pi") {
			throw new Error(`agent "${agent.name}": piResources 仅适用于 pi Agent`);
		}
		if (agent.capabilityExtensions !== undefined) {
			if (!Array.isArray(agent.capabilityExtensions)) {
				throw new Error(`agent "${agent.name}": capabilityExtensions must be an array`);
			}
			for (const b of agent.capabilityExtensions) {
				if (!b.id || !b.extensionId || !b.capabilityId) {
					throw new Error(`agent "${agent.name}": capability binding 需要 id/extensionId/capabilityId`);
				}
			}
		}
		if (agent.env !== undefined) {
			if (typeof agent.env !== "object" || Array.isArray(agent.env)) {
				throw new Error(`agent "${agent.name}": env must be an object`);
			}
			for (const [key, value] of Object.entries(agent.env)) {
				if (typeof value !== "string") {
					throw new Error(`agent "${agent.name}": env value for "${key}" must be a string`);
				}
			}
		}

		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const idx = agents.findIndex((a) => a.name === agent.name);
			// Extension 配置版本递增（§3.3.5）：旧配置保留的 extensionRevision
			// 在基础上 +1，manager Session 据此发现装配陈旧。
			const prev = idx >= 0 ? agents[idx] : undefined;
			agent.extensionRevision = (prev?.extensionRevision ?? 0) + 1;
			if (idx >= 0) agents[idx] = agent;
			else agents.push(agent);
			await this.writeAgents(agents);
		});
		this.emitChange();
		return agent;
	}

	async removeAgent(name: string): Promise<boolean> {
		const existing = await this.getAgent(name);
		if (existing?.pinned) throw new Error(`agent「${name}」是 pinned 内置 Agent，不可删除`);
		let removed = false;
		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const next = agents.filter((a) => a.name !== name);
			removed = next.length !== agents.length;
			if (removed) await this.writeAgents(next);
		});
		// Best-effort cleanup of the avatar file so it doesn't orphan on disk.
		if (removed && SAFE_AGENT_NAME.test(name)) await this.removeAvatarFiles(name);
		if (removed) this.emitChange();
		return removed;
	}

	async setEnabled(name: string, enabled: boolean): Promise<AgentConfig> {
		let updated: AgentConfig | undefined;
		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const idx = agents.findIndex((a) => a.name === name);
			if (idx < 0) throw new Error(`agent not found: ${name}`);
			if (agents[idx]!.pinned && !enabled) throw new Error(`agent「${name}」是 pinned 内置 Agent，不可禁用`);
			agents[idx] = { ...agents[idx]!, enabled, extensionRevision: (agents[idx]!.extensionRevision ?? 0) + 1 };
			updated = agents[idx];
			await this.writeAgents(agents);
		});
		this.emitChange();
		return updated!;
	}

	// ---- Connector / Capability 绑定（§10.1 管理 API 的存储层） ----

	/** 通用 Agent 字段变更：统一处理持久化、extensionRevision 递增与变更通知。 */
	private async mutateAgent(name: string, mutate: (agent: AgentConfig) => AgentConfig): Promise<AgentConfig> {
		let updated: AgentConfig | undefined;
		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const idx = agents.findIndex((a) => a.name === name);
			if (idx < 0) throw new Error(`agent not found: ${name}`);
			const next = mutate({ ...agents[idx]! });
			next.extensionRevision = (agents[idx]!.extensionRevision ?? 0) + 1;
			agents[idx] = next;
			updated = next;
			await this.writeAgents(agents);
		});
		this.emitChange();
		return updated!;
	}

	/** 设置/更换 Connector 绑定（§10.1 基础接入；secret 明文不落这里）。 */
	async setConnectorBinding(name: string, connector: AgentConnectorBinding | undefined): Promise<AgentConfig> {
		const agent = await this.getAgent(name);
		if (!agent) throw new Error(`agent not found: ${name}`);
		if (agent.pinned) throw new Error(`agent「${name}」是 pinned 内置 Agent，不绑定 Connector`);
		if (connector !== undefined) {
			if (!connector.extensionId?.trim() || !connector.connectorId?.trim()) {
				throw new Error("connector 需要 extensionId 与 connectorId");
			}
			if (typeof connector.config !== "object" || connector.config === null || Array.isArray(connector.config)) {
				throw new Error("connector.config 必须是对象");
			}
		}
		return this.mutateAgent(name, (a) => {
			if (connector) a.connector = connector;
			else delete a.connector;
			return a;
		});
	}

	/** 新增 Capability Extension 绑定。 */
	async addCapabilityBinding(name: string, binding: Omit<AgentCapabilityBinding, "id"> & { id?: string }): Promise<AgentConfig> {
		const agent = await this.getAgent(name);
		if (!agent) throw new Error(`agent not found: ${name}`);
		if (agent.pinned) throw new Error(`agent「${name}」是 pinned 内置 Agent，不绑定 Capability Extension`);
		if (!binding.extensionId?.trim() || !binding.capabilityId?.trim()) {
			throw new Error("capability binding 需要 extensionId 与 capabilityId");
		}
		if (binding.activation !== undefined && binding.activation !== "always" && binding.activation !== "searchable") {
			throw new Error('binding.activation 必须是 "always" | "searchable"');
		}
		const full: AgentCapabilityBinding = {
			...binding,
			id: binding.id ?? randomUUID().slice(0, 8),
			enabled: binding.enabled ?? true,
			config: binding.config ?? {},
		};
		return this.mutateAgent(name, (a) => {
			const list = [...(a.capabilityExtensions ?? [])];
			if (list.some((b) => b.id === full.id)) throw new Error(`binding id 重复：${full.id}`);
			list.push(full);
			a.capabilityExtensions = list;
			return a;
		});
	}

	/** 更新 Capability Extension 绑定（enabled/config/activation/versionPin/secretRefs）。 */
	async patchCapabilityBinding(
		name: string,
		bindingId: string,
		patch: Partial<Omit<AgentCapabilityBinding, "id" | "extensionId" | "capabilityId">>,
	): Promise<AgentConfig> {
		return this.mutateAgent(name, (a) => {
			const list = [...(a.capabilityExtensions ?? [])];
			const idx = list.findIndex((b) => b.id === bindingId);
			if (idx < 0) throw new Error(`binding not found: ${bindingId}`);
			const current = list[idx]!;
			list[idx] = {
				...current,
				...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
				...(patch.config !== undefined ? { config: patch.config } : {}),
				...(patch.activation !== undefined ? { activation: patch.activation } : {}),
				...(patch.versionPin !== undefined ? { versionPin: patch.versionPin } : {}),
				...(patch.secretRefs !== undefined ? { secretRefs: patch.secretRefs } : {}),
			};
			a.capabilityExtensions = list;
			return a;
		});
	}

	/** 移除 Capability Extension 绑定（保留安装包本身）。 */
	async removeCapabilityBinding(name: string, bindingId: string): Promise<AgentConfig> {
		return this.mutateAgent(name, (a) => {
			const list = (a.capabilityExtensions ?? []).filter((b) => b.id !== bindingId);
			if (list.length === (a.capabilityExtensions ?? []).length) throw new Error(`binding not found: ${bindingId}`);
			a.capabilityExtensions = list;
			return a;
		});
	}

	// ---- pinned manager（§10.5） ----

	/** 读取 pinned manager 条目（不存在时返回 undefined）。 */
	async getManager(): Promise<AgentConfig | undefined> {
		const agent = await this.getAgent(MANAGER_AGENT_NAME);
		return agent?.pinned ? agent : undefined;
	}

	/** 校验并归一化 manager 可编辑配置。 */
	private validateManagerSettings(input: Record<string, unknown>): PiManagerSettings {
		const out: PiManagerSettings = {};
		if (input.model !== undefined) {
			if (typeof input.model !== "string" || !input.model.trim()) throw new Error("manager.model 必须是非空字符串");
			out.model = input.model.trim();
		}
		for (const key of ["builtinTools", "noExtensions"] as const) {
			if (input[key] !== undefined) {
				if (typeof input[key] !== "boolean") throw new Error(`manager.${key} 必须是布尔值`);
				out[key] = input[key] as boolean;
			}
		}
		if (input.thinkingLevel !== undefined) {
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
			if (!levels.includes(input.thinkingLevel as string)) {
				throw new Error(`manager.thinkingLevel 必须是 ${levels.join(" | ")}`);
			}
			out.thinkingLevel = input.thinkingLevel as PiManagerSettings["thinkingLevel"];
		}
		return out;
	}

	/**
	 * 更新 pinned manager 的可编辑配置（§10.5）：描述 + manager settings 合并
	 * （patch 中未出现的 settings 键保持不变；prompt 传空串清除）。
	 */
	async updateManager(patch: { description?: string; manager?: Record<string, unknown>; responsibility?: AgentResponsibilityProfile | null; piResources?: PiResourceConfig | null }): Promise<AgentConfig> {
		const agent = await this.getManager();
		if (!agent) throw new Error(`pinned manager 不存在：${MANAGER_AGENT_NAME}`);
		const settings = patch.manager !== undefined ? this.validateManagerSettings(patch.manager) : undefined;
		const responsibility = patch.responsibility ? this.normalizeResponsibility(patch.responsibility) : undefined;
		const piResources = patch.piResources ? this.normalizePiResources(patch.piResources) : undefined;
		return this.mutateAgent(MANAGER_AGENT_NAME, (a) => {
			if (patch.description !== undefined) a.description = patch.description.trim();
			if (patch.responsibility !== undefined) {
				if (responsibility) a.responsibility = responsibility;
				else delete a.responsibility;
			}
			if (patch.piResources !== undefined) {
				if (piResources) a.piResources = piResources;
				else delete a.piResources;
			}
			if (settings) {
				// 合并语义：patch 中出现的键覆盖（false/空串也是有意义的值），
				// 未出现的键保持不变。
				const current = { ...(a.manager ?? {}) };
				for (const [key, value] of Object.entries(settings)) {
					(current as Record<string, unknown>)[key] = value;
				}
				a.manager = current;
			}
			return a;
		});
	}

	// ---- avatars (§11) ----

	private avatarsDir(): string {
		return path.join(this.teamsDir, "avatars");
	}

	/** Remove any existing avatar files for `name` (all whitelisted extensions). */
	private async removeAvatarFiles(name: string): Promise<void> {
		for (const t of AVATAR_TYPES) {
			await unlink(path.join(this.avatarsDir(), `${name}.${t.ext}`)).catch((err: unknown) => {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			});
		}
	}

	/**
	 * Store an uploaded avatar image and point the agent's `avatar` field at it.
	 * The buffer is validated by magic bytes (the client-supplied mediaType is
	 * ignored); same-name uploads overwrite, and stale extensions are cleaned up.
	 */
	async saveAvatar(name: string, buf: Buffer): Promise<AgentConfig> {
		if (!SAFE_AGENT_NAME.test(name)) throw new Error(`invalid agent name: ${name}`);
		const agent = await this.getAgent(name);
		if (!agent) throw new Error(`agent not found: ${name}`);
		if (buf.length === 0) throw new Error("avatar image is empty");
		if (buf.length > AVATAR_MAX_BYTES) {
			throw new Error(`avatar exceeds ${AVATAR_MAX_BYTES / 1024 / 1024}MB limit`);
		}
		const type = AVATAR_TYPES.find((t) => t.sniff(buf));
		if (!type) throw new Error("avatar must be a png/jpg/webp/gif image");
		await mkdir(this.avatarsDir(), { recursive: true });
		await this.removeAvatarFiles(name);
		const fileName = `${name}.${type.ext}`;
		await writeFile(path.join(this.avatarsDir(), fileName), buf);
		return this.setAvatarField(name, fileName);
	}

	/** Delete the avatar file and clear the field, falling back to the default. */
	async removeAvatar(name: string): Promise<AgentConfig> {
		if (!SAFE_AGENT_NAME.test(name)) throw new Error(`invalid agent name: ${name}`);
		const agent = await this.getAgent(name);
		if (!agent) throw new Error(`agent not found: ${name}`);
		await this.removeAvatarFiles(name);
		return this.setAvatarField(name, undefined);
	}

	private async setAvatarField(name: string, fileName: string | undefined): Promise<AgentConfig> {
		let updated: AgentConfig | undefined;
		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const idx = agents.findIndex((a) => a.name === name);
			if (idx < 0) throw new Error(`agent not found: ${name}`);
			const next = { ...agents[idx]! };
			if (fileName) next.avatar = fileName;
			else delete next.avatar;
			agents[idx] = next;
			updated = next;
			await this.writeAgents(agents);
		});
		return updated!;
	}

	/** Read the avatar image for `name`; null when unset or the file is gone. */
	async readAvatar(name: string): Promise<{ buf: Buffer; mime: string } | null> {
		if (!SAFE_AGENT_NAME.test(name)) return null;
		const agent = await this.getAgent(name);
		if (!agent?.avatar) return null;
		const type = AVATAR_TYPES.find((t) => agent.avatar === `${name}.${t.ext}`);
		if (!type) return null;
		try {
			const buf = await readFile(path.join(this.avatarsDir(), agent.avatar));
			return { buf, mime: type.mime };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return null;
		}
	}

	// ---- windows ----

	private async loadWindowsFile(): Promise<WindowsFile> {
		try {
			const raw = await readFile(this.windowsFile, "utf-8");
			const parsed = JSON.parse(raw) as Partial<WindowsFile>;
			return { version: 1, windows: parsed.windows ?? {} };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			// 决策 20：无兼容、无历史数据迁移。旧 rooms.json 直接忽略。
			return { version: 1, windows: {} };
		}
	}

	private async windowsFileData(): Promise<WindowsFile> {
		this.windowsPromise ??= this.loadWindowsFile().catch((err: unknown) => {
			this.windowsPromise = null;
			throw err;
		});
		return this.windowsPromise;
	}

	private async writeWindows(data: WindowsFile): Promise<void> {
		await this.writeJsonFile(this.windowsFile, data);
		this.windowsPromise = Promise.resolve(data);
	}

	/** All window configs. */
	async listWindows(): Promise<WindowConfig[]> {
		return Object.values((await this.windowsFileData()).windows);
	}

	async getWindow(id: string): Promise<WindowConfig | undefined> {
		return (await this.windowsFileData()).windows[id];
	}

	/** Resolve the identity used by a newly created Window. */
	async contextForWorkspace(workspaceId?: string): Promise<{ workspaceId?: string; cwdSnapshot: string }> {
		if (!workspaceId) return { cwdSnapshot: this.defaultCwdSnapshot };
		const workspace = await this.workspaces.require(workspaceId);
		return { workspaceId, cwdSnapshot: workspace.canonicalPath };
	}

	defaultContextCwd(): string {
		return this.defaultCwdSnapshot;
	}

	/**
	 * Resolve the window cwd. No workspace is a first-class mode and preserves
	 * the original product behavior: manager and workers both run in the
	 * configured default cwd. An explicit workspace never falls back.
	 */
	async workspaceFor(windowId: string): Promise<string> {
		const w = await this.getWindow(windowId);
		if (!w) throw new Error(`window not found: ${windowId}`);
		const current = await realpath(w.cwdSnapshot).catch(() => undefined);
		if (!current || current !== w.cwdSnapshot) throw new Error(`窗口运行目录已失效或身份已变化：${w.cwdSnapshot}`);
		if (!w.workspaceId) return w.cwdSnapshot;
		const workspace = await this.workspaces.require(w.workspaceId);
		if (workspace.canonicalPath !== w.cwdSnapshot) throw new Error(`窗口 cwdSnapshot 与 Workspace 身份不一致：${windowId}`);
		await this.workspaces.touch(workspace.id);
		await ensureHandoffGuidance(workspace.canonicalPath);
		return workspace.canonicalPath;
	}

	/** The window that owns a pi session, if any. */
	async windowForSession(sessionId: string): Promise<WindowConfig | undefined> {
		return (await this.listWindows()).find((w) => w.sessions.includes(sessionId));
	}

	/** Existing direct window: project is part of the identity. */
	async findDirectWindow(member: string, workspaceId?: string, cwdSnapshot?: string): Promise<WindowConfig | undefined> {
		const context = workspaceId
			? await this.contextForWorkspace(workspaceId)
			: { cwdSnapshot: cwdSnapshot ?? this.defaultCwdSnapshot };
		return (await this.listWindows()).find(
			(w) =>
				w.type === "direct" &&
				w.members[0] === member &&
				w.workspaceId === workspaceId &&
				w.cwdSnapshot === context.cwdSnapshot,
		);
	}

	/**
	 * Find or auto-create the direct window for a worker (solo task routing,
	 * §4.1: no user involvement). The pi session is created by the caller's
	 * callback only when a new window is actually needed, so a dedup hit never
	 * leaks an orphaned session.
	 */
	async ensureDirectWindow(
		member: string,
		workspaceId: string | undefined,
		createSession: () => Promise<{ id: string }>,
		opts: { name?: string; prompt?: string; cwdSnapshot?: string } = {},
	): Promise<WindowConfig> {
		const context = workspaceId
			? await this.contextForWorkspace(workspaceId)
			: { cwdSnapshot: opts.cwdSnapshot ?? this.defaultCwdSnapshot };
		if ((await realpath(context.cwdSnapshot).catch(() => undefined)) !== context.cwdSnapshot) {
			throw new Error(`窗口运行目录已失效或身份已变化：${context.cwdSnapshot}`);
		}
		return this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const existing = Object.values(data.windows).find(
				(w) =>
					w.type === "direct" &&
					w.members[0] === member &&
					w.workspaceId === workspaceId &&
					w.cwdSnapshot === context.cwdSnapshot,
			);
			if (existing) return existing;
			const created = await createSession();
			const window: WindowConfig = {
				id: randomUUID(),
				type: "direct",
				members: [member],
				name: opts.name?.trim() || undefined,
				prompt: opts.prompt?.trim() || undefined,
				workspaceId,
				cwdSnapshot: context.cwdSnapshot,
				sessions: [created.id],
				activeSession: created.id,
				createdAt: new Date().toISOString(),
			};
			data.windows[window.id] = window;
			await this.writeWindows(data);
			return window;
		});
	}

	/**
	 * Guarantee the solo singleton window exists (pinned, never deletable).
	 * Creates a pi session for it on first boot via `createSession`. If the
	 * solo window exists but its session was lost, a replacement is created.
	 */
	async ensureSoloWindow(
		createSession: (workspaceId: string | undefined, cwdSnapshot: string) => Promise<{ id: string }>,
		sessionExists: (id: string) => Promise<boolean>,
	): Promise<WindowConfig> {
		return this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const solo = Object.values(data.windows).find((w) => w.type === "solo");
			if (solo) {
				if (solo.sessions.length > 0 && (await sessionExists(solo.activeSession))) return solo;
				const created = await createSession(solo.workspaceId, solo.cwdSnapshot);
				solo.sessions = [created.id];
				solo.activeSession = created.id;
				data.windows[solo.id] = solo;
				await this.writeWindows(data);
				return solo;
			}
			const created = await createSession(undefined, this.defaultCwdSnapshot);
			const fresh: WindowConfig = {
				id: "solo",
				type: "solo",
				members: [],
				sessions: [created.id],
				activeSession: created.id,
				cwdSnapshot: this.defaultCwdSnapshot,
				pinned: true,
				createdAt: new Date().toISOString(),
			};
			data.windows["solo"] = fresh;
			await this.writeWindows(data);
			return fresh;
		});
	}

	/** Create a new window bound to a fresh pi session. Direct dedup is the
	 * caller's job (findDirectWindow) so a dedup hit never creates a session. */
	async createWindow(opts: {
		type: WindowType;
		members: string[];
		workspaceId?: string;
		cwdSnapshot?: string;
		name?: string;
		prompt?: string;
		sessionId: string;
	}): Promise<WindowConfig> {
		const { type, members, workspaceId, cwdSnapshot, name, prompt, sessionId } = opts;
		if (type === "solo") throw new Error("solo 窗口由系统创建，不能手动发起");
		const context = await this.contextForWorkspace(workspaceId);
		if (cwdSnapshot !== undefined && cwdSnapshot !== context.cwdSnapshot) {
			throw new Error("Window cwdSnapshot does not match its context");
		}
		return this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const window: WindowConfig = {
				id: randomUUID(),
				type,
				members: [...new Set(members)],
				name: name?.trim() || undefined,
				prompt: prompt?.trim() || undefined,
				sessions: [sessionId],
				activeSession: sessionId,
				workspaceId,
				cwdSnapshot: context.cwdSnapshot,
				createdAt: new Date().toISOString(),
			};
			data.windows[window.id] = window;
			await this.writeWindows(data);
			return window;
		});
	}

	async updateWindow(
		id: string,
		patch: { name?: string; members?: string[]; prompt?: string },
	): Promise<WindowConfig> {
		const result = await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[id];
			if (!w) throw new Error(`window not found: ${id}`);
			if (patch.name !== undefined) w.name = patch.name?.trim() || undefined;
			if (patch.prompt !== undefined) w.prompt = patch.prompt?.trim() || undefined;
			if (patch.members !== undefined) {
				const members = [...new Set(patch.members)];
				if (w.type === "solo") {
					if (members.length > 0) throw new Error("solo 窗口不能添加成员");
					w.members = [];
			} else if (w.type === "direct") {
					if (members.length !== 1) throw new Error("单聊窗口必须有且仅有一个 worker");
					const duplicate = Object.values(data.windows).find(
						(other) =>
							other.id !== w.id &&
							other.type === "direct" &&
							other.workspaceId === w.workspaceId &&
							other.cwdSnapshot === w.cwdSnapshot &&
							other.members[0] === members[0],
					);
					if (duplicate) throw new Error("该 worker 在当前项目已有单聊窗口");
					w.members = members;
				} else {
					if (members.length < 2) throw new Error("群聊窗口至少需要 2 个 worker");
					w.members = members;
				}
			}
			await this.writeWindows(data);
			return w;
		});
		// 成员或 prompt 变化影响 manager Session 的装配与撤权，通知订阅方。
		if (patch.members !== undefined || patch.prompt !== undefined) this.emitChange();
		return result;
	}

	/** 原地切换上下文：调用方先取消 Run、创建新 manager Session，再原子替换。 */
	async replaceWindowWorkspace(
		id: string,
		workspaceId: string | undefined,
		sessionId: string,
		expected?: Pick<WindowConfig, "workspaceId" | "cwdSnapshot" | "members" | "prompt" | "sessions" | "activeSession">,
	): Promise<{ window: WindowConfig; previousSessionIds: string[] }> {
		const target = await this.contextForWorkspace(workspaceId);
		let previousSessionIds: string[] = [];
		const window = await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[id];
			if (!w) throw new Error(`window not found: ${id}`);
			if (
				expected &&
				(w.workspaceId !== expected.workspaceId ||
					w.cwdSnapshot !== expected.cwdSnapshot ||
					w.activeSession !== expected.activeSession ||
					w.prompt !== expected.prompt ||
					JSON.stringify(w.members) !== JSON.stringify(expected.members) ||
					JSON.stringify(w.sessions) !== JSON.stringify(expected.sessions))
			) {
				throw new Error("window changed during workspace switch; retry");
			}
			if (w.type === "direct") {
				const duplicate = Object.values(data.windows).find(
					(other) =>
						other.id !== w.id &&
						other.type === "direct" &&
						other.workspaceId === workspaceId &&
						other.cwdSnapshot === target.cwdSnapshot &&
						other.members[0] === w.members[0],
				);
				if (duplicate) throw new Error("该 worker 在目标项目已有单聊窗口");
			}
			previousSessionIds = [...w.sessions];
			w.workspaceId = workspaceId;
			w.cwdSnapshot = target.cwdSnapshot;
			w.sessions = [sessionId];
			w.activeSession = sessionId;
			w.workerBindings = {};
			await this.writeWindows(data);
			return w;
		});
		this.emitChange();
		return { window, previousSessionIds };
	}

	/** Delete a window (solo refused). Returns its pi session ids so the caller
	 * can cascade-delete them from the session store. */
	async removeWindow(id: string): Promise<string[]> {
		const sessionIds: string[] = [];
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[id];
			if (!w) return;
			if (w.pinned) throw new Error("solo 窗口不可删除");
			sessionIds.push(...w.sessions);
			delete data.windows[id];
			await this.writeWindows(data);
		});
		return sessionIds;
	}

	/** Create a new pi session inside a window and make it active. */
	async addWindowSession(windowId: string, sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[windowId];
			if (!w) throw new Error(`window not found: ${windowId}`);
			if (!w.sessions.includes(sessionId)) w.sessions.unshift(sessionId);
			w.activeSession = sessionId;
			await this.writeWindows(data);
		});
	}

	/** Switch the active pi session of a window (must already belong to it). */
	async setActiveWindowSession(windowId: string, sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[windowId];
			if (!w) throw new Error(`window not found: ${windowId}`);
			if (!w.sessions.includes(sessionId)) throw new Error(`session not in window: ${sessionId}`);
			w.activeSession = sessionId;
			await this.writeWindows(data);
		});
	}

	/** Delete one pi session inside a window; the last session is protected. */
	async removeWindowSession(
		windowId: string,
		sessionId: string,
	): Promise<{ removed: boolean; blocked?: string }> {
		let res: { removed: boolean; blocked?: string } = { removed: false };
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[windowId];
			if (!w) return;
			if (!w.sessions.includes(sessionId)) return;
			if (w.sessions.length <= 1) {
				res = { removed: false, blocked: "窗口至少要保留一个会话" };
				return;
			}
			w.sessions = w.sessions.filter((s) => s !== sessionId);
			if (w.activeSession === sessionId) w.activeSession = w.sessions[0]!;
			await this.writeWindows(data);
			res = { removed: true };
		});
		return res;
	}

	/** The pi sessions belonging to a window, plus the active one. */
	async windowSessionList(windowId: string): Promise<{ sessions: string[]; active: string }> {
		const w = await this.getWindow(windowId);
		if (!w) return { sessions: [], active: "" };
		const sessions = w.sessions.length ? w.sessions : [windowId];
		const active = w.activeSession && sessions.includes(w.activeSession) ? w.activeSession : sessions[0]!;
		return { sessions, active };
	}

	/** Enabled workers a window may delegate to. solo always resolves to []. */
	async windowMembers(windowId: string): Promise<AgentConfig[]> {
		const agents = await this.listAgents();
		const enabled = agents.filter((a) => a.enabled !== false && !a.pinned);
		const w = await this.getWindow(windowId);
		if (!w || w.type === "solo" || w.members.length === 0) return [];
		return enabled.filter((a) => w.members.includes(a.name));
	}

	/** Members for the window that owns a pi session. */
	async membersForSession(sessionId: string): Promise<AgentConfig[]> {
		const w = await this.windowForSession(sessionId);
		return w ? this.windowMembers(w.id) : [];
	}

	/** When a pi session is deleted outside the window API: purge it from any
	 * window's session list (keeping at least one session per window). */
	async removeSessionFromWindows(sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			let changed = false;
			for (const w of Object.values(data.windows)) {
				if (!w.sessions.includes(sessionId)) continue;
				if (w.sessions.length <= 1) continue;
				w.sessions = w.sessions.filter((s) => s !== sessionId);
				if (w.activeSession === sessionId) w.activeSession = w.sessions[0]!;
				changed = true;
			}
			if (changed) await this.writeWindows(data);
		});
	}

	private async readWorkerSession(windowId: string, worker: string): Promise<string | undefined> {
		const w = await this.getWindow(windowId);
		return w?.workerBindings?.[worker]?.sessionHandle;
	}

	/** Record the worker session handle for continuity. Best-effort, non-fatal. */
	async rememberWorkerSession(
		windowId: string,
		worker: string,
		sessionHandle: string | undefined,
		workspaceId: string | undefined,
		cwdSnapshot: string,
		agentRevision: number,
	): Promise<void> {
		if (!sessionHandle) return;
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[windowId];
			if (!w) return;
			// A run that finishes after a workspace/config transition must never
			// repopulate the new window with its old opaque session handle.
			if (w.workspaceId !== workspaceId || (await this.workspaceFor(w.id)) !== cwdSnapshot) return;
			const currentAgent = (await this.loadAgentsFile()).find((agent) => agent.name === worker);
			if (!currentAgent || (currentAgent.extensionRevision ?? 0) !== agentRevision) return;
			w.workerBindings = {
				...(w.workerBindings ?? {}),
				[worker]: { sessionHandle, workspaceId, cwdSnapshot, agentRevision, updatedAt: new Date().toISOString() },
			};
			await this.writeWindows(data);
		}).catch(() => undefined);
	}

	/** Invalidate worker session identity after credentials or extension code changes. */
	async bumpAgentRevision(name: string): Promise<number> {
		return this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const agent = agents.find((item) => item.name === name);
			if (!agent) throw new Error(`agent not found: ${name}`);
			agent.extensionRevision = (agent.extensionRevision ?? 0) + 1;
			await this.writeAgents(agents);
			return agent.extensionRevision;
		});
	}

	/**
	 * Run the worker's probe command and return a normalized status. Uses the
	 * shared spawn transport (Phase 1 extraction); driver behavior lives in the
	 * AgentRuntime layer but the agent registry probe is kept here so the
	 * management UI can check health without an enabled Agent binding.
	 */
	async probeAgent(name: string): Promise<WorkerProbeResult> {
		const agent = await this.getAgent(name);
		if (!agent) throw new Error(`agent not found: ${name}`);
		const invoke = agent.invoke;
		// Connector 接入的 Agent 走 Driver.probe（路由层处理）；这里只保留
		// legacy command invoke 的探测路径。
		if (invoke?.type !== "command") {
			return {
				name,
				command: agent.connector ? `connector:${agent.connector.connectorId}` : `pi:${name}`,
				ok: false,
				raw: {},
				exitCode: -1,
				error: "该 Agent 的探测请走 Connector Driver.probe",
			};
		}
		const args = invoke.probeArgs ?? ["doctor", "--json"];
		const secrets = this.credentials ? await this.credentials.getSecrets(agent.name) : {};
		const env = { ...process.env, ...(agent.env ?? {}), ...secrets };
		const { exitCode, stdout, stderr, timedOut, spawnError } = await spawnWorker({
			command: invoke.command,
			args,
			env,
			cwd: this.cwd,
			timeoutMs: 15_000,
		});
		if (timedOut) {
			return { name, command: `${invoke.command} ${args.join(" ")}`, ok: false, raw: {}, exitCode: -1, error: "probe timed out" };
		}
		let raw: Record<string, unknown> = {};
		let ok = false;
		try {
			raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
			ok = exitCode === 0;
		} catch {
			ok = false;
		}
		return {
			name,
			command: `${invoke.command} ${args.join(" ")}`,
			ok,
			raw,
			exitCode,
			...(ok ? {} : { error: stderr.trim() || (spawnError ? spawnError.message : `exit code ${exitCode}`) }),
		};
	}

}
