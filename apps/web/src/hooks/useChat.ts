"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { abortSession, fetchMessages, sendMessage, sessionWsUrl, type MessageAttachmentInput } from "@/lib/api";
import { applyRecoveredToolResults, markRunningToolCalls, reducePiEvent, renderHistory, replayPiEvents } from "@/lib/events";
import type { ChatMessage, ChatStatus, PiMessage } from "@/lib/types";

const HISTORY_CACHE_LIMIT = 8;
const historyCache = new Map<string, ChatMessage[]>();

interface HistorySnapshot {
	messages: ChatMessage[];
	hasRunning: boolean;
}

function rememberHistory(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
	historyCache.delete(sessionId);
	historyCache.set(sessionId, messages);
	while (historyCache.size > HISTORY_CACHE_LIMIT) {
		const oldest = historyCache.keys().next().value as string | undefined;
		if (!oldest) break;
		historyCache.delete(oldest);
	}
	return messages;
}

async function loadHistorySnapshot(sessionId: string): Promise<HistorySnapshot> {
	const { messages, runningToolCallIds, recoveredToolResults } = await fetchMessages(sessionId);
	const rendered = renderHistory(messages as PiMessage[]);
	const reconciled = markRunningToolCalls(applyRecoveredToolResults(rendered, recoveredToolResults), runningToolCallIds);
	return {
		messages: reconciled,
		hasRunning: reconciled.some((message) => message.toolCalls.some((call) => call.status === "running")),
	};
}

/** 切换 Session 前预热消息快照，避免新会话首帧先渲染空数组。 */
export async function preloadChatHistory(sessionId: string): Promise<void> {
	const snapshot = await loadHistorySnapshot(sessionId);
	rememberHistory(sessionId, snapshot.messages);
}

export function useChat(sessionId: string) {
	// Session 切换会 remount；命中预热/最近访问快照时直接首帧展示，随后仍从
	// 服务端重对齐，缓存只消除视觉空档，不替代事实源。
	const cachedHistory = historyCache.get(sessionId);
	const [messages, setMessages] = useState<ChatMessage[]>(() => cachedHistory ?? []);
	const [historyLoading, setHistoryLoading] = useState(() => !cachedHistory);
	const [status, setStatus] = useState<ChatStatus>("connecting");
	const [running, setRunning] = useState(() => cachedHistory?.some((message) => message.toolCalls.some((call) => call.status === "running")) ?? false);
	const [stopping, setStopping] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const stoppingRef = useRef(false);
	const activityVersionRef = useRef(0);
	const messageEventSeqRef = useRef(0);
	const snapshotRequestRef = useRef(0);
	const activeSnapshotRequestRef = useRef<number | null>(null);
	const wsEventsRef = useRef<Array<{ seq: number; event: { type: string; [key: string]: unknown } }>>([]);
	const beginHistorySnapshot = useCallback(() => {
		const requestId = ++snapshotRequestRef.current;
		activeSnapshotRequestRef.current = requestId;
		wsEventsRef.current = [];
		return { requestId, baselineSeq: messageEventSeqRef.current };
	}, []);

	const applyHistorySnapshot = useCallback((snapshot: HistorySnapshot, baselineSeq: number): HistorySnapshot => {
		const cutoffSeq = messageEventSeqRef.current;
		const messages = replayPiEvents(
			snapshot.messages,
			wsEventsRef.current
				.filter((entry) => entry.seq > baselineSeq && entry.seq <= cutoffSeq)
				.map((entry) => entry.event),
		);
		wsEventsRef.current = wsEventsRef.current.filter((entry) => entry.seq > cutoffSeq);
		rememberHistory(sessionId, messages);
		setMessages(messages);
		return {
			messages,
			hasRunning: messages.some((message) => message.toolCalls.some((call) => call.status === "running")),
		};
	}, [sessionId]);

	useEffect(() => {
		if (!sessionId) return;
		let disposed = false;
		// Set when the server says the session does not exist (HTTP 404 on
		// /messages or WS close code 4404): stop reconnecting — retrying
		// would just loop the same failure forever.
		let gone = false;
		let attempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let historyReadyFrame: number | null = null;

		const markHistoryReady = () => {
			if (historyReadyFrame !== null) cancelAnimationFrame(historyReadyFrame);
			historyReadyFrame = requestAnimationFrame(() => {
				if (!disposed) setHistoryLoading(false);
			});
		};

		const loadHistory = (initial = false) => {
			const activityVersion = activityVersionRef.current;
			const { requestId, baselineSeq } = beginHistorySnapshot();
			return loadHistorySnapshot(sessionId)
				.then((snapshot) => {
					if (!disposed && snapshotRequestRef.current === requestId) {
						const merged = applyHistorySnapshot(snapshot, baselineSeq);
						activeSnapshotRequestRef.current = null;
						// A WS start/settled event arriving after this request began is
						// newer than the HTTP snapshot and must win the running flag race.
						if (activityVersionRef.current === activityVersion) setRunning(merged.hasRunning);
					}
					if (initial) markHistoryReady();
				})
				.catch((err: unknown) => {
					if (snapshotRequestRef.current === requestId) activeSnapshotRequestRef.current = null;
					const message = err instanceof Error ? err.message : String(err);
					if (message.endsWith(": 404")) {
						gone = true;
						historyCache.delete(sessionId);
						if (!disposed) {
							setStatus("gone");
							setError("会话不存在或已被删除");
						}
					} else if (!disposed) {
						setError(message);
					}
					if (initial) markHistoryReady();
				});
		};

		void loadHistory(true);

		const connect = () => {
			if (disposed || gone) return;
			setStatus(attempt === 0 ? "connecting" : "reconnecting");
			const ws = new WebSocket(sessionWsUrl(sessionId));
			wsRef.current = ws;

			ws.onopen = () => {
				if (disposed) return;
				const wasReconnect = attempt > 0;
				attempt = 0;
				setStatus("connected");
				// Re-align with the server after a drop: events emitted while the
				// socket was down were never delivered. Reset the running flag —
				// if a turn is still live, the reloaded history + new events
				// restore an accurate view.
				if (wasReconnect) {
					activityVersionRef.current += 1;
					setRunning(false);
					void loadHistory();
				}
			};
			ws.onmessage = (m) => {
				let event: { type: string; [k: string]: unknown };
				try {
					event = JSON.parse(m.data as string);
				} catch {
					return;
				}
				messageEventSeqRef.current += 1;
				if (activeSnapshotRequestRef.current !== null) {
					wsEventsRef.current.push({ seq: messageEventSeqRef.current, event });
				}
				setMessages((prev) => rememberHistory(sessionId, reducePiEvent(prev, event)));
				if (event.type === "agent_start" || event.type === "turn_start") {
					activityVersionRef.current += 1;
					setRunning(true);
				}
				if (event.type === "agent_settled" || event.type === "error") {
					activityVersionRef.current += 1;
					setRunning(false);
				}
			};
			ws.onclose = (ev) => {
				if (disposed) return;
				// A dropped socket can't deliver agent_settled; unblock the UI
				// so the user isn't stuck with a permanently disabled input.
				setRunning(false);
				if (ev.code === 4404) {
					// Server says the session is gone — do not retry.
					gone = true;
					setStatus("gone");
					setError("会话不存在或已被删除");
					return;
				}
				// Exponential backoff: 1s, 2s, 4s, … capped at 15s. Retries never
				// stop; after a few failures the UI switches to the "disconnected"
				// hint while reconnecting continues in the background.
				const delay = Math.min(15000, 1000 * 2 ** attempt);
				attempt += 1;
				setStatus(attempt >= 5 ? "error" : "reconnecting");
				retryTimer = setTimeout(connect, delay);
			};
		};
		connect();

		return () => {
			disposed = true;
			if (retryTimer) clearTimeout(retryTimer);
			if (historyReadyFrame !== null) cancelAnimationFrame(historyReadyFrame);
			const ws = wsRef.current;
			wsRef.current = null;
			if (!ws) return;
			// CONNECTING 时直接 close 会让浏览器打 "closed before the connection
			// is established"（StrictMode 双调用、快速切换会话都会踩到）；摘掉
			// handlers 并等 open 后再关，静默释放。
			if (ws.readyState === WebSocket.CONNECTING) {
				ws.onopen = null;
				ws.onmessage = null;
				ws.onclose = null;
				ws.onerror = null;
				ws.addEventListener("open", () => ws.close(), { once: true });
			} else {
				ws.close();
			}
		};
	}, [applyHistorySnapshot, beginHistorySnapshot, sessionId]);

	const send = useCallback(
		async (text: string, attachments: MessageAttachmentInput[] = []) => {
			const content = text.trim();
			if ((!content && attachments.length === 0) || running) return;
			try {
				await sendMessage(sessionId, content, attachments);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[sessionId, running],
	);

	const stop = useCallback(async () => {
		if (stoppingRef.current) throw new Error("停止请求正在处理中");
		stoppingRef.current = true;
		setStopping(true);
		setError(null);
		try {
			const result = await abortSession(sessionId);
			setRunning(false);
			let historyRequestId: number | undefined;
			try {
				const { requestId, baselineSeq } = beginHistorySnapshot();
				historyRequestId = requestId;
				const snapshot = await loadHistorySnapshot(sessionId);
				if (snapshotRequestRef.current === requestId) {
					applyHistorySnapshot(snapshot, baselineSeq);
					activeSnapshotRequestRef.current = null;
				}
			} catch (err) {
				if (historyRequestId !== undefined && snapshotRequestRef.current === historyRequestId) activeSnapshotRequestRef.current = null;
				throw new Error(`任务已停止，但结果刷新失败：${err instanceof Error ? err.message : String(err)}`);
			}
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			throw err;
		} finally {
			stoppingRef.current = false;
			setStopping(false);
		}
	}, [applyHistorySnapshot, beginHistorySnapshot, sessionId]);

	return { messages, historyLoading, status, running, stopping, error, send, stop };
}
