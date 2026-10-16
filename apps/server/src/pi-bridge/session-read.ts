import { SessionManager, buildSessionProjection, type ExtensionAPI, type InlineExtension, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionMessageEntry["message"];
import { Type, type Static } from "typebox";
import type { TeamsStore } from "../store/teams.js";

/**
 * 会话深链（docs/2026-10-16-会话深链交接方案.md）：交接的是指向活会话的稳定
 * 引用，接收方用 session_read 按需回读，平台不设导入预算——读多少由调用方
 * 自己决定。
 *
 * 权限边界（方案 §3）：
 * - 同窗口会话：自由读（同一房间即同一上下文家族，含 parked 的项目上下文）；
 * - 跨窗口、同 Workspace：Manager 自由读；Worker 采用「引用即授权」——目标
 *   会话链接必须出现在它自己的对话（用户消息）或委派任务材料里；
 * - 跨 Workspace：一律拒绝（Workspace 是数据边界）；
 * - 一律只读，深链永远不提供写入口。
 */

export const CORE_TOOL_SESSION_READ = "session_read";

/** Worker 侧提示词路由材料（单聊 guidance 与执行会话 system prompt 共用）。 */
export const SESSION_READ_WORKER_HINT =
	`会话深链：对话或任务材料中出现的会话链接（/chats?room=…&session=… 或 puddingteams://rooms/…/sessions/…）可用 ${CORE_TOOL_SESSION_READ} 工具只读回读；只有被明确引用过的会话才有权限，跨 Workspace 一律不可读。`;

/** Manager 侧 roster 提示词里的一行（agent-extensions 引用）。 */
export const SESSION_READ_MANAGER_HINT =
	`会话深链：${CORE_TOOL_SESSION_READ} 可只读回读本 Workspace 内任何房间会话（接受 /chats?room=…&session=… 链接、puddingteams:// 链接或会话 id）。委派时把相关会话链接放进 contextRefs，Worker 即可用 ${CORE_TOOL_SESSION_READ} 按需回读这些背景（引用即授权）；需要冻结副本时仍走 Fork。`;

export interface SessionRef {
	sessionId: string;
	roomId?: string;
}

const SCHEME_REF = /^puddingteams:\/\/rooms\/([\w-]+)\/sessions\/([\w-]+)\/?$/;
// 查询串用白名单字符集：任何 CJK 标点/空白都天然终止匹配，不靠列举排除符。
const CHATS_REF = /^(?:https?:\/\/[A-Za-z0-9._~:+-]+)?\/chats\?([A-Za-z0-9_=&%+.~-]+)$/;
const BARE_ID = /^[\w-]{8,}$/;
const SCHEME_SCAN = /puddingteams:\/\/rooms\/[\w-]+\/sessions\/[\w-]+/g;
const CHATS_SCAN = /(?:https?:\/\/[A-Za-z0-9._~:+-]+)?\/chats\?[A-Za-z0-9_=&%+.~-]+/g;

/** 解析单个会话引用：应用深链、web 链接或裸会话 id。 */
export function parseSessionRef(input: string): SessionRef | undefined {
	const value = input.trim();
	const scheme = SCHEME_REF.exec(value);
	if (scheme) return { roomId: scheme[1], sessionId: scheme[2]! };
	const chats = CHATS_REF.exec(value);
	if (chats) {
		const params = new URLSearchParams(chats[1]!);
		const sessionId = params.get("session");
		if (sessionId) return { sessionId, roomId: params.get("room") ?? undefined };
	}
	if (BARE_ID.test(value)) return { sessionId: value };
	return undefined;
}

/**
 * 从自由文本里提取会话引用（授权扫描用）：只认显式链接形态，不扫裸 id——
 * 任意文本里的 uuid 子串不构成授权意图。
 */
export function extractSessionRefs(text: string): SessionRef[] {
	const refs = new Map<string, SessionRef>();
	for (const match of text.matchAll(SCHEME_SCAN)) {
		const ref = parseSessionRef(match[0]);
		if (ref) refs.set(ref.sessionId, ref);
	}
	for (const match of text.matchAll(CHATS_SCAN)) {
		const ref = parseSessionRef(match[0]);
		if (ref) refs.set(ref.sessionId, ref);
	}
	return [...refs.values()];
}

export interface SessionTranscriptPage {
	roomId: string;
	roomType: string;
	roomName?: string;
	/** 本次返回的渲染文本。 */
	text: string;
	/** 本次起始游标（渲染后消息序列的下标）。 */
	cursor: number;
	/** 还有更多消息时的下一游标。 */
	nextCursor?: number;
	/** 当前模式下可见消息总数。 */
	total: number;
	/** 读取时刻的已提交叶条目；对比它可判断源会话是否有新进展。 */
	leafEntryId?: string;
	/** 因单次字符上限提前截断。 */
	truncated: boolean;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
/** 单次调用的字符上限：full 模式的工具结果可能很大，分页必须同时受条数与字符约束。 */
const MAX_PAGE_CHARS = 100_000;
const TOOL_RESULT_CHARS = 2_000;

type Caller =
	| { kind: "chat"; sessionId: () => string; role: "manager" | "worker" }
	| { kind: "execution"; workspaceId: () => string | undefined; ownUserText: () => Promise<string> };

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object")
		.flatMap((part) => {
			if (part.type === "text" && typeof part.text === "string") return [part.text];
			return [];
		})
		.join("\n");
}

function renderMessage(message: AgentMessage, mode: "messages" | "full"): string | undefined {
	if (message.role === "user") {
		const text = messageText(message).trim();
		return text ? `【用户】\n${text}` : undefined;
	}
	if (message.role === "assistant") {
		const text = messageText(message).trim();
		if (mode === "messages") return text ? `【助手】\n${text}` : undefined;
		const content = (message as { content?: unknown }).content;
		const calls = Array.isArray(content)
			? content
					.filter((part): part is { type: string; name?: string; arguments?: unknown } =>
						Boolean(part) && typeof part === "object" && part.type === "toolCall")
					.map((part) => `[工具调用] ${part.name ?? "?"} ${JSON.stringify(part.arguments ?? {}).slice(0, 500)}`)
			: [];
		const body = [text, ...calls].filter(Boolean).join("\n");
		return body ? `【助手】\n${body}` : undefined;
	}
	if (mode === "full" && message.role === "toolResult") {
		const name = (message as { toolName?: string }).toolName ?? "?";
		const text = messageText(message).trim();
		return `[工具结果] ${name}\n${text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}…(截断)` : text}`;
	}
	if (mode === "full" && (message.role as string) === "custom") {
		const customType = (message as { customType?: string }).customType ?? "custom";
		const text = messageText(message).trim();
		return text ? `[平台卡 ${customType}]\n${text}` : `[平台卡 ${customType}]`;
	}
	return undefined;
}

const SessionReadParams = Type.Object({
	ref: Type.String({ description: "会话引用：/chats?room=…&session=… 链接、puddingteams://rooms/…/sessions/… 链接，或会话 id。" }),
	mode: Type.Optional(
		Type.Union([Type.Literal("messages"), Type.Literal("full")], {
			description: "messages（默认）只含用户/助手文字，省上下文；full 另含工具调用、工具结果与平台卡，成本高，先想清楚再读。",
		}),
	),
	cursor: Type.Optional(Type.Integer({ minimum: 0, description: "上次返回的 nextCursor；缺省从头读。" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT, description: `本次最多读取的消息条数，默认 ${DEFAULT_PAGE_LIMIT}。` })),
});

export class SessionReadService {
	constructor(
		private readonly teams: TeamsStore,
		private readonly sessionDir: string,
		private readonly log?: (msg: string) => void,
	) {}

	/** 窗口聊天会话（manager solo/group 与 worker 单聊）的 session_read 装配。 */
	chatExtension(getSessionId: () => string, role: "manager" | "worker"): { name: string; factory: (pi: ExtensionAPI) => void } {
		const caller: Caller = { kind: "chat", sessionId: getSessionId, role };
		return { name: "pudding-session-read", factory: (pi) => this.register(pi, caller) };
	}

	/** Worker 委派执行会话的 session_read 装配：授权来自任务/会话里出现过的链接。 */
	executionExtension(workspaceId: () => string | undefined, ownUserText: () => Promise<string>): { name: string; factory: (pi: ExtensionAPI) => void } {
		const caller: Caller = { kind: "execution", workspaceId, ownUserText };
		return { name: "pudding-session-read", factory: (pi) => this.register(pi, caller) };
	}

	private register(pi: ExtensionAPI, caller: Caller): void {
		pi.registerTool({
			name: CORE_TOOL_SESSION_READ,
			label: "Session Read",
			description:
				"只读回读本 Workspace 内的房间会话（活引用，读到的是最新进展；leafEntryId 可判断源是否有更新）。messages 模式只含双方文字（默认）；full 含工具调用与结果。用 cursor/limit 自控读取量。Worker 只能读对话或任务材料中被明确引用过的会话（引用即授权）；跨 Workspace 一律不可读。",
			parameters: SessionReadParams,
			execute: async (_toolCallId: string, params: Static<typeof SessionReadParams>) => {
				const ref = parseSessionRef(params.ref);
				if (!ref) throw new Error("无法识别的会话引用；请给 /chats?room=…&session=… 链接、puddingteams:// 链接或会话 id");
				const target = await this.authorize(caller, ref);
				const page = await this.read(target.window.id, ref.sessionId, {
					mode: params.mode ?? "messages",
					cursor: params.cursor ?? 0,
					limit: params.limit ?? DEFAULT_PAGE_LIMIT,
				});
				const header = `会话 ${ref.sessionId}（窗口 ${page.roomName ?? page.roomId}，${page.roomType}）｜共 ${page.total} 条｜leafEntryId=${page.leafEntryId ?? "无"}`;
				const footer = page.nextCursor !== undefined
					? `\n\n（还有更早/更多消息：nextCursor=${page.nextCursor}，继续读取请传 cursor=${page.nextCursor}${page.truncated ? "；本次因字符上限提前截断" : ""}）`
					: "\n\n（已到会话末尾）";
				return {
					content: [{ type: "text", text: `${header}\n\n${page.text || "（当前模式下没有可读消息）"}${footer}` }],
					details: { sessionId: ref.sessionId, ...page },
				};
			},
		});
	}

	/** 权限判定：通过则返回目标上下文，否则抛出人类可读的拒绝原因。 */
	private async authorize(caller: Caller, ref: SessionRef) {
		const target = await this.teams.contextForSession(ref.sessionId);
		if (!target) throw new Error("目标会话不存在或不属于任何对话窗口");
		if (ref.roomId && ref.roomId !== target.window.id) throw new Error("链接中的房间与会话不匹配");
		let callerWorkspaceId: string | undefined;
		if (caller.kind === "chat") {
			const own = await this.teams.contextForSession(caller.sessionId());
			if (own?.window.id === target.window.id) return target;
			callerWorkspaceId = own?.workspaceId;
		} else {
			callerWorkspaceId = caller.workspaceId();
		}
		// 未注册 Workspace 的窗口同属默认工作目录上下文（undefined === undefined）；
		// 只有双方都落在已登记、且不同的 Workspace 才算跨界。
		if (callerWorkspaceId !== target.workspaceId) {
			throw new Error("该会话属于其他 Workspace，不可读取");
		}
		if (caller.kind === "chat" && caller.role === "manager") return target;
		const text = caller.kind === "chat" ? await this.ownUserText(caller.sessionId()) : await caller.ownUserText();
		if (extractSessionRefs(text).some((granted) => granted.sessionId === ref.sessionId)) return target;
		throw new Error("该会话没有在本对话/任务中被引用，无权读取；请让对方把会话链接发给你（引用即授权）");
	}

	/** Worker 单聊的授权来源：自己会话里用户消息出现过的会话链接。 */
	private async ownUserText(sessionId: string): Promise<string> {
		try {
			const file = (await SessionManager.listAll(this.sessionDir)).find((item) => item.id === sessionId)?.path;
			if (!file) return "";
			const manager = SessionManager.open(file, this.sessionDir);
			return manager
				.getBranch()
				.flatMap((entry) => entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message)] : [])
				.join("\n");
		} catch (error) {
			this.log?.(`session_read 授权扫描失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`);
			return "";
		}
	}

	/** 只读渲染目标会话的当前分支；只读已提交（落盘）的条目。 */
	async read(roomId: string, sessionId: string, opts: { mode: "messages" | "full"; cursor: number; limit: number }): Promise<SessionTranscriptPage> {
		const file = (await SessionManager.listAll(this.sessionDir)).find((item) => item.id === sessionId)?.path;
		if (!file) throw new Error("目标会话还没有已提交的对话记录");
		const manager = SessionManager.open(file, this.sessionDir);
		const projection = buildSessionProjection(manager.getEntries(), manager.getLeafId());
		const rendered: string[] = [];
		for (const message of projection.messages) {
			const block = renderMessage(message, opts.mode);
			if (block) rendered.push(block);
		}
		const total = rendered.length;
		const cursor = Math.min(opts.cursor, total);
		const limit = Math.max(1, Math.min(opts.limit, MAX_PAGE_LIMIT));
		const page: string[] = [];
		let chars = 0;
		let truncated = false;
		let index = cursor;
		for (; index < total && page.length < limit; index++) {
			const block = rendered[index]!;
			if (chars + block.length > MAX_PAGE_CHARS) {
				if (page.length > 0) {
					truncated = true;
					break;
				}
				// 单块超限也要守住上限：截断这一块后继续往下装。
				page.push(`${block.slice(0, MAX_PAGE_CHARS)}\n…（单条消息超出 ${MAX_PAGE_CHARS} 字符上限，已截断）`);
				truncated = true;
				chars = MAX_PAGE_CHARS;
				continue;
			}
			page.push(block);
			chars += block.length;
		}
		const room = await this.teams.getWindow(roomId);
		return {
			roomId,
			roomType: room?.type ?? "unknown",
			...(room?.name ? { roomName: room.name } : {}),
			text: page.join("\n\n"),
			cursor,
			...(index < total ? { nextCursor: index } : {}),
			total,
			leafEntryId: manager.getLeafId() ?? undefined,
			truncated,
		};
	}
}
