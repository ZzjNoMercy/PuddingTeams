"use client";

import { useEffect, useState } from "react";
import { delegationProcessWsUrl, fetchDelegationProcessMessages } from "@/lib/api";
import { markRunningToolCalls, reducePiEvent, renderHistory } from "@/lib/events";
import type { ChatMessage, PiMessage } from "@/lib/types";

/**
 * pi worker 执行过程（只读）：历史走 JSONL 回放，live 会话连 WS 跟流。
 * 渲染数据流与 manager 聊天完全相同（renderHistory + reducePiEvent）。
 * `full=false` 按委托创建时间切出本次委托的片段（worker 会话跨任务续接）；
 * `full=true` 展示完整会话，便于跨任务 trace。
 */
export function useWorkerProcess(delegationId: string | null, full = false) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [live, setLive] = useState(false);
	const [agentId, setAgentId] = useState("");
	const [status, setStatus] = useState("");
	const [createdAt, setCreatedAt] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!delegationId) return;
		let disposed = false;
		let ws: WebSocket | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		// 调用方以 key={delegationId} 重挂载本 hook 所在组件，初始 state 已是
		// 全新会话态，无需在 effect 里重置（react-hooks/set-state-in-effect）。

		const connectWs = () => {
			ws = new WebSocket(delegationProcessWsUrl(delegationId));
			ws.onmessage = (m) => {
				let event: { type: string; [k: string]: unknown };
				try {
					event = JSON.parse(m.data as string);
				} catch {
					return;
				}
				if (event.type === "worker_offline") {
					setLive(false);
					return;
				}
				setMessages((prev) => reducePiEvent(prev, event));
			};
		};

		// worker 会话可能还没落 handle（started 事件未到）：短重试等它就绪。
		const load = (attempt: number) => {
			fetchDelegationProcessMessages(delegationId)
				.then(({ messages: msgs, live: isLive, agentId: agent, status: st, createdAt: created, runningToolCallIds }) => {
					if (disposed) return;
					const since = Date.parse(created);
					const scoped =
						full || Number.isNaN(since)
							? (msgs as PiMessage[])
							: (msgs as PiMessage[]).filter((m) => (m.timestamp ?? Date.now()) >= since);
					setMessages(markRunningToolCalls(renderHistory(scoped), runningToolCallIds));
					setLive(isLive);
					setAgentId(agent);
					setStatus(st);
					setCreatedAt(created);
					setLoading(false);
					if (isLive) connectWs();
				})
				.catch((err: unknown) => {
					if (disposed) return;
					if (attempt < 4) {
						retryTimer = setTimeout(() => load(attempt + 1), 1200);
						return;
					}
					setLoading(false);
					setError(err instanceof Error ? err.message : String(err));
				});
		};
		load(0);

		return () => {
			disposed = true;
			if (retryTimer) clearTimeout(retryTimer);
			ws?.close();
		};
	}, [delegationId, full]);

	return { messages, loading, live, agentId, status, createdAt, error };
}
