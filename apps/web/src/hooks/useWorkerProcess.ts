"use client";

import { useEffect, useRef, useState } from "react";
import { delegationProcessWsUrl, fetchDelegationProcessMessages, WorkerProcessScopeError } from "@/lib/api";
import { markRunningToolCalls, reducePiEvent, renderHistory, replayPiEvents } from "@/lib/events";
import type { ChatMessage, PiMessage } from "@/lib/types";

/**
 * pi worker 执行过程（只读）：历史走 JSONL 回放，live 会话连 WS 跟流。
 * 渲染数据流与 manager 聊天完全相同（renderHistory + reducePiEvent）。
 * `full=false` 按委托创建时间切出本次委托的片段（worker 会话跨任务续接）；
 * `full=true` 展示完整会话，便于跨任务 trace。
 */
export function useWorkerProcess(delegationId: string | null, full = false, liveUpdates = true) {
	// The caller may mark the task terminal as soon as its Receipt appears.
	// That must not tear down an already subscribed stream before worker_offline.
	const subscribeToLive = useRef(liveUpdates);
	const connectLiveRef = useRef<(() => void) | null>(null);
	const refreshRef = useRef<(() => void) | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [live, setLive] = useState(false);
	const [agentId, setAgentId] = useState("");
	const [status, setStatus] = useState("");
	const [createdAt, setCreatedAt] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [scopeError, setScopeError] = useState(false);
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		if (!liveUpdates) return;
		subscribeToLive.current = true;
		connectLiveRef.current?.();
	}, [liveUpdates]);

	useEffect(() => {
		if (!delegationId) return;
		let disposed = false;
		let ws: WebSocket | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let snapshotVersion = 0;
		const renderSnapshot = (snapshot: Awaited<ReturnType<typeof fetchDelegationProcessMessages>>) => {
			const since = Date.parse(snapshot.createdAt);
			const scoped = full || Number.isNaN(since)
				? (snapshot.messages as PiMessage[])
				: (snapshot.messages as PiMessage[]).filter((message) => (message.timestamp ?? Date.now()) >= since);
			return markRunningToolCalls(renderHistory(scoped), snapshot.runningToolCallIds);
		};
		// 调用方以 key={delegationId} 重挂载本 hook 所在组件，初始 state 已是
		// 全新会话态，无需在 effect 里重置（react-hooks/set-state-in-effect）。

		const connectWs = () => {
			const socket = new WebSocket(delegationProcessWsUrl(delegationId, full));
			ws = socket;
			let ready = false;
			let offline = false;
			let latestSnapshotLive = true;
			let buffered: Array<{ type: string; [key: string]: unknown }> = [];
			let bufferOverflow = false;
			socket.onmessage = (m) => {
				if (disposed || ws !== socket) return;
				let event: { type: string; [k: string]: unknown };
				try {
					event = JSON.parse(m.data as string);
				} catch {
					return;
				}
				if (event.type === "session_ready") {
					if (ready) return;
					ready = true;
					const version = ++snapshotVersion;
					// The live subscription is now active. Re-read the JSONL snapshot
					// and replay events that arrived before ready or during that read.
					void fetchDelegationProcessMessages(delegationId, full).then((snapshot) => {
						if (disposed || ws !== socket || version !== snapshotVersion) return;
						latestSnapshotLive = snapshot.live;
						if (!bufferOverflow) setMessages(replayPiEvents(renderSnapshot(snapshot), buffered));
						setLive(snapshot.live && !offline && socket.readyState === WebSocket.OPEN);
						setConnectionError(bufferOverflow ? "实时事件过多，无法确认执行记录完整；请重新读取执行记录" :
							snapshot.live && !offline && socket.readyState !== WebSocket.OPEN ? "实时连接已断开，执行记录可能不是最新" : null);
						setRefreshing(false);
						setAgentId(snapshot.agentId);
						setStatus(snapshot.status);
						setCreatedAt(snapshot.createdAt);
						setError(null);
						setScopeError(false);
						buffered = [];
					}).catch((error: unknown) => {
						if (disposed || ws !== socket || version !== snapshotVersion) return;
						latestSnapshotLive = false;
						setLive(false);
						setRefreshing(false);
						if (!(error instanceof WorkerProcessScopeError)) {
							setConnectionError(`重新读取执行记录失败：${error instanceof Error ? error.message : String(error)}`);
						} else {
							setConnectionError(null);
							setError(error instanceof Error ? error.message : String(error));
							setScopeError(error instanceof WorkerProcessScopeError);
						}
						socket.close();
					});
					return;
				}
				if (event.type === "worker_offline") {
					offline = true;
					setLive(false);
					setConnectionError(null);
					const tail = buffered;
					const tailOverflow = bufferOverflow;
					const version = ++snapshotVersion;
					void fetchDelegationProcessMessages(delegationId, full).then((snapshot) => {
						if (disposed || ws !== socket || version !== snapshotVersion) return;
						// The terminal HTTP read may have started before the final WS
						// events reached the JSONL file. Keep the visible stream if its
						// bounded replay tail overflowed; otherwise replay that tail.
						if (!tailOverflow) setMessages(replayPiEvents(renderSnapshot(snapshot), tail));
						setStatus(snapshot.status);
						setCreatedAt(snapshot.createdAt);
						setConnectionError(tailOverflow ? "实时事件过多，无法确认最终记录完整；请重新读取执行记录" : null);
					}).catch((error: unknown) => {
						if (disposed || ws !== socket || version !== snapshotVersion) return;
						if (error instanceof WorkerProcessScopeError) {
							setError(error.message);
							setScopeError(true);
							setConnectionError(null);
						} else {
							setConnectionError(`无法确认最终执行记录：${error instanceof Error ? error.message : String(error)}`);
						}
					});
					return;
				}
				// The server subscribes before sending session_ready, so even
				// pre-ready events must survive the following HTTP re-read.
				if (!bufferOverflow) {
					if (buffered.length < 2000) buffered.push(event);
					else { buffered = []; bufferOverflow = true; }
				}
				setMessages((prev) => reducePiEvent(prev, event));
			};
			socket.onclose = () => {
				if (disposed || ws !== socket) return;
				setLive(false);
				setRefreshing(false);
				if (!offline && latestSnapshotLive) setConnectionError("实时连接已断开，执行记录可能不是最新");
			};
		};

		// worker 会话可能还没落 handle（started 事件未到）：短重试等它就绪。
		const load = (attempt: number) => {
			fetchDelegationProcessMessages(delegationId, full)
				.then((snapshot) => {
					if (disposed) return;
					setMessages(renderSnapshot(snapshot));
					// A live HTTP snapshot is not a live connection. The ready event
					// upgrades this state after the WS subscription is active.
					setLive(false);
					setAgentId(snapshot.agentId);
					setStatus(snapshot.status);
					setCreatedAt(snapshot.createdAt);
					setLoading(false);
					setError(null);
					setScopeError(false);
					setConnectionError(null);
					if (snapshot.live) {
						const connect = () => { if (!disposed && !ws) connectWs(); };
						connectLiveRef.current = connect;
						if (subscribeToLive.current) connect();
					}
				})
				.catch((err: unknown) => {
					if (disposed) return;
					if (attempt < 4 && !(err instanceof WorkerProcessScopeError)) {
						retryTimer = setTimeout(() => load(attempt + 1), 1200);
						return;
					}
					setLoading(false);
					setError(err instanceof Error ? err.message : String(err));
					setScopeError(err instanceof WorkerProcessScopeError);
				});
		};
		// A manual recovery must keep the last visible WS content until a fresh
		// snapshot is confirmed. Remounting the hook hides it behind loading and
		// makes an uncertain stream look like an empty process.
		refreshRef.current = () => {
			if (disposed) return;
			setRefreshing(true);
			const version = ++snapshotVersion;
			void fetchDelegationProcessMessages(delegationId, full).then((snapshot) => {
				if (disposed || version !== snapshotVersion) return;
				setAgentId(snapshot.agentId);
				setStatus(snapshot.status);
				setCreatedAt(snapshot.createdAt);
				setError(null);
				setScopeError(false);
				if (snapshot.live) {
					const previous = ws;
					ws = null;
					previous?.close();
					setConnectionError("正在重新连接执行过程；已显示内容暂时保留");
					connectWs();
					} else {
					const previous = ws;
					ws = null;
					previous?.close();
					connectLiveRef.current = null;
					setMessages(renderSnapshot(snapshot));
					setLive(false);
					setConnectionError(null);
					setRefreshing(false);
				}
			}).catch((error: unknown) => {
				if (disposed || version !== snapshotVersion) return;
				if (error instanceof WorkerProcessScopeError) {
					setError(error.message);
					setScopeError(true);
					setConnectionError(null);
				} else {
					setConnectionError(`重新读取执行记录失败：${error instanceof Error ? error.message : String(error)}`);
				}
				setRefreshing(false);
			});
		};
		load(0);

		return () => {
			disposed = true;
			connectLiveRef.current = null;
			refreshRef.current = null;
			if (retryTimer) clearTimeout(retryTimer);
			ws?.close();
		};
	}, [delegationId, full]);

	return { messages, loading, live, agentId, status, createdAt, error, scopeError, connectionError, refreshing, refresh: () => refreshRef.current?.() };
}
