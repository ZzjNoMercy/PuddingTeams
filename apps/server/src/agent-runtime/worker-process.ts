import { type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { DelegationRecord, DelegationStore } from "./delegation-store.js";
import type { TeamsStore } from "../store/teams.js";
import { liveWorkerSession } from "./pi-driver.js";
import type { DelegationTimelineEvent, DelegationTimelineStore } from "./delegation-timeline-store.js";
import { liveWorkerMessages, replayWorkerSessionMessages, subscribeWorkerSession, workerRunningToolCallIds } from "./worker-process-session.js";

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
	executionState: DelegationRecord["executionState"];
	workerStarted: boolean;
	readOnlyAssessment?: DelegationRecord["readOnlyAssessment"];
	receipt?: DelegationRecord["receipt"];
	sessionHandle?: string;
	/** 委托创建时间：worker 会话跨任务续接，前端按它切出本次委托的消息片段。 */
	createdAt: string;
	/** 会话当前驻留内存（正在跑或近期跑过），可订阅实时事件。 */
	live: boolean;
	view: "session" | "timeline";
}

export interface WorkerProcessListItem extends WorkerProcessInfo {
	sourceRoomId?: string;
	workspaceId?: string;
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
		const piDriver = d.driverId === "pi" || (!d.driverId && (agent?.connector?.connectorId === "pi" || !agent));
		const view = d.sessionHandle && piDriver ? "session" : "timeline";
		return {
			delegationId: d.id,
			managerSessionId: d.managerSessionId,
			goalId: d.goalId,
			agentId: d.agentId,
			executionState: d.executionState,
			workerStarted: d.workerStarted,
			readOnlyAssessment: d.readOnlyAssessment,
			receipt: d.receipt,
			sessionHandle: d.sessionHandle,
			createdAt: d.createdAt,
			live: view === "session"
				? Boolean(d.sessionHandle && liveWorkerSession(d.sessionHandle) !== undefined)
				: d.executionState === "running" || d.executionState === "waiting_input" || d.executionState === "cancel_requested" || d.executionState === "reconciling",
			view,
		};
	}

	/** Source conversation is the identity; execution windows and chat mirrors are not. */
	async list(windowId: string, sourceSessionId?: string): Promise<WorkerProcessListItem[]> {
		return this.listRecords(sourceSessionId ? { sourceSessionId } : { windowId });
	}

	async listRecords(filters: { windowId?: string; sourceSessionId?: string; workerId?: string; workspaceId?: string; goalId?: string } = {}): Promise<WorkerProcessListItem[]> {
		const records = (await this.delegations.listDelegations())
			.filter(record => (!filters.sourceSessionId || record.managerSessionId === filters.sourceSessionId)
				&& (!filters.workerId || record.agentId === filters.workerId)
				&& (!filters.workspaceId || record.workspaceId === filters.workspaceId)
				&& (!filters.goalId || record.goalId === filters.goalId)
				&& (!filters.windowId || record.windowId === filters.windowId))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return Promise.all(records.map(async record => ({
			...(await this.resolve(record.id))!,
			sourceRoomId: (await this.teams.windowForSession(record.managerSessionId))?.id,
			workspaceId: record.workspaceId,
			updatedAt: record.updatedAt,
			task: record.task,
			intent: record.intent,
			expectedOutcome: record.expectedOutcome,
		})));
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

	/**
	 * 会话消息历史：live 命中用内存会话（含未落盘的流式尾部）；否则从 JSONL
	 * 当前分支读 message 条目。返回 pi AgentMessage[]（与 manager 会话的
	 * /messages 同形）。会话不存在返回 undefined。读取实现共享自
	 * worker-process-session.ts（只读过程模块）。
	 */
	async messages(delegationId: string, handle: string): Promise<unknown[] | undefined> {
		// live 注册表成员身份本身就是执行中的证明；回放才需要台账归属校验。
		const delegation = await this.delegations.getDelegation(delegationId);
		if (!delegation || delegation.sessionHandle !== handle || (delegation.driverId && delegation.driverId !== "pi")) return undefined;
		return liveWorkerMessages(handle) ?? replayWorkerSessionMessages(handle, delegation.workerSessionDir ?? this.defaultSessionDir);
	}

	/** Restrict process messages to the recorded execution boundary. */
	async scopedMessages(info: WorkerProcessInfo, messages: unknown[]): Promise<unknown[] | undefined> {
		if (!info.sessionHandle) return undefined;
		// The live AgentSession can append while the delegation index is loading.
		// Fix the message set before awaiting the index so a later Run cannot enter
		// an earlier request through a shared mutable array reference.
		const snapshot = [...messages];
		const start = Date.parse(info.createdAt);
		if (!Number.isFinite(start)) return undefined;
		const sealedAt = info.receipt?.sealedAt ? Date.parse(info.receipt.sealedAt) : NaN;
		if (info.receipt?.sealedAt && !Number.isFinite(sealedAt)) return undefined;
		const peers = await this.delegations.listDelegations();
		const peerStarts = peers
			.filter((candidate) => candidate.id !== info.delegationId && candidate.agentId === info.agentId && candidate.sessionHandle === info.sessionHandle)
			.map((candidate) => Date.parse(candidate.createdAt));
		if (peerStarts.some((timestamp) => !Number.isFinite(timestamp) || timestamp === start)) return undefined;
		const nextStarts = peerStarts.filter((timestamp) => timestamp > start);
		const end = Math.min(Number.isFinite(sealedAt) ? sealedAt + 1 : Infinity, ...nextStarts);
		if (snapshot.some((message) => {
			const timestamp = (message as { timestamp?: unknown } | null)?.timestamp;
			return typeof timestamp !== "number" || !Number.isFinite(timestamp);
		})) return undefined;
		return snapshot.filter((message) => {
			const timestamp = (message as { timestamp: number }).timestamp;
			return timestamp >= start && timestamp < end;
		});
	}

	/** 仅 live 会话可订阅实时事件；非 live 返回 undefined（前端只展示历史）。 */
	subscribeLive(handle: string, listener: (event: AgentSessionEvent) => void): (() => void) | undefined {
		return subscribeWorkerSession(handle, listener);
	}

	/**
	 * live 会话仍在执行的工具调用 id：历史重放会把无 toolResult 的调用一律
	 * 降级「已中断」，前端需要这个清单把它们标回 running（与 manager 的
	 * /messages 语义一致）。非 live/非流式返回空。
	 */
	runningToolCallIds(handle: string): string[] {
		return workerRunningToolCallIds(handle);
	}
}
