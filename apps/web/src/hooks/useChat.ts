"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { abortSession, fetchMessages, sendMessage, sessionWsUrl, MessageDeliveryUnconfirmedError, MessageOperationRejectedError, SessionMessagesError, type MessageAttachmentInput } from "@/lib/api";
import { ChatSendIntentChangedError, clearChatSendOperation, reserveChatSendOperation } from "@/lib/chat-send-operation";
import { applyRecoveredToolResults, markRunningToolCalls, reducePiEvent, renderHistory, replayPiEvents } from "@/lib/events";
import type { ChatMessage, ChatStatus, PiMessage } from "@/lib/types";

const HISTORY_CACHE_LIMIT = 8;
const historyCache = new Map<string, ChatMessage[]>();

interface HistorySnapshot {
	messages: ChatMessage[];
	hasRunning: boolean;
	unansweredUserMessage: boolean;
	unfinishedAssistantTurn: boolean;
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
	const { messages, running, unansweredUserMessage, unfinishedAssistantTurn, runningToolCallIds, recoveredToolResults } = await fetchMessages(sessionId);
	const rendered = renderHistory(messages as PiMessage[]);
	const reconciled = markRunningToolCalls(applyRecoveredToolResults(rendered, recoveredToolResults), runningToolCallIds);
	return {
		messages: reconciled,
		hasRunning: running || reconciled.some((message) => message.toolCalls.some((call) => call.status === "running")),
		unansweredUserMessage,
		unfinishedAssistantTurn,
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
	const [historyLoaded, setHistoryLoaded] = useState(false);
	const [status, setStatus] = useState<ChatStatus>("connecting");
	const [running, setRunning] = useState(() => cachedHistory?.some((message) => message.toolCalls.some((call) => call.status === "running")) ?? false);
	const [unansweredUserMessage, setUnansweredUserMessage] = useState(false);
	const [unfinishedAssistantTurn, setUnfinishedAssistantTurn] = useState(false);
	const [sending, setSending] = useState(false);
	const sendingRef = useRef(false);
	const connectionReadyRef = useRef(false);
	const goneRef = useRef(false);
	const [stopping, setStopping] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [unconfirmedOperation, setUnconfirmedOperation] = useState<{ key: string; historyReviewed: boolean } | null>(null);
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
		setUnansweredUserMessage(snapshot.unansweredUserMessage);
		setUnfinishedAssistantTurn(snapshot.unfinishedAssistantTurn);
		return {
			messages,
			hasRunning: snapshot.hasRunning || messages.some((message) => message.toolCalls.some((call) => call.status === "running")),
			unansweredUserMessage: snapshot.unansweredUserMessage,
			unfinishedAssistantTurn: snapshot.unfinishedAssistantTurn,
		};
	}, [sessionId]);
	const markGone = useCallback(() => {
		goneRef.current = true;
		connectionReadyRef.current = false;
		snapshotRequestRef.current += 1;
		activeSnapshotRequestRef.current = null;
		wsEventsRef.current = [];
		historyCache.delete(sessionId);
		setStatus("gone");
		setError("会话不存在或已被删除");
		if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
	}, [sessionId]);

	useEffect(() => {
		if (!sessionId) return;
		connectionReadyRef.current = false;
		goneRef.current = false;
		let disposed = false;
		let attempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
		let historyReadyFrame: number | null = null;

		const markHistoryReady = () => {
			if (historyReadyFrame !== null) cancelAnimationFrame(historyReadyFrame);
			historyReadyFrame = requestAnimationFrame(() => {
				if (!disposed) setHistoryLoading(false);
			});
		};

		const loadHistory = (): Promise<boolean> => {
			const activityVersion = activityVersionRef.current;
			const { requestId, baselineSeq } = beginHistorySnapshot();
			return loadHistorySnapshot(sessionId)
				.then((snapshot) => {
					const applied = !disposed && snapshotRequestRef.current === requestId;
					if (applied) {
						const merged = applyHistorySnapshot(snapshot, baselineSeq);
						setHistoryLoaded(true);
						activeSnapshotRequestRef.current = null;
						// A WS start/settled event arriving after this request began is
						// newer than the HTTP snapshot and must win the running flag race.
						if (activityVersionRef.current === activityVersion) setRunning(merged.hasRunning);
						markHistoryReady();
					}
					return applied;
				})
				.catch((err: unknown) => {
					if (disposed || snapshotRequestRef.current !== requestId) return false;
					activeSnapshotRequestRef.current = null;
					const message = err instanceof Error ? err.message : String(err);
					if (err instanceof SessionMessagesError && err.status === 404) {
						markGone();
					} else {
						setError(message);
					}
					markHistoryReady();
					return false;
				});
		};

		void loadHistory();

		const connect = () => {
			if (disposed || goneRef.current) return;
			setStatus(attempt === 0 ? "connecting" : "reconnecting");
			const ws = new WebSocket(sessionWsUrl(sessionId));
			wsRef.current = ws;
			let sessionReady = false;
			ws.onopen = () => {
				if (goneRef.current) { ws.close(); return; }
				handshakeTimer = setTimeout(() => {
					if (!sessionReady && ws.readyState === WebSocket.OPEN) ws.close();
				}, 15000);
			};
			ws.onmessage = (m) => {
				if (goneRef.current) return;
				let event: { type: string; [k: string]: unknown };
				try {
					event = JSON.parse(m.data as string);
				} catch {
					return;
				}
				if (event.type === "session_ready") {
					if (sessionReady) return;
					sessionReady = true;
					if (handshakeTimer) clearTimeout(handshakeTimer);
					handshakeTimer = null;
					// The server sends ready immediately before subscribing to pi
					// events. By the time this frame is handled, that subscription is
					// active; the new snapshot can replay every later WS event.
					void loadHistory().then((loaded) => {
						if (disposed || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
						if (!loaded) {
							ws.close(); // Retry the snapshot through the normal reconnect path.
							return;
						}
						attempt = 0;
						connectionReadyRef.current = true;
						setStatus("connected");
					});
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
				if (handshakeTimer) clearTimeout(handshakeTimer);
				handshakeTimer = null;
				connectionReadyRef.current = false;
				// Preserve the last running state until a fresh server snapshot arrives.
				if (ev.code === 4404) {
					// Server says the session is gone — do not retry.
					markGone();
					return;
				}
				if (goneRef.current) return;
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
			connectionReadyRef.current = false;
			if (retryTimer) clearTimeout(retryTimer);
			if (handshakeTimer) clearTimeout(handshakeTimer);
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
	}, [applyHistorySnapshot, beginHistorySnapshot, markGone, sessionId]);

	const send = useCallback(
		async (text: string, attachments: MessageAttachmentInput[] = []) => {
			const content = text.trim();
			if (!content && attachments.length === 0) throw new Error("请输入消息或添加附件");
			if (!connectionReadyRef.current) throw new Error("连接正在恢复，请稍后重试");
			if (running || sendingRef.current) throw new Error("当前会话正在处理消息，请等待后重试");
			sendingRef.current = true;
			setSending(true);
			setError(null);
			let operationId: string | undefined;
			try {
				operationId = await reserveChatSendOperation(sessionId, content, attachments);
				await sendMessage(sessionId, content, attachments, operationId);
				clearChatSendOperation(sessionId, operationId);
				setUnconfirmedOperation(null);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setError(message);
				if (operationId && err instanceof MessageOperationRejectedError) {
					clearChatSendOperation(sessionId, operationId);
					setUnconfirmedOperation(null);
				}
				if (err instanceof ChatSendIntentChangedError) {
					setUnconfirmedOperation((current) => current?.key === err.key ? current : { key: err.key, historyReviewed: false });
				}
				if (operationId && err instanceof MessageDeliveryUnconfirmedError) {
					setUnconfirmedOperation({ key: operationId, historyReviewed: false });
				}
				throw err;
			} finally {
				sendingRef.current = false;
				setSending(false);
			}
		},
		[sessionId, running],
	);

	/** Reconcile durable history with WebSocket events before a viewer acknowledges a room revision. */
	const refreshHistory = useCallback(async (): Promise<boolean> => {
		if (goneRef.current) return false;
		const activityVersion = activityVersionRef.current;
		const { requestId, baselineSeq } = beginHistorySnapshot();
		try {
			const snapshot = await loadHistorySnapshot(sessionId);
			if (snapshotRequestRef.current !== requestId) return false;
			const merged = applyHistorySnapshot(snapshot, baselineSeq);
			activeSnapshotRequestRef.current = null;
			setHistoryLoaded(true);
			if (activityVersionRef.current === activityVersion) setRunning(merged.hasRunning);
			return true;
		} catch (err) {
			if (snapshotRequestRef.current === requestId) {
				activeSnapshotRequestRef.current = null;
				if (err instanceof SessionMessagesError && err.status === 404) markGone();
			}
			return false;
		}
	}, [applyHistorySnapshot, beginHistorySnapshot, markGone, sessionId]);

	const reviewUnconfirmedHistory = useCallback(async (): Promise<boolean> => {
		const key = unconfirmedOperation?.key;
		if (!key) return false;
		const refreshed = await refreshHistory();
		if (refreshed) setUnconfirmedOperation((current) => current?.key === key ? { ...current, historyReviewed: true } : current);
		return refreshed;
	}, [refreshHistory, unconfirmedOperation?.key]);

	const startNewMessageIntent = useCallback((): boolean => {
		if (!unconfirmedOperation?.historyReviewed || sendingRef.current) return false;
		clearChatSendOperation(sessionId, unconfirmedOperation.key);
		setUnconfirmedOperation(null);
		setError(null);
		return true;
	}, [sessionId, unconfirmedOperation]);

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

	return { messages, historyLoading, historyLoaded, status, running, unansweredUserMessage, unfinishedAssistantTurn, sending, stopping, error, unconfirmedOperation, send, stop, refreshHistory, reviewUnconfirmedHistory, startNewMessageIntent };
}
