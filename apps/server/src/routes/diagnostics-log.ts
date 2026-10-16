import type { FastifyInstance } from "fastify";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { effectiveLogLevel, type LoggingSettings } from "../store/product-settings.js";

/**
 * 用户取证入口（只读）：把「当前日志级别 + 日志文件 + 尾部内容」打成一个
 * 自包含 JSON 交给用户，便于贴给支持方。
 *
 * 为什么是 JSON 而不是 zip：平台日志全是文本（没有 crashpad/二进制转储），
 * 单文件 JSON 可以被 grep、被 diff、被邮件带走，且不需要任何归档依赖。
 * 边界：只读日志文件与设置，不读 secrets/，不触发任何同步或重放。
 */
const TAIL_BYTES = 1024 * 1024;
const MAX_FILES = 2;

const LOG_FILES = ["server.log", "server.log.1"];

export interface LogDiagnosticsDeps {
	/** 启动器重定向出的日志文件（CLI / Electron 会设置）；源码开发态为 undefined。 */
	logFile?: string;
	home: string;
	readLogging: () => Promise<LoggingSettings>;
	/** 内存中的最近日志（开发态没有文件时的取证来源）。 */
	recentLog?: () => { text: string; truncated: boolean };
	version?: string;
	runId?: string;
}

async function readTail(file: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean } | undefined> {
	let handle;
	try {
		handle = await open(file, "r");
	} catch {
		return undefined;
	}
	try {
		const info = await handle.stat();
		const start = Math.max(0, info.size - maxBytes);
		const length = info.size - start;
		const buffer = Buffer.alloc(Number(length));
		await handle.read(buffer, 0, Number(length), start);
		return { text: buffer.toString("utf-8"), bytes: Number(info.size), truncated: start > 0 };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function describe(file: string): Promise<{ name: string; bytes: number; modifiedAt: string } | undefined> {
	try {
		const info = await stat(file);
		return { name: path.basename(file), bytes: info.size, modifiedAt: info.mtime.toISOString() };
	} catch {
		return undefined;
	}
}

/** 日志文件的候选路径：启动器显式给出的文件优先，其余按约定目录探测。 */
function candidateLogFiles(deps: LogDiagnosticsDeps): string[] {
	const explicit = deps.logFile?.trim();
	if (explicit) return [explicit, `${explicit}.1`];
	return LOG_FILES.map((name) => path.join(deps.home, "logs", name));
}

export function registerLogDiagnostics(app: FastifyInstance, deps: LogDiagnosticsDeps): void {
	app.get("/api/diagnostics/logs", async () => {
		const logging = await deps.readLogging();
		const files = (await Promise.all(candidateLogFiles(deps).map(describe))).filter((item) => item !== undefined);
		return {
			logging: { enabled: logging.enabled, level: logging.level, effectiveLevel: effectiveLogLevel(logging) },
			logFile: deps.logFile?.trim() || null,
			conventionalPath: path.join(deps.home, "logs", "server.log"),
			files,
		};
	});

	app.get("/api/diagnostics/logs/bundle", async (_req, reply) => {
		const logging = await deps.readLogging();
		const candidates = candidateLogFiles(deps).slice(0, MAX_FILES);
		const logs: Record<string, { bytes: number; truncated: boolean; text: string }> = {};
		for (const file of candidates) {
			const tail = await readTail(file, TAIL_BYTES);
			if (tail) logs[path.basename(file)] = { bytes: tail.bytes, truncated: tail.truncated, text: tail.text };
		}
		// 内存里的最近日志：源码开发态没有文件，这是唯一的本地证据；发行态把它
		// 作为「最近 N 行」附上，便于对着文件尾部快速定位。
		const recent = deps.recentLog?.();
		if (recent?.text) logs["recent.log"] = { bytes: Buffer.byteLength(recent.text), truncated: recent.truncated, text: recent.text };
		const now = new Date();
		const bundle = {
			schemaVersion: 1,
			generatedAt: now.toISOString(),
			app: {
				name: "PuddingTeams",
				...(deps.version ? { version: deps.version } : {}),
				home: deps.home,
				pid: process.pid,
				node: process.version,
				platform: `${process.platform}-${process.arch}`,
				...(deps.runId ? { runId: deps.runId } : {}),
			},
			logging: { enabled: logging.enabled, level: logging.level, effectiveLevel: effectiveLogLevel(logging), logFile: deps.logFile?.trim() || null },
			notes: [
				"本包只包含日志尾部与运行标识；不含密钥、令牌或会话内容。",
				"源码开发态没有日志文件，日志只在启动它的终端里。",
			],
			logs,
		};
		const stamp = now.toISOString().replace(/[:.]/g, "-");
		reply.header("content-type", "application/json; charset=utf-8");
		reply.header("content-disposition", `attachment; filename="puddingteams-logs-${stamp}.json"`);
		return bundle;
	});
}
