import type {
	ChatMessage,
	PiAssistantMessage,
	PiContentBlock,
	PiMessage,
	PiTextBlock,
	PiToolCallBlock,
	PiToolResultMessage,
	ToolCallView,
} from "./types";

let idCounter = 0;
export function uid(): string {
	idCounter += 1;
	return `m${Date.now().toString(36)}-${idCounter}`;
}

function textOf(blocks: PiContentBlock[] | undefined): string {
	if (!blocks) return "";
	return blocks
		.filter((b): b is PiTextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

/** Render an assistant pi message into chat view state (non-streaming shape). */
export function renderPiMessage(m: PiAssistantMessage): {
	content: string;
	thinking?: string;
	toolCalls: ToolCallView[];
} {
	const blocks = Array.isArray(m.content) ? m.content : [];
	const content = textOf(blocks);
	const thinking = blocks
		.filter((b) => b.type === "thinking")
		.map((b) => b.thinking)
		.join("\n");
	const toolCalls: ToolCallView[] = blocks
		.filter((b): b is PiToolCallBlock => b.type === "toolCall")
		.map((b) => ({ id: b.id, name: b.name, args: b.arguments, status: "pending" }));
	return {
		content,
		thinking: thinking.length ? thinking : undefined,
		toolCalls,
	};
}

/** Build the initial message list when a session is opened (history from file). */
export function renderHistory(msgs: PiMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of msgs) {
		if (m.role === "toolResult") {
			// Fold tool results into the matching tool call of the latest assistant message.
			let idx = -1;
			for (let i = out.length - 1; i >= 0; i--) {
				if (out[i]!.role === "assistant") {
					idx = i;
					break;
				}
			}
			if (idx >= 0) {
				const assistant = out[idx]!;
				out[idx] = {
					...assistant,
					toolCalls: assistant.toolCalls.map((t) =>
						t.id === m.toolCallId
							? { ...t, status: m.isError ? "error" : "done", result: textOf(m.content), isError: m.isError }
							: t,
					),
				};
			}
			continue;
		}
		if (m.role === "user") {
			out.push({
				id: uid(),
				role: "user",
				content: typeof m.content === "string" ? m.content : textOf(m.content),
				toolCalls: [],
				timestamp: m.timestamp ?? Date.now(),
				streaming: false,
			});
			continue;
		}
		out.push({
			id: uid(),
			role: "assistant",
			...renderPiMessage(m),
			timestamp: m.timestamp ?? Date.now(),
			streaming: false,
		});
	}
	return out;
}

function findLastAssistant(messages: ChatMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "assistant") return i;
	}
	return -1;
}

function upsertToolCall(messages: ChatMessage[], patch: Partial<ToolCallView> & { id: string }): ChatMessage[] {
	const idx = findLastAssistant(messages);
	if (idx < 0) return messages;
	const msg = messages[idx]!;
	const existing = msg.toolCalls.find((t) => t.id === patch.id);
	const toolCalls = existing
		? msg.toolCalls.map((t) => (t.id === patch.id ? { ...t, ...patch } : t))
		: [
				...msg.toolCalls,
				{
					id: patch.id,
					name: patch.name ?? "",
					status: patch.status ?? "pending",
					args: patch.args,
					result: patch.result,
					isError: patch.isError,
				},
			];
	return messages.map((m, i) => (i === idx ? { ...m, toolCalls } : m));
}

function stringifyResult(result: unknown): string {
	if (result === undefined || result === null) return "";
	if (typeof result === "string") return result;
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

/**
 * Fold one pi event into the current chat message list. Pure: returns a new
 * array, so it can run inside React state updaters.
 */
export function reducePiEvent(messages: ChatMessage[], event: { type: string; [k: string]: unknown }): ChatMessage[] {
	switch (event.type) {
		case "error": {
			const message = typeof event.message === "string" ? event.message : "unknown error";
			return [
				...messages,
				{
					id: uid(),
					role: "assistant",
					content: message,
					error: true,
					toolCalls: [],
					timestamp: Date.now(),
					streaming: false,
					name: "error",
					isError: true,
				},
			];
		}
		case "message_start": {
			const m = event.message as PiMessage;
			if (!m) return messages;
			if (m.role === "user") {
				return [
					...messages,
					{
						id: uid(),
						role: "user",
						content: typeof m.content === "string" ? m.content : textOf(m.content),
						toolCalls: [],
						timestamp: m.timestamp ?? Date.now(),
						streaming: false,
					},
				];
			}
			if (m.role === "assistant") {
				return [
					...messages,
					{
						id: uid(),
						role: "assistant",
						...renderPiMessage(m),
						timestamp: m.timestamp ?? Date.now(),
						streaming: true,
					},
				];
			}
			return messages;
		}
		case "message_update": {
			const m = event.message as PiAssistantMessage;
			if (!m) return messages;
			const idx = findLastAssistant(messages);
			if (idx < 0) return messages;
			const prev = messages[idx]!;
			const statusById = new Map(prev.toolCalls.map((t) => [t.id, t.status]));
			const toolCalls = renderPiMessage(m).toolCalls.map((t) => ({
				...t,
				status: statusById.get(t.id) ?? t.status,
			}));
			return messages.map((msg, i) => (i === idx ? { ...msg, ...renderPiMessage(m), toolCalls, streaming: true } : msg));
		}
		case "message_end": {
			const m = event.message as PiMessage;
			if (!m || m.role !== "assistant") return messages;
			const idx = findLastAssistant(messages);
			if (idx < 0) {
				return [
					...messages,
					{ id: uid(), role: "assistant", ...renderPiMessage(m), timestamp: m.timestamp ?? Date.now(), streaming: false },
				];
			}
			const prev = messages[idx]!;
			const statusById = new Map(prev.toolCalls.map((t) => [t.id, t.status]));
			const toolCalls = renderPiMessage(m).toolCalls.map((t) => ({
				...t,
				status: statusById.get(t.id) ?? t.status,
			}));
			return messages.map((msg, i) =>
				i === idx ? { ...msg, ...renderPiMessage(m), toolCalls, streaming: false } : msg,
			);
		}
		case "tool_execution_start": {
			return upsertToolCall(messages, {
				id: event.toolCallId as string,
				name: event.toolName as string,
				args: event.args,
				status: "running",
			});
		}
		case "tool_execution_end": {
			return upsertToolCall(messages, {
				id: event.toolCallId as string,
				name: event.toolName as string,
				status: event.isError ? "error" : "done",
				result: stringifyResult(event.result),
				isError: Boolean(event.isError),
			});
		}
		case "turn_end": {
			let next = messages;
			const results = (event.toolResults as PiToolResultMessage[] | undefined) ?? [];
			for (const tr of results) {
				next = upsertToolCall(next, {
					id: tr.toolCallId,
					name: tr.toolName,
					status: tr.isError ? "error" : "done",
					result: textOf(tr.content),
					isError: tr.isError,
				});
			}
			return next;
		}
		default:
			return messages;
	}
}
