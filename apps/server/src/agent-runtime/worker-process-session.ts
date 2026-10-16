import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { liveWorkerSession } from "./pi-driver.js";

/** Read-only delegated execution trace. Never resolves a handle as a chat. */
export type LiveWorkerSessionLookup = (handle: string) => AgentSession | undefined;

/** live 会话的消息（含未落盘的流式尾部）；非 live 返回 undefined。 */
export function liveWorkerMessages(handle: string, liveLookup: LiveWorkerSessionLookup = liveWorkerSession): unknown[] | undefined {
	const live = liveLookup(handle);
	if (!live) return undefined;
	if (live.isStreaming) return [...live.messages];
	return live.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message);
}

/** 从 JSONL 当前分支回放 message 条目（与 manager 会话的 /messages 同形）。 */
export async function replayWorkerSessionMessages(handle: string, dir: string): Promise<unknown[] | undefined> {
	const info = (await SessionManager.listAll(dir)).find((session) => session.id === handle);
	if (!info) return undefined;
	return SessionManager.open(info.path, dir)
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry as { message: unknown }).message);
}

/**
 * live 会话仍在执行的工具调用 id（历史重放会把无 toolResult 的调用一律降级
 * 「已中断」，前端据此标回 running）。非 live/非流式返回空。
 */
export function workerRunningToolCallIds(
	handle: string,
	liveLookup: LiveWorkerSessionLookup = liveWorkerSession,
): string[] {
	const live = liveLookup(handle);
	if (!live || !live.isStreaming) return [];
	const pending = new Set<string>();
	for (const message of live.messages) {
		const m = message as {
			role?: string;
			content?: unknown;
			toolCallId?: string;
		};
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content) {
				const b = block as { type?: string; id?: string };
				if (b?.type === "toolCall" && typeof b.id === "string") pending.add(b.id);
			}
		} else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
			pending.delete(m.toolCallId);
		}
	}
	return [...pending];
}

/** live 执行 session 的事件订阅；非 live 返回 undefined（调用方发快照后保持空闲）。 */
export function subscribeWorkerSession(
	handle: string,
	listener: (event: AgentSessionEvent) => void,
	liveLookup: LiveWorkerSessionLookup = liveWorkerSession,
): (() => void) | undefined {
	const live = liveLookup(handle);
	return live ? live.subscribe(listener) : undefined;
}

