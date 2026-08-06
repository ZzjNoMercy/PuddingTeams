import { spawn } from "node:child_process";

/** Cap on accumulated worker stdout so a runaway process can't OOM the server. */
export const MAX_STDOUT = 2 * 1024 * 1024;
/** Cap on a single JSONL line (a real worker event is far smaller). */
export const MAX_LINE = 512 * 1024;

export interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	killed: boolean;
	spawnError?: Error;
	/** Parsed JSONL lines from stdout (in order). */
	lines: unknown[];
	/** True when no stdout chunk arrived within `startupMs`. */
	startupTimedOut: boolean;
}

export interface SpawnOptions {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	/** Working directory of the subprocess. */
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	stdinJson?: unknown;
	/** Parse stdout as newline-delimited JSON; otherwise single-JSON mode. */
	jsonl?: boolean;
	/** First-event deadline: reject when no data arrives within startupMs. */
	startupMs?: number;
	onStdout?: (chunk: string) => void;
}

/**
 * Spawn a subprocess and wait for it to exit. Preserves the proven behavior
 * from the old TeamsStore.spawnWorker: shell:false, stdout/stderr separated,
 * SIGTERM then SIGKILL after a grace period, AbortSignal cancellation, stdin
 * EPIPE swallowed, per-stream byte caps. Adds a JSONL decoder with a tailing
 * half-line buffer and a first-event startup deadline.
 */
export async function spawnWorker(opts: SpawnOptions): Promise<SpawnResult> {
	const {
		command,
		args,
		env,
		cwd,
		timeoutMs = 900_000,
		signal,
		stdinJson,
		jsonl = false,
		startupMs = 30_000,
		onStdout,
	} = opts;
	const proc = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });

	if (stdinJson !== undefined) {
		proc.stdin.write(JSON.stringify(stdinJson));
		proc.stdin.end();
	}
	proc.stdin.on("error", () => undefined);

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let killed = false;
	let exited = false;
	let spawnError: Error | undefined;
	let firstChunkAt: number | null = null;
	let startupTimedOut = false;
	let startupTimer: NodeJS.Timeout | undefined;

	const lines: unknown[] = [];
	let lineBuf = "";

	const onChunk = (chunk: string) => {
		if (stdout.length < MAX_STDOUT) stdout += chunk;
		onStdout?.(chunk);
		if (firstChunkAt === null) {
			firstChunkAt = Date.now();
			if (startupTimer) clearTimeout(startupTimer);
		}
		if (jsonl) {
			lineBuf += chunk;
			let nl: number;
			while ((nl = lineBuf.indexOf("\n")) >= 0) {
				const raw = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				if (raw.length > MAX_LINE) continue;
				const trimmed = raw.trim();
				if (!trimmed) continue;
				try {
					lines.push(JSON.parse(trimmed));
				} catch {
					// 非 JSON 行是诊断输出，忽略（stderr 才是诊断通道）。
				}
			}
		}
	};

	proc.stdout.setEncoding("utf-8");
	proc.stderr.setEncoding("utf-8");
	proc.stdout.on("data", onChunk);
	proc.stderr.on("data", (chunk: string) => {
		if (stderr.length < MAX_STDOUT) stderr += chunk;
	});

	let killTimer: NodeJS.Timeout | undefined;
	const killProc = () => {
		killed = true;
		if (exited) return;
		proc.kill("SIGTERM");
		killTimer = setTimeout(() => {
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

	// Startup deadline: a worker that never emits anything is likely wedged
	// (or the CLI failed to start). We let it live but record the stall so the
	// runtime can fail with a precise message instead of waiting forever.
	startupTimer = setTimeout(() => {
		if (firstChunkAt === null) startupTimedOut = true;
	}, startupMs);
	startupTimer.unref();

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
	if (startupTimer) clearTimeout(startupTimer);
	signal?.removeEventListener("abort", onAbort);

	// Flush the tailing half-line buffer in JSONL mode.
	if (jsonl && lineBuf.trim()) {
		try {
			lines.push(JSON.parse(lineBuf.trim()));
		} catch {
			// ignore
		}
	}

	return { exitCode, stdout, stderr, timedOut, killed, spawnError, lines, startupTimedOut };
}
