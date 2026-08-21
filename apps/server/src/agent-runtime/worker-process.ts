import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { DelegationRecord, DelegationStore } from "./delegation-store.js";
import type { TeamsStore } from "../store/teams.js";
import { liveWorkerSession } from "./pi-driver.js";
import type { DelegationTimelineEvent, DelegationTimelineStore } from "./delegation-timeline-store.js";

/**
 * pi worker 执行过程可视化（只读）：pi worker 的 child session 是完整 pi
 * AgentSession（进程内 SDK，JSONL 落盘），运行中驻留在 pi-driver 的内存池，
 * 结束后可从 JSONL 回放。本服务把这两种来源统一成「按 delegationId 查看」
 * 的读接口，供路由层给前端提供与 manager 一致的事件流/历史。
 *
 * pi worker 保留完整 AgentSession 回放；spawn CLI worker 使用平台追加式
 * delegation timeline。两种来源共享同一个「执行过程」入口。
 */

export interface WorkerProcessInfo {
	delegationId: string;
	managerSessionId: string;
	goalId?: string;
	agentId: string;
	status: DelegationRecord["status"];
	sessionHandle?: string;
	/** 委托创建时间：worker 会话跨任务续接，前端按它切出本次委托的消息片段。 */
	createdAt: string;
	/** 会话当前驻留内存（正在跑或近期跑过），可订阅实时事件。 */
	live: boolean;
	view: "session" | "timeline";
}

export interface WorkerProcessListItem extends WorkerProcessInfo {
	updatedAt: string;
	task?: string;
	intent?: string;
	expectedOutcome?: string;
}

export class WorkerProcessService {
	constructor(
		private readonly delegations: DelegationStore,
		private readonly teams: TeamsStore,
		/** 平台默认 worker 会话目录（<home>/sessions/workers）。 */
		private readonly defaultSessionDir: string,
		private readonly timelines?: DelegationTimelineStore,
	) {}

	async resolve(delegationId: string): Promise<WorkerProcessInfo | undefined> {
		const d = await this.delegations.getDelegation(delegationId);
		if (!d) return undefined;
		const agent = await this.teams.getAgent(d.agentId);
		const view = d.sessionHandle && (agent?.connector?.connectorId === "pi" || !agent) ? "session" : "timeline";
		return {
			delegationId: d.id,
			managerSessionId: d.managerSessionId,
			goalId: d.goalId,
			agentId: d.agentId,
			status: d.status,
			sessionHandle: d.sessionHandle,
			createdAt: d.createdAt,
			live: view === "session"
				? Boolean(d.sessionHandle && liveWorkerSession(d.sessionHandle) !== undefined)
				: d.status === "running" || d.status === "waiting_input",
			view,
		};
	}

	/**
	 * Current-session process index for the shared worker drawer. A solo/group
	 * delegation is owned by the manager session but executes in (and is mirrored
	 * to) a worker direct window, so requiring both ids to match hides a live Run.
	 * Show manager-owned records plus records explicitly mirrored into the
	 * currently displayed room session.
	 */
	async list(windowId: string, managerSessionId?: string): Promise<WorkerProcessListItem[]> {
		const byWindow = await this.delegations.listDelegations(windowId);
		let records = byWindow;
		if (managerSessionId) {
			const byManager = await this.delegations.listDelegations(undefined, managerSessionId);
			const mirrored = await this.mirroredTaskIndex(managerSessionId);
			const visibleWindowRecords = byWindow.filter((record) =>
				mirrored.has(record.id) || Boolean(record.managerToolCallId && mirrored.has(record.managerToolCallId)),
			);
			const union = new Map([...byManager, ...visibleWindowRecords].map((record) => [record.id, record]));
			records = [...union.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		}
		const sessionIds = [...new Set(records.filter((record) => !record.task).map((record) => record.managerSessionId))];
		const mirroredTasks = new Map<string, Map<string, string>>();
		await Promise.all(sessionIds.map(async (sessionId) => {
			mirroredTasks.set(sessionId, await this.mirroredTaskIndex(sessionId));
		}));
		return Promise.all(records.map(async (record) => {
			const info = await this.resolve(record.id);
			if (!info) throw new Error(`delegation disappeared while listing: ${record.id}`);
			const taskIndex = mirroredTasks.get(record.managerSessionId);
			return {
				...info,
				updatedAt: record.updatedAt,
				managerSessionId: record.managerSessionId,
				task: record.task
					?? taskIndex?.get(record.id)
					?? (record.managerToolCallId ? taskIndex?.get(record.managerToolCallId) : undefined),
				intent: record.intent,
				expectedOutcome: record.expectedOutcome,
			};
		}));
	}

	/** Recover task names for records created before DelegationRecord persisted `task`. */
	private async mirroredTaskIndex(managerSessionId: string): Promise<Map<string, string>> {
		const index = new Map<string, string>();
		const managerSessionsDir = path.dirname(this.defaultSessionDir);
		const info = (await SessionManager.listAll(managerSessionsDir)).find((item) => item.id === managerSessionId);
		if (info) {
			const session = SessionManager.open(info.path, managerSessionsDir);
			for (const entry of session.getBranch()) {
				const message = entry as {
					type?: string;
					customType?: string;
					content?: unknown;
					details?: { delegationId?: unknown; taskId?: unknown };
				};
				if (message.type !== "custom_message" || message.customType !== "pudding:task_assign" || typeof message.content !== "string") continue;
				if (typeof message.details?.delegationId === "string") index.set(message.details.delegationId, message.content);
				if (typeof message.details?.taskId === "string") index.set(message.details.taskId, message.content);
			}
		}
		return index;
	}

	async timeline(delegationId: string, afterSeq = 0): Promise<DelegationTimelineEvent[]> {
		return this.timelines?.list(delegationId, afterSeq) ?? [];
	}

	async subscribeTimeline(
		delegationId: string,
		afterSeq: number,
		listener: (event: DelegationTimelineEvent) => void,
	): Promise<{ events: DelegationTimelineEvent[]; unsubscribe: () => void }> {
		if (!this.timelines) return { events: [], unsubscribe: () => undefined };
		return this.timelines.subscribeFrom(delegationId, afterSeq, listener);
	}

	/** Agent 可在 Connector config 里覆盖 sessionDir（与 pi-driver 装配一致）。 */
	private async sessionDirFor(agentId: string): Promise<string> {
		const agent = await this.teams.getAgent(agentId);
		const configured = agent?.connector?.config?.sessionDir;
		return typeof configured === "string" && configured.trim() ? configured.trim() : this.defaultSessionDir;
	}

	/**
	 * 会话消息历史：live 命中用内存会话（含未落盘的流式尾部）；否则从 JSONL
	 * 当前分支读 message 条目。返回 pi AgentMessage[]（与 manager 会话的
	 * /messages 同形）。会话不存在返回 undefined。
	 */
	async messages(agentId: string, handle: string): Promise<unknown[] | undefined> {
		const live = liveWorkerSession(handle);
		if (live) return live.messages;
		const dir = await this.sessionDirFor(agentId);
		const info = (await SessionManager.listAll(dir)).find((s) => s.id === handle);
		if (!info) return undefined;
		const sm = SessionManager.open(info.path, dir);
		return sm
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => (entry as { message: unknown }).message);
	}

	/** 仅 live 会话可订阅实时事件；非 live 返回 undefined（前端只展示历史）。 */
	subscribeLive(handle: string, listener: (event: AgentSessionEvent) => void): (() => void) | undefined {
		const live = liveWorkerSession(handle);
		return live ? live.subscribe(listener) : undefined;
	}

	/**
	 * live 会话仍在执行的工具调用 id：历史重放会把无 toolResult 的调用一律
	 * 降级「已中断」，前端需要这个清单把它们标回 running（与 manager 的
	 * /messages 语义一致）。非 live/非流式返回空。
	 */
	runningToolCallIds(handle: string): string[] {
		const live = liveWorkerSession(handle);
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
}
