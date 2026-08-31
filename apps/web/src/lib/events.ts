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
import type { RecoveredToolResult } from "./api";

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

function safeErrorDetail(raw: string): string {
	return raw
		.replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;}]+/gi, "$1[已隐藏]")
		.replace(/\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi, "[已隐藏的密钥]")
		.slice(0, 4_000);
}

/** Convert provider/SDK diagnostics into actionable user copy. */
export function friendlyModelError(raw: string): { content: string; detail: string } {
	const detail = safeErrorDetail(raw.trim() || "unknown error");
	const value = detail.toLowerCase();
	let title = "Manager 本轮回复失败";
	let explanation = "你的消息已经保存，但模型服务没有成功返回结果。";
	let action = "请再次发送上一条消息；如果仍然失败，可以刷新页面或切换模型后重试。";

	if (/role ['\"]?tool|tool_calls|preceding message/.test(value)) {
		title = "会话上下文暂时异常";
		explanation = "系统在整理之前的工具调用记录时发现顺序不一致，因此安全停止了本轮请求。你的任务尚未开始执行。";
		action = "请直接重试上一条消息；如果仍然出现此提示，再新建会话继续。";
	} else if (/context.length|maximum context|too many tokens|token limit|context window/.test(value)) {
		title = "当前对话内容过长";
		explanation = "这段对话已经超出所选模型一次能够读取的内容范围。";
		action = "请新建会话继续，或缩短任务背景、移除不必要的附件后重试。";
	} else if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|api key|authentication|credential/.test(value)) {
		title = "模型服务认证失败";
		explanation = "当前模型的访问凭证无效、已过期或没有调用权限。";
		action = "请前往模型设置检查 Provider 凭证，或切换到已配置的模型。";
	} else if (/\b429\b|rate.?limit|too many requests|quota|capacity|overloaded/.test(value)) {
		title = "模型服务当前繁忙";
		explanation = "服务触发了频率、额度或容量限制，你的消息不会丢失。";
		action = "请稍后重试，或切换到其他可用模型。";
	} else if (/timeout|timed out|econn|network|fetch failed|socket|connection|gateway/.test(value)) {
		title = "暂时无法连接模型服务";
		explanation = "请求在传输过程中超时或连接中断。";
		action = "请检查网络后重试；如果持续失败，请确认 Provider 地址与服务状态。";
	} else if (/\b400\b|invalid_request|bad request/.test(value)) {
		title = "模型请求未被接受";
		explanation = "模型服务认为本轮请求格式无效，因此没有开始生成回复。";
		action = "请重试上一条消息；如果问题持续出现，可切换模型并展开技术详情进行排查。";
	}

	return {
		content: `**${title}**\n\n${explanation}\n\n${action}`,
		detail,
	};
}

/** Render an assistant pi message into chat view state (non-streaming shape). */
export function renderPiMessage(m: PiAssistantMessage): {
	content: string;
	thinking?: string;
	toolCalls: ToolCallView[];
	usage?: PiUsage;
	error?: boolean;
	errorDetail?: string;
} {
	const blocks = Array.isArray(m.content) ? m.content : [];
	const content = textOf(blocks);
	const providerError = m.stopReason === "error" && typeof m.errorMessage === "string"
		? m.errorMessage.trim()
		: "";
	const friendlyError = providerError ? friendlyModelError(providerError) : undefined;
	const visibleContent = friendlyError
		? [content, friendlyError.content].filter(Boolean).join("\n\n")
		: content;
	const thinking = blocks
		.filter((b) => b.type === "thinking")
		.map((b) => b.thinking)
		.join("\n");
	const toolCalls: ToolCallView[] = blocks
		.filter((b): b is PiToolCallBlock => b.type === "toolCall")
		.map((b) => ({ id: b.id, name: b.name, args: b.arguments, status: "pending" }));
	return {
		content: visibleContent,
		thinking: thinking.length ? thinking : undefined,
		toolCalls,
		usage: m.usage,
		error: friendlyError ? true : undefined,
		errorDetail: friendlyError?.detail,
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

/**
 * Approval/result custom messages are the append-only status stream for an
 * earlier delegate tool result. Reconcile that original card by delegationId
 * (or interactionId) so an admitted approval stops rendering as waiting.
 */
function reconcileDelegationStatus(list: ChatMessage[], next: ChatMessage): ChatMessage[] {
	const details = next.details as { taskId?: string; delegationId?: string; interactionId?: string; status?: string } | undefined;
	if (!details) return list;
	let status: string | undefined;
	if (next.customType === "pudding:task_assign") status = details.status ?? "running";
	else if (next.customType === "pudding:interaction_required") status = "needs_input";
	else if (next.customType === "pudding:interaction_resolved") {
		status = details.status === "approved" ? "running" : details.status;
	} else if (next.customType === "pudding:task_result") status = details.status;
	if (!status || (!details.taskId && !details.delegationId && !details.interactionId)) return list;

	let changed = false;
	const reconciled = list.map((message) => {
		if (next.customType === "pudding:task_assign" && details.taskId && message.customType === "pudding:task_result") {
			const resultDetails = message.details as Record<string, unknown> | undefined;
			if (resultDetails?.taskId === details.taskId) {
				changed = true;
				return {
					...message,
					details: {
						...(next.details && typeof next.details === "object" ? next.details as Record<string, unknown> : {}),
						...resultDetails,
					},
				};
			}
		}
		if (!message.toolCalls.length) return message;
		const toolCalls = message.toolCalls.map((call) => {
			if (!isDelegateCall(call)) return call;
			const callDetails = call.details as { delegationId?: string; interactionId?: string; status?: string } | undefined;
			const matches = Boolean(
				(details.taskId && call.id === details.taskId)
				|| (details.delegationId && callDetails?.delegationId === details.delegationId)
				|| (details.interactionId && callDetails?.interactionId === details.interactionId),
			);
			if (!matches) return call;
			changed = true;
			const previousStatus = callDetails?.status;
			const nextStatus = next.customType === "pudding:task_assign" && ["completed", "failed", "cancelled"].includes(previousStatus ?? "")
				? previousStatus
				: status;
			return {
				...call,
				details: {
					...(callDetails ?? {}),
					...(next.details && typeof next.details === "object" ? next.details as Record<string, unknown> : {}),
					status: nextStatus,
				},
			};
		});
		return toolCalls.some((call, index) => call !== message.toolCalls[index]) ? { ...message, toolCalls } : message;
	});
	return changed ? reconciled : list;
}

/**
 * direct 直派的指派卡会先写一张即时卡（无 delegationId），worker 会话就绪后
 * 再补一张同 taskId 的富化卡（带「执行过程」入口字段）。同 taskId 只留最新，
 * 历史回放与实时事件走同一去重，避免一张变两张。
 */
function upsertCustomMessage(list: ChatMessage[], next: ChatMessage): ChatMessage[] {
	let effectiveNext = next;
	if (next.customType === "pudding:task_result") {
		const taskId = (next.details as { taskId?: string } | undefined)?.taskId;
		const assign = taskId
			? list.find((message) =>
				message.role === "custom"
				&& message.customType === "pudding:task_assign"
				&& (message.details as { taskId?: string } | undefined)?.taskId === taskId
			)
			: undefined;
		if (assign?.details && typeof assign.details === "object") {
			// A terminal card supersedes the running row visually, but it is still
			// the same Delegation. Preserve process metadata from the append-only
			// assign event so existing sessions and partial terminal payloads retain
			// their read-only process entry after completion.
			effectiveNext = {
				...next,
				details: {
					...(assign.details as Record<string, unknown>),
					...(next.details && typeof next.details === "object" ? next.details as Record<string, unknown> : {}),
				},
			};
		}
	}
	const reconciledList = reconcileDelegationStatus(list, effectiveNext);
	if (effectiveNext.customType === "pudding:task_assign") {
		const taskId = (effectiveNext.details as { taskId?: string } | undefined)?.taskId;
		if (taskId) {
			const idx = reconciledList.findIndex(
				(m) =>
					m.role === "custom" &&
					m.customType === effectiveNext.customType &&
					(m.details as { taskId?: string } | undefined)?.taskId === taskId,
			);
			if (idx >= 0) {
				const copy = [...reconciledList];
				copy[idx] = effectiveNext;
				return copy;
			}
		}
	}
	return [...reconciledList, effectiveNext];
}

/**
 * 渲染前分组：连续的 assistant 段（一个 run 的多个 turn，常只有 thinking+工具、
 * 无正文）合并成一条气泡，正文叙述与工具摘要按序排布（参考：叙述段落之间夹
 * 一行「使用了 N 个工具」的折叠摘要）。reducer 仍操作扁平列表，分组只是
 * 渲染层视图，不影响事件折叠语义。
 */
export type RenderItem = ChatMessage | { kind: "assistantGroup"; id: string; messages: ChatMessage[] };

export function groupForRender(messages: ChatMessage[]): RenderItem[] {
	const out: RenderItem[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") {
			out.push(m);
			continue;
		}
		const last = out[out.length - 1];
		if (last && "kind" in last && last.kind === "assistantGroup") {
			last.messages.push(m);
			continue;
		}
		out.push({ kind: "assistantGroup", id: m.id, messages: [m] });
	}
	return out;
}

/** Build the initial message list when a session is opened (history from file). */
export function renderHistory(msgs: PiMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of msgs) {
		if (m.role === "custom") {
			const next = renderCustom(m);
			if (m.display === false) {
				// Approval projections created while the manager is inside a delegate
				// tool stay hidden in the pi/model transcript to preserve tool ordering,
				// but are still first-class product UI and must survive reload.
				if (m.customType === "pudding:interaction_required") {
					const replaced = upsertCustomMessage(out, next);
					out.length = 0;
					out.push(...replaced);
					continue;
				}
				// Hidden group running projections are audit/recovery state, not a
				// second chat card. Fold them into the original delegate tool call.
				if (m.customType === "pudding:task_assign") {
					const replaced = reconcileDelegationStatus(out, next);
					out.length = 0;
					out.push(...replaced);
				}
				continue;
			}
			const replaced = upsertCustomMessage(out, next);
			out.length = 0;
			out.push(...replaced);
			continue;
		}
		if (m.role === "toolResult") {
			// Delayed/recovered results may arrive after later assistant turns. Always
			// attach by toolCallId instead of assuming the latest assistant owns it.
			const idx = findMessageWithTool(out, m.toolCallId);
			if (idx >= 0) {
				const assistant = out[idx]!;
				out[idx] = {
					...assistant,
					toolCalls: assistant.toolCalls.map((t) =>
						t.id === m.toolCallId
							? {
									...t,
									status: m.isError ? "error" : "done",
									result: textOf(m.content),
									details: t.details && typeof t.details === "object"
										? { ...(t.details as Record<string, unknown>), ...(m.details && typeof m.details === "object" ? m.details as Record<string, unknown> : {}), ...(m.isError ? { status: "failed" } : {}) }
										: m.details,
									isError: m.isError,
								}
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

/** Merge refresh-time terminal projections by toolCallId without inventing cards. */
export function applyRecoveredToolResults(messages: ChatMessage[], results: RecoveredToolResult[]): ChatMessage[] {
	return results.reduce((next, result) => reducePiEvent(next, {
		type: "tool_execution_end",
		toolCallId: result.toolCallId,
		toolName: result.toolName,
		result: {
			content: [{ type: "text", text: result.text }],
			details: result.details,
		},
		isError: result.isError,
	}), messages);
}

/** Replay WS events that arrived after an HTTP history request began. */
export function replayPiEvents(messages: ChatMessage[], events: Array<{ type: string; [key: string]: unknown }>): ChatMessage[] {
	return events.reduce((current, event) => reducePiEvent(current, event), messages);
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
	const existingIndex = findMessageWithTool(messages, patch.id);
	const idx = existingIndex >= 0 ? existingIndex : findLastAssistant(messages);
	if (idx < 0) return messages;
	const msg = messages[idx]!;
	const existing = msg.toolCalls.find((t) => t.id === patch.id);
	const toolCalls = existing
		? msg.toolCalls.map((t) => {
				if (t.id !== patch.id) return t;
				const merged = { ...t, ...patch };
				// details 做浅合并：运行中 onUpdate（sessionHandle 等）与终态 meta
				// 分多次到达，直接替换会把先到的字段抹掉。
				if (patch.details === undefined) {
					merged.details = t.details;
				} else if (t.details && typeof t.details === "object" && typeof patch.details === "object") {
					merged.details = { ...(t.details as Record<string, unknown>), ...(patch.details as Record<string, unknown>) };
				}
				if (patch.status === "error" && merged.details && typeof merged.details === "object") {
					merged.details = { ...(merged.details as Record<string, unknown>), status: "failed" };
				}
				return merged;
			})
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
			const friendly = friendlyModelError(message);
			return [
				...messages,
				{
					id: uid(),
					role: "assistant",
					content: friendly.content,
					error: true,
					errorDetail: friendly.detail,
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
				const next = renderCustom(m);
				if (m.display === false) {
					if (m.customType === "pudding:interaction_required") {
						return upsertCustomMessage(messages, next);
					}
					// Hidden manager projections are not cards, but they carry the
					// delegation/process metadata needed by the original delegate row.
					return m.customType === "pudding:task_assign"
						? reconcileDelegationStatus(messages, next)
						: messages;
				}
				return upsertCustomMessage(messages, next);
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
			const previousById = new Map(prev.toolCalls.map((t) => [t.id, t]));
			const toolCalls = renderPiMessage(m).toolCalls.map((t) => ({
				...(previousById.get(t.id) ?? {}),
				...t,
				status: previousById.get(t.id)?.status ?? t.status,
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
			const previousById = new Map(prev.toolCalls.map((t) => [t.id, t]));
			const toolCalls = renderPiMessage(m).toolCalls.map((t) => ({
				...(previousById.get(t.id) ?? {}),
				...t,
				status: previousById.get(t.id)?.status ?? t.status,
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
			// details 也要带上：delegate 的 started 更新携带 sessionHandle/
			// delegationId/processView，是「执行过程」入口的运行中数据来源。
			const { text, details } = extractToolResult(event.partialResult);
			return upsertToolCall(messages, {
				id: event.toolCallId as string,
				name: event.toolName as string,
				status: "running",
				progress: text || undefined,
				...(details ? { details } : {}),
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
												details: tr.isError && (tr.details ?? t.details) && typeof (tr.details ?? t.details) === "object"
													? { ...((tr.details ?? t.details) as Record<string, unknown>), status: "failed" }
													: tr.details ?? t.details,
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
