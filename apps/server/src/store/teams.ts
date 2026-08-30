import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, realpath, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CredentialsStore } from "./credentials.js";
import { spawnWorker } from "../agent-runtime/transport/spawn.js";
import { ensureHandoffGuidance } from "../agent-runtime/handoff.js";
import type { AgentCapabilityBinding, AgentConnectorBinding } from "../agent-runtime/extensions.js";
import { WorkspaceStore, type WorkspaceTrust } from "./workspaces.js";
import type { ManagerCodeSearchProvider, WorkerCodeSearchOverride } from "../pi-bridge/code-search.js";

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
	/** Manager 独立搜索策略；默认 off。relay 窗口始终关闭。 */
	codeSearch?: ManagerCodeSearchProvider;
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
	/** 资源库（pi 全局目录）技能选用名单，按 name；缺省 = 不启用任何库技能。 */
	enabledSkills?: string[];
	/** 资源库（pi 全局目录）模板选用名单，按 name；缺省 = 不启用任何库模板。 */
	enabledPrompts?: string[];
	skillPaths?: string[];
	promptTemplatePaths?: string[];
	loadWorkspaceSkills?: boolean;
	loadWorkspacePrompts?: boolean;
	loadWorkspaceContext?: boolean;
}

/** pinned 内置 Pi manager 的保留名（§10.5）。 */
export const MANAGER_AGENT_NAME = "manager";

/**
 * 显示名归一化：trim；null/空串 = 清除（展示回退 name）；任意 unicode，≤40 字符。
 * undefined 表示"未提供"（调用方据此区分不更新与清除）。
 */
export function normalizeDisplayName(input: string | null | undefined, agentName: string): string | undefined {
	if (input === undefined) return undefined;
	if (input === null) return undefined;
	if (typeof input !== "string") throw new Error(`agent "${agentName}": displayName 必须是字符串`);
	const display = input.trim();
	if (!display) return undefined;
	if ([...display].length > 40) throw new Error(`agent "${agentName}": displayName 不能超过 40 个字符`);
	return display;
}

/** Agent 的显示名：displayName 缺省时回退不可变内部 id（name）。 */
export function agentDisplayName(agent: Pick<AgentConfig, "name" | "displayName">): string {
	return agent.displayName?.trim() || agent.name;
}

/**
 * 从显示名派生内部 id：提取 ASCII slug（小写、连字符，≤32 字符）；
 * 显示名无 ASCII 字母数字时回退 worker-<6 位随机 hex>。撞名由调用方追加后缀。
 */
export function agentIdFromDisplayName(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	if (slug && /^[a-z0-9]/.test(slug)) return slug;
	return `worker-${randomBytes(3).toString("hex")}`;
}

export interface AgentResponsibilityProfile {
	identity?: string;
	domain: string;
	owns: string[];
	excludes: string[];
	escalateWhen?: string[];
}

export interface AgentConfig {
	/** Pi worker 可覆盖 Harness 默认搜索实现。 */
	codeSearch?: WorkerCodeSearchOverride;
	/**
	 * Agent 的不可变内部 id（工具命名空间 agent_<agentId>__*、windows/credentials/
	 * delegations 的存储键、REST 路径参数）。创建后不可改；创建时可由 displayName
	 * 自动生成。用户可见的显示名是 displayName，不要用 name 做展示。
	 */
	name: string;
	/** 用户可见显示名，可随时改；任意 unicode，允许重复。缺省回退 name。 */
	displayName?: string;
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
	/** Avatar image file name inside `<assets>/avatars/` (§11); absent = default. */
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
	/** Window in which this Worker Session executes; prevents cross-window handle reuse. */
	targetWindowId: string;
	/** 缺省表示未选择项目；此时 cwdSnapshot 是平台默认运行目录。 */
	workspaceId?: string;
	cwdSnapshot: string;
	agentRevision: number;
	updatedAt: string;
}

/**
 * Worker 连续性属于一次 PuddingTeams 房间 Session，而不是整个 Window。
 * 外层 key 是 manager/room Session id，内层 key 是 Worker id。
 */
export type SessionWorkerBindings = Record<string, Record<string, WorkerBinding>>;

/**
 * A Window keeps exactly one execution context active. Contexts left through
 * an in-place workspace switch are parked here with their complete Session
 * state so switching back can restore the conversation without crossing cwd
 * boundaries.
 */
export interface ParkedWindowContext {
	workspaceId?: string;
	cwdSnapshot: string;
	sessions: string[];
	activeSession: string;
	workerBindings?: SessionWorkerBindings;
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
	 * 群聊协作提示词（提示词管理方案 §5.3）：仅 Group 可编辑，只注入该群聊
	 * manager，不传给 Worker。Direct 无 manager 回合、无协作段（§5.2，纯
	 * worker 通道），服务端拒绝写入；Solo 无协作段。
	 */
	prompt?: string;
	/** Per-room-Session, per-worker handles for isolated multi-turn continuity (§7.1). */
	workerBindings?: SessionWorkerBindings;
	/** Inactive workspace contexts keyed by workspace identity + canonical cwd. */
	parkedContexts: Record<string, ParkedWindowContext>;
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

function windowContextKey(workspaceId: string | undefined, cwdSnapshot: string): string {
	return JSON.stringify([workspaceId ?? null, cwdSnapshot]);
}

function activeWindowContext(window: WindowConfig): ParkedWindowContext {
	return {
		...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
		cwdSnapshot: window.cwdSnapshot,
		sessions: [...window.sessions],
		activeSession: window.activeSession,
		...(window.workerBindings ? { workerBindings: structuredClone(window.workerBindings) } : {}),
	};
}

function assignActiveWindowContext(window: WindowConfig, context: ParkedWindowContext): void {
	window.workspaceId = context.workspaceId;
	window.cwdSnapshot = context.cwdSnapshot;
	window.sessions = [...context.sessions];
	window.activeSession = context.activeSession;
	window.workerBindings = context.workerBindings ? structuredClone(context.workerBindings) : {};
}

function contextContainingSession(
	window: WindowConfig,
	sessionId: string,
): { context: ParkedWindowContext; active: boolean; key?: string } | undefined {
	if (window.sessions.includes(sessionId)) {
		return {
			context: {
				...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
				cwdSnapshot: window.cwdSnapshot,
				sessions: window.sessions,
				activeSession: window.activeSession,
				workerBindings: window.workerBindings,
			},
			active: true,
		};
	}
	for (const [key, context] of Object.entries(window.parkedContexts)) {
		if (context.sessions.includes(sessionId)) return { context, active: false, key };
	}
	return undefined;
}

interface WindowsFile {
	version: number;
	windows: Record<string, WindowConfig>;
}

const WINDOWS_FILE_VERSION = 2;

function recordValue(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeWorkerBinding(value: Record<string, unknown>): boolean {
	return typeof value.sessionHandle === "string"
		|| typeof value.targetWindowId === "string"
		|| typeof value.cwdSnapshot === "string"
		|| typeof value.agentRevision === "number";
}

/**
 * One-shot v1 -> v2 upgrade. v1 kept worker bindings at Window scope and had
 * no parkedContexts field. Preserve every Session id and map those handles to
 * the then-active Session; v2 runtime code only consumes the normalized shape.
 */
function upgradeWindowsFile(data: WindowsFile): boolean {
	if (data.version > WINDOWS_FILE_VERSION) {
		throw new Error(`windows.json version ${data.version} is newer than supported version ${WINDOWS_FILE_VERSION}`);
	}
	if (data.version === WINDOWS_FILE_VERSION) return false;
	let changed = true;
	const targetWindowFor = (owner: WindowConfig, agentId: string): string => {
		if (owner.type !== "solo") return owner.id;
		return Object.values(data.windows).find((candidate) =>
			candidate.type === "direct"
			&& candidate.members[0] === agentId
			&& candidate.workspaceId === owner.workspaceId
			&& candidate.cwdSnapshot === owner.cwdSnapshot,
		)?.id ?? owner.id;
	};
	for (const window of Object.values(data.windows)) {
		const rawWindow = window as WindowConfig & { parkedContexts?: unknown; workerBindings?: unknown };
		if (!recordValue(rawWindow.parkedContexts)) {
			rawWindow.parkedContexts = {};
			changed = true;
		}
		if (rawWindow.workerBindings === undefined) continue;
		if (!recordValue(rawWindow.workerBindings)) {
			throw new Error(`window "${window.id ?? "unknown"}" has invalid workerBindings`);
		}
		const normalized: SessionWorkerBindings = {};
		for (const [key, rawValue] of Object.entries(rawWindow.workerBindings)) {
			if (!recordValue(rawValue)) throw new Error(`window "${window.id}" has invalid worker binding: ${key}`);
			if (!looksLikeWorkerBinding(rawValue)) {
				if (!window.sessions.includes(key)) {
					throw new Error(`window "${window.id}" has worker bindings for foreign session: ${key}`);
				}
				const bucket: Record<string, WorkerBinding> = {};
				for (const [agentId, rawBinding] of Object.entries(rawValue)) {
					if (!recordValue(rawBinding) || !looksLikeWorkerBinding(rawBinding)) {
						throw new Error(`window "${window.id}" has invalid worker binding: ${key}/${agentId}`);
					}
					bucket[agentId] = {
						...(typeof rawBinding.sessionHandle === "string" ? { sessionHandle: rawBinding.sessionHandle } : {}),
						targetWindowId: typeof rawBinding.targetWindowId === "string" && rawBinding.targetWindowId ? rawBinding.targetWindowId : targetWindowFor(window, agentId),
						...(typeof rawBinding.workspaceId === "string" && rawBinding.workspaceId ? { workspaceId: rawBinding.workspaceId } : window.workspaceId ? { workspaceId: window.workspaceId } : {}),
						cwdSnapshot: typeof rawBinding.cwdSnapshot === "string" && rawBinding.cwdSnapshot ? rawBinding.cwdSnapshot : window.cwdSnapshot,
						agentRevision: typeof rawBinding.agentRevision === "number" ? rawBinding.agentRevision : 0,
						updatedAt: typeof rawBinding.updatedAt === "string" && rawBinding.updatedAt ? rawBinding.updatedAt : window.createdAt,
					};
				}
				normalized[key] = bucket;
				continue;
			}
			// Legacy v1 shape: workerBindings[agentId] = WorkerBinding. That binding
			// belonged to the active room Session at the time of the upgrade.
			const bucket = normalized[window.activeSession] ?? {};
			bucket[key] = {
				...(typeof rawValue.sessionHandle === "string" ? { sessionHandle: rawValue.sessionHandle } : {}),
				targetWindowId: typeof rawValue.targetWindowId === "string" && rawValue.targetWindowId ? rawValue.targetWindowId : targetWindowFor(window, key),
				...(typeof rawValue.workspaceId === "string" && rawValue.workspaceId ? { workspaceId: rawValue.workspaceId } : window.workspaceId ? { workspaceId: window.workspaceId } : {}),
				cwdSnapshot: typeof rawValue.cwdSnapshot === "string" && rawValue.cwdSnapshot ? rawValue.cwdSnapshot : window.cwdSnapshot,
				agentRevision: typeof rawValue.agentRevision === "number" ? rawValue.agentRevision : 0,
				updatedAt: typeof rawValue.updatedAt === "string" && rawValue.updatedAt ? rawValue.updatedAt : window.createdAt,
			};
			normalized[window.activeSession] = bucket;
		}
		if (JSON.stringify(normalized) !== JSON.stringify(rawWindow.workerBindings)) {
			rawWindow.workerBindings = normalized;
			changed = true;
		}
	}
	data.version = WINDOWS_FILE_VERSION;
	return changed;
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
		// 首装内置 Designer：继承平台默认模型，不烤入开发机上的 provider、
		// skills 或 systemPrompt，确保换一台电脑也能安全创建并继续配置。
		name: "pi-b",
		displayName: "Designer",
		description: "负责UI/UX设计和PPT制作",
		connector: {
			extensionId: "pi",
			connectorId: "pi",
			transport: "sdk",
			config: {},
		},
		enabled: true,
	},
	{
		// 第一方双宿主 Connector 随发行物预置；这里只创建可见 Worker 实例，
		// 上游 CLI/登录态仍由每台电脑独立探测和配置。
		name: "claude-code",
		description: "Anthropic Claude Code CLI worker（spawn + stream-json 流式）",
		connector: {
			extensionId: "claude-code",
			connectorId: "claude-code",
			transport: "spawn",
			config: {},
		},
		enabled: true,
	},
	{
		name: "codex",
		description: "OpenAI Codex CLI worker（spawn + JSONL 流式）",
		connector: {
			extensionId: "codex",
			connectorId: "codex",
			transport: "spawn",
			config: {},
		},
		enabled: true,
	},
	{
		// 决策 20：旧结构直接替换——PuddingClaw 以第一方 Connector binding 接入。
		// 2026-08-17：种子不再预置描述与 capabilities——那是给 manager 的路由
		// 材料，必须由用户在前台按需填写，源码/connector 包不替用户做决定。
		name: "puddingclaw",
		description: "",
		connector: {
			extensionId: "puddingclaw",
			connectorId: "puddingclaw",
			transport: "spawn",
			config: { command: "puddingclaw" },
		},
		enabled: true,
	},
	{
		// 双传输打样：默认展示一个直连 Headless NDJSON 的 HTTP Worker，便于
		// 前端验证它与 CLI spawn 的房间进度一致。默认禁用，避免 manager 在
		// 用户尚未确认 Backend 地址前把真实委托路由到测试实例。
		name: "puddingclaw-http",
		displayName: "PuddingClaw HTTP",
		description: "",
		connector: {
			extensionId: "puddingclaw",
			connectorId: "puddingclaw",
			transport: "http",
			config: { endpoint: "http://127.0.0.1:8888" },
		},
		enabled: false,
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
 * Registry + window store for phase 2. Owns `agents.json` (the worker registry)
 * and `windows.json` (chat windows: solo / direct / group) under `dirs.state`;
 * avatar 图片在 `dirs.assets/avatars/`，平台管理项目根在
 * `dirs.managedWorkspaces/`（内含 WorkspaceStore）。Worker subprocess
 * 的生命周期由 AgentRuntime/Driver 层负责，本类只承担注册表与窗口存储。
 *
 * Every mutation runs under an in-process mutex and re-reads the file fresh,
 * so concurrent writes cannot lose updates (all-or-nothing per mutation).
 */
export interface TeamsStoreDirs {
	/** agents.json / windows.json / workspaces.json 所在目录。 */
	state: string;
	/** 头像等用户资源根（avatars/ 子目录）。 */
	assets: string;
	/** 平台管理项目（managed workspace）根目录。 */
	managedWorkspaces: string;
	/** 随 App 发布的只读资源目录；首装时复制需要独立头像的内置 Worker 资源。 */
	bundledAssets?: string;
}

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
		private readonly dirs: TeamsStoreDirs,
		private readonly cwd: string,
		private readonly defaultTimeoutMs = 900_000,
		private readonly credentials?: CredentialsStore,
	) {
		this.agentsFile = path.join(dirs.state, "agents.json");
		this.windowsFile = path.join(dirs.state, "windows.json");
		this.workspaces = new WorkspaceStore(dirs.state, dirs.managedWorkspaces);
	}

	/** Ensure the state dir exists; seed agents.json with defaults on first run. */
	async init(): Promise<void> {
		await mkdir(this.dirs.state, { recursive: true });
		this.defaultCwdSnapshot = await realpath(path.resolve(this.cwd));
		await this.workspaces.init();
		if (!existsSync(this.agentsFile)) {
			const defaults = structuredClone(DEFAULT_TEAMS);
			const designerAvatar = this.dirs.bundledAssets
				? path.join(this.dirs.bundledAssets, "pi-b.webp")
				: undefined;
			if (designerAvatar && existsSync(designerAvatar)) {
				const fileName = "pi-b.webp";
				await mkdir(path.join(this.dirs.assets, "avatars"), { recursive: true });
				await copyFile(designerAvatar, path.join(this.dirs.assets, "avatars", fileName));
				const designer = defaults.find((agent) => agent.name === "pi-b");
				if (designer) designer.avatar = fileName;
			}
			await this.writeAgents(defaults);
		}
		const agents = await this.loadAgentsFile();
		const manager = agents.find((agent) => agent.name === MANAGER_AGENT_NAME);
		if (!manager || !manager.pinned || manager.invoke?.type !== "pi") {
			throw new Error("agents.json uses pre-P3 data; pinned manager is required, clear development data");
		}
		// Workspace selection is optional. When present it must be a non-empty
		// identity; absence is the intentional legacy/default-cwd chat mode.
		const loadedWindows = await this.loadWindowsFile();
		const windows = structuredClone(loadedWindows);
		const upgraded = upgradeWindowsFile(windows);
		// Validate the complete candidate before touching the source file. A bad
		// v1 registry must remain byte-for-byte recoverable without manual rollback.
		await this.validateWindowsFile(windows);
		if (upgraded && existsSync(this.windowsFile)) {
			const source = await readFile(this.windowsFile);
			await this.ensureWindowsUpgradeBackup(source);
			await this.writeWindows(windows);
		}
		this.windowsPromise = Promise.resolve(windows);
	}

	private async validateWindowsFile(windows: WindowsFile): Promise<void> {
		const sessionOwners = new Map<string, string>();
		const directIdentities = new Map<string, string>();
		for (const window of Object.values(windows.windows)) {
			if (
				(window.workspaceId !== undefined && (typeof window.workspaceId !== "string" || !window.workspaceId)) ||
				typeof window.cwdSnapshot !== "string" ||
				!window.cwdSnapshot ||
				!Array.isArray(window.sessions) ||
				window.sessions.length === 0 ||
				!window.sessions.includes(window.activeSession) ||
				!window.parkedContexts ||
				typeof window.parkedContexts !== "object" ||
				Array.isArray(window.parkedContexts)
			) {
				throw new Error(`window "${window.id ?? "unknown"}" has invalid workspace-history data`);
			}
			const contexts = [
				{ key: windowContextKey(window.workspaceId, window.cwdSnapshot), context: activeWindowContext(window), active: true },
				...Object.entries(window.parkedContexts).map(([key, context]) => ({ key, context, active: false })),
			];
			const activeKey = contexts[0]!.key;
			if (window.type !== "solo" && Object.keys(window.parkedContexts).length > 0) {
				throw new Error(`window "${window.id}" cannot park contexts; direct/group Workspace identity is immutable`);
			}
			for (const { key, context, active } of contexts) {
				if (
					(context.workspaceId !== undefined && (typeof context.workspaceId !== "string" || !context.workspaceId)) ||
					typeof context.cwdSnapshot !== "string" ||
					!context.cwdSnapshot ||
					!Array.isArray(context.sessions) ||
					context.sessions.length === 0 ||
					!context.sessions.includes(context.activeSession) ||
					key !== windowContextKey(context.workspaceId, context.cwdSnapshot) ||
					(!active && key === activeKey)
				) {
					throw new Error(`window "${window.id}" has invalid parked workspace context: ${key}`);
				}
				if (Object.keys(context.workerBindings ?? {}).some((sessionId) => !context.sessions.includes(sessionId))) {
					throw new Error(`window "${window.id}" context ${key} has worker bindings for foreign sessions`);
				}
				if (context.workspaceId) {
					const workspace = await this.workspaces.get(context.workspaceId);
					if (!workspace) throw new Error(`workspace not found: ${context.workspaceId}`);
					if (workspace.canonicalPath !== context.cwdSnapshot) {
						throw new Error(`window "${window.id}" cwdSnapshot does not match workspaceId`);
					}
				}
				for (const sessionId of context.sessions) {
					const owner = sessionOwners.get(sessionId);
					if (owner) throw new Error(`session "${sessionId}" belongs to multiple window contexts: ${owner}, ${window.id}`);
					sessionOwners.set(sessionId, window.id);
				}
			}
			if (window.type === "direct") {
				const identity = JSON.stringify([window.members[0], window.workspaceId ?? null, window.cwdSnapshot]);
				const duplicate = directIdentities.get(identity);
				if (duplicate) throw new Error(`duplicate direct window context: ${duplicate}, ${window.id}`);
				directIdentities.set(identity, window.id);
			}
		}
	}

	private async ensureWindowsUpgradeBackup(source: Buffer): Promise<string> {
		const base = `${this.windowsFile}.v1.bak`;
		let target = base;
		if (existsSync(base)) {
			const existing = await readFile(base);
			if (existing.equals(source)) return base;
			const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
			target = `${this.windowsFile}.v1.${digest}.bak`;
			if (existsSync(target)) {
				const sameVersion = await readFile(target);
				if (!sameVersion.equals(source)) throw new Error(`windows.json backup hash collision: ${target}`);
				return target;
			}
		}
		const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(source);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, target);
			return target;
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
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
		await mkdir(path.dirname(file), { recursive: true });
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
		// 选用名单：非字符串项丢弃，去重后排序，空名单不保留。
		for (const key of ["enabledSkills", "enabledPrompts"] as const) {
			const value = input[key];
			if (value !== undefined) {
				if (!Array.isArray(value)) throw new Error(`piResources.${key} 必须是字符串数组`);
				const names = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].sort();
				if (names.length) result[key] = names;
			}
		}
		for (const key of ["loadWorkspaceSkills", "loadWorkspacePrompts", "loadWorkspaceContext"] as const) {
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
		const displayName = normalizeDisplayName(agent.displayName, agent.name);
		if (displayName) agent.displayName = displayName;
		else delete agent.displayName;
		agent.responsibility = this.normalizeResponsibility(agent.responsibility);
		if (!agent.responsibility) delete agent.responsibility;
		agent.piResources = this.normalizePiResources(agent.piResources);
		if (!agent.piResources) delete agent.piResources;
		if (agent.codeSearch !== undefined && !["inherit", "builtin", "fff"].includes(agent.codeSearch)) {
			throw new Error(`agent "${agent.name}": codeSearch 必须是 inherit | builtin | fff`);
		}
		const invoke = agent.invoke;
		if (invoke?.type === "pi") {
			// §10.5：pi 类型只放开给 pinned 保留名 manager，且强制启用。
			if (agent.name !== MANAGER_AGENT_NAME) {
				throw new Error(`agent "${agent.name}": "pi" invoke 仅限保留名 "${MANAGER_AGENT_NAME}"`);
			}
			if (agent.connector) throw new Error("manager 不绑定 Connector");
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
			if (!["spawn", "http", "rpc", "acp", "sdk"].includes(c.transport)) {
				throw new Error(`agent "${agent.name}": connector.transport 非法`);
			}
			if (c.config === undefined || typeof c.config !== "object" || Array.isArray(c.config)) {
				throw new Error(`agent "${agent.name}": connector.config 必须是对象`);
			}
		}
		if (agent.piResources && !agent.pinned && agent.connector?.connectorId !== "pi") {
			throw new Error(`agent "${agent.name}": piResources 仅适用于 pi Agent`);
		}
		if (agent.codeSearch && (agent.pinned || agent.connector?.connectorId !== "pi")) {
			throw new Error(`agent "${agent.name}": codeSearch 仅适用于 pi Worker`);
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
			if (!["spawn", "http", "rpc", "acp", "sdk"].includes(connector.transport)) {
				throw new Error("connector.transport 非法");
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
		if (input.codeSearch !== undefined) {
			if (!["off", "builtin", "fff"].includes(input.codeSearch as string)) {
				throw new Error("manager.codeSearch 必须是 off | builtin | fff");
			}
			out.codeSearch = input.codeSearch as ManagerCodeSearchProvider;
		}
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
	async updateManager(patch: { description?: string; displayName?: string | null; manager?: Record<string, unknown>; responsibility?: AgentResponsibilityProfile | null; piResources?: PiResourceConfig | null }): Promise<AgentConfig> {
		const agent = await this.getManager();
		if (!agent) throw new Error(`pinned manager 不存在：${MANAGER_AGENT_NAME}`);
		const settings = patch.manager !== undefined ? this.validateManagerSettings(patch.manager) : undefined;
		const responsibility = patch.responsibility ? this.normalizeResponsibility(patch.responsibility) : undefined;
		const piResources = patch.piResources ? this.normalizePiResources(patch.piResources) : undefined;
		return this.mutateAgent(MANAGER_AGENT_NAME, (a) => {
			if (patch.description !== undefined) a.description = patch.description.trim();
			if (patch.displayName !== undefined) {
				const displayName = normalizeDisplayName(patch.displayName, MANAGER_AGENT_NAME);
				if (displayName) a.displayName = displayName;
				else delete a.displayName;
			}
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
		return path.join(this.dirs.assets, "avatars");
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
			return { version: typeof parsed.version === "number" ? parsed.version : 1, windows: parsed.windows ?? {} };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			// 决策 20：无兼容、无历史数据迁移。旧 rooms.json 直接忽略。
			return { version: WINDOWS_FILE_VERSION, windows: {} };
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
	async contextForWorkspace(
		workspaceId?: string,
	): Promise<{ workspaceId?: string; cwdSnapshot: string; trust?: WorkspaceTrust }> {
		if (!workspaceId) return { cwdSnapshot: this.defaultCwdSnapshot };
		const workspace = await this.workspaces.require(workspaceId);
		return { workspaceId, cwdSnapshot: workspace.canonicalPath, trust: workspace.trust };
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
		return this.workspaceForContext(w.workspaceId, w.cwdSnapshot, `窗口 ${windowId}`);
	}

	private async workspaceForContext(workspaceId: string | undefined, cwdSnapshot: string, label: string): Promise<string> {
		const current = await realpath(cwdSnapshot).catch(() => undefined);
		if (!current || current !== cwdSnapshot) throw new Error(`${label}运行目录已失效或身份已变化：${cwdSnapshot}`);
		if (!workspaceId) return cwdSnapshot;
		const workspace = await this.workspaces.require(workspaceId);
		if (workspace.canonicalPath !== cwdSnapshot) throw new Error(`${label} cwdSnapshot 与 Workspace 身份不一致`);
		await this.workspaces.touch(workspace.id);
		await ensureHandoffGuidance(workspace.canonicalPath);
		return workspace.canonicalPath;
	}

	/** Resolve durable ownership and frozen workspace context for any active or parked Session. */
	async contextForSession(sessionId: string): Promise<{
		window: WindowConfig;
		workspaceId?: string;
		cwdSnapshot: string;
		active: boolean;
		workerBindings: SessionWorkerBindings;
	} | undefined> {
		for (const window of await this.listWindows()) {
			const found = contextContainingSession(window, sessionId);
			if (!found) continue;
			return {
				window,
				...(found.context.workspaceId ? { workspaceId: found.context.workspaceId } : {}),
				cwdSnapshot: found.context.cwdSnapshot,
				active: found.active,
				workerBindings: found.context.workerBindings ?? {},
			};
		}
		return undefined;
	}

	async workspaceForSession(sessionId: string): Promise<string> {
		const context = await this.contextForSession(sessionId);
		if (!context) throw new Error(`session has no window owner: ${sessionId}`);
		return this.workspaceForContext(context.workspaceId, context.cwdSnapshot, `会话 ${sessionId}`);
	}

	/** The window that owns an active or parked pi session, if any. */
	async windowForSession(sessionId: string): Promise<WindowConfig | undefined> {
		return (await this.contextForSession(sessionId))?.window;
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
				// Direct 不接受自定义协作提示词（§5.2 固定 relay）；opts.prompt 仅
				// 由旧调用方传入，这里不再写入。
				workspaceId,
				cwdSnapshot: context.cwdSnapshot,
				sessions: [created.id],
				activeSession: created.id,
				parkedContexts: {},
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
				// The active Session may be a fresh, fileless conversation while an
				// older Session in the same context is already durable. Preserve the
				// whole list when any Session survives; the rooms lifecycle repair will
				// select a live active Session and prune only truly dead ids.
				if (solo.sessions.length > 0) {
					const survives = await Promise.all(solo.sessions.map((id) => sessionExists(id)));
					if (survives.some(Boolean)) return solo;
				}
				const created = await createSession(solo.workspaceId, solo.cwdSnapshot);
				solo.sessions = [created.id];
				solo.activeSession = created.id;
				solo.workerBindings = {};
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
				parkedContexts: {},
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
		// §5.2：Direct 只有平台固定 relay，拒绝自定义协作提示词。
		if (type === "direct" && prompt?.trim()) throw new Error("单聊窗口不支持自定义协作提示词（固定 relay）");
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
				parkedContexts: {},
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
			if (patch.prompt !== undefined) {
				// §5.2：Direct 固定 relay，拒绝写入自定义协作提示词；传 "" 允许，
				// 用于清掉历史遗留值。
				if (w.type === "direct" && patch.prompt?.trim()) {
					throw new Error("单聊窗口不支持自定义协作提示词（固定 relay）");
				}
				w.prompt = patch.prompt?.trim() || undefined;
			}
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

	/**
	 * 原地切换上下文：当前上下文完整停放；目标上下文存在时恢复其 Session，
	 * 首次进入目标时才使用调用方预创建的新 Session。旧 Session 永不在切换时删除。
	 */
	/** Snapshot the target parked context so callers can validate its Session files before committing a restore. */
	async parkedWindowContext(id: string, workspaceId: string | undefined): Promise<ParkedWindowContext | undefined> {
		const [window, target] = await Promise.all([this.getWindow(id), this.contextForWorkspace(workspaceId)]);
		if (!window) throw new Error(`window not found: ${id}`);
		if (window.type !== "solo") return undefined;
		const context = window.parkedContexts[windowContextKey(workspaceId, target.cwdSnapshot)];
		return context ? structuredClone(context) : undefined;
	}

	async replaceWindowWorkspace(
		id: string,
		workspaceId: string | undefined,
		sessionId: string | undefined,
		expected?: Pick<WindowConfig, "workspaceId" | "cwdSnapshot" | "members" | "prompt" | "sessions" | "activeSession" | "parkedContexts">,
	): Promise<{ window: WindowConfig; restored: boolean }> {
		const target = await this.contextForWorkspace(workspaceId);
		let restored = false;
		const window = await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[id];
			if (!w) throw new Error(`window not found: ${id}`);
			if (w.type !== "solo") throw new Error("only the solo singleton can switch Workspace in place");
			if (
				expected &&
				(w.workspaceId !== expected.workspaceId ||
					w.cwdSnapshot !== expected.cwdSnapshot ||
					w.activeSession !== expected.activeSession ||
					w.prompt !== expected.prompt ||
					JSON.stringify(w.members) !== JSON.stringify(expected.members) ||
					JSON.stringify(w.sessions) !== JSON.stringify(expected.sessions) ||
					JSON.stringify(w.parkedContexts) !== JSON.stringify(expected.parkedContexts))
			) {
				throw new Error("window changed during workspace switch; retry");
			}
			const currentKey = windowContextKey(w.workspaceId, w.cwdSnapshot);
			const targetKey = windowContextKey(workspaceId, target.cwdSnapshot);
			const parked = w.parkedContexts[targetKey];
			w.parkedContexts[currentKey] = activeWindowContext(w);
			if (parked) {
				delete w.parkedContexts[targetKey];
				assignActiveWindowContext(w, parked);
				restored = true;
			} else {
				if (!sessionId) throw new Error("new workspace context requires a manager Session");
				assignActiveWindowContext(w, {
					...(workspaceId ? { workspaceId } : {}),
					cwdSnapshot: target.cwdSnapshot,
					sessions: [sessionId],
					activeSession: sessionId,
					workerBindings: {},
				});
			}
			await this.writeWindows(data);
			return w;
		});
		this.emitChange();
		return { window, restored };
	}

	/** Delete a window (solo refused). Returns all active + parked pi session ids so the caller
	 * can cascade-delete them from the session store. */
	async removeWindow(id: string): Promise<string[]> {
		const sessionIds: string[] = [];
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[id];
			if (!w) return;
			if (w.pinned) throw new Error("solo 窗口不可删除");
			sessionIds.push(...w.sessions, ...Object.values(w.parkedContexts).flatMap((context) => context.sessions));
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
			if (w.workerBindings) delete w.workerBindings[sessionId];
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
				if (w.sessions.includes(sessionId)) {
					if (w.sessions.length <= 1) continue;
					w.sessions = w.sessions.filter((s) => s !== sessionId);
					if (w.activeSession === sessionId) w.activeSession = w.sessions[0]!;
					if (w.workerBindings) delete w.workerBindings[sessionId];
					changed = true;
					continue;
				}
				for (const [key, context] of Object.entries(w.parkedContexts)) {
					if (!context.sessions.includes(sessionId)) continue;
					if (context.sessions.length <= 1) {
						delete w.parkedContexts[key];
					} else {
						context.sessions = context.sessions.filter((id) => id !== sessionId);
						if (context.activeSession === sessionId) context.activeSession = context.sessions[0]!;
						if (context.workerBindings) delete context.workerBindings[sessionId];
					}
					changed = true;
					break;
				}
			}
			if (changed) await this.writeWindows(data);
		});
	}

	/** Record the worker handle under the conversation Session that owns it. Best-effort, non-fatal. */
	async rememberWorkerSession(
		windowId: string,
		managerSessionId: string,
		worker: string,
		sessionHandle: string | undefined,
		workspaceId: string | undefined,
		cwdSnapshot: string,
		agentRevision: number,
	): Promise<void> {
		if (!sessionHandle) return;
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const target = data.windows[windowId];
			const owner = Object.values(data.windows)
				.map((window) => ({ window, found: contextContainingSession(window, managerSessionId) }))
				.find((entry) => entry.found);
			if (!target || !owner?.found || !owner.found.active) return;
			const legalTarget = owner.window.type === "solo"
				? target.type === "direct" && target.members.includes(worker)
				: target.id === owner.window.id;
			if (!legalTarget) return;
			// A run that finishes after a workspace/config transition must never
			// repopulate the new conversation with its old opaque session handle.
			if (target.workspaceId !== workspaceId || (await this.workspaceFor(target.id)) !== cwdSnapshot) return;
			const currentAgent = (await this.loadAgentsFile()).find((agent) => agent.name === worker);
			if (!currentAgent || (currentAgent.extensionRevision ?? 0) !== agentRevision) return;
			// Rebuild only from Session ids still owned by this Window. Besides pruning
			// deleted sessions, this directly replaces the old Window-flat shape.
			const bindings = owner.found.context.workerBindings ?? {};
			const retained = Object.fromEntries(
				owner.found.context.sessions
					.filter((sessionId) => bindings[sessionId])
					.map((sessionId) => [sessionId, bindings[sessionId]!]),
			);
			const nextBindings = {
				...retained,
				[managerSessionId]: {
					...(retained[managerSessionId] ?? {}),
					[worker]: { sessionHandle, targetWindowId: target.id, workspaceId, cwdSnapshot, agentRevision, updatedAt: new Date().toISOString() },
				},
			};
			if (owner.found.active) owner.window.workerBindings = nextBindings;
			else owner.found.context.workerBindings = nextBindings;
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
