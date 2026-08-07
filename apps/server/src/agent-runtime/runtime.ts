import { randomUUID } from "node:crypto";
import { DelegationStore, type DelegationRecord, type InteractionRecord } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { InteractionBroker, InteractionError } from "./interaction-broker.js";
import type {
	AgentDriver,
	AgentEvent,
	AgentOperation,
	InvocationContext,
	InteractionResponse,
	NeedsInputResult,
	NormalizedResult,
} from "./types.js";

export interface DelegateInput {
	windowId: string;
	managerSessionId: string;
	managerToolCallId?: string;
	agentId: string;
	message: string;
	/** "run" 新开 worker session；"continue" 续接 window 记录的 session。 */
	mode: "run" | "continue";
	sessionHandle?: string;
	options?: Record<string, unknown>;
	requestId?: string;
}

export interface RuntimeOutcome {
	status: "completed" | "failed" | "needs_input";
	result: NormalizedResult;
	delegation: DelegationRecord;
	interaction?: InteractionRecord;
}

export interface RespondOutcome {
	status: "completed" | "failed" | "needs_input" | "rejected";
	result: NormalizedResult;
	delegation: DelegationRecord;
	interaction?: InteractionRecord;
}

export interface InteractionTTL {
	/** 默认 24h；受上游更短 TTL 限制。 */
	ttlMs: number;
}

/** 同一 Session 已有 active/waiting Run 时的 409 语义冲突。 */
export class SessionConflictError extends Error {
	constructor(sessionHandle: string) {
		super(`Session already has an active Run or pending input (409): ${sessionHandle}`);
		this.name = "SessionConflictError";
	}
}

/**
 * AgentRuntime：生命周期、并发锁、超时、取消、持久化与事件归一化（方案 §3/§8）。
 *
 * 不变量（§1.3 / §12.1）：
 * - 同一 Session 同时最多一个 active/waiting Run（per-sessionHandle 锁）；
 * - `continue` 只允许 Session 空闲时调用；
 * - `respond` 必须携带 Interaction 句柄并恢复原 runHandle；
 * - waiting_input 不是 failed，绝不通过自然语言重试重跑任务；
 * - 重复 response request_id 幂等。
 */
export class AgentRuntime {
	private readonly activeRuns = new Map<string, string>();
	/** 正在执行的 respond（per-interaction 防并发，M3）。 */
	private readonly responding = new Set<string>();
	private readonly broker: InteractionBroker;

	constructor(
		private readonly delegations: DelegationStore,
		private readonly secrets: InteractionSecretStore,
		private readonly resolveDriver: (agentId: string) => AgentDriver | undefined,
		private readonly ttl: InteractionTTL = { ttlMs: 24 * 60 * 60 * 1000 },
	) {
		this.broker = new InteractionBroker(delegations);
	}

	/** In-process per-session lock: one active/waiting run per sessionHandle. */
	private acquireSession(sessionHandle: string, delegationId: string): boolean {
		if (this.activeRuns.has(sessionHandle)) return false;
		this.activeRuns.set(sessionHandle, delegationId);
		return true;
	}

	private releaseSession(sessionHandle: string, delegationId: string): void {
		if (this.activeRuns.get(sessionHandle) === delegationId) this.activeRuns.delete(sessionHandle);
	}

	async delegate(input: DelegateInput, ctx: InvocationContext): Promise<RuntimeOutcome> {
		const driver = this.resolveDriver(input.agentId);
		if (!driver) throw new Error(`agent not found or no driver: ${input.agentId}`);

		// 会话锁（H2 修复）：continue 必须确认目标 session 空闲（§1.3）。
		// 检查 + 占位必须是原子的：JS 单线程保证这里在同步段内完成，两个并发
		// continue 不会同时通过检查后各自 spawn。
		const knownSession = input.sessionHandle;
		if (knownSession) {
			if (this.activeRuns.has(knownSession)) {
				throw new SessionConflictError(knownSession);
			}
			// 先占位（值待 delegation 创建后更新），阻止并发的第二次 delegate。
			this.activeRuns.set(knownSession, "pending");
		}

		const delegation = await this.delegations.createDelegation({
			windowId: input.windowId,
			managerSessionId: input.managerSessionId,
			managerToolCallId: input.managerToolCallId,
			agentId: input.agentId,
			operation: input.mode,
			sessionHandle: knownSession,
		});
		if (knownSession) this.activeRuns.set(knownSession, delegation.id);

		const requestId = input.requestId ?? randomUUID();
		let sessionHandle = knownSession;
		try {
			const events =
				input.mode === "run" || !knownSession
					? driver.run({ message: input.message, requestId, options: input.options }, ctx)
					: driver.continue(
							{ message: input.message, requestId, sessionHandle: knownSession, options: input.options },
							ctx,
						);

			for await (const event of events) {
				const handled = await this.handleEvent(event, delegation, sessionHandle, ctx);
				if (handled.terminal) return handled.outcome;
				if (event.type === "started" && event.sessionHandle) {
					sessionHandle = event.sessionHandle;
					await this.delegations.updateDelegation(delegation.id, { sessionHandle });
				}
			}
		} catch (err) {
			if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
			else if (knownSession) this.activeRuns.delete(knownSession);
			throw err;
		}
		// 驱动没有产生边界事件（协议错误）。
		if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
		else if (knownSession) this.activeRuns.delete(knownSession);
		const failed: NormalizedResult = {
			agentId: input.agentId,
			status: "failed",
			errorCode: "no_boundary_event",
			error: "worker 未返回边界事件（completed/failed/needs_input）",
			recoverable: false,
		};
		await this.delegations.updateDelegation(delegation.id, { status: "failed", result: failed });
		return { status: "failed", result: failed, delegation };
	}

	/**
	 * 消费一个 AgentEvent 并推进 delegation/interaction 状态。
	 * 返回 terminal=true 时调用方应停止迭代。
	 */
	private async handleEvent(
		event: AgentEvent,
		delegation: DelegationRecord,
		sessionHandle: string | undefined,
		ctx: InvocationContext,
	): Promise<{ terminal: boolean; outcome: RuntimeOutcome }> {
		switch (event.type) {
			case "started": {
				const patch: Partial<DelegationRecord> = {};
				if (event.runHandle) patch.runHandle = event.runHandle;
				if (event.sessionHandle) patch.sessionHandle = event.sessionHandle;
				if (Object.keys(patch).length) await this.delegations.updateDelegation(delegation.id, patch);
				// 记录 run 锁（若 driver 给出 sessionHandle）。
				if (event.sessionHandle && !this.activeRuns.has(event.sessionHandle)) {
					this.activeRuns.set(event.sessionHandle, delegation.id);
				}
				return { terminal: false, outcome: undefined as unknown as RuntimeOutcome };
			}
			case "progress": {
				ctx.onUpdate?.(event.message, { running: true });
				return { terminal: false, outcome: undefined as unknown as RuntimeOutcome };
			}
			case "input_required": {
				const interaction = await this.persistInteraction(delegation, event.result, event.providerState);
				// C1/H1：runHandle/sessionHandle 只可能出现在 boundary result 里
				// （真实 driver 的 started 事件不带这些），必须从这里落盘，否则
				// respond 无 runHandle、续接无 sessionHandle。
				const effectiveRun = event.result.runHandle ?? delegation.runHandle;
				const effectiveSession = event.result.sessionHandle ?? sessionHandle ?? delegation.sessionHandle;
				const updated = await this.delegations.updateDelegation(delegation.id, {
					status: "waiting_input",
					revision: (delegation.revision ?? 0) + 1,
					sessionHandle: effectiveSession,
					runHandle: effectiveRun,
					result: undefined,
				});
				if (effectiveSession) this.activeRuns.set(effectiveSession, delegation.id);
				return {
					terminal: true,
					outcome: {
						status: "needs_input",
						result: event.result,
						delegation: updated!,
						interaction,
					},
				};
			}
			case "completed": {
				// H1：优先采用 boundary result 的 sessionHandle（run 模式 started
				// 不带 session），否则续接会丢失 worker session。
				const effectiveSession = event.result.sessionHandle ?? sessionHandle ?? delegation.sessionHandle;
				await this.delegations.updateDelegation(delegation.id, {
					status: "completed",
					sessionHandle: effectiveSession,
					runHandle: event.result.runHandle ?? delegation.runHandle,
					revision: (delegation.revision ?? 0) + 1,
					result: event.result,
				});
				if (effectiveSession) this.releaseSession(effectiveSession, delegation.id);
				return { terminal: true, outcome: { status: "completed", result: event.result, delegation } };
			}
			case "failed": {
				// H1：采用 boundary result 的 sessionHandle，避免 run 模式丢 session。
				const effectiveSession = event.result.sessionHandle ?? sessionHandle ?? delegation.sessionHandle;
				await this.delegations.updateDelegation(delegation.id, {
					status: event.result.status === "cancelled" ? "cancelled" : "failed",
					sessionHandle: effectiveSession,
					runHandle: event.result.runHandle ?? delegation.runHandle,
					revision: (delegation.revision ?? 0) + 1,
					result: event.result,
				});
				if (effectiveSession) this.releaseSession(effectiveSession, delegation.id);
				return {
					terminal: true,
					outcome: { status: "failed", result: event.result, delegation },
				};
			}
		}
	}

	/** 保存 pending interaction：公开记录 + 加密 provider state。 */
	private async persistInteraction(
		delegation: DelegationRecord,
		needs: NeedsInputResult,
		providerState?: Record<string, unknown>,
	): Promise<InteractionRecord> {
		// needs.interaction.id 是本地占位，真实句柄在 driver 的私有字段里。
		const interaction = await this.delegations.createInteraction({
			delegationId: delegation.id,
			kind: needs.interaction.kind,
			requests: needs.interaction.requests,
			providerStateRef: `${delegation.id}/${needs.interaction.id || "main"}`,
			expiresAt: needs.interaction.expiresAt ?? new Date(Date.now() + this.ttl.ttlMs).toISOString(),
		});
		// 加密存 provider state（决策 4）：token 永不出 Runtime 落盘边界。
		await this.secrets.setProviderState(interaction.id, {
			delegationId: delegation.id,
			agentId: delegation.agentId,
			runHandle: delegation.runHandle,
			needsId: needs.interaction.id,
			...providerState,
		});
		return interaction;
	}

	/** 恢复 provider state（仅 Runtime 内部使用，token 永不出 Runtime）。 */
	private async providerStateOf(interactionId: string): Promise<Record<string, unknown> | undefined> {
		return this.secrets.getProviderState(interactionId);
	}

	/**
	 * 提交审批：校验通过后调用 Driver.respond 恢复同一条 Run。
	 * 若再次 needs_input：更新同一 interaction 的 revision。
	 */
	async respond(
		interactionId: string,
		input: { requestId: string; revision: number; responses: InteractionResponse[] },
		ctx: InvocationContext,
	): Promise<RespondOutcome> {
		const interaction = await this.delegations.getInteraction(interactionId);
		if (!interaction) throw new InteractionError("not_found", "interaction not found");
		const delegation = await this.delegations.getDelegation(interaction.delegationId);
		if (!delegation) throw new InteractionError("not_found", "delegation not found");

		// M3：同一 interaction 同时在飞（双签 / 两个标签页）时，拒绝第二次调用，
		// 绝不并发调 driver.respond。
		if (this.responding.has(interactionId)) {
			return {
				status: "failed",
				result: { agentId: delegation.agentId, status: "failed", errorCode: "responding", error: "该审批正在处理中，请稍候", recoverable: true },
				delegation,
				interaction,
			};
		}

		const driver = this.resolveDriver(delegation.agentId);
		if (!driver) throw new InteractionError("not_found", `no driver for agent ${delegation.agentId}`);
		if (!driver.respond) {
			throw new InteractionError("not_pending", `agent ${delegation.agentId} does not support respond`);
		}

		// 幂等检查 + 校验。
		const { interaction: approved, replayed } = await this.broker.submit(interactionId, input);
		if (replayed) {
			// 幂等重放：已经消费过，返回当前终态，不再次调用 driver。
			const existing = await this.delegations.getDelegation(interaction.delegationId);
			return {
				status: existing?.status === "completed" ? "completed" : existing?.status === "cancelled" ? "rejected" : "failed",
				result: existing?.result ?? { agentId: delegation.agentId, status: "failed", errorCode: "no_state", error: "无状态", recoverable: false },
				delegation: existing ?? delegation,
				interaction: approved,
			};
		}
		if (approved.status === "approved" || approved.status === "rejected") {
			// 请求被拒绝：Delegation 标记 cancelled，不再调用 driver。
			if (approved.status === "rejected") {
				const updated = await this.broker.advanceDelegation(approved);
				return {
					status: "rejected",
					result: {
						agentId: delegation.agentId,
						status: "cancelled",
						errorCode: "rejected",
						error: "审批被拒绝",
						recoverable: true,
					},
					delegation: updated ?? delegation,
					interaction: approved,
				};
			}
		} else {
			// 状态既不是 pending 也不是终态——异常路径。
			return {
				status: "failed",
				result: { agentId: delegation.agentId, status: "failed", errorCode: "unexpected_state", error: `interaction is ${approved.status}`, recoverable: false },
				delegation,
				interaction: approved,
			};
		}

		// approved：调用 driver.respond 恢复原 Run。
		const providerState = await this.providerStateOf(interactionId);
		const runHandle = delegation.runHandle ?? "";
		if (!runHandle) {
			throw new InteractionError("not_found", `delegation ${delegation.id} has no runHandle`);
		}

		const invocationCtx: InvocationContext = {
			...ctx,
			onUpdate: ctx.onUpdate,
		};
		// Driver 需要 continuation token；PuddingClawDriver 在构造时持有，这里把
		// provider state 透传为 respond 的私有字段（Runtime 不接触明文）。
		invocationCtx.providerState = providerState;

		let sessionHandle = delegation.sessionHandle;
		this.responding.add(interactionId);
		try {
			for await (const event of driver.respond!(
				{
					runHandle,
					interactionHandle: providerState?.continuation_token ? String(providerState.continuation_token) : interactionId,
					requestId: input.requestId,
					responses: input.responses,
				},
				invocationCtx,
			)) {
				const outcome = await this.respondEvent(event, interaction, delegation, sessionHandle, invocationCtx);
				if (outcome.terminal) return outcome.outcome;
				if (event.type === "started" && event.sessionHandle) sessionHandle = event.sessionHandle;
			}
		} catch (err) {
			if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
			throw err;
		} finally {
			this.responding.delete(interactionId);
		}
		return {
			status: "failed",
			result: { agentId: delegation.agentId, status: "failed", errorCode: "no_boundary_event", error: "respond 无边界事件", recoverable: false },
			delegation,
			interaction,
		};
	}

	private async respondEvent(
		event: AgentEvent,
		interaction: InteractionRecord,
		delegation: DelegationRecord,
		sessionHandle: string | undefined,
		ctx: InvocationContext,
	): Promise<{ terminal: boolean; outcome: RespondOutcome }> {
		switch (event.type) {
			case "progress":
				ctx.onUpdate?.(event.message, { running: true });
				return { terminal: false, outcome: undefined as unknown as RespondOutcome };
			case "completed": {
				const updated = await this.delegations.updateDelegation(delegation.id, {
					status: "completed",
					revision: (delegation.revision ?? 0) + 1,
					sessionHandle,
					result: event.result,
				});
				await this.secrets.removeProviderState(interaction.id);
				await this.delegations.updateInteraction(interaction.id, { status: "approved" });
				if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
				return {
					terminal: true,
					outcome: { status: "completed", result: event.result, delegation: updated ?? delegation, interaction },
				};
			}
			case "failed": {
				const updated = await this.delegations.updateDelegation(delegation.id, {
					status: event.result.status === "cancelled" ? "cancelled" : "failed",
					revision: (delegation.revision ?? 0) + 1,
					result: event.result,
				});
				await this.secrets.removeProviderState(interaction.id);
				await this.delegations.updateInteraction(interaction.id, { status: "failed" });
				if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
				return {
					terminal: true,
					outcome: { status: "failed", result: event.result, delegation: updated ?? delegation, interaction },
				};
			}
			case "input_required": {
				// 再次需要输入：更新同一 interaction 的 request 集合，保持 pending，
				// 并刷新加密 provider state（新 continuation token）。
				const updated = await this.delegations.updateInteraction(interaction.id, {
					status: "pending",
					revision: interaction.revision + 1,
					requests: event.result.interaction.requests,
					// L1：回到 pending 必须清掉 consumedRequestId，否则第二轮提交
					// 复用同一 requestId 会被误判为幂等重放。
					consumedRequestId: undefined,
				});
				if (event.providerState) {
					await this.secrets.setProviderState(interaction.id, {
						delegationId: delegation.id,
						agentId: delegation.agentId,
						runHandle: delegation.runHandle ?? event.result.runHandle,
						needsId: event.result.interaction.id,
						...event.providerState,
					});
				}
				await this.delegations.updateDelegation(delegation.id, { status: "waiting_input" });
				return {
					terminal: true,
					outcome: {
						status: "needs_input",
						result: event.result,
						delegation,
						interaction: updated ?? interaction,
					},
				};
			}
			case "started":
				return { terminal: false, outcome: undefined as unknown as RespondOutcome };
		}
	}

	/** 取消当前 Run（不删除 Session）。M4：同时清理 pending interaction 与
	 * 加密 continuation token，否则审批卡永远 pending、token 遗留磁盘。 */
	async cancel(delegationId: string, ctx: InvocationContext): Promise<void> {
		const delegation = await this.delegations.getDelegation(delegationId);
		if (!delegation) throw new Error("delegation not found");
		const driver = this.resolveDriver(delegation.agentId);
		if (!driver) throw new Error(`no driver for agent ${delegation.agentId}`);
		if (driver.cancel && delegation.runHandle) {
			await driver.cancel({ runHandle: delegation.runHandle }, ctx);
		}
		await this.delegations.updateDelegation(delegationId, { status: "cancelled" });
		// 清理该 delegation 名下所有 pending interactions 及其加密 token。
		for (const interaction of await this.delegations.listInteractions()) {
			if (interaction.delegationId !== delegationId) continue;
			if (interaction.status === "pending" || interaction.status === "responding") {
				await this.delegations.updateInteraction(interaction.id, { status: "expired" });
			}
			await this.secrets.removeProviderState(interaction.id).catch(() => undefined);
		}
		if (delegation.sessionHandle) this.releaseSession(delegation.sessionHandle, delegationId);
	}

	/** 校验当前 Session 是否可发起新 Run（锁 + 状态）。 */
	async canDelegate(sessionHandle: string): Promise<{ ok: boolean; reason?: string }> {
		if (this.activeRuns.has(sessionHandle)) {
			return { ok: false, reason: "Session already has an active Run or pending input (409)" };
		}
		return { ok: true };
	}

	async listDelegations(windowId?: string, managerSessionId?: string): Promise<DelegationRecord[]> {
		return this.delegations.listDelegations(windowId, managerSessionId);
	}

	/** 列出窗口下的 interactions（审批卡列表对账，H3）。 */
	async listInteractions(windowId?: string): Promise<InteractionRecord[]> {
		return this.delegations.listInteractions(windowId);
	}

	/** 按 interaction id 查（审批卡刷新/对账）。 */
	async getInteraction(id: string): Promise<InteractionRecord | undefined> {
		return this.delegations.getInteraction(id);
	}

	async getDelegation(id: string): Promise<DelegationRecord | undefined> {
		return this.delegations.getDelegation(id);
	}

	/** 按 interaction id 反查 delegation（H3/H5）。 */
	async getDelegationById(id: string): Promise<DelegationRecord | undefined> {
		const interaction = await this.delegations.getInteraction(id);
		if (!interaction) return undefined;
		return this.delegations.getDelegation(interaction.delegationId);
	}
}
