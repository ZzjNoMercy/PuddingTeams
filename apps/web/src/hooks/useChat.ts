"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { abortSession, fetchMessages, sendMessage, sessionWsUrl, type MessageAttachmentInput } from "@/lib/api";
import { reducePiEvent, renderHistory } from "@/lib/events";
import type { ChatMessage, ChatStatus, PiMessage } from "@/lib/types";

export function useChat(sessionId: string) {
	// ChatPane is mounted with `key={sessionId}`, so a session switch remounts
	// this hook and the initial state below is already the "fresh session" state.
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [historyLoading, setHistoryLoading] = useState(true);
	const [status, setStatus] = useState<ChatStatus>("connecting");
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const wsRef = useRef<WebSocket | null>(null);

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

		const loadHistory = (initial = false) =>
			fetchMessages(sessionId)
				.then((msgs) => {
					if (!disposed) setMessages(renderHistory(msgs as PiMessage[]));
					if (initial) markHistoryReady();
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					if (message.endsWith(": 404")) {
						gone = true;
						if (!disposed) {
							setStatus("gone");
							setError("会话不存在或已被删除");
						}
					} else if (!disposed) {
						setError(message);
					}
					if (initial) markHistoryReady();
				});

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
				setMessages((prev) => reducePiEvent(prev, event));
				if (event.type === "agent_start" || event.type === "turn_start") setRunning(true);
				if (event.type === "agent_settled" || event.type === "error") setRunning(false);
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
			wsRef.current?.close();
			wsRef.current = null;
		};
	}, [sessionId]);

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

	const stop = useCallback(() => {
		void abortSession(sessionId).catch(() => undefined);
	}, [sessionId]);

	return { messages, historyLoading, status, running, error, send, stop };
}
