import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * 一条结构化运行时活动记录：只写事实（谁、多久、几次、是否失败），
 * 级别与落地由宿主决定。pi 不提供 turn 与压缩的耗时，这两项由调用方
 * 用 state 里的开始时刻配对；工具耗时可直接用 SDK 的 durationMs。
 */
export interface SessionActivity {
	sessionId: string;
	kind: "turn" | "tool" | "retry" | "compaction";
	phase?: "start" | "end";
	durationMs?: number;
	toolName?: string;
	isError?: boolean;
	toolCallCount?: number;
	stopReason?: string;
	model?: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	success?: boolean;
	reason?: string;
	willRetry?: boolean;
	error?: string;
}

export interface ActivityState {
	turnStartedAt?: number;
	compactionStartedAt?: number;
}

const ERROR_TEXT_LIMIT = 300;

function clip(value: unknown): string | undefined {
	return typeof value === "string" && value ? value.slice(0, ERROR_TEXT_LIMIT) : undefined;
}

function elapsed(now: number, startedAt: number | undefined): number | undefined {
	return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

/**
 * 把 pi 的会话事件翻译成结构化活动。只覆盖能回答「慢在哪、重试了几次、
 * 压了几次上下文」的事件；其余事件返回 `undefined`（不产生日志噪声）。
 * `state` 按引用返回：未变化时是同一个对象，调用方可据此避免无谓写入。
 */
export function sessionActivity(event: AgentSessionEvent, input: { sessionId: string; now: number; state: ActivityState }): { activity?: SessionActivity; state: ActivityState } {
	const base = { sessionId: input.sessionId };
	switch (event.type) {
		case "turn_start":
			return { state: { ...input.state, turnStartedAt: input.now } };
		case "turn_end": {
			const message = event.message as { stopReason?: unknown; provider?: unknown; model?: unknown };
			const provider = typeof message?.provider === "string" ? message.provider : undefined;
			const model = typeof message?.model === "string" ? message.model : undefined;
			return {
				activity: {
					...base,
					kind: "turn",
					phase: "end",
					...(elapsed(input.now, input.state.turnStartedAt) !== undefined ? { durationMs: elapsed(input.now, input.state.turnStartedAt) } : {}),
					toolCallCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
					...(typeof message?.stopReason === "string" ? { stopReason: message.stopReason } : {}),
					...(provider || model ? { model: [provider, model].filter(Boolean).join("/") } : {}),
				},
				state: { ...input.state, turnStartedAt: undefined },
			};
		}
		case "tool_execution_end":
			return {
				activity: {
					...base,
					kind: "tool",
					phase: "end",
					toolName: typeof event.toolName === "string" && event.toolName ? event.toolName : "unknown",
					isError: event.isError === true,
					...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
				},
				state: input.state,
			};
		case "auto_retry_start":
			return {
				activity: { ...base, kind: "retry", phase: "start", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, error: clip(event.errorMessage) },
				state: input.state,
			};
		case "auto_retry_end":
			return {
				activity: { ...base, kind: "retry", phase: "end", attempt: event.attempt, success: event.success === true, error: clip(event.finalError) },
				state: input.state,
			};
		case "summarization_retry_scheduled":
			return {
				activity: { ...base, kind: "retry", phase: "start", reason: "summarization", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, error: clip(event.errorMessage) },
				state: input.state,
			};
		case "summarization_retry_finished":
			return { activity: { ...base, kind: "retry", phase: "end", reason: "summarization", success: true }, state: input.state };
		case "compaction_start":
			return { activity: { ...base, kind: "compaction", phase: "start", reason: event.reason }, state: { ...input.state, compactionStartedAt: input.now } };
		case "compaction_end":
			return {
				activity: {
					...base,
					kind: "compaction",
					phase: "end",
					reason: event.reason,
					success: event.aborted !== true,
					...(event.willRetry === true ? { willRetry: true } : {}),
					...(elapsed(input.now, input.state.compactionStartedAt) !== undefined ? { durationMs: elapsed(input.now, input.state.compactionStartedAt) } : {}),
					error: clip(event.errorMessage),
				},
				state: { ...input.state, compactionStartedAt: undefined },
			};
		default:
			return { state: input.state };
	}
}
