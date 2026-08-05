import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

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
}

export interface RoomConfig {
	sessionId: string;
	/** Display name; defaults to the session's first message. */
	name?: string;
	/** Member allowlist (worker names). Undefined = all enabled; [] = none. */
	agents?: string[];
	/** Per-worker last session id, for multi-turn continuity. */
	workerSessions?: Record<string, string>;
	/** pi session ids in this room (newest first). Defaults to [sessionId]. */
	sessions?: string[];
	/** Currently active pi session. Defaults to the first in `sessions`. */
	activeSession?: string;
}

interface TeamsFile {
	version: number;
	agents: AgentConfig[];
}

interface RoomsFile {
	version: number;
	rooms: Record<string, RoomConfig>;
}

export interface WorkerRunResult {
	worker: string;
	/** Worker-reported status: completed | needs_input | failed | blocked | error | … */
	status: string;
	/** Human-readable result: final_response, else reply, else raw stdout. */
	content: string;
	/** Full parsed worker JSON payload (metadata + content). */
	raw: Record<string, unknown>;
	exitCode: number;
	elapsedMs: number;
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

/** Cap on accumulated worker stdout so a runaway process can't OOM the server. */
const MAX_STDOUT = 2 * 1024 * 1024;

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	killed: boolean;
	spawnError?: Error;
}

/**
 * Registry + room store for phase 2. Owns `teams.json` (the worker registry)
 * and `rooms.json` (per-session room configs), and spawns worker subprocesses
 * on behalf of the team_task tool.
 *
 * Every mutation runs under an in-process mutex and re-reads the file fresh,
 * so concurrent writes cannot lose updates (all-or-nothing per mutation).
 */
export class TeamsStore {
	private agentsPromise: Promise<AgentConfig[]> | null = null;
	private roomsPromise: Promise<RoomsFile> | null = null;
	private readonly agentsFile: string;
	private readonly roomsFile: string;
	/** Serializes all registry/room mutations in this process. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly teamsDir: string,
		private readonly cwd: string,
		private readonly defaultTimeoutMs = 900_000,
	) {
		this.agentsFile = path.join(teamsDir, "teams.json");
		this.roomsFile = path.join(teamsDir, "rooms.json");
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

	// ---- rooms ----

	private async loadRoomsFile(): Promise<RoomsFile> {
		try {
			const raw = await readFile(this.roomsFile, "utf-8");
			const parsed = JSON.parse(raw) as Partial<RoomsFile>;
			return { version: 1, rooms: parsed.rooms ?? {} };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { version: 1, rooms: {} };
		}
	}

	private async roomsFileData(): Promise<RoomsFile> {
		this.roomsPromise ??= this.loadRoomsFile().catch((err: unknown) => {
			this.roomsPromise = null;
			throw err;
		});
		return this.roomsPromise;
	}

	private async writeRooms(data: RoomsFile): Promise<void> {
		await this.writeJsonFile(this.roomsFile, data);
		this.roomsPromise = Promise.resolve(data);
	}

	async getRoom(sessionId: string): Promise<RoomConfig> {
		const data = await this.roomsFileData();
		return data.rooms[sessionId] ?? { sessionId };
	}

	/** True when a room config exists for this session id. */
	async hasRoomConfig(sessionId: string): Promise<boolean> {
		return sessionId in (await this.roomsFileData()).rooms;
	}

	/** All room configs currently registered. */
	async listRooms(): Promise<RoomConfig[]> {
		return Object.values((await this.roomsFileData()).rooms);
	}

	async patchRoom(sessionId: string, patch: { name?: string; agents?: string[] }): Promise<RoomConfig> {
		return this.serialize(async () => {
			const data = await this.loadRoomsFile();
			const current = data.rooms[sessionId] ?? { sessionId };
			const room: RoomConfig = { ...current, sessionId };
			if (patch.name !== undefined) room.name = patch.name?.trim() || undefined;
			// An explicit empty array means "no members", distinct from
			// undefined ("default: all enabled").
			if (patch.agents !== undefined) room.agents = [...new Set(patch.agents)];
			data.rooms[sessionId] = room;
			await this.writeRooms(data);
			return room;
		});
	}

	async removeRoom(sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.loadRoomsFile();
			if (!(sessionId in data.rooms)) return;
			delete data.rooms[sessionId];
			await this.writeRooms(data);
		});
	}

	/** When a pi session is deleted: drop its own room config and purge the
	 * session from any other room's session list (keeping rooms consistent). */
	async removeSessionFromRooms(sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.loadRoomsFile();
			let changed = false;
			if (sessionId in data.rooms) {
				delete data.rooms[sessionId];
				changed = true;
			}
			for (const [key, room] of Object.entries(data.rooms)) {
				if (room.sessions && room.sessions.includes(sessionId)) {
					const next = room.sessions.filter((s) => s !== sessionId);
					room.sessions = next.length ? next : [key];
					if (room.activeSession === sessionId) room.activeSession = room.sessions[0];
					changed = true;
				}
			}
			if (changed) await this.writeRooms(data);
		});
	}

	/** Enabled workers the current room may delegate to. No explicit members
	 * (no room config yet, or empty list) = solo conversation. */
	async roomMembers(sessionId: string): Promise<AgentConfig[]> {
		const agents = await this.listAgents();
		const enabled = agents.filter((a) => a.enabled !== false);
		const room = await this.getRoom(sessionId);
		const allow = room.agents;
		if (!allow || allow.length === 0) return [];
		return enabled.filter((a) => allow.includes(a.name));
	}

	/** The pi sessions belonging to a room, plus the active one. */
	async roomSessionList(roomId: string): Promise<{ sessions: string[]; active: string }> {
		const room = await this.getRoom(roomId);
		const sessions = room.sessions && room.sessions.length ? room.sessions : [roomId];
		const active =
			room.activeSession && sessions.includes(room.activeSession) ? room.activeSession : sessions[0]!;
		return { sessions, active };
	}

	/** Create a new pi session inside a room and make it active. */
	async addRoomSession(roomId: string, sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.loadRoomsFile();
			const room = data.rooms[roomId] ?? { sessionId: roomId };
			const sessions = room.sessions && room.sessions.length ? room.sessions : [roomId];
			if (!sessions.includes(sessionId)) sessions.unshift(sessionId);
			room.sessions = sessions;
			room.activeSession = sessionId;
			data.rooms[roomId] = room;
			await this.writeRooms(data);
		});
	}

	/** Switch the active pi session of a room (must already belong to it). */
	async setActiveRoomSession(roomId: string, sessionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.loadRoomsFile();
			const room = data.rooms[roomId] ?? { sessionId: roomId };
			const sessions = room.sessions && room.sessions.length ? room.sessions : [roomId];
			if (!sessions.includes(sessionId)) throw new Error(`session not in room: ${sessionId}`);
			room.activeSession = sessionId;
			data.rooms[roomId] = room;
			await this.writeRooms(data);
		});
	}

	// ---- worker execution ----

	private async readWorkerSession(sessionId: string, worker: string): Promise<string | undefined> {
		const room = await this.getRoom(sessionId);
		return room.workerSessions?.[worker];
	}

	/** Record the worker session id for continuity. Best-effort, non-fatal. */
	private rememberWorkerSession(
		sessionId: string,
		worker: string,
		workerSessionId: string | undefined,
	): void {
		if (!workerSessionId) return;
		void this.serialize(async () => {
			const data = await this.loadRoomsFile();
			const room = data.rooms[sessionId] ?? { sessionId };
			room.workerSessions = { ...(room.workerSessions ?? {}), [worker]: workerSessionId };
			data.rooms[sessionId] = room;
			await this.writeRooms(data);
		}).catch(() => undefined);
	}

	/**
	 * Spawn a worker subprocess and wait for it to exit. Guarantees cleanup on
	 * timeout/abort: SIGTERM, then SIGKILL after a grace period unless the
	 * process has actually exited.
	 */
	private async spawnWorker(opts: {
		command: string;
		args: string[];
		env: NodeJS.ProcessEnv;
		timeoutMs?: number;
		signal?: AbortSignal;
		stdinJson?: unknown;
		onStdout?: (chunk: string) => void;
	}): Promise<SpawnResult> {
		const { command, args, env, timeoutMs = this.defaultTimeoutMs, signal, stdinJson, onStdout } = opts;
		const proc = spawn(command, args, { cwd: this.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });

		if (stdinJson !== undefined) {
			proc.stdin.write(JSON.stringify(stdinJson));
			proc.stdin.end();
		}
		// A fast-exiting child can close stdin early; swallow EPIPE instead of
		// an unhandled 'error' on the stream.
		proc.stdin.on("error", () => undefined);

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killed = false;
		let exited = false;
		let spawnError: Error | undefined;

		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		proc.stdout.on("data", (chunk: string) => {
			if (stdout.length < MAX_STDOUT) stdout += chunk;
			onStdout?.(chunk);
		});
		proc.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		let killTimer: NodeJS.Timeout | undefined;
		const killProc = () => {
			killed = true;
			if (exited) return;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				// `proc.killed` only says SIGTERM was sent, not that the
				// process exited — a worker that ignores SIGTERM must still be
				// SIGKILLed, otherwise the promise below never resolves.
				if (!exited) proc.kill("SIGKILL");
			}, 5000);
			killTimer.unref();
		};
		const onAbort = () => killProc();
		if (signal?.aborted) killProc();
		else signal?.addEventListener("abort", onAbort, { once: true });

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			killProc();
		}, timeoutMs);
		timeoutTimer.unref();

		const exitCode = await new Promise<number>((resolve) => {
			proc.on("error", (err: Error) => {
				spawnError = err;
				resolve(-1);
			});
			proc.on("close", (code) => {
				exited = true;
				if (killTimer) clearTimeout(killTimer);
				resolve(code ?? 0);
			});
		});

		clearTimeout(timeoutTimer);
		signal?.removeEventListener("abort", onAbort);

		return { exitCode, stdout, stderr, timedOut, killed, spawnError };
	}

	/**
	 * Run one worker delegation: feed the task JSON on stdin, wait for its
	 * single stdout JSON and map it to a WorkerRunResult. A parseable payload
	 * with a `status` field is honored regardless of exit code (e.g. exit 1 =
	 * needs_input/blocked/failed); only CLI-level failures are errors.
	 */
	async runAgent(opts: {
		agent: AgentConfig;
		task: string;
		model?: string;
		sessionId: string;
		signal?: AbortSignal;
		onUpdate?: (content: string, details: unknown) => void;
	}): Promise<WorkerRunResult> {
		const { agent, task, model, sessionId, signal } = opts;
		const invoke = agent.invoke;
		if (invoke.type !== "command") {
			throw new Error(`worker "${agent.name}": invoke type "${invoke.type}" not supported`);
		}
		const prevSession = await this.readWorkerSession(sessionId, agent.name);
		const started = Date.now();
		const input: Record<string, unknown> = { message: task };
		if (model) input.model = model;
		if (prevSession) input.session_id = prevSession;

		const env = { ...process.env, ...(agent.env ?? {}) };
		let lastUpdate = 0;
		const { exitCode, stdout, stderr, timedOut, killed, spawnError } = await this.spawnWorker({
			command: invoke.command,
			args: invoke.runArgs,
			env,
			signal,
			stdinJson: input,
			onStdout: () => {
				// Throttle live progress: worker CLIs often emit nothing until
				// the end, so a heartbeat every ~1s is plenty.
				const now = Date.now();
				if (now - lastUpdate > 1000) {
					lastUpdate = now;
					opts.onUpdate?.(`${agent.name} 正在执行…`, { running: true });
				}
			},
		});
		const elapsedMs = Date.now() - started;

		if (timedOut) {
			throw new Error(
				`worker "${agent.name}" timed out after ${Math.round(this.defaultTimeoutMs / 1000)}s`,
			);
		}
		if (killed) {
			throw new Error(`worker "${agent.name}" was cancelled`);
		}
		if (exitCode === -1 && spawnError) {
			throw new Error(`worker "${agent.name}" failed to start: ${spawnError.message}`);
		}

		let raw: Record<string, unknown> | undefined;
		try {
			raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
		} catch {
			raw = undefined;
		}

		if (raw && typeof raw.status === "string") {
			const reply = typeof raw.reply === "string" ? raw.reply : "";
			const finalResponse = typeof raw.final_response === "string" ? raw.final_response : "";
			const content = finalResponse || reply || stdout.trim();
			this.rememberWorkerSession(sessionId, agent.name, raw.session_id as string | undefined);
			return { worker: agent.name, status: raw.status, content, raw, exitCode, elapsedMs };
		}

		if (exitCode !== 0) {
			const detail = stderr.trim() || (spawnError ? spawnError.message : `exit code ${exitCode}`);
			throw new Error(`worker "${agent.name}" failed: ${detail}`);
		}
		if (!raw) {
			throw new Error(
				`worker "${agent.name}" returned non-JSON output${stderr ? `: ${stderr.trim()}` : ""}`,
			);
		}

		this.rememberWorkerSession(sessionId, agent.name, raw.session_id as string | undefined);
		return { worker: agent.name, status: "completed", content: stdout.trim(), raw, exitCode, elapsedMs };
	}

	/** Run the worker's probe command and return a normalized status. */
	async probeAgent(name: string): Promise<WorkerProbeResult> {
		const agent = await this.getAgent(name);
		if (!agent) throw new Error(`agent not found: ${name}`);
		const invoke = agent.invoke;
		if (invoke.type !== "command") {
			return { name, command: `mcp:${name}`, ok: false, raw: {}, exitCode: -1, error: "mcp invoke not supported" };
		}
		const args = invoke.probeArgs ?? ["doctor", "--json"];
		const env = { ...process.env, ...(agent.env ?? {}) };
		const { exitCode, stdout, stderr, timedOut, spawnError } = await this.spawnWorker({
			command: invoke.command,
			args,
			env,
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
