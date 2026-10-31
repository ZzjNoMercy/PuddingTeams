import type { RoomAttachmentRef, RoomEvent } from "./room-event-store.js";

/**
 * RoomEvent → 参与者输入的单一转换（方案 §7、§22.2）。
 *
 * 公共历史增量 + 当前用户消息合成一条 user message：不写独立 custom_message，
 * 也不把任何 Participant 私有执行记录带进来。预算按字符上界计算，超限时由
 * 调用方在写入公共事件前返回 422（本模块只抛类型化错误）。
 */

export class RoomContextRangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoomContextRangeError";
	}
}

export class RoomContextTooLargeError extends Error {
	constructor(readonly chars: number, readonly maxChars: number) {
		super(`房间上下文超出预算：${chars} > ${maxChars}`);
		this.name = "RoomContextTooLargeError";
	}
}

export interface RoomCurrentInput {
	eventId: string;
	content: string;
	mentions: string[];
	attachments?: RoomAttachmentRef[];
	/** 当前回合目标；缺省渲染为「@你」。 */
	targetAgentName?: string;
}

export interface BuildRoomContextInput {
	roomSessionId: string;
	events: readonly RoomEvent[];
	/** binding.lastRoomEntryId：已经在之前输入中装配过的公共事件（不含）。 */
	after?: string;
	/**
	 * 已提交公共事件的 cutoff（含）；省略表示当前用户事件尚未落盘，
	 * 只渲染现有全部历史（首次消息/写入前预算检查）。
	 */
	through?: string;
	current: RoomCurrentInput;
	maxChars?: number;
	/** agent 内部 id → 展示名；缺省回退 id。 */
	agentNames?: Record<string, string>;
	/** 公共历史为空时仍输出标题行；默认 true。 */
	includeEmptyHeader?: boolean;
}

export interface BuiltRoomContext {
	text: string;
	chars: number;
	historyCount: number;
	afterEventId?: string;
	afterSeq?: number;
	throughEventId?: string;
	throughSeq: number;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function inline(value: string): string {
	return value.replace(CONTROL_CHARS, " ");
}

function codePointLength(text: string): number {
	let count = 0;
	for (const _ of text) count += 1;
	return count;
}

function actorLabel(event: Pick<RoomEvent, "actor">, agentNames: Record<string, string>): string {
	if (event.actor.kind === "user") return "用户";
	if (event.actor.kind === "system") return "系统";
	return agentNames[event.actor.agentId] ?? event.actor.agentId;
}

function mentionLabel(mentions: readonly string[], agentNames: Record<string, string>): string {
	if (mentions.length === 0) return "";
	return ` → ${mentions.map((id) => `@${agentNames[id] ?? id}`).join("、")}`;
}

function attachmentLines(attachments: readonly RoomAttachmentRef[] | undefined): string[] {
	if (!attachments?.length) return [];
	return attachments.map((item) => `附件：${inline(item.name)}（${inline(item.mediaType)}，sha256=${item.sha256}）：${inline(item.path)}`);
}

function renderEvent(event: RoomEvent, agentNames: Record<string, string>): string {
	const actor = actorLabel(event, agentNames);
	const label = event.kind === "terminal" ? "房间终态" : event.kind === "artifact" ? "房间产物" : "房间消息";
	const header = `[${label}｜${actor}${event.kind === "message" ? mentionLabel(event.mentions, agentNames) : ""}｜event=${event.id}]`;
	const lines = [header];
	if (event.content) lines.push(event.content);
	if (event.artifactRefs?.length) {
		for (const ref of event.artifactRefs) lines.push(`产物：${inline(ref.name)}${ref.kind ? `（${inline(ref.kind)}）` : ""}：${inline(ref.path)}`);
	}
	lines.push(...attachmentLines(event.attachments));
	return lines.join("\n");
}

/**
 * 只渲染 binding 水位之后、本次 cutoff 之前的公共事件；当前用户事件不会
 * 同时出现在历史和当前段落里。调用方必须传入完整、已校验的 RoomEvent 快照。
 */
export function buildRoomContext(input: BuildRoomContextInput): BuiltRoomContext {
	if (input.maxChars !== undefined && (!Number.isSafeInteger(input.maxChars) || input.maxChars < 0)) {
		throw new RoomContextRangeError(`maxChars 必须是非负整数: ${String(input.maxChars)}`);
	}
	const seenSeq = new Set<number>();
	let previousSeq = 0;
	for (const event of input.events) {
		if (!Number.isSafeInteger(event.seq) || event.seq <= previousSeq || seenSeq.has(event.seq)) throw new RoomContextRangeError("公共事件必须按严格递增的 seq 排列");
		previousSeq = event.seq;
		seenSeq.add(event.seq);
	}
	if (!input.current.eventId) throw new RoomContextRangeError("当前用户事件缺少 eventId");
	if (!Array.isArray(input.current.mentions) || input.current.mentions.some((item) => typeof item !== "string" || !item) || new Set(input.current.mentions).size !== input.current.mentions.length) {
		throw new RoomContextRangeError("当前用户事件的 mentions 无效");
	}
	const byId = new Map(input.events.map((event) => [event.id, event]));
	const persistedCurrent = byId.get(input.current.eventId);
	if (persistedCurrent) {
		if (persistedCurrent.kind !== "message" || persistedCurrent.actor.kind !== "user"
			|| persistedCurrent.content !== input.current.content
			|| JSON.stringify(persistedCurrent.mentions) !== JSON.stringify(input.current.mentions)
			|| JSON.stringify(persistedCurrent.attachments ?? null) !== JSON.stringify(input.current.attachments ?? null)) {
			throw new RoomContextRangeError("当前用户事件与已落盘投影不一致");
		}
	}
	const through = input.through === undefined ? undefined : byId.get(input.through);
	if (input.through !== undefined && !through) throw new RoomContextRangeError(`cutoff 事件不存在：${input.through}`);
	const after = input.after === undefined ? undefined : byId.get(input.after);
	if (input.after !== undefined && !after) throw new RoomContextRangeError(`水位事件不存在：${input.after}`);
	const last = input.events.at(-1);
	if (last && last.roomSessionId !== input.roomSessionId) throw new RoomContextRangeError("事件属于其他 RoomSession");
	if (through && through.roomSessionId !== input.roomSessionId) throw new RoomContextRangeError("cutoff 属于其他 RoomSession");
	if (through && last && through.id !== last.id) throw new RoomContextRangeError("cutoff 必须位于当前已提交尾部");
	const afterSeq = after?.seq ?? 0;
	const throughSeq = through?.seq ?? last?.seq ?? 0;
	if (afterSeq > throughSeq) throw new RoomContextRangeError("水位晚于本次 cutoff");
	if (!Number.isInteger(afterSeq) || !Number.isInteger(throughSeq)) throw new RoomContextRangeError("事件 seq 无效");

	const agentNames = input.agentNames ?? {};
	const history = input.events.filter((event) =>
		event.seq > afterSeq && event.seq <= throughSeq && event.id !== input.current.eventId);
	const cutoffLabel = through ? `${through.id}/${through.seq}` : "initial/0";
	const sections: string[] = [];
	if (history.length > 0 || input.includeEmptyHeader !== false) {
		sections.push(`[房间公共历史｜roomSessionId=${input.roomSessionId}｜through=${cutoffLabel}]\n仅包含面向房间的最终发言、必要终态和公开产物；不是任何成员的私有执行记录。`);
	}
	for (const event of history) sections.push(renderEvent(event, agentNames));
	const target = input.current.targetAgentName
		? `@${input.current.targetAgentName}`
		: input.current.mentions.length === 1 ? `@${agentNames[input.current.mentions[0]!] ?? input.current.mentions[0]}` : "@你";
	const currentLines = [`[当前用户消息｜用户 → ${target}｜event=${input.current.eventId}]`];
	if (input.current.content) currentLines.push(input.current.content);
	currentLines.push(...attachmentLines(input.current.attachments));
	sections.push(currentLines.join("\n"));

	const text = sections.join("\n\n");
	const chars = codePointLength(text);
	if (input.maxChars !== undefined && chars > input.maxChars) throw new RoomContextTooLargeError(chars, input.maxChars);
	return {
		text,
		chars,
		historyCount: history.length,
		...(after ? { afterEventId: after.id, afterSeq: after.seq } : {}),
		...(through ?? last ? { throughEventId: (through ?? last)!.id } : {}),
		throughSeq,
	};
}

/**
 * 只渲染一段公共历史（session_read / 调试用），不追加当前用户消息。
 */
export function renderRoomHistory(events: readonly RoomEvent[], opts: { agentNames?: Record<string, string> } = {}): string {
	return events.map((event) => renderEvent(event, opts.agentNames ?? {})).join("\n\n");
}
