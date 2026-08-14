import type { ChatMessage } from "./types";

/**
 * 会话用量统计：从带 usage 的 assistant 消息聚合（usage 是 provider 计数经
 * pi-ai 归一化，cost 是 pi 按模型价目表换算，见会话记录文档 §3.2）。
 * direct 单聊等没有 assistant 回合的窗口返回 null（不渲染统计条）。
 */
export interface SessionStats {
	/** 用户消息数（轮）。 */
	rounds: number;
	/** 带 usage 的 assistant 消息数（步）。 */
	steps: number;
	/** 输入合计（净输入 + 缓存读 + 缓存写）。 */
	inputTokens: number;
	outputTokens: number;
	/** 缓存命中率 = ΣcacheRead / Σinput 总量；无缓存字段时为 undefined。 */
	cacheHitRate?: number;
	/** 累计成本（美元）；所有轮都没有 cost 时为 undefined。 */
	totalCost?: number;
	/** 最近一轮耗时（上一条消息时间戳 → 末条 assistant 时间戳，含工具时间）。 */
	lastRoundMs?: number;
	/** 最近一轮输出速率 tok/s。 */
	lastTokPerSec?: number;
}

export function computeSessionStats(messages: ChatMessage[]): SessionStats | null {
	const assistants = messages.filter((m) => m.role === "assistant" && m.usage && !m.error);
	if (assistants.length === 0) return null;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let hasCost = false;
	for (const m of assistants) {
		const u = m.usage!;
		input += u.input + u.cacheRead + u.cacheWrite;
		output += u.output;
		cacheRead += u.cacheRead;
		cacheWrite += u.cacheWrite;
		if (u.cost) {
			cost += u.cost.total;
			hasCost = true;
		}
	}
	const last = assistants[assistants.length - 1]!;
	const idx = messages.lastIndexOf(last);
	const prev = idx > 0 ? messages[idx - 1]! : undefined;
	const lastRoundMs = prev ? Math.max(0, last.timestamp - prev.timestamp) : undefined;
	const lastTokPerSec =
		lastRoundMs && lastRoundMs > 200 ? Math.round((last.usage!.output / lastRoundMs) * 1000) : undefined;
	return {
		rounds: messages.filter((m) => m.role === "user").length,
		steps: assistants.length,
		inputTokens: input,
		outputTokens: output,
		cacheHitRate: cacheRead + cacheWrite > 0 && input > 0 ? cacheRead / input : undefined,
		totalCost: hasCost ? cost : undefined,
		lastRoundMs,
		lastTokPerSec,
	};
}

/** 8K / 1.2M 风格的 token 缩写。 */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}
