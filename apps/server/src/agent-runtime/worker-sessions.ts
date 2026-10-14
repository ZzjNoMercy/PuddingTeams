import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { agentDisplayName, type AgentConfig, type TeamsStore, type WindowConfig } from "../store/teams.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { DelegationRecord, DelegationStore } from "./delegation-store.js";
import { liveWorkerSession } from "./pi-driver.js";

/**
 * Worker 执行 session 的一等会话数据面（房间即群聊方案：单聊窗口双 session）。
 *
 * direct 窗口实际存在两类 session：容器 session（window.sessions，只装 custom
 * 卡）与执行 session（delegation 台账的 sessionHandle，真实 pi 会话，JSONL 落
 * 在 worker 专属目录）。执行 session 绝不登记进 window.sessions（会被
 * ensureWindowAlive 剪枝），而是通过本模块平行投影到 RoomSummary.workerSessions。
 *
 * 本模块是 session 路由的统一解析层：GET messages / WS / 后续 POST 输入排队、
 * 重命名与删除都经 resolveSession 分流，归属校验集中在这里。
 */

/** 执行 session 的房间侧投影（平行于容器 session 列表，不进 window.sessions）。 */
export interface WorkerSessionSummary {
	/** Worker 执行 session 的 handle（pi Session id）。 */
	id: string;
	/** session_info 里的用户命名优先；缺省取首个 delegation 任务首句（≤40 字，不回写文件）。 */
	name: string;
	firstMessage: string;
	modifiedAt: string;
	origin: "delegation";
	/** 发起委派（或本窗口 direct 直派）的 manager/容器 session。 */
	sourceManagerSessionId: string;
	/** 发起方所属窗口；源 session 已失去窗口归属时为空串。 */
	sourceWindowId: string;
	/** solo → "大管家"；群 → 群名；本窗口自己的直派会话不列入枚举。 */
	sourceWindowName: string;
	/** 该 handle 最近一次 delegation（跨 session continue 审计的入口）。 */
	lastDelegationId: string;
	running: boolean;
}

/** 仍在占用执行 session 的 delegation 状态（与 invoker.activeDelegations 同集）。 */
export const ACTIVE_WORKER_EXECUTION_STATES: ReadonlySet<DelegationRecord["executionState"]> = new Set([
	"waiting_admission",
	"running",
	"waiting_input",
	"cancel_requested",
	"reconciling",
]);

/** 测试可注入的 live 注册表查找；生产缺省为 pi-driver 的驻留池。 */
export type LiveWorkerSessionLookup = (handle: string) => AgentSession | undefined;

function userTextOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } =>
			Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"))
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** 与 direct-dispatch 的容器 session 命名惯例一致：任务首句，空白归一，≤40 字。 */
function taskDerivedName(task: string | undefined): string {
	return (task ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function sourceWindowDisplayName(w: WindowConfig, agents: AgentConfig[]): string {
	if (w.name?.trim()) return w.name.trim();
	if (w.type === "solo") return "大管家";
	if (w.type === "direct") {
		const member = agents.find((agent) => agent.name === w.members[0]);
		return `与 ${member ? agentDisplayName(member) : (w.members[0] ?? "")} 单聊`;
	}
	const names = w.members.map((member) => agentDisplayName(agents.find((agent) => agent.name === member) ?? { name: member }));
	return `群聊：${names.join("、") || w.members.join("、")}`;
}

/**
 * 枚举 direct 窗口可见的执行 session：delegation 台账按 windowId 过滤、按
 * sessionHandle 去重聚合。文件已删除且不在 live 池的 handle 跳过（删除路径的
 * 收敛语义）；本窗口 direct 直派产生的执行 session 不列入——它是「直接对话」
 * 容器会话的执行面，列出会同一段对话出现两条。
 */
export async function listWorkerSessionsForWindow(
	deps: {
		delegations: Pick<DelegationStore, "listDelegations">;
		teams: Pick<TeamsStore, "getWindow" | "windowForSession" | "listAgents">;
		defaultSessionDir: string;
		liveLookup?: LiveWorkerSessionLookup;
	},
	window: WindowConfig,
): Promise<WorkerSessionSummary[]> {
	// P2: execution contexts are exposed only by delegationId, never as chats.
	return [];
}

/**
 * Session 路由解析层：按 id 判定 manager 容器 session（PiSessionStore 能打开）
 * 或 worker 执行 session（台账归属校验 + 文件存在性）。worker 侧只在执行窗口
 * 仍存在的 direct 窗口上成立——群聊维持 manager session 单一事实源， deleted
 * 文件的回放由调用方得到 undefined 后转 404。
 */
export type ResolvedSession =
	| { kind: "manager"; sessionId: string }
	| {
		kind: "worker";
		sessionHandle: string;
		/** 执行窗口（direct）；parked/active-context 门禁按它的窗口上下文判定。 */
		windowId: string;
		/** 归属校验命中的 delegation（审计入口）。 */
		delegationId: string;
		workerSessionDir: string;
		live: boolean;
	};

export async function resolveSession(
	deps: {
		sessions: Pick<PiSessionStore, "list" | "isOpen">;
		delegations: Pick<DelegationStore, "listDelegations">;
		teams: Pick<TeamsStore, "getWindow">;
		defaultSessionDir: string;
		liveLookup?: LiveWorkerSessionLookup;
	},
	id: string,
): Promise<ResolvedSession | undefined> {
	if (deps.sessions.isOpen(id) || (await deps.sessions.list()).some((session) => session.id === id)) {
		return { kind: "manager", sessionId: id };
	}
	return undefined;
}

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
 * 执行 session 消息历史的唯一读取入口：live 注册表优先，否则从给定目录回放。
 * WorkerProcessService.messages 与 chat 路由的 worker 分支共用，避免两份实现。
 */
export async function readWorkerSessionMessages(
	handle: string,
	dir: string,
	liveLookup: LiveWorkerSessionLookup = liveWorkerSession,
): Promise<unknown[] | undefined> {
	return liveWorkerMessages(handle, liveLookup) ?? (await replayWorkerSessionMessages(handle, dir));
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

/** 执行 session 的落盘文件位置（重命名/删除用）；不存在返回 undefined。 */
export async function findWorkerSessionFile(handle: string, dir: string): Promise<string | undefined> {
	const info = (await SessionManager.listAll(dir).catch(() => [])).find((session) => session.id === handle);
	return info?.path;
}

/**
 * 重命名执行 session（步骤 5）：live 直接改驻留实例（写 session_info），
 * 否则在 JSONL 上追加 session_info；与容器 session 同一 60 字上限。
 */
export async function renameWorkerSession(
	handle: string,
	dir: string,
	name: string,
	liveLookup: LiveWorkerSessionLookup = liveWorkerSession,
): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("会话名称不能为空");
	if (trimmed.length > 60) throw new Error("会话名称不能超过 60 个字符");
	const live = liveLookup(handle);
	if (live) {
		live.setSessionName(trimmed);
		return;
	}
	const file = await findWorkerSessionFile(handle, dir);
	if (!file) throw new Error("session not found");
	SessionManager.open(file, dir).appendSessionInfo(trimmed);
}
