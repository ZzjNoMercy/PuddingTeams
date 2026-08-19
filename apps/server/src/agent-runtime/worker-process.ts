import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { DelegationRecord, DelegationStore } from "./delegation-store.js";
import type { TeamsStore } from "../store/teams.js";
import { liveWorkerSession } from "./pi-driver.js";

/**
 * pi worker 执行过程可视化（只读）：pi worker 的 child session 是完整 pi
 * AgentSession（进程内 SDK，JSONL 落盘），运行中驻留在 pi-driver 的内存池，
 * 结束后可从 JSONL 回放。本服务把这两种来源统一成「按 delegationId 查看」
 * 的读接口，供路由层给前端提供与 manager 一致的事件流/历史。
 *
 * 只支持 pi worker（Connector 绑定 connectorId === "pi"）；外部 CLI worker
 * 的执行流在对方进程里，拿不到 pi 事件流。
 */

export interface WorkerProcessInfo {
	delegationId: string;
	agentId: string;
	status: DelegationRecord["status"];
	sessionHandle?: string;
	/** 委托创建时间：worker 会话跨任务续接，前端按它切出本次委托的消息片段。 */
	createdAt: string;
	/** 会话当前驻留内存（正在跑或近期跑过），可订阅实时事件。 */
	live: boolean;
}

export class WorkerProcessService {
	constructor(
		private readonly delegations: DelegationStore,
		private readonly teams: TeamsStore,
		/** 平台默认 worker 会话目录（<home>/sessions/workers）。 */
		private readonly defaultSessionDir: string,
	) {}

	async resolve(delegationId: string): Promise<WorkerProcessInfo | undefined> {
		const d = await this.delegations.getDelegation(delegationId);
		if (!d) return undefined;
		return {
			delegationId: d.id,
			agentId: d.agentId,
			status: d.status,
			sessionHandle: d.sessionHandle,
			createdAt: d.createdAt,
			live: d.sessionHandle ? liveWorkerSession(d.sessionHandle) !== undefined : false,
		};
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
