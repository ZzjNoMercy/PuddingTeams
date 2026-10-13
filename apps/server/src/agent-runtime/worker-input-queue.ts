import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentInvoker } from "./invoker.js";
import type { AgentRuntime } from "./runtime.js";
import type { DelegationStore } from "./delegation-store.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import { directTaskId } from "./direct-dispatch.js";
import type { RuntimeModelSettings } from "./types.js";

/**
 * Worker 执行 session 的直接输入队列（步骤 4）：用户在执行 session 视图里
 * 直接向 worker 发消息。目标 session 被 runtime 锁占用（canDelegate 为否）
 * 时消息入队（FIFO 持久化，原子写）；锁释放点在同一临界区先取队首再放行
 * 新锁申请（runtime.setSessionQueueHook），保证先到的用户输入先于后到的
 * 委派。委派侧 conflict 语义不变。
 *
 * 幂等：operationId（HTTP Idempotency-Key）先去重——队列命中返回原排队态，
 * delegation 台账命中视为已派发，重试不会双投。
 */

export interface WorkerInputQueueItem {
	id: string;
	windowId: string;
	sessionHandle: string;
	/** 完整委托文本（交给 worker 的正文）。 */
	text: string;
	/** 容器 session 用户卡的展示文本。 */
	displayText: string;
	operationId: string;
	createdAt: string;
	status: "queued" | "failed";
	failureReason?: string;
}

interface QueueFile {
	items: WorkerInputQueueItem[];
}

/** state/worker-input-queue.json 的持久化队列（原子写 + 进程内串行变更）。 */
export class WorkerInputQueueStore {
	private items: WorkerInputQueueItem[] = [];
	private chain: Promise<unknown> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async init(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as QueueFile;
			if (Array.isArray(parsed.items)) this.items = parsed.items.filter((item) => item && typeof item.id === "string" && typeof item.sessionHandle === "string");
		} catch { /* 缺文件/损坏按空队列启动；损坏文件留给下一次原子写覆盖 */ }
	}

	list(): WorkerInputQueueItem[] {
		return [...this.items];
	}

	get(id: string): WorkerInputQueueItem | undefined {
		return this.items.find((item) => item.id === id);
	}

	findByOperationId(operationId: string): WorkerInputQueueItem | undefined {
		return this.items.find((item) => item.operationId === operationId);
	}

	/** 该 handle 的排队项（FIFO：按入队时间）。 */
	queuedForHandle(sessionHandle: string): WorkerInputQueueItem[] {
		return this.items
			.filter((item) => item.sessionHandle === sessionHandle && item.status === "queued")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	}

	private mutate<T>(fn: () => T | Promise<T>): Promise<T> {
		const run = this.chain.then(fn);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async persist(): Promise<void> {
		const tmp = `${this.filePath}.tmp`;
		await writeFile(tmp, JSON.stringify({ items: this.items } satisfies QueueFile, null, 2));
		await rename(tmp, this.filePath);
	}

	/** 入队；operationId 命中既有项时原样返回（幂等重试不双投）。 */
	async enqueue(item: WorkerInputQueueItem): Promise<WorkerInputQueueItem> {
		return this.mutate(async () => {
			const existing = this.findByOperationId(item.operationId);
			if (existing) return existing;
			this.items.push(item);
			await this.persist();
			return item;
		});
	}

	async remove(id: string): Promise<boolean> {
		return this.mutate(async () => {
			const before = this.items.length;
			this.items = this.items.filter((item) => item.id !== id);
			if (this.items.length === before) return false;
			await this.persist();
			return true;
		});
	}

	async markFailed(id: string, reason: string): Promise<WorkerInputQueueItem | undefined> {
		return this.mutate(async () => {
			const item = this.items.find((entry) => entry.id === id);
			if (!item || item.status !== "queued") return item;
			item.status = "failed";
			item.failureReason = reason;
			await this.persist();
			return item;
		});
	}

	/** 该 handle 全部排队项标失败（删除执行 session / 窗口失效路径），返回被失败化的项。 */
	async failQueuedForHandle(sessionHandle: string, reason: string): Promise<WorkerInputQueueItem[]> {
		return this.mutate(async () => {
			const failed: WorkerInputQueueItem[] = [];
			for (const item of this.items) {
				if (item.sessionHandle !== sessionHandle || item.status !== "queued") continue;
				item.status = "failed";
				item.failureReason = reason;
				failed.push(item);
			}
			if (failed.length) await this.persist();
			return failed;
		});
	}
}

export type WorkerInputSubmitResult =
	| { status: "dispatched" }
	| { status: "queued"; queueId: string };

interface DispatcherDeps {
	queue: WorkerInputQueueStore;
	teams: TeamsStore;
	sessions: PiSessionStore;
	invoker: AgentInvoker;
	runtime: AgentRuntime;
	delegations: DelegationStore;
	runtimeModelFor?: (sessionId: string) => Promise<RuntimeModelSettings>;
	log?: (message: string) => void;
}

export class WorkerInputDispatcher {
	/** 正在派发中的队项 id（进程内；重启后由台账幂等兜底）。 */
	private readonly claimed = new Set<string>();
	private tokenSeq = 0;

	constructor(private readonly deps: DispatcherDeps) {}

	/** 注册 runtime 锁交接钩子（启动时一次）。 */
	attach(): void {
		this.deps.runtime.setSessionQueueHook((handle) => this.onLockReleased(handle));
	}

	private onLockReleased(sessionHandle: string): string | undefined {
		const item = this.deps.queue.queuedForHandle(sessionHandle).find((entry) => !this.claimed.has(entry.id));
		if (!item) return undefined;
		const token = `${item.id}:${++this.tokenSeq}`;
		this.claimed.add(item.id);
		queueMicrotask(() => void this.drainClaimed(sessionHandle, token, item.id));
		return token;
	}

	/** 用户卡 eventId：落盘去重的单点（submit 主写 + drain 补写同一 id）。 */
	private userCardEventId(operationId: string): string {
		return `worker-input:${operationId}`;
	}

	private userCard(item: WorkerInputQueueItem, queued: boolean) {
		return {
			customType: "pudding:user_message",
			content: item.displayText,
			details: {
				windowId: item.windowId,
				operationId: item.operationId,
				eventId: this.userCardEventId(item.operationId),
				targetSessionHandle: item.sessionHandle,
				executionText: item.text,
				queued,
			},
		};
	}

	/**
	 * 执行 session 视图的发送入口。空闲（canDelegate 且队空）时认领锁直接派发；
	 * 否则持久化入队并给容器 session 补排队态用户卡。
	 */
	async submit(input: {
		windowId: string;
		sessionHandle: string;
		text: string;
		displayText: string;
		operationId: string;
	}): Promise<WorkerInputSubmitResult> {
		const deduped = this.deps.queue.findByOperationId(input.operationId);
		if (deduped) {
			return deduped.status === "queued" ? { status: "queued", queueId: deduped.id } : { status: "dispatched" };
		}
		const dispatched = (await this.deps.delegations.listDelegations()).some(
			(record) => record.operationId === input.operationId && record.sessionHandle === input.sessionHandle,
		);
		if (dispatched) return { status: "dispatched" };

		const window = await this.deps.teams.getWindow(input.windowId);
		if (!window || window.type !== "direct") throw new Error("执行会话所属窗口已不存在");
		const item: WorkerInputQueueItem = {
			id: randomUUID(),
			windowId: input.windowId,
			sessionHandle: input.sessionHandle,
			text: input.text,
			displayText: input.displayText,
			operationId: input.operationId,
			createdAt: new Date().toISOString(),
			status: "queued",
		};
		await this.deps.queue.enqueue(item);
		// 锁空闲且无前序排队 → 同步认领后直接派发；认领会失败说明有并发占位，退回排队。
		const idle = !this.deps.runtime.isSessionLocked(input.sessionHandle)
			&& (await this.deps.runtime.canDelegate(input.sessionHandle)).ok
			&& this.deps.queue.queuedForHandle(input.sessionHandle).every((entry) => entry.id === item.id);
		let token: string | undefined;
		if (idle) {
			const candidate = `${item.id}:${++this.tokenSeq}`;
			if (this.deps.runtime.claimSessionForQueue(input.sessionHandle, candidate)) token = candidate;
		}
		await this.deps.sessions.sendCustomMessageDurable(window.activeSession, this.userCard(item, !token));
		if (!token) return { status: "queued", queueId: item.id };
		this.claimed.add(item.id);
		await this.dispatchClaimed(input.sessionHandle, token, item.id);
		return { status: "dispatched" };
	}

	/** 派发执行（后台长跑）；submit 的即时路径只等接单确认（delegation 落账）。 */
	private async dispatchClaimed(sessionHandle: string, token: string, itemId: string): Promise<void> {
		let resolveAdmission!: () => void;
		let rejectAdmission!: (error: unknown) => void;
		let admitted = false;
		const admission = new Promise<void>((resolve, reject) => {
			resolveAdmission = resolve;
			rejectAdmission = reject;
		});
		const done = this.drainClaimed(sessionHandle, token, itemId, () => {
			admitted = true;
			resolveAdmission();
		});
		// 早终态（如准入拒绝）可能不经 onDelegationCreated 直接落定，同样放行接单等待。
		void done.then(() => {
			if (!admitted) { admitted = true; resolveAdmission(); }
		}, (err: unknown) => {
			if (!admitted) rejectAdmission(err);
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				admission,
				new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("worker 输入派发接单未确认")), 30000); }),
			]);
		} finally { if (timer) clearTimeout(timer); }
	}

	private async drainClaimed(sessionHandle: string, token: string, itemId: string, onAdmitted?: () => void): Promise<void> {
		const item = this.deps.queue.get(itemId);
		const release = () => this.deps.runtime.releaseSessionQueueClaim(sessionHandle, token);
		try {
			if (!item || item.status !== "queued") {
				release();
				return;
			}
			// 崩溃恢复幂等：台账已有同 operationId 的 delegation 说明已派发过。
			const existing = (await this.deps.delegations.listDelegations())
				.filter((record) => record.operationId === item.operationId && record.sessionHandle === sessionHandle)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
			if (existing) {
				await this.deps.queue.remove(item.id);
				release();
				return;
			}
			const window = await this.deps.teams.getWindow(item.windowId);
			if (!window || window.type !== "direct") throw new Error("执行会话所属窗口已不存在");
			const workerName = window.members[0];
			if (!workerName) throw new Error("执行窗口没有可用 worker");
			const agent = await this.deps.invoker.requireAgent(workerName);
			const containerSessionId = window.activeSession;
			// submit 已主写用户卡；这里是崩溃重启后补写（eventId 去重，幂等）。
			await this.deps.sessions.appendCustomMessageIfAbsent(
				containerSessionId,
				this.userCardEventId(item.operationId),
				this.userCard(item, false),
				{ triggerTurn: false },
			);
			let runtimeModel = await this.deps.runtimeModelFor?.(containerSessionId);
			if (runtimeModel && Object.keys(runtimeModel).length === 0) runtimeModel = undefined;
			const result = await this.deps.invoker.delegate({
				agent,
				windowId: window.id,
				managerSessionId: containerSessionId,
				managerToolCallId: directTaskId(item.operationId),
				operationId: item.operationId,
				message: item.text,
				mode: "continue",
				sessionHandle,
				sessionQueueToken: token,
				runtimeModel,
				onDelegationCreated: () => {
					// 接单落账后排队项使命完成：此后崩溃恢复由 delegation 台账幂等兜底
					//（本函数开头的 existing 检查）。若等执行结束才移除，web 轮询会在
					// 整个执行期间把这条消息显示为「排队中」，而它其实就是当前任务。
					void this.deps.queue.remove(itemId).catch(() => undefined);
					onAdmitted?.();
				},
			});
			await this.deps.queue.remove(item.id);
			if (result.status === "needs_input") return; // 审批卡已由 invoker 写进容器 session
			if (result.conflict) throw new Error("派发时执行会话仍被占用（锁交接失效）");
			await this.deps.sessions.appendCustomMessageIfAbsent(
				containerSessionId,
				`worker-input-result:${item.operationId}`,
				{
					customType: "pudding:task_result",
					content: result.content,
					details: {
						operationId: item.operationId,
						taskId: directTaskId(item.operationId),
						targetSessionHandle: sessionHandle,
						windowId: window.id,
						worker: agent.name,
						status: result.status,
						...(result.delegationId ? { delegationId: result.delegationId } : {}),
						...(result.sessionHandle ? { sessionHandle: result.sessionHandle } : {}),
					},
				},
				{ triggerTurn: false },
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const failed = await this.deps.queue.markFailed(itemId, message);
			// 接单落账后队列项已移除，markFailed 落空；此处的失败仍要对用户可见。
			const failedItem = failed ?? item;
			if (failedItem) {
				const window = await this.deps.teams.getWindow(failedItem.windowId).catch(() => undefined);
				if (window) {
					await this.deps.sessions.appendCustomMessageIfAbsent(
						window.activeSession,
						`worker-input-result:${failedItem.operationId}`,
						{
							customType: "pudding:task_result",
							content: `执行会话输入派发失败：${message}`,
							details: { operationId: failedItem.operationId, targetSessionHandle: sessionHandle, windowId: failedItem.windowId, status: "failed" },
						},
						{ triggerTurn: false },
					).catch(() => undefined);
				}
			}
			release();
		} finally {
			this.claimed.delete(itemId);
		}
	}

	/** 该 handle 仍在排队的项（删除执行 session 的 409 预检用）。 */
	queuedItems(sessionHandle: string): WorkerInputQueueItem[] {
		return this.deps.queue.queuedForHandle(sessionHandle);
	}

	/** 窗口的排队项（queued/failed，FIFO 顺序；web 渲染灰态待发送气泡用）。 */
	listForWindow(windowId: string, sessionHandle?: string): WorkerInputQueueItem[] {
		return this.deps.queue.list()
			.filter((item) => item.windowId === windowId && (!sessionHandle || item.sessionHandle === sessionHandle))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	}

	/**
	 * 取消排队项。已认领派发中的不能取消（执行已发出）；取消后给容器 session
	 * 补一张取消卡，让时间线上的排队态用户卡有着落。
	 */
	async cancel(windowId: string, queueId: string): Promise<"removed" | "dispatching" | "not_found"> {
		const item = this.deps.queue.get(queueId);
		if (!item || item.windowId !== windowId) return "not_found";
		if (this.claimed.has(item.id) && item.status === "queued") return "dispatching";
		const removed = await this.deps.queue.remove(item.id);
		if (!removed) return "not_found";
		if (item.status === "queued") {
			const window = await this.deps.teams.getWindow(item.windowId).catch(() => undefined);
			if (window) {
				await this.deps.sessions.appendCustomMessageIfAbsent(
					window.activeSession,
					`worker-input-cancel:${item.operationId}`,
					{
						customType: "pudding:task_result",
						content: "排队中的消息已取消，未发送给 worker。",
						details: { operationId: item.operationId, targetSessionHandle: item.sessionHandle, windowId: item.windowId, status: "cancelled" },
					},
					{ triggerTurn: false },
				).catch(() => undefined);
			}
		}
		return "removed";
	}

	/** 删除执行 session：其排队输入全部失败化并对用户可见。 */
	async failQueuedForHandle(sessionHandle: string, reason: string): Promise<void> {
		const failed = await this.deps.queue.failQueuedForHandle(sessionHandle, reason);
		for (const item of failed) {
			const window = await this.deps.teams.getWindow(item.windowId).catch(() => undefined);
			if (!window) continue;
			await this.deps.sessions.appendCustomMessageIfAbsent(
				window.activeSession,
				`worker-input-result:${item.operationId}`,
				{
					customType: "pudding:task_result",
					content: `排队中的消息未发送：${reason}`,
					details: { operationId: item.operationId, targetSessionHandle: sessionHandle, windowId: item.windowId, status: "failed" },
				},
				{ triggerTurn: false },
			).catch(() => undefined);
		}
	}

	/**
	 * 启动对账：进程重启后锁全空，凡仍有排队项的 handle 空闲即补投；
	 * 窗口/binding 已失效的项标失败可见，绝不静默吞掉。
	 */
	async reconcileOnBoot(): Promise<{ dispatched: number; failed: number }> {
		let dispatched = 0;
		let failed = 0;
		const handles = [...new Set(this.deps.queue.list().filter((item) => item.status === "queued").map((item) => item.sessionHandle))];
		for (const handle of handles) {
			const first = this.deps.queue.queuedForHandle(handle)[0];
			if (!first) continue;
			const window = await this.deps.teams.getWindow(first.windowId).catch(() => undefined);
			const owned = window && (await this.deps.delegations.listDelegations(window.id)).some((record) => record.sessionHandle === handle);
			if (!window || window.type !== "direct" || !owned) {
				const failing = this.deps.queue.queuedForHandle(handle).length;
				await this.failQueuedForHandle(handle, "执行会话所属窗口或会话绑定已失效");
				failed += failing;
				continue;
			}
			if (this.deps.runtime.isSessionLocked(handle) || !(await this.deps.runtime.canDelegate(handle)).ok) continue;
			const token = `${first.id}:${++this.tokenSeq}`;
			if (!this.deps.runtime.claimSessionForQueue(handle, token)) continue;
			this.claimed.add(first.id);
			dispatched++;
			void this.drainClaimed(handle, token, first.id).catch((error: unknown) => {
				this.deps.log?.(`worker input queue drain failed for ${handle}: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
		return { dispatched, failed };
	}
}
