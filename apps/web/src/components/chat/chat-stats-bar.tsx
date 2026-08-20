"use client";

import type { SessionStats } from "@/lib/session-stats";
import { formatTokens } from "@/lib/session-stats";

/**
 * 会话用量统计条（composer 上方）：轮/步、最近轮耗时与输出速率、缓存命中率、
 * 输入/输出 token 与累计成本。数据来自 assistant 消息的 usage（provider 计数，
 * pi 归一化与计价）。无数据（direct 单聊等）时不渲染。
 */
export function ChatStatsBar({ stats, visible = true }: { stats: SessionStats | null; visible?: boolean }) {
	if (!stats) return null;
	const parts: string[] = [`${stats.rounds} 轮 · ${stats.steps} 步`];
	if (stats.lastRoundMs !== undefined) {
		const sec = (stats.lastRoundMs / 1000).toFixed(1);
		parts.push(`上轮 ${sec}s${stats.lastTokPerSec ? ` · ${stats.lastTokPerSec} tok/s` : ""}`);
	}
	if (stats.cacheHitRate !== undefined) parts.push(`缓存命中 ${Math.round(stats.cacheHitRate * 100)}%`);
	parts.push(`输入 ${formatTokens(stats.inputTokens)} · 输出 ${formatTokens(stats.outputTokens)}`);
	if (stats.totalCost !== undefined) parts.push(`$${stats.totalCost < 0.01 ? stats.totalCost.toFixed(4) : stats.totalCost.toFixed(2)}`);
	return (
		<div className={`home-chat-stats${visible ? "" : " is-hidden"}`} aria-hidden={!visible}>
			{/* 悬浮层顶部是渐变透明区，文字要自带底色胶囊，否则消息流透出来干涉阅读。 */}
			<span className="home-chat-stats-pill">{parts.join(" ｜ ")}</span>
		</div>
	);
}
