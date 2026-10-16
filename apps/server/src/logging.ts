import { effectiveLogLevel, type LoggingSettings } from "./store/product-settings.js";

/**
 * 平台日志策略：一处决定「平台 logger 写多少」与「console 兜底写不写」。
 *
 * 平台自己的日志走 pino（`app.log.*`），但 pi SDK、Extension、Capability 里有大量
 * `console.*`（本次统计 22 处 + 上游 150 处）绕过 logger。若只改 pino 级别，用户
 * 关掉开关后仍会看到输出，「关闭日志」就是假的。这里把 console 也纳入同一策略：
 * 按级别的相对详略过滤 console 方法，silent 时全部静默，重新打开能完整恢复。
 */

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];
const METHOD_LEVEL: Record<ConsoleMethod, "error" | "warn" | "info" | "debug"> = {
	error: "error",
	warn: "warn",
	info: "info",
	log: "info",
	debug: "debug",
	trace: "debug",
};
const SEVERITY: readonly ("silent" | "error" | "warn" | "info" | "debug")[] = ["silent", "error", "warn", "info", "debug"];
/** Fastify 的默认访问日志行；它们是文件里的噪声，不进内存缓冲。 */
const ACCESS_LOG_LINE = /"msg":"(?:incoming request|request completed)"/;

/**
 * 访问日志是否输出。只有真的落进日志文件的运行态才需要它——CLI 与 Electron 启动器
 * 会设 `PUDDINGTEAMS_LOG_FILE`。源码开发态（`pnpm dev`，日志只进终端）默认关闭
 * Fastify 的逐请求日志：每个请求两行 JSON 会把终端刷屏，而环形缓冲本来就已把它们
 * 过滤掉（见 `LogRing`）。需要按 URL 排查时用 `PUDDINGTEAMS_ACCESS_LOG=1` 强制打开。
 */
export function accessLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.PUDDINGTEAMS_LOG_FILE?.trim()) || env.PUDDINGTEAMS_ACCESS_LOG === "1";
}

export interface ConsoleSink {
	log: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
	trace: (...args: unknown[]) => void;
}

/** 让 target 上比 `level` 更详细的 console 方法变成空实现；返回恢复函数。 */
function silenceBeyondLevel(settings: LoggingSettings, target: ConsoleSink): () => void {
	const level = effectiveLogLevel(settings);
	const allowed = SEVERITY.indexOf(level);
	const undo: Array<() => void> = [];
	for (const method of CONSOLE_METHODS) {
		if (SEVERITY.indexOf(METHOD_LEVEL[method]) <= allowed) continue;
		const original = target[method];
		target[method] = () => undefined;
		undo.push(() => { target[method] = original; });
	}
	return () => { for (const restore of undo) restore(); };
}

let restoreConsole: (() => void) | undefined;

/**
 * 内存环形缓冲：保留最近若干行日志。发行态有文件可读，源码开发态（日志只在
 * 终端里）它是唯一的取证来源——`puddingteams logs --export` 与设置页的
 * 诊断包都靠它。故意只留在内存：不落盘、不加密、进程退出即消失。
 */
export class LogRing {
	private readonly lines: string[] = [];
	private dropped = 0;
	constructor(private readonly maxLines = 2_000) {}

	append(line: string): void {
		// Fastify 默认访问日志每个请求两行，会以每秒多条的速度把有意义的行冲掉；
		// 环形缓冲只留平台自身的日志（启动、能力装配、活动、错误）。访问日志仍在
		// stdout/文件里，需要时按 URL 查。
		if (ACCESS_LOG_LINE.test(line)) return;
		const trimmed = line.trimEnd();
		if (!trimmed) return;
		this.lines.push(trimmed);
		if (this.lines.length > this.maxLines) {
			this.dropped += this.lines.length - this.maxLines;
			this.lines.splice(0, this.lines.length - this.maxLines);
		}
	}

	/** 丢弃过旧行的标记：取证时要能说清"这只是一段尾部"。 */
	snapshot(): { text: string; truncated: boolean } {
		return { text: this.lines.join("\n"), truncated: this.dropped > 0 };
	}
}

/** pino 输出流：写 stdout（发行态由启动器重定向进文件），同时留一份进环形缓冲。 */
export function logStream(ring: LogRing, target: NodeJS.WriteStream = process.stdout): { write: (line: string) => void } {
	return { write: (line: string) => { target.write(line); ring.append(line); } };
}

/**
 * 应用 console 兜底策略。**不可叠加包装**：每次都先恢复上一次的改写再重新应用，
 * 否则「先关闭再打开」会把空实现误当成原始实现，日志永久消失。
 */
export function configureConsoleLogPolicy(settings: LoggingSettings, target: ConsoleSink = console): void {
	restoreConsole?.();
	restoreConsole = silenceBeyondLevel(settings, target);
}

/** 应用一次日志设置：pino 级别与 console 策略同时生效。 */
export function applyLoggingSettings(logger: { level: string }, settings: LoggingSettings, target: ConsoleSink = console): void {
	logger.level = effectiveLogLevel(settings);
	configureConsoleLogPolicy(settings, target);
}
