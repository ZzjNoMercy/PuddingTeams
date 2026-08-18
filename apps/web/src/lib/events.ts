import type {
	ChatMessage,
	PiAssistantMessage,
	PiContentBlock,
	PiCustomMessage,
	PiMessage,
	PiTextBlock,
	PiToolCallBlock,
	PiToolResultMessage,
	PiUsage,
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
	usage?: PiUsage;
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
		usage: m.usage,
	};
}

/** Map a pi custom_message (e.g. pudding:task_assign/result) to chat view state. */
function renderCustom(m: PiCustomMessage): ChatMessage {
	return {
		id: uid(),
		role: "custom",
		customType: m.customType,
		details: m.details,
		content: typeof m.content === "string" ? m.content : textOf(m.content),
		toolCalls: [],
		timestamp: m.timestamp ?? Date.now(),
		streaming: false,
	};
}

/** Build the initial message list when a session is opened (history from file). */
export function renderHistory(msgs: PiMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of msgs) {
		if (m.role === "custom") {
			if (m.display === false) continue;
			out.push(renderCustom(m));
			continue;
		}
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
							? { ...t, status: m.isError ? "error" : "done", result: textOf(m.content), details: m.details, isError: m.isError }
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
	// 完整历史里不可能存在合法的 pending：toolCall 落盘为 pending 后必有
	// 对应 toolResult 折叠回来（done/error）。走完全部记录仍是 pending 的
	// 调用只会来自中断——abort（stopReason "aborted"/"error"）或进程被杀
	// （消息体都没写全）。统一降级为"已中断"展示；若会话其实还在跑，随后
	// 的 WS 事件会按 toolCallId 把它修正为 done/error。
	for (const msg of out) {
		for (const call of msg.toolCalls) {
			if (call.status === "pending") call.status = "interrupted";
		}
	}
	return out;
}

/**
 * 回放降级兜底：renderHistory 会把没有 toolResult 的调用一律标成"已中断"，
 * 但 delegate 这类长阻塞调用在委派期间本来就没有 toolResult。服务端在
 * /messages 响应里给出仍在运行的 toolCallId 清单，这里把它们标回 running。
 */
export function markRunningToolCalls(messages: ChatMessage[], runningIds: string[]): ChatMessage[] {
	if (runningIds.length === 0) return messages;
	const running = new Set(runningIds);
	let changed = false;
	const next = messages.map((msg) => {
		if (!msg.toolCalls.some((t) => t.status === "interrupted" && running.has(t.id))) return msg;
		changed = true;
		return {
			...msg,
			toolCalls: msg.toolCalls.map((t) =>
				t.status === "interrupted" && running.has(t.id) ? { ...t, status: "running" as const } : t,
			),
		};
	});
	return changed ? next : messages;
}

function findLastAssistant(messages: ChatMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "assistant") return i;
	}
	return -1;
}

/** Find the (latest) message that already holds a tool call with this id. */
function findMessageWithTool(messages: ChatMessage[], toolCallId: string): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.toolCalls.some((t) => t.id === toolCallId)) return i;
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
					details: patch.details,
					isError: patch.isError,
					progress: patch.progress,
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
 * Extract the user-facing text (and optional structured details) from a tool
 * result. Custom tools return AgentToolResult = { content: [...], details }.
 */
function extractToolResult(result: unknown): { text: string; details?: unknown } {
	if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
		const text = textOf((result as { content: PiContentBlock[] }).content);
		const details = (result as { details?: unknown }).details;
		return { text, details };
	}
	return { text: stringifyResult(result) };
}

/** per-agent 委托工具名（agent_<id>__delegate，Phase 4 起取代 team_task）。 */
const DELEGATE_TOOL_RE = /^agent_(.+)__delegate$/;

/** 是否为 per-agent 委托工具调用。 */
export function isDelegateCall(call: ToolCallView): boolean {
	return DELEGATE_TOOL_RE.test(call.name);
}

/** The worker a delegate call was sent to (result details first, else tool name). */
export function delegateWorker(call: ToolCallView): string | undefined {
	if (!isDelegateCall(call)) return undefined;
	const details = call.details as { worker?: string } | undefined;
	if (details?.worker) return details.worker;
	return DELEGATE_TOOL_RE.exec(call.name)?.[1];
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
			if (m.role === "custom") {
				if (m.display === false) return messages;
				return [...messages, renderCustom(m)];
			}
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
				// Backstop: a new assistant message means any earlier one finished
				// — clear leftover streaming flags even if its message_end was lost.
				const settled = messages.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg));
				return [
					...settled,
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
		case "tool_execution_update": {
			// Live progress from tools (delegate tool onUpdate → partialResult).
			// The tool call is already running; keep it visible in case a start
			// was missed, and surface the progress text on the card.
			const { text } = extractToolResult(event.partialResult);
			return upsertToolCall(messages, {
				id: event.toolCallId as string,
				name: event.toolName as string,
				status: "running",
				progress: text || undefined,
			});
		}
		case "tool_execution_end": {
			const isError = Boolean(event.isError);
			const { text, details } = extractToolResult(event.result);
			return upsertToolCall(messages, {
				id: event.toolCallId as string,
				name: event.toolName as string,
				status: isError ? "error" : "done",
				result: text,
				details,
				isError,
			});
		}
		case "turn_end": {
			let next = messages;
			const results = (event.toolResults as PiToolResultMessage[] | undefined) ?? [];
			for (const tr of results) {
				// tool_execution_end already folded the result into the
				// originating assistant message. Only backstop that message —
				// never append a duplicate card to a later assistant message.
				const idx = findMessageWithTool(next, tr.toolCallId);
				if (idx < 0) continue;
				next = next.map((m, i) =>
					i === idx
						? {
								...m,
								toolCalls: m.toolCalls.map((t) =>
									t.id === tr.toolCallId
										? {
												...t,
												status: tr.isError ? "error" : "done",
												result: textOf(tr.content),
												details: tr.details ?? t.details,
												isError: tr.isError,
											}
										: t,
								),
							}
						: m,
				);
			}
			// Backstop: the turn is over — nothing can still be streaming, even
			// if a message_end event was lost or misaligned in the live stream.
			return next.map((m) => (m.streaming ? { ...m, streaming: false } : m));
		}
		case "agent_end": {
			// Whole agent run finished — final backstop for streaming flags.
			return messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
		}
		default:
			return messages;
	}
}
