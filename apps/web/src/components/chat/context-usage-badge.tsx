"use client";

import type { ContextUsage } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ContextUsageBadge({ usage }: { usage: ContextUsage }) {
	const pending = usage.tokens === null || usage.percent === null;
	const roundedPercent = pending ? null : Math.round(usage.percent!);
	const progress = pending ? 0 : Math.min(100, Math.max(0, usage.percent!));
	const label = pending
		? `上下文窗口 ${usage.contextWindow.toLocaleString("zh-CN")} tokens · 压缩后等待下一次模型响应更新`
		: `上下文已用 ${roundedPercent}% · ${usage.tokens!.toLocaleString("zh-CN")} / ${usage.contextWindow.toLocaleString("zh-CN")} tokens`;
	return (
		<span className="home-chat-context-pill">
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="home-chat-context-ring-trigger" tabIndex={0} aria-label={label}>
						<svg className="home-chat-context-ring" viewBox="0 0 16 16" aria-hidden="true">
							<circle className="home-chat-context-ring-track" cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="2" />
							<circle
								className="home-chat-context-ring-value"
								cx="8"
								cy="8"
								r={RING_RADIUS}
								fill="none"
								strokeWidth="2"
								strokeLinecap="round"
								strokeDasharray={RING_CIRCUMFERENCE}
								strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress / 100)}
								transform="rotate(-90 8 8)"
							/>
						</svg>
					</span>
				</TooltipTrigger>
				<TooltipContent side="top" align="center">{label}</TooltipContent>
			</Tooltip>
			<span className="home-chat-context-percent" aria-hidden="true">{pending ? "待更新" : `${roundedPercent}%`}</span>
		</span>
	);
}
