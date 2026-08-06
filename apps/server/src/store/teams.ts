import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CredentialsStore } from "./credentials.js";
import { spawnWorker } from "../agent-runtime/transport/spawn.js";

export interface CommandInvoke {
	type: "command";
	/** Executable name/path spawned for every worker call. */
	command: string;
	/** Args appended for a run (stdin receives the task JSON). */
	runArgs: string[];
	/** Args for a health probe (default: `["doctor", "--json"]`). */
	probeArgs?: string[];
}

export interface McpInvoke {
	type: "mcp";
	[k: string]: unknown;
}

export type AgentInvoke = CommandInvoke | McpInvoke;

export interface AgentConfig {
	/** Unique id used by team_task. */
	name: string;
	description: string;
	invoke: AgentInvoke;
	/** Extra env vars merged over the process env for this worker. */
	env?: Record<string, string>;
	enabled?: boolean;
	capabilities?: string[];
	/** Avatar image file name inside `.teams/avatars/` (§11); absent = default. */
	avatar?: string;
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
	/**
	 * 房间绑定的工作区根目录（绝对路径）；缺省 <平台数据目录>/workspaces/<windowId>/。
	 * coding agent 以此为 cwd，同时作为各 agent 写权限的收敛边界（§15）。
	 */
	workspace?: string;
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
		name: "puddingclaw",
		description:
			"企业数据分析 Worker（NL2SQL、数据查询、指标归因、知识查询）。执行前需要用户指定分析模型（analytics model），未指定时会返回可选模型列表。",
		capabilities: ["data.query", "data.analysis", "data.nl2sql", "knowledge.query"],
		invoke: {
			type: "command",
			command: "puddingclaw",
			runArgs: ["run", "--input-json", "-", "--json"],
			probeArgs: ["doctor", "--json"],
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
 * and `windows.json` (chat windows: solo / direct / group), and spawns worker
 * subprocesses on behalf of the team_task tool.
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

	constructor(
		private readonly teamsDir: string,
		private readonly cwd: string,
		private readonly defaultTimeoutMs = 900_000,
		private readonly credentials?: CredentialsStore,
	) {
		this.agentsFile = path.join(teamsDir, "teams.json");
		this.windowsFile = path.join(teamsDir, "windows.json");
	}

	/** Ensure the registry dir exists; seed teams.json with defaults on first run. */
	async init(): Promise<void> {
		await mkdir(this.teamsDir, { recursive: true });
		if (!existsSync(this.agentsFile)) {
			await this.writeAgents(DEFAULT_TEAMS);
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

	async upsertAgent(input: AgentConfig): Promise<AgentConfig> {
		const agent: AgentConfig = {
			enabled: true,
			...input,
			name: input.name.trim(),
		};
		if (!agent.name) throw new Error("agent name is required");
		if (agent.invoke?.type !== "command") {
			throw new Error(`agent "${agent.name}": only "command" invoke is supported`);
		}
		if (!agent.invoke.command?.trim()) {
			throw new Error(`agent "${agent.name}": invoke.command is required`);
		}
		const runArgs = agent.invoke.runArgs ?? [];
		if (!Array.isArray(runArgs) || !runArgs.every((a) => typeof a === "string")) {
			throw new Error(`agent "${agent.name}": runArgs must be an array of strings`);
		}
		if (agent.invoke.probeArgs !== undefined && !agent.invoke.probeArgs.every((a) => typeof a === "string")) {
			throw new Error(`agent "${agent.name}": probeArgs must be an array of strings`);
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
		agent.invoke = { ...agent.invoke, runArgs };

		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const idx = agents.findIndex((a) => a.name === agent.name);
			if (idx >= 0) agents[idx] = agent;
			else agents.push(agent);
			await this.writeAgents(agents);
		});
		return agent;
	}

	async removeAgent(name: string): Promise<boolean> {
		let removed = false;
		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const next = agents.filter((a) => a.name !== name);
			removed = next.length !== agents.length;
			if (removed) await this.writeAgents(next);
		});
		// Best-effort cleanup of the avatar file so it doesn't orphan on disk.
		if (removed && SAFE_AGENT_NAME.test(name)) await this.removeAvatarFiles(name);
		return removed;
	}

	async setEnabled(name: string, enabled: boolean): Promise<AgentConfig> {
		let updated: AgentConfig | undefined;
		await this.serialize(async () => {
			const agents = await this.loadAgentsFile();
			const idx = agents.findIndex((a) => a.name === name);
			if (idx < 0) throw new Error(`agent not found: ${name}`);
			agents[idx] = { ...agents[idx]!, enabled };
			updated = agents[idx];
			await this.writeAgents(agents);
		});
		return updated!;
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

	/** The window that owns a pi session, if any. */
	async windowForSession(sessionId: string): Promise<WindowConfig | undefined> {
		return (await this.listWindows()).find((w) => w.sessions.includes(sessionId));
	}

	/** Existing direct window for a single worker (dedup on "发起单聊"). */
	async findDirectWindow(member: string): Promise<WindowConfig | undefined> {
		return (await this.listWindows()).find((w) => w.type === "direct" && w.members[0] === member);
	}

	/**
	 * Find or auto-create the direct window for a worker (solo task routing,
	 * §4.1: no user involvement). The pi session is created by the caller's
	 * callback only when a new window is actually needed, so a dedup hit never
	 * leaks an orphaned session.
	 */
	async ensureDirectWindow(
		member: string,
		createSession: () => Promise<{ id: string }>,
	): Promise<WindowConfig> {
		const existing = await this.findDirectWindow(member);
		if (existing) return existing;
		const created = await createSession();
		return this.createWindow({ type: "direct", members: [member], sessionId: created.id });
	}

	/**
	 * Guarantee the solo singleton window exists (pinned, never deletable).
	 * Creates a pi session for it on first boot via `createSession`. If the
	 * solo window exists but its session was lost, a replacement is created.
	 */
	async ensureSoloWindow(
		createSession: () => Promise<{ id: string }>,
		sessionExists: (id: string) => Promise<boolean>,
	): Promise<WindowConfig> {
		return this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const solo = Object.values(data.windows).find((w) => w.type === "solo");
			if (solo) {
				if (solo.sessions.length > 0 && (await sessionExists(solo.activeSession))) return solo;
				const created = await createSession();
				solo.sessions = [created.id];
				solo.activeSession = created.id;
				data.windows[solo.id] = solo;
				await this.writeWindows(data);
				return solo;
			}
			const created = await createSession();
			const fresh: WindowConfig = {
				id: "solo",
				type: "solo",
				members: [],
				sessions: [created.id],
				activeSession: created.id,
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
		name?: string;
		prompt?: string;
		sessionId: string;
	}): Promise<WindowConfig> {
		const { type, members, name, prompt, sessionId } = opts;
		if (type === "solo") throw new Error("solo 窗口由系统创建，不能手动发起");
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
		return this.serialize(async () => {
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
					w.members = members;
				} else {
					if (members.length < 2) throw new Error("群聊窗口至少需要 2 个 worker");
					w.members = members;
				}
			}
			await this.writeWindows(data);
			return w;
		});
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
		const enabled = agents.filter((a) => a.enabled !== false);
		const w = await this.getWindow(windowId);
		if (!w || w.type === "solo" || w.members.length === 0) return [];
		return enabled.filter((a) => w.members.includes(a.name));
	}

	/** Members for the window that owns a pi session (used by team_task). */
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
	): Promise<void> {
		if (!sessionHandle) return;
		await this.serialize(async () => {
			const data = await this.loadWindowsFile();
			const w = data.windows[windowId];
			if (!w) return;
			w.workerBindings = {
				...(w.workerBindings ?? {}),
				[worker]: { sessionHandle, updatedAt: new Date().toISOString() },
			};
			await this.writeWindows(data);
		}).catch(() => undefined);
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
		if (invoke.type !== "command") {
			return { name, command: `mcp:${name}`, ok: false, raw: {}, exitCode: -1, error: "mcp invoke not supported" };
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
