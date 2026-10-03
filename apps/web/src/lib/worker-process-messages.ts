import { replayPiEvents } from "./events";
import type { ChatMessage } from "./types";

/** Pi history excludes the current streamingMessage until message_end. */
export function reconcileWorkerProcessMessages(
	visible: ChatMessage[],
	history: ChatMessage[],
	events: Array<{ type: string; [key: string]: unknown }>,
): ChatMessage[] {
	// Only carry unfinished turns within this mounted delegation. Canonical
	// history replaces matching turns; completed/removed history is not revived.
	const missing = visible.filter((message) => message.role === "assistant" && message.streaming
		&& !history.some((entry) => entry.role === "assistant" && (
			entry.id === message.id || entry.timestamp === message.timestamp
			|| Boolean(message.puddingMessageId && entry.puddingMessageId === message.puddingMessageId)
		)));
	return replayPiEvents([...history, ...missing].sort((a, b) => a.timestamp - b.timestamp), events);
}
