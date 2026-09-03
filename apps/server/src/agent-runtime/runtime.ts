import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DelegationStore, type DelegationRecord, type InteractionRecord } from "./delegation-store.js";
import {
	sealExecutionReceipt,
	type ArtifactCaptureResult,
	type ExecutionReceipt,
	type ExecutionState,
} from "./execution-receipt.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { InteractionBroker, InteractionError } from "./interaction-broker.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { DelegationTimelineStore } from "./delegation-timeline-store.js";
import {
	WorkspaceExecutionCoordinator,
	type WorkspaceChangeSet,
	type StandaloneVerificationEnvironment,
	type VerificationEnvironmentCopy,
	type VerificationEnvironmentObservation,
	type WorkspaceExecutionPolicy,
} from "./workspace-execution.js";
import type {
	AgentDriver,
	AgentEvent,
	AgentOperation,
	DriverCapabilities,
	InvocationContext,
	InteractionResponse,
	NeedsInputResult,
	NormalizedResult,
	WorkerActivity,
} from "./types.js";
import { redactText, redactValue } from "./redaction.js";

export interface DelegateInput {
	windowId: string;
	workspaceId?: string;
	cwdSnapshot: string;
	managerSessionId: string;
	managerToolCallId?: string;
	contractHash?: string;
	purpose?: "execution" | "verification";
	verificationId?: string;
	verifiesSubmissionId?: string;
	environmentProfileId?: string;
	verificationEnvironmentId?: string;
	goalId?: string;
	workPlanId?: string;
	workItemId?: string;
	attempt?: number;
	goalEpoch?: number;
	goalRevision?: number;
	workItemRevision?: number;
	parentDelegationId?: string;
	handoffKind?: "request" | "followup";
	intent?: string;
	expectedOutcome?: string;
	evidenceRequirements?: string[];
	completionBoundary?: string;
	agentId: string;
	agentRevision: number;
	message: string;
	/** "run" 新开 worker session；"continue" 续接 window 记录的 session。 */
	mode: "run" | "continue";
	sessionHandle?: string;
	options?: Record<string, unknown>;
	requestId?: string;
	workspaceExecutionScopeId?: string;
	workspaceChangeSetId?: string;
	workspaceExecutionPolicy?: WorkspaceExecutionPolicy;
	/** Internal lifecycle hook: fires only after the immutable Run record exists. */
	onCreated?: (delegation: DelegationRecord) => void;
	/** Fires after the Driver produces its first event; platform admission uses this as the honest start boundary. */
	onDriverStarted?: (delegation: DelegationRecord) => void;
	/** Durable external gate evaluated after Delegation creation but before Driver invocation. */
	beforeDriverStart?: (delegation: DelegationRecord) => Promise<void>;
	/** Driver resolved from the same immutable Agent snapshot as agentRevision. */
	driver?: AgentDriver;
	/** Internal resume path for a platform-policy Interaction; never accepted from Manager prompts. */
	resumeDelegationId?: string;
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

/** 失效会话失败的特征：worker 报 session 不存在（后端删 session/换实例/CLI 世代
 * 替换都会触发，平台无需区分原因）。只匹配明确措辞，不误吞普通执行失败。 */
const STALE_SESSION_PATTERN = /session[^\n]*not found/i;
function isStaleSessionFailure(event: AgentEvent): boolean {
	return event.type === "failed" && typeof event.result.error === "string" && STALE_SESSION_PATTERN.test(event.result.error);
}

function capabilityFingerprint(agentRevision: number, driverId: string, capabilities: DriverCapabilities): string {
	return `sha256:${createHash("sha256").update(JSON.stringify({
		agentRevision,
		driverId,
		transport: capabilities.transport,
		workspace: capabilities.workspace ?? null,
		interactionKinds: [...capabilities.interactionKinds].sort(),
		operations: [...capabilities.operations].sort(),
	})).digest("hex")}`;
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
	/** 活 Run 的 delegationId 集合。activeRuns 以 sessionHandle 为键，无会话句柄
	 *  的 driver（如 puddingclaw 一次性 CLI run，started 事件不带 sessionHandle）
	 *  永远不会登记进 activeRuns；isDelegationActive 必须以本集合为准，否则
	 *  前端历史重放会把在跑的委托误标「已中断」。 */
	private readonly activeDelegations = new Set<string>();
	/** Active subprocess/stream cancellation owned by the Runtime, not HTTP. */
	private readonly runControllers = new Map<string, AbortController>();
	private readonly runSettled = new Map<string, Promise<void>>();
	private readonly transitionQueues = new Map<string, Promise<unknown>>();
	/** 同一远端 Delegation 同时只能有一条 reattach 流。 */
	private readonly reattachInFlight = new Set<string>();
	/** 正在执行的 respond（per-interaction 防并发，M3）。 */
	private readonly responding = new Set<string>();
	private readonly broker: InteractionBroker;

	constructor(
		private readonly delegations: DelegationStore,
		private readonly secrets: InteractionSecretStore,
		private readonly resolveDriver: (agentId: string) => AgentDriver | undefined | Promise<AgentDriver | undefined>,
		private readonly ttl: InteractionTTL = { ttlMs: 24 * 60 * 60 * 1000 },
		/** §15.6 交付物登记（可选；push/observe 无差别，缺省不登记）。 */
		private readonly artifacts?: ArtifactStore,
		/** Append-only worker activity timeline (optional in isolated tests). */
		private readonly timeline?: DelegationTimelineStore,
		private readonly workspaceExecution?: WorkspaceExecutionCoordinator,
	) {
		this.broker = new InteractionBroker(delegations);
	}

	private activityFromUpdate(agentId: string, content: string, details: unknown): WorkerActivity {
		const candidate = details && typeof details === "object"
			? (details as { activity?: Partial<WorkerActivity> }).activity
			: undefined;
		if (candidate && typeof candidate === "object") {
			return {
				source: typeof candidate.source === "string" && candidate.source ? candidate.source : agentId,
				sourceEvent: typeof candidate.sourceEvent === "string" && candidate.sourceEvent ? candidate.sourceEvent : "progress",
				kind: candidate.kind ?? "lifecycle",
				status: candidate.status ?? "running",
				title: typeof candidate.title === "string" && candidate.title ? candidate.title : content,
				...(typeof candidate.content === "string" ? { content: candidate.content } : {}),
				...(typeof candidate.itemId === "string" ? { itemId: candidate.itemId } : {}),
				...(typeof candidate.sourceSeq === "number" ? { sourceSeq: candidate.sourceSeq } : {}),
				...(candidate.metadata && typeof candidate.metadata === "object" ? { metadata: candidate.metadata } : {}),
			};
		}
		return {
			source: agentId,
			sourceEvent: "runtime.progress",
			kind: "lifecycle",
			status: "running",
			title: content,
		};
	}

	private timelineContext(ctx: InvocationContext, delegation: DelegationRecord): InvocationContext {
		return {
			...ctx,
			onUpdate: (content, details) => {
				const publicContent = redactText(content);
				const safeDetails = redactValue(details);
				if (this.timeline) {
					void this.timeline
						.append(delegation.id, this.activityFromUpdate(delegation.agentId, publicContent, safeDetails))
						.catch(() => undefined);
				}
				const publicDetails = safeDetails && typeof safeDetails === "object"
					? { ...(safeDetails as Record<string, unknown>), delegationId: delegation.id }
					: { delegationId: delegation.id };
				ctx.onUpdate?.(publicContent, publicDetails);
			},
		};
	}

	private async recordBoundary(delegation: DelegationRecord, event: AgentEvent): Promise<void> {
		if (!this.timeline) return;
		let activity: WorkerActivity | undefined;
		if (event.type === "input_required") {
			activity = {
				source: delegation.agentId,
				sourceEvent: "runtime.input_required",
				kind: "approval",
				status: "waiting",
				title: "等待人工处理",
				metadata: { interactionKind: event.result.interaction.kind },
			};
		} else if (event.type === "completed") {
			activity = {
				source: delegation.agentId,
				sourceEvent: "runtime.completed",
				kind: "lifecycle",
				status: "completed",
				title: "Worker 已报告完成",
			};
		} else if (event.type === "failed") {
			activity = {
				source: delegation.agentId,
				sourceEvent: "runtime.failed",
				kind: event.result.status === "cancelled" ? "lifecycle" : "error",
				status: event.result.status === "cancelled" ? "completed" : "failed",
				title: event.result.status === "cancelled" ? "任务已取消" : "任务执行失败",
				content: event.result.error,
				metadata: { errorCode: event.result.errorCode, resultStatus: event.result.status },
			};
		}
		if (activity) await this.timeline.append(delegation.id, activity).catch(() => undefined);
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

	private trackRun(delegationId: string): () => void {
		let resolve!: () => void;
		const settled = new Promise<void>((done) => {
			resolve = done;
		});
		this.runSettled.set(delegationId, settled);
		return () => {
			resolve();
			if (this.runSettled.get(delegationId) === settled) this.runSettled.delete(delegationId);
		};
	}

	/** A recovered upstream observation is also an honest Worker-start boundary. */
	private async markRecoveredWorkerStarted(delegation: DelegationRecord): Promise<DelegationRecord> {
		if (delegation.workerStarted) return delegation;
		const marked = await this.delegations.transitionDelegation(delegation.id, [delegation.executionState], {
			executionState: delegation.executionState,
			workerStarted: true,
			revision: delegation.revision + 1,
		});
		if (marked.applied && marked.record) return marked.record;
		// Preserve the caller's original allowed-state fence when another lifecycle
		// transition won the race. Reusing a newer terminal record here could make a
		// stale recovery observation attempt to reseal an immutable Receipt.
		if (marked.record?.executionState === delegation.executionState && marked.record.workerStarted && !marked.record.receipt) {
			return marked.record;
		}
		return delegation;
	}

	private withDelegationTransition<T>(delegationId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.transitionQueues.get(delegationId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.transitionQueues.set(delegationId, tail);
		void tail.finally(() => {
			if (this.transitionQueues.get(delegationId) === tail) this.transitionQueues.delete(delegationId);
		});
		return run;
	}

	private conflictResult(record: DelegationRecord): NormalizedResult {
		if (record.result) return record.result;
		return {
			agentId: record.agentId,
			status: "failed",
			errorCode: "state_conflict",
			error: `Run 状态已推进到 ${record.executionState}，当前边界事件未写入权威状态`,
			recoverable: record.executionState !== "observation_lost",
		};
	}

	/**
	 * An aborted consumer stream is a cancellation observation, not a Driver
	 * failure boundary. Local transports end with this iterator; remote transports
	 * remain effect-unknown unless their own cancel/reconcile protocol confirms a
	 * terminal state.
	 */
	private async settleAbortedDriverStream(
		delegation: DelegationRecord,
		agentId: string,
		ctx: InvocationContext,
	): Promise<{ result: Exclude<NormalizedResult, NeedsInputResult>; delegation: DelegationRecord }> {
		const requested = await this.withDelegationTransition(delegation.id, async () => {
			const current = await this.delegations.getDelegation(delegation.id);
			if (!current || !["running", "reconciling"].includes(current.executionState)) return { record: current, applied: false };
			return this.delegations.transitionDelegation(delegation.id, ["running", "reconciling"], {
				executionState: "cancel_requested",
				revision: current.revision + 1,
			});
		});
		let current = requested.record ?? await this.delegations.getDelegation(delegation.id);
		const localLifecycle = delegation.driverTransport === "spawn" || delegation.driverTransport === "sdk" || delegation.driverTransport === undefined;
		let result: Exclude<NormalizedResult, NeedsInputResult>;
		if (current?.executionState === "cancel_requested" && localLifecycle) {
			result = {
				agentId,
				status: "cancelled",
				errorCode: "cancelled",
				error: "Manager 已停止等待，本地执行流已确认退出",
				recoverable: true,
			};
			const sealed = await this.withDelegationTransition(delegation.id, () =>
				this.sealTerminal(current!, ["cancel_requested"], "cancelled", result, ctx),
			);
			current = sealed.record ?? current;
			if (sealed.applied) await this.recordBoundary(delegation, { type: "failed", result });
		} else if (current?.executionState === "cancel_requested") {
			result = {
				agentId,
				status: "failed",
				errorCode: "observation_lost",
				error: "Manager 已停止等待，但远端执行是否停止无法确认",
				recoverable: true,
			};
			const lost = await this.withDelegationTransition(delegation.id, () =>
				this.delegations.transitionDelegation(delegation.id, ["cancel_requested"], {
					executionState: "observation_lost",
					revision: current!.revision + 1,
				}),
			);
			current = lost.record ?? current;
			if (lost.applied && this.workspaceExecution && current?.workspaceExecutionScopeId) {
				const scope = await this.workspaceExecution.get(current.workspaceExecutionScopeId);
				await this.workspaceExecution.fence(current.workspaceExecutionScopeId, scope?.ownerToken).catch(() => undefined);
			}
		} else {
			const stored = current?.result;
			result = stored && stored.status !== "needs_input"
				? stored
				: { agentId, status: "failed", errorCode: "cancel_pending", error: "取消状态正在收敛", recoverable: true };
		}
		return { result, delegation: current ?? delegation };
	}

	async delegate(input: DelegateInput, ctx: InvocationContext): Promise<RuntimeOutcome> {
		const driver = input.driver ?? (await this.resolveDriver(input.agentId));
		if (!driver) throw new Error(`agent not found or no driver: ${input.agentId}`);
		const driverCapabilities = await driver.capabilities();
		const requestId = input.requestId ?? randomUUID();
		const fingerprint = capabilityFingerprint(input.agentRevision, driver.id, driverCapabilities);
		if (input.purpose === "verification" && input.verificationEnvironmentId && driverCapabilities.transport !== "spawn" && driverCapabilities.transport !== "sdk") {
			throw new Error("首期 environment_verified 只允许本地 spawn/sdk Driver；远端协议尚不能证明签发环境绑定");
		}

		const knownSession = input.sessionHandle;
		let verificationEnvironment: VerificationEnvironmentCopy | undefined;
		if (input.verificationEnvironmentId) {
			if (input.purpose !== "verification" || !input.verificationId) throw new Error("verificationEnvironmentId 只允许绑定明确的 verification purpose");
			if (!this.workspaceExecution) throw new Error("WorkspaceExecutionCoordinator 未启用");
			verificationEnvironment = await this.workspaceExecution.resolveVerificationTarget(input.verificationEnvironmentId, input.verificationId);
		}

		// 所有可能失败的环境预检完成后再占 Session；否则非法环境会留下
		// 没有 Delegation 对应的 pending 锁。
		if (knownSession) {
			if (this.activeRuns.has(knownSession)) throw new SessionConflictError(knownSession);
			this.activeRuns.set(knownSession, "pending");
		}
		let delegation: DelegationRecord;
		try {
			if (input.resumeDelegationId) {
				const existing = await this.delegations.getDelegation(input.resumeDelegationId);
				if (!existing || existing.executionState !== "admitted") throw new Error("admission Delegation 已失效，不能启动");
				if (existing.agentId !== input.agentId || existing.operationId !== requestId) throw new Error("admission Delegation 身份不匹配");
				if (existing.capabilityFingerprint !== fingerprint) throw new Error("Worker 能力已变化，需要重新准入评估");
				delegation = existing;
			} else delegation = await this.delegations.createDelegation({
				operationId: requestId,
			contractHash: input.contractHash,
			windowId: input.windowId,
			workspaceId: input.workspaceId,
			cwdSnapshot: input.cwdSnapshot,
			managerSessionId: input.managerSessionId,
			managerToolCallId: input.managerToolCallId,
			purpose: input.purpose ?? "execution",
			verificationId: input.verificationId,
			verifiesSubmissionId: input.verifiesSubmissionId,
			environmentProfileId: input.environmentProfileId,
			verificationEnvironmentId: input.verificationEnvironmentId,
			goalId: input.goalId,
			workPlanId: input.workPlanId,
			workItemId: input.workItemId,
			attempt: input.attempt,
			goalEpoch: input.goalEpoch,
			goalRevision: input.goalRevision,
			workItemRevision: input.workItemRevision,
			parentDelegationId: input.parentDelegationId,
			handoffKind: input.handoffKind,
			task: input.message,
			intent: input.intent,
			expectedOutcome: input.expectedOutcome,
			evidenceRequirements: input.evidenceRequirements,
			completionBoundary: input.completionBoundary,
			agentId: input.agentId,
			agentRevision: input.agentRevision,
				driverId: driver.id,
				driverTransport: driverCapabilities.transport,
				workspaceCapabilities: driverCapabilities.workspace,
				capabilityFingerprint: fingerprint,
				readOnlyAssessment: input.workspaceExecutionPolicy?.mode === "read_only_shared"
					? driverCapabilities.workspace?.readOnlyEnforcement === "sandbox" || driverCapabilities.workspace?.readOnlyEnforcement === "remote_policy"
						? "verified"
						: undefined
					: "not_required",
				operation: input.mode,
				sessionHandle: knownSession,
				options: input.options,
			workspaceExecutionScopeId: input.workspaceExecutionScopeId,
			workspaceChangeSetId: input.workspaceChangeSetId,
			workspaceExecutionPolicy: input.workspaceExecutionPolicy,
				executionCwd: verificationEnvironment?.executionCwd,
			});
		} catch (error) {
			if (knownSession && this.activeRuns.get(knownSession) === "pending") this.activeRuns.delete(knownSession);
			throw error;
		}
		const readOnlyRequired = input.workspaceExecutionPolicy?.mode === "read_only_shared";
		const readOnlyEnforced = driverCapabilities.workspace?.readOnlyEnforcement === "sandbox"
			|| driverCapabilities.workspace?.readOnlyEnforcement === "remote_policy";
		if (readOnlyRequired && !readOnlyEnforced && delegation.readOnlyAssessment !== "unverified_user_accepted") {
			const requestId = `admission:${delegation.id}`;
			const interaction = await this.delegations.createInteraction({
				delegationId: delegation.id,
				source: "platform_policy",
				kind: "confirmation",
				requests: [{
					requestId,
					prompt: `Teams 无法验证 Worker「${delegation.agentId}」会保持只读。是否仍允许 Teams 使用这个 Worker 执行本任务？`,
					risk: "继续只代表 Teams 准入该 Worker，不会修改 Worker 权限；若产生文件变更，仍按原任务契约记录偏差。",
					options: ["proceed_with_worker", "select_another_worker"],
				}],
				policyContext: {
					reasonCode: "read_only_not_enforceable",
					capabilityFingerprint: fingerprint,
					allowedActions: ["cancel", "proceed_with_worker", "select_another_worker"],
					workerStarted: false,
				},
				expiresAt: new Date(Date.now() + this.ttl.ttlMs).toISOString(),
			});
			const waiting = await this.delegations.transitionDelegation(delegation.id, ["admitted"], {
				executionState: "waiting_admission",
				admissionInteractionId: interaction.id,
				revision: delegation.revision + 1,
			});
			delegation = waiting.record ?? delegation;
			if (knownSession && this.activeRuns.get(knownSession) === "pending") this.activeRuns.delete(knownSession);
			input.onCreated?.(delegation);
			const result: NeedsInputResult = {
				agentId: delegation.agentId,
				status: "needs_input",
				interaction: {
					id: interaction.id,
					kind: interaction.kind,
					requests: interaction.requests,
					expiresAt: interaction.expiresAt,
				},
				meta: { source: "platform_policy", workerStarted: false },
			};
			return { status: "needs_input", result, delegation, interaction };
		}
		if (this.workspaceExecution && input.workspaceExecutionPolicy && !verificationEnvironment) {
			try {
				const inheritedScopeId = input.workspaceExecutionScopeId
					?? (input.parentDelegationId ? (await this.delegations.getDelegation(input.parentDelegationId))?.workspaceExecutionScopeId : undefined);
				const inherited = inheritedScopeId ? await this.workspaceExecution.get(inheritedScopeId) : undefined;
				let mode = input.workspaceExecutionPolicy.mode;
				const readOnlyEnforcement = driverCapabilities.workspace?.readOnlyEnforcement === "sandbox" || driverCapabilities.workspace?.readOnlyEnforcement === "remote_policy"
					? "strong" as const
					: "none" as const;
				if (mode === "read_only_shared" && readOnlyEnforcement === "none") {
					if (delegation.readOnlyAssessment !== "unverified_user_accepted") throw new Error("Worker 只读能力未验证，且尚未获得 Teams 准入决定");
					// Conservative coordination only: acquire the target Workspace lease.
					// This does not grant or change Worker permissions.
					mode = "exclusive_write";
				}
				if (mode === "exclusive_write") {
					const blocking = await this.workspaceExecution.getBlockingScope(input.workspaceId, input.cwdSnapshot);
					if (blocking) {
						const owners = await Promise.all(blocking.delegationIds.map((id) => this.delegations.getDelegation(id)));
						const terminal = owners.length > 0 && owners.every((owner) => owner !== undefined && ["reported_completed", "reported_failed", "cancelled"].includes(owner.executionState));
						if (terminal) {
							// Safe lazy migration for leases retained by older runtimes: every
							// owning Driver already has a durable terminal observation, so no
							// upstream writer can still be active.
							await this.workspaceExecution.release(blocking.id, {
								ownerToken: blocking.ownerToken,
								allowFenced: true,
								cleanup: false,
							});
						}
					}
				}
				if (mode === "isolated_worktree" && driverCapabilities.workspace?.honorsInvocationCwd !== true) throw new Error("Connector 不保证使用平台注入 cwd，不能进入隔离 worktree");
				const scope = await this.workspaceExecution.begin({
					workspacePath: input.cwdSnapshot,
					workspaceId: input.workspaceId,
					mode,
					delegationId: delegation.id,
					goalId: input.goalId,
					goalEpoch: input.goalEpoch,
					executionScopeId: inheritedScopeId,
					ownerToken: inherited?.ownerToken,
					readOnlyEnforcement,
				});
				delegation = (await this.delegations.updateDelegation(delegation.id, {
					workspaceExecutionPolicy: input.workspaceExecutionPolicy,
					workspaceExecutionScopeId: scope.id,
					executionCwd: scope.executionCwd,
				})) ?? delegation;
			} catch (error) {
				const blocked: Exclude<NormalizedResult, NeedsInputResult> = {
					agentId: input.agentId,
					status: "blocked",
					errorCode: "workspace_policy_blocked",
					error: error instanceof Error ? error.message : String(error),
					recoverable: true,
				};
				const terminal = await this.sealTerminal(delegation, ["admitted"], "reported_failed", blocked, { ...ctx, cwd: input.cwdSnapshot });
				if (knownSession) this.activeRuns.delete(knownSession);
				return { status: "failed", result: blocked, delegation: terminal.record ?? delegation };
			}
		}
		const started = await this.delegations.transitionDelegation(delegation.id, ["admitted"], {
			executionState: "running",
			revision: delegation.revision + 1,
		});
		if (!started.applied || !started.record) throw new Error(`Delegation ${delegation.id} 启动边界已失效`);
		delegation = started.record;
		if (input.beforeDriverStart) {
			try {
				await input.beforeDriverStart(delegation);
				delegation = (await this.delegations.updateDelegation(delegation.id, {
					replacementAdmissionReady: true,
				})) ?? delegation;
			} catch (error) {
				const blocked: Exclude<NormalizedResult, NeedsInputResult> = {
					agentId: input.agentId,
					status: "blocked",
					errorCode: "replacement_reservation_failed",
					error: error instanceof Error ? error.message : String(error),
					recoverable: true,
				};
				const terminal = await this.sealTerminal(delegation, ["running"], "reported_failed", blocked, { ...ctx, cwd: input.cwdSnapshot });
				if (knownSession) this.activeRuns.delete(knownSession);
				return { status: "failed", result: blocked, delegation: terminal.record ?? delegation };
			}
		}
		if (knownSession) this.activeRuns.set(knownSession, delegation.id);
		this.activeDelegations.add(delegation.id);
		input.onCreated?.(delegation);

		// delegationId 注入 ctx：Driver 据此生成 handoff 导出目录（§15.3）。
		const controller = new AbortController();
		this.runControllers.set(delegation.id, controller);
		const settleRun = this.trackRun(delegation.id);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const runCtx = this.timelineContext({
			...ctx,
			cwd: delegation.executionCwd ?? delegation.cwdSnapshot,
			workspaceBoundary: delegation.workspaceExecutionPolicy?.mode === "isolated_worktree"
				? "platform_isolated_checkout"
				: "workspace",
			delegationId: delegation.id,
			operationId: requestId,
			idempotencyKey: requestId,
			...(verificationEnvironment ? { verificationProfile: {
				profileId: input.environmentProfileId ?? "cli-verification-v1",
				environmentId: verificationEnvironment.id,
				sourceBinding: "goal_workspace" as const,
				executionRoot: verificationEnvironment.root,
				workspaceBoundary: verificationEnvironment.kind === "guarded_target" ? "platform_mutation_guard" as const : "platform_isolated_copy" as const,
				mutationPolicy: verificationEnvironment.kind === "guarded_target" ? "block_on_change" as const : "isolated_changes_only" as const,
				networkPolicy: "inherit_connector_policy" as const,
			} } : {}),
			...(delegation.workspaceId ? { workspaceId: delegation.workspaceId } : {}),
			signal,
		}, delegation);
		// The immutable delegation exists before the Driver starts. Surface its id
		// immediately so every running card (including external CLI workers that do
		// not expose a session/run handle yet) can offer precise cancellation.
		runCtx.onUpdate?.("worker 已接收任务，正在启动…", {
			running: true,
			delegationId: delegation.id,
			activity: {
				source: delegation.agentId,
				sourceEvent: "runtime.accepted",
				kind: "lifecycle",
				status: "started",
				title: "PuddingTeams 已接收任务",
			},
		});
		let sessionHandle = knownSession;
		// 失效会话恢复：continue 撞上 session-not-found（后端删 session/换实例/
		// 升级换代都会让旧 handle 失效，平台无法也无需区分原因）时，丢弃失效
		// handle 以新会话透明重跑一次，而不是把失败抛给上层让 manager 连环试错。
		let staleRetried = false;
		let workerStartObserved = delegation.workerStarted;
		const markWorkerStarted = async (notify = true): Promise<void> => {
			if (workerStartObserved) return;
			const current = await this.delegations.getDelegation(delegation.id);
			if (!current || current.executionState !== "running") return;
			const marked = await this.delegations.transitionDelegation(delegation.id, ["running"], {
				executionState: "running",
				workerStarted: true,
				revision: current.revision + 1,
			});
			if (!marked.applied || !marked.record) return;
			workerStartObserved = true;
			delegation = marked.record;
			if (notify) input.onDriverStarted?.(delegation);
		};
		const startRun = (fresh: boolean): AsyncIterable<AgentEvent> =>
			fresh || input.mode === "run" || !sessionHandle
				? driver.run({ message: input.message, requestId, options: input.options }, runCtx)
				: driver.continue(
						{ message: input.message, requestId, sessionHandle: sessionHandle!, options: input.options },
						runCtx,
					);
		try {
			let events = startRun(false);
			for (;;) {
				let restart = false;
				for await (const event of events) {
					await markWorkerStarted();
					if (!staleRetried && knownSession && input.mode !== "run" && isStaleSessionFailure(event)) {
						staleRetried = true;
						restart = true;
						this.releaseSession(sessionHandle ?? knownSession, delegation.id);
						this.activeRuns.delete(knownSession);
						sessionHandle = undefined;
						await this.delegations.updateDelegation(delegation.id, { sessionHandle: undefined });
						runCtx.onUpdate?.("worker 旧会话已失效，正在以新会话重试…", { running: true });
						events = startRun(true);
						break;
					}
					const handled = await this.handleEvent(event, delegation, sessionHandle, runCtx);
					if (handled.terminal) {
						this.runControllers.delete(delegation.id);
						// waiting_input（HITL 待审批）不算结束：Run 挂起待 respond，
						// 仍算活跃，否则审批期间前端会误标「已中断」。
						if (handled.outcome.status !== "needs_input") this.activeDelegations.delete(delegation.id);
						settleRun();
						return handled.outcome;
					}
					if (event.type === "started" && event.sessionHandle) {
						sessionHandle = event.sessionHandle;
						await this.delegations.updateDelegation(delegation.id, { sessionHandle });
						// 执行过程可视化：运行中的委托卡即可拿到 sessionHandle 入口。
						runCtx.onUpdate?.("worker 会话已就绪", {
							running: true,
							sessionHandle,
							delegationId: delegation.id,
						});
					}
				}
				if (!restart) break;
			}
		} catch (err) {
			if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
			else if (knownSession) this.activeRuns.delete(knownSession);
			if (ctx.signal?.aborted) {
				const interrupted = await this.settleAbortedDriverStream(delegation, input.agentId, runCtx);
				this.runControllers.delete(delegation.id);
				this.activeDelegations.delete(delegation.id);
				settleRun();
				return { status: "failed", result: interrupted.result, delegation: interrupted.delegation };
			}
			const cancelling = await this.delegations.getDelegation(delegation.id);
			if (cancelling?.executionState === "cancel_requested") {
				const pending: NormalizedResult = { agentId: input.agentId, status: "failed", errorCode: "cancel_pending", error: "取消请求正在等待执行面确认", recoverable: true };
				this.runControllers.delete(delegation.id);
				this.activeDelegations.delete(delegation.id);
				settleRun();
				return { status: "failed", result: pending, delegation: cancelling };
			}
			const failed: NormalizedResult = {
				agentId: input.agentId,
				status: "failed",
				errorCode: "driver_error",
				error: err instanceof Error ? err.message : String(err),
				recoverable: false,
			};
			const transition = await this.withDelegationTransition(delegation.id, () =>
				this.sealTerminal(delegation, ["running", "cancel_requested"], "reported_failed", failed, runCtx),
			);
			if (transition.applied) {
				await this.recordBoundary(delegation, { type: "failed", result: failed });
			}
			this.runControllers.delete(delegation.id);
			this.activeDelegations.delete(delegation.id);
			settleRun();
			if (!transition.applied && transition.record?.executionState === "cancelled") {
				const cancelled: NormalizedResult = { agentId: input.agentId, status: "cancelled", errorCode: "cancelled", error: "任务已取消", recoverable: true };
				return { status: "failed", result: cancelled, delegation: transition.record };
			}
			throw err;
		}
		// 驱动没有产生边界事件（协议错误）。
		await markWorkerStarted(false);
		if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
		else if (knownSession) this.activeRuns.delete(knownSession);
		if (ctx.signal?.aborted) {
			const interrupted = await this.settleAbortedDriverStream(delegation, input.agentId, runCtx);
			this.runControllers.delete(delegation.id);
			this.activeDelegations.delete(delegation.id);
			settleRun();
			return { status: "failed", result: interrupted.result, delegation: interrupted.delegation };
		}
		const cancelling = await this.delegations.getDelegation(delegation.id);
		if (cancelling?.executionState === "cancel_requested") {
			const pending: NormalizedResult = { agentId: input.agentId, status: "failed", errorCode: "cancel_pending", error: "取消请求正在等待执行面确认", recoverable: true };
			this.runControllers.delete(delegation.id);
			this.activeDelegations.delete(delegation.id);
			settleRun();
			return { status: "failed", result: pending, delegation: cancelling };
		}
		const failed: NormalizedResult = {
			agentId: input.agentId,
			status: "failed",
			errorCode: "no_boundary_event",
			error: "worker 未返回边界事件（completed/failed/needs_input）",
			recoverable: false,
		};
		const transition = await this.withDelegationTransition(delegation.id, () =>
			this.sealTerminal(delegation, ["running", "cancel_requested"], "reported_failed", failed, runCtx),
		);
		if (transition.applied) {
			await this.recordBoundary(delegation, { type: "failed", result: failed });
		}
		this.runControllers.delete(delegation.id);
		this.activeDelegations.delete(delegation.id);
		settleRun();
		if (!transition.applied && transition.record?.executionState === "cancelled") {
			const cancelled: NormalizedResult = { agentId: input.agentId, status: "cancelled", errorCode: "cancelled", error: "任务已取消", recoverable: true };
			return { status: "failed", result: cancelled, delegation: transition.record };
		}
		return { status: "failed", result: failed, delegation: transition.record ?? delegation };
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
		return this.withDelegationTransition(delegation.id, () =>
			this.handleEventUnlocked(event, delegation, sessionHandle, ctx),
		);
	}

	private async handleEventUnlocked(
		event: AgentEvent,
		delegation: DelegationRecord,
		sessionHandle: string | undefined,
		ctx: InvocationContext,
	): Promise<{ terminal: boolean; outcome: RuntimeOutcome }> {
		const current = await this.delegations.getDelegation(delegation.id);
		if (current?.executionState === "cancelled") {
			const effectiveSession = sessionHandle ?? current.sessionHandle;
			if (effectiveSession) this.releaseSession(effectiveSession, delegation.id);
			const result: NormalizedResult = {
				agentId: delegation.agentId,
				status: "cancelled",
				errorCode: "cancelled",
				error: "任务已取消",
				recoverable: true,
			};
			return { terminal: true, outcome: { status: "failed", result, delegation: current } };
		}
			switch (event.type) {
			case "started": {
				const patch = {
					executionState: "running" as const,
					revision: (current?.revision ?? delegation.revision) + 1,
					...(event.runHandle ? { runHandle: event.runHandle } : {}),
					...(event.sessionHandle ? { sessionHandle: event.sessionHandle } : {}),
				};
				if (current && ["admitted", "running", "waiting_input", "reconciling", "observation_lost"].includes(current.executionState)) {
					await this.delegations.transitionDelegation(delegation.id, [current.executionState], patch);
				}
				// 记录 run 锁（若 driver 给出 sessionHandle）。
				if (event.sessionHandle && !this.activeRuns.has(event.sessionHandle)) {
					this.activeRuns.set(event.sessionHandle, delegation.id);
				}
				return { terminal: false, outcome: undefined as unknown as RuntimeOutcome };
			}
			case "progress": {
				ctx.onUpdate?.(redactText(event.message), { running: true });
				return { terminal: false, outcome: undefined as unknown as RuntimeOutcome };
			}
			case "input_required": {
				const publicResult = redactValue(event.result);
				// C1/H1：runHandle/sessionHandle 只可能出现在 boundary result 里
				// （真实 driver 的 started 事件不带这些），必须从这里落盘，否则
				// respond 无 runHandle、续接无 sessionHandle。
				const effectiveRun = event.result.runHandle ?? current?.runHandle ?? delegation.runHandle;
				const effectiveSession = event.result.sessionHandle ?? sessionHandle ?? current?.sessionHandle ?? delegation.sessionHandle;
					const transitioned = await this.delegations.transitionDelegation(delegation.id, ["running", "reconciling"], {
						executionState: "waiting_input",
					revision: (current?.revision ?? delegation.revision ?? 0) + 1,
					sessionHandle: effectiveSession,
					runHandle: effectiveRun,
					result: undefined,
				});
				if (!transitioned.applied) {
					const record = transitioned.record ?? delegation;
					const result = this.conflictResult(record);
					return { terminal: true, outcome: { status: "failed", result, delegation: record } };
				}
				const interaction = await this.persistInteraction(delegation, publicResult, event.providerState);
				if (effectiveSession) this.activeRuns.set(effectiveSession, delegation.id);
				await this.recordBoundary(delegation, { ...event, result: publicResult });
				return {
					terminal: true,
					outcome: {
						status: "needs_input",
						result: publicResult,
						delegation: transitioned.record!,
						interaction,
					},
				};
			}
			case "completed": {
				const publicResult = redactValue(event.result);
				// H1：优先采用 boundary result 的 sessionHandle（run 模式 started
				// 不带 session），否则续接会丢失 worker session。
				const effectiveSession = event.result.sessionHandle ?? sessionHandle ?? current?.sessionHandle ?? delegation.sessionHandle;
				// outcome 必须带更新后的 delegation：invoker 据 delegation.sessionHandle
				// 写 workerBindings 续接记忆（否则 run 模式永远丢失 sessionHandle）。
					const terminalBase = current ?? delegation;
					const transitioned = await this.sealTerminal(
						terminalBase,
						["running", "cancel_requested", "reconciling"],
						"reported_completed",
						publicResult,
						ctx,
						{ sessionHandle: effectiveSession, runHandle: event.result.runHandle ?? current?.runHandle ?? delegation.runHandle },
					);
				if (!transitioned.applied) {
					const record = transitioned.record ?? delegation;
					const result = this.conflictResult(record);
					return { terminal: true, outcome: { status: "failed", result, delegation: record } };
				}
				if (effectiveSession) this.releaseSession(effectiveSession, delegation.id);
					await this.recordBoundary(delegation, { ...event, result: publicResult });
					return { terminal: true, outcome: { status: "completed", result: publicResult, delegation: transitioned.record! } };
			}
			case "failed": {
				const publicResult = redactValue(event.result);
				// H1：采用 boundary result 的 sessionHandle，避免 run 模式丢 session。
				const effectiveSession = event.result.sessionHandle ?? sessionHandle ?? current?.sessionHandle ?? delegation.sessionHandle;
					const terminalBase = current ?? delegation;
					const transitioned = await this.sealTerminal(
						terminalBase,
						["running", "cancel_requested", "reconciling"],
						publicResult.status === "cancelled" ? "cancelled" : "reported_failed",
						publicResult,
						ctx,
						{ sessionHandle: effectiveSession, runHandle: event.result.runHandle ?? current?.runHandle ?? delegation.runHandle },
					);
				if (!transitioned.applied) {
					const record = transitioned.record ?? delegation;
					const result = this.conflictResult(record);
					return { terminal: true, outcome: { status: "failed", result, delegation: record } };
				}
					if (effectiveSession) this.releaseSession(effectiveSession, delegation.id);
					await this.recordBoundary(delegation, { ...event, result: publicResult });
				return {
					terminal: true,
						outcome: { status: "failed", result: publicResult, delegation: transitioned.record! },
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
			source: "worker",
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

	/** Capture every reported Artifact and preserve failures in the immutable Receipt. */
	private async captureArtifacts(
		result: NormalizedResult,
		delegation: DelegationRecord,
		_ctx: InvocationContext,
	): Promise<ArtifactCaptureResult[]> {
		if (!result.artifacts?.length) return [];
		if (!this.artifacts) {
			return result.artifacts.map((artifact) => ({
				reportedPath: artifact.path,
				status: "failed",
				issue: "ArtifactStore 未启用，无法捕获上游声明的 Artifact",
			}));
		}
		const captures: ArtifactCaptureResult[] = [];
		// Artifact paths are reported by the Worker relative to the cwd it
		// actually executed in. For isolated scopes that directory intentionally
		// differs from the target checkout until acceptance/promotion.
		const executionRoot = delegation.executionCwd ?? delegation.cwdSnapshot;
		for (const artifact of result.artifacts) {
			const absolute = path.isAbsolute(artifact.path)
				? artifact.path
				: path.resolve(executionRoot, artifact.path);
			try {
				const record = await this.artifacts.register({
					name: artifact.name,
					path: absolute,
					kind: artifact.kind,
					size: artifact.size,
					origin: artifact.origin,
					producer: delegation.agentId,
					delegationId: delegation.id,
					windowId: delegation.windowId,
					workspaceId: delegation.workspaceId,
					cwdSnapshot: executionRoot,
				});
				captures.push({ reportedPath: artifact.path, artifactId: record.id, contentHash: record.contentHash, status: "captured" });
			} catch (error) {
				const issue = error instanceof Error ? error.message : String(error);
				const status: ArtifactCaptureResult["status"] = /outside|identity changed|symlink/i.test(issue)
					? "rejected"
					: /ENOENT|not a file|missing/i.test(issue)
						? "missing"
						: "failed";
				captures.push({ reportedPath: artifact.path, status, issue });
			}
		}
		return captures;
	}

	private async buildReceipt(
		delegation: DelegationRecord,
		result: NormalizedResult,
		ctx: InvocationContext,
	): Promise<ExecutionReceipt> {
		if (delegation.receipt) return delegation.receipt;
		if (result.status === "needs_input") throw new Error("waiting_input 不能封存 ExecutionReceipt");
		const artifactCapture = await this.captureArtifacts(result, delegation, ctx);
		const receipt = sealExecutionReceipt({
			contract: {
				delegationId: delegation.id,
				operationId: delegation.operationId ?? delegation.id,
				contractHash: delegation.contractHash,
				goalId: delegation.goalId,
				workPlanId: delegation.workPlanId,
				workItemId: delegation.workItemId,
				attempt: delegation.attempt,
				goalRevision: delegation.goalRevision,
				workItemRevision: delegation.workItemRevision,
				goalEpoch: delegation.goalEpoch,
				task: delegation.task,
				intent: delegation.intent,
				expectedOutcome: delegation.expectedOutcome,
				evidenceRequirements: delegation.evidenceRequirements,
				completionBoundary: delegation.completionBoundary,
				workspaceId: delegation.workspaceId,
				cwdSnapshot: delegation.cwdSnapshot,
				agentId: delegation.agentId,
				agentRevision: delegation.agentRevision,
				createdAt: delegation.createdAt,
				workerStarted: delegation.workerStarted,
				workspaceExecutionScopeId: delegation.workspaceExecutionScopeId,
				workspaceChangeSetId: delegation.workspaceChangeSetId,
			},
			result,
			artifactCapture,
			connectorId: delegation.driverId ?? delegation.agentId,
			transport: delegation.driverTransport ?? "sdk",
		});
		return receipt;
	}

	/** Capture evidence first, then commit boundary + immutable Receipt in one store rewrite. */
	private async sealTerminal(
		delegation: DelegationRecord,
		allowed: readonly ExecutionState[],
		executionState: Extract<ExecutionState, "reported_completed" | "reported_failed" | "cancelled">,
		result: Exclude<NormalizedResult, NeedsInputResult>,
		ctx: InvocationContext,
		patch: Partial<DelegationRecord> = {},
	): Promise<{ applied: boolean; record?: DelegationRecord }> {
		let working = delegation;
		if (!working.pendingTerminal) {
			const journaled = await this.delegations.transitionDelegation(working.id, allowed, {
				executionState: working.executionState,
				pendingTerminal: { executionState, result, startedAt: new Date().toISOString() },
				revision: working.revision + 1,
			});
			if (!journaled.applied || !journaled.record) return journaled;
			working = journaled.record;
		}
		let workspaceChangeSet: WorkspaceChangeSet | undefined;
		let workspaceIssue: string | undefined;
		if (this.workspaceExecution && working.workspaceExecutionScopeId) {
			try {
				const scope = await this.workspaceExecution.get(working.workspaceExecutionScopeId);
				workspaceChangeSet = await this.workspaceExecution.capture(working.workspaceExecutionScopeId, scope?.ownerToken);
			} catch (error) {
				workspaceIssue = `Workspace change-set 收集失败：${error instanceof Error ? error.message : String(error)}`;
			}
		}
		const receipt = await this.buildReceipt(working, result, ctx);
		if (workspaceChangeSet) {
			receipt.workspaceChangeSetId = workspaceChangeSet.id;
			if (workspaceChangeSet.integrity === "violation") {
				receipt.integrity = "violation";
				receipt.issues.push("read_only_shared execution scope 检测到 Workspace 写入");
			}
		}
		if (workspaceIssue) {
			receipt.issues.push(workspaceIssue);
			if (receipt.integrity === "clean") receipt.integrity = "suspect";
			if (receipt.collectionStatus === "complete") receipt.collectionStatus = "partial";
		}
		const terminal = await this.delegations.transitionDelegation(working.id, [working.executionState], {
			...patch,
			...(workspaceChangeSet ? { workspaceChangeSetId: workspaceChangeSet.id } : {}),
			executionState,
			pendingTerminal: undefined,
			result,
			receipt,
			revision: working.revision + 1,
		});
		// read_only_shared never has a promotable execution result. When its
		// boundary was not enforceable, admission conservatively upgraded the
		// coordination scope to exclusive_write; retaining that lease after a
		// Driver-observed terminal result fences every later read-only query on the
		// Workspace. Capture the change-set first, commit the terminal fact, then
		// release the coordination scope. A fenced lease is safe to release here
		// because this path itself is the terminal Driver observation.
		if (terminal.applied
			&& this.workspaceExecution
			&& working.workspaceExecutionScopeId
			&& working.workspaceExecutionPolicy?.mode === "read_only_shared") {
			const scope = await this.workspaceExecution.get(working.workspaceExecutionScopeId);
			if (scope) {
				await this.workspaceExecution.release(scope.id, {
					ownerToken: scope.ownerToken,
					allowFenced: true,
					cleanup: false,
				});
			}
		}
		return terminal;
	}

	/** 恢复 provider state（仅 Runtime 内部使用，token 永不出 Runtime）。 */
	private async providerStateOf(interactionId: string): Promise<Record<string, unknown> | undefined> {
		return this.secrets.getProviderState(interactionId);
	}

	private admissionResumeInput(delegation: DelegationRecord, driver: AgentDriver): DelegateInput {
		return {
			windowId: delegation.windowId,
			workspaceId: delegation.workspaceId,
			cwdSnapshot: delegation.cwdSnapshot,
			managerSessionId: delegation.managerSessionId,
			managerToolCallId: delegation.managerToolCallId,
			contractHash: delegation.contractHash,
			purpose: delegation.purpose,
			verificationId: delegation.verificationId,
			verifiesSubmissionId: delegation.verifiesSubmissionId,
			environmentProfileId: delegation.environmentProfileId,
			verificationEnvironmentId: delegation.verificationEnvironmentId,
			goalId: delegation.goalId,
			workPlanId: delegation.workPlanId,
			workItemId: delegation.workItemId,
			attempt: delegation.attempt,
			goalEpoch: delegation.goalEpoch,
			goalRevision: delegation.goalRevision,
			workItemRevision: delegation.workItemRevision,
			parentDelegationId: delegation.parentDelegationId,
			handoffKind: delegation.handoffKind,
			intent: delegation.intent,
			expectedOutcome: delegation.expectedOutcome,
			evidenceRequirements: delegation.evidenceRequirements,
			completionBoundary: delegation.completionBoundary,
			agentId: delegation.agentId,
			agentRevision: delegation.agentRevision,
			message: delegation.task ?? "",
			mode: delegation.operation,
			sessionHandle: delegation.sessionHandle,
			options: delegation.options,
			requestId: delegation.operationId ?? delegation.id,
			workspaceExecutionScopeId: delegation.workspaceExecutionScopeId,
			workspaceChangeSetId: delegation.workspaceChangeSetId,
			workspaceExecutionPolicy: delegation.workspaceExecutionPolicy,
			driver,
			resumeDelegationId: delegation.id,
		};
	}

	/**
	 * Consume a platform admission as a replacement decision. This only closes
	 * the pre-start Delegation; AgentInvoker owns Worker selection and creates the
	 * causally linked replacement under the current room/workspace policy.
	 */
	async beginAdmissionReplacement(
		interactionId: string,
		input: { requestId: string; revision: number; responses: InteractionResponse[] },
		replacementAgentId: string,
		ctx: InvocationContext,
	): Promise<{ delegation: DelegationRecord; interaction: InteractionRecord; replayed: boolean }> {
		const interaction = await this.delegations.getInteraction(interactionId);
		if (!interaction || interaction.source !== "platform_policy") throw new InteractionError("not_found", "Teams admission interaction not found");
		const delegation = await this.delegations.getDelegation(interaction.delegationId);
		if (!delegation) throw new InteractionError("not_found", "delegation not found");
		if (!replacementAgentId.trim() || replacementAgentId === delegation.agentId) throw new InteractionError("invalid_scope", "replacement Worker must be different from the current Worker");
		if (input.responses.length !== 1 || input.responses[0]?.action !== "approve" || input.responses[0].scope !== "select_another_worker") {
			throw new InteractionError("invalid_scope", "换 Worker 必须使用 select_another_worker 响应");
		}
		const timestamp = new Date().toISOString();
		const { interaction: decided, replayed } = await this.broker.submit(interactionId, input, () => ({
			decision: { chosenAction: "select_another_worker", replacementAgentId, actorId: "local-user", decidedAt: timestamp, requestId: input.requestId },
			application: { operationId: `admission-replacement:${delegation.id}`, status: "applying", replacementAgentId, updatedAt: timestamp },
		}));
		if (replayed) return { delegation, interaction: decided, replayed: true };
		const result: Exclude<NormalizedResult, NeedsInputResult> = {
			agentId: delegation.agentId,
			status: "cancelled",
			errorCode: "admission_replaced",
			error: `用户选择改派给 Worker「${replacementAgentId}」；原 Worker 未启动`,
			recoverable: true,
		};
		const terminal = await this.withDelegationTransition(delegation.id, () =>
			this.sealTerminal(delegation, ["waiting_admission"], "cancelled", result, ctx),
		);
		if (!terminal.applied || !terminal.record) {
			await this.delegations.transitionInteractionApplication(interactionId, ["applying"], {
				operationId: `admission-replacement:${delegation.id}`,
				status: "failed",
				replacementAgentId,
				failureCode: "delegation_not_pending",
			});
			throw new InteractionError("not_pending", `delegation is ${terminal.record?.executionState ?? "missing"}`);
		}
		return { delegation: terminal.record, interaction: decided, replayed: false };
	}

	async completeAdmissionReplacement(interactionId: string, replacementDelegationId: string): Promise<InteractionRecord> {
		const interaction = await this.delegations.getInteraction(interactionId);
		if (!interaction?.application || interaction.decision?.chosenAction !== "select_another_worker") throw new InteractionError("not_pending", "replacement admission is not applying");
		const transitioned = await this.delegations.transitionInteractionApplication(interactionId, ["applying"], {
			status: "applied",
			replacementDelegationId,
		});
		if (transitioned.applied && transitioned.record) return transitioned.record;
		const current = transitioned.record ?? await this.delegations.getInteraction(interactionId);
		if (current?.application?.status === "applied" && current.application.replacementDelegationId === replacementDelegationId) return current;
		throw new InteractionError("not_pending", `replacement application is ${current?.application?.status ?? "missing"}`);
	}

	async failAdmissionReplacement(interactionId: string, failureCode: string, replacementDelegationId?: string): Promise<void> {
		const interaction = await this.delegations.getInteraction(interactionId);
		if (!interaction?.application || interaction.decision?.chosenAction !== "select_another_worker") return;
		await this.delegations.transitionInteractionApplication(interactionId, ["applying"], {
			status: "failed",
			failureCode,
			...(replacementDelegationId ? { replacementDelegationId } : {}),
		});
	}

	private async respondPlatformPolicy(
		interaction: InteractionRecord,
		delegation: DelegationRecord,
		input: { requestId: string; revision: number; responses: InteractionResponse[] },
		ctx: InvocationContext,
		driverSnapshot: AgentDriver | undefined,
		onAdmitted?: (continuing: boolean) => void,
	): Promise<RespondOutcome> {
		if (input.responses.some((response) => response.action !== "reject" && (response.action !== "approve" || response.scope !== "proceed_with_worker"))) {
			throw new InteractionError("invalid_scope", "Teams 准入只接受取消或 proceed_with_worker；不能借由响应 payload 改写 Worker 权限");
		}
		const decisionTime = new Date().toISOString();
		const { interaction: decided, replayed } = await this.broker.submit(interaction.id, input, (status) => {
			const rejected = status === "rejected";
			return {
				decision: {
					chosenAction: rejected ? "cancel" : "proceed_with_worker",
					actorId: "local-user",
					decidedAt: decisionTime,
					requestId: input.requestId,
				},
				application: {
					operationId: `admission:${delegation.id}`,
					status: rejected ? "applied" : "applying",
					...(rejected ? {} : { readOnlyAssessment: "unverified_user_accepted" as const }),
					updatedAt: decisionTime,
				},
			};
		});
		if (replayed) {
			onAdmitted?.(false);
			const current = await this.delegations.getDelegation(delegation.id) ?? delegation;
			return {
				status: current.executionState === "cancelled" ? "rejected" : current.executionState === "waiting_admission" ? "needs_input" : current.executionState === "reported_completed" ? "completed" : "failed",
				result: current.result ?? {
					agentId: current.agentId,
					status: current.executionState === "cancelled" ? "cancelled" : "failed",
					errorCode: "admission_replayed",
					error: "该 Teams 准入决定已经处理",
					recoverable: current.executionState !== "cancelled",
				},
				delegation: current,
				interaction: decided,
			};
		}
		const rejected = decided.status === "rejected";
		if (rejected) {
			const result: Exclude<NormalizedResult, NeedsInputResult> = {
				agentId: delegation.agentId,
				status: "cancelled",
				errorCode: "admission_rejected",
				error: "用户未允许 Teams 在能力缺口下使用该 Worker",
				recoverable: true,
			};
			const terminal = await this.sealTerminal(delegation, ["waiting_admission"], "cancelled", result, ctx);
			onAdmitted?.(false);
			return { status: "rejected", result, delegation: terminal.record ?? delegation, interaction: decided };
		}

		const driver = driverSnapshot ?? await this.resolveDriver(delegation.agentId);
		if (!driver) throw new InteractionError("not_found", `no driver for agent ${delegation.agentId}`);
		const capabilities = await driver.capabilities();
		const fingerprint = capabilityFingerprint(delegation.agentRevision, driver.id, capabilities);
		if (fingerprint !== interaction.policyContext?.capabilityFingerprint || fingerprint !== delegation.capabilityFingerprint) {
			await this.delegations.updateInteraction(interaction.id, {
				status: "failed",
				application: { operationId: `admission:${delegation.id}`, status: "failed", failureCode: "capability_stale", updatedAt: new Date().toISOString() },
			});
			onAdmitted?.(false);
			throw new InteractionError("stale_revision", "Worker 能力已变化，请重新发起准入确认");
		}
		const admitted = await this.delegations.transitionDelegation(delegation.id, ["waiting_admission"], {
			executionState: "admitted",
			readOnlyAssessment: "unverified_user_accepted",
			revision: delegation.revision + 1,
		});
		if (!admitted.applied || !admitted.record) {
			await this.delegations.updateInteraction(interaction.id, {
				application: { operationId: `admission:${delegation.id}`, status: "failed", failureCode: "delegation_not_pending", updatedAt: new Date().toISOString() },
			});
			onAdmitted?.(false);
			throw new InteractionError("not_pending", `delegation is ${admitted.record?.executionState ?? "missing"}`);
		}
		try {
			const resumeInput = this.admissionResumeInput(admitted.record, driver);
			resumeInput.onDriverStarted = () => {
				void this.delegations.updateInteraction(interaction.id, {
					application: { operationId: `admission:${delegation.id}`, status: "applied", readOnlyAssessment: "unverified_user_accepted", updatedAt: new Date().toISOString() },
				}).finally(() => onAdmitted?.(true));
			};
			const outcome = await this.delegate(resumeInput, ctx);
			await this.delegations.updateInteraction(interaction.id, {
				application: { operationId: `admission:${delegation.id}`, status: "applied", readOnlyAssessment: "unverified_user_accepted", updatedAt: new Date().toISOString() },
			});
			return outcome.status === "needs_input"
				? outcome
				: { ...outcome, interaction: await this.delegations.getInteraction(interaction.id) };
		} catch (error) {
			await this.delegations.updateInteraction(interaction.id, {
				application: { operationId: `admission:${delegation.id}`, status: "failed", failureCode: "start_failed", updatedAt: new Date().toISOString() },
			});
			throw error;
		}
	}

	/**
	 * 提交审批：校验通过后调用 Driver.respond 恢复同一条 Run。
	 * 若再次 needs_input：更新同一 interaction 的 revision。
	 */
	async respond(
		interactionId: string,
		input: { requestId: string; revision: number; responses: InteractionResponse[] },
		ctx: InvocationContext,
		driverSnapshot?: AgentDriver,
		onAdmitted?: (continuing: boolean) => void,
	): Promise<RespondOutcome> {
		const interaction = await this.delegations.getInteraction(interactionId);
		if (!interaction) throw new InteractionError("not_found", "interaction not found");
		const delegation = await this.delegations.getDelegation(interaction.delegationId);
		if (!delegation) throw new InteractionError("not_found", "delegation not found");
		if (interaction.source === "platform_policy" && interaction.status === "pending" && interaction.expiresAt && Date.parse(interaction.expiresAt) < Date.now()) {
			await this.expireAdmissionRequests();
			throw new InteractionError("expired", "Teams 准入请求已过期，Worker 未启动");
		}

		// M3：同一 interaction 同时在飞（双签 / 两个标签页）时，拒绝第二次调用，
		// 绝不并发调 driver.respond。
		if (this.responding.has(interactionId)) {
			onAdmitted?.(false);
			return {
				status: "failed",
				result: { agentId: delegation.agentId, status: "failed", errorCode: "responding", error: "该审批正在处理中，请稍候", recoverable: true },
				delegation,
				interaction,
			};
		}
		if (interaction.source === "platform_policy") {
			this.responding.add(interactionId);
			try {
				return await this.respondPlatformPolicy(interaction, delegation, input, ctx, driverSnapshot, onAdmitted);
			} finally {
				this.responding.delete(interactionId);
			}
		}

		const driver = driverSnapshot ?? (await this.resolveDriver(delegation.agentId));
		if (!driver) throw new InteractionError("not_found", `no driver for agent ${delegation.agentId}`);
		if (!driver.respond) {
			throw new InteractionError("not_pending", `agent ${delegation.agentId} does not support respond`);
		}

		// 幂等检查 + 校验。
		const { interaction: approved, replayed } = await this.broker.submit(interactionId, input);
		if (replayed) {
			onAdmitted?.(false);
			// 幂等重放：已经消费过，返回当前终态，不再次调用 driver。
			const existing = await this.delegations.getDelegation(interaction.delegationId);
			return {
				status: existing?.executionState === "reported_completed" ? "completed" : existing?.executionState === "cancelled" ? "rejected" : "failed",
				result: existing?.result ?? { agentId: delegation.agentId, status: "failed", errorCode: "no_state", error: "无状态", recoverable: false },
				delegation: existing ?? delegation,
				interaction: approved,
			};
		}
		if (approved.status === "approved" || approved.status === "rejected") {
			// 请求被拒绝：Delegation 标记 cancelled，不再调用 driver。
			if (approved.status === "rejected") {
				const rejected: Exclude<NormalizedResult, NeedsInputResult> = {
					agentId: delegation.agentId,
					status: "cancelled",
					errorCode: "rejected",
					error: "审批被拒绝",
					recoverable: true,
				};
				const terminal = await this.withDelegationTransition(delegation.id, () =>
					this.sealTerminal(delegation, ["waiting_input"], "cancelled", rejected, ctx),
				);
				// reject 也是终态：释放 input_required 时占的 session 锁（否则该
				// session 永久 409 直到重启），并清理加密 continuation token（M4）。
				if (delegation.sessionHandle) this.releaseSession(delegation.sessionHandle, delegation.id);
				this.activeDelegations.delete(delegation.id);
				await this.secrets.removeProviderState(interaction.id).catch(() => undefined);
				onAdmitted?.(false);
				return {
					status: "rejected",
					result: rejected,
					delegation: terminal.record ?? delegation,
					interaction: approved,
				};
			}
		} else {
			onAdmitted?.(false);
			// 状态既不是 pending 也不是终态——异常路径。
			return {
				status: "failed",
				result: { agentId: delegation.agentId, status: "failed", errorCode: "unexpected_state", error: `interaction is ${approved.status}`, recoverable: false },
				delegation,
				interaction: approved,
			};
		}

		// approved：调用 driver.respond 恢复原 Run。
		// Interaction 已消费后，Delegation 必须立即从 waiting_input 回到
		// running；否则 worker 实际续跑期间，任务卡、抽屉与持久化状态会一直
		// 假装仍在等待审批。
		const resumed = await this.withDelegationTransition(delegation.id, () =>
			this.delegations.transitionDelegation(delegation.id, ["waiting_input"], {
				executionState: "running",
				revision: (delegation.revision ?? 0) + 1,
			}),
		);
		if (!resumed.applied) {
			onAdmitted?.(false);
			const record = resumed.record ?? delegation;
			return {
				status: "failed",
				result: {
					agentId: delegation.agentId,
					status: record.executionState === "cancelled" ? "cancelled" : "failed",
					errorCode: record.executionState === "cancelled" ? "cancelled" : "state_conflict",
					error: record.executionState === "cancelled" ? "任务已取消" : `审批恢复失败：任务已是 ${record.executionState}`,
					recoverable: record.executionState !== "cancelled",
				},
				delegation: record,
				interaction: approved,
			};
		}
		const providerState = await this.providerStateOf(interactionId);
		// runHandle 可能为空：worker 在 Run 启动前发问（如分析模型澄清）时无
		// 运行句柄可恢复，能否继续由 Driver 判断（PuddingClaw 走 clarify-and-
		// retry 重跑）。这里抛错会把 delegation 永远卡在 waiting_input。
		const runHandle = delegation.runHandle ?? "";

		const controller = new AbortController();
		this.runControllers.set(delegation.id, controller);
		const settleRun = this.trackRun(delegation.id);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const invocationCtx = this.timelineContext({
			...ctx,
			signal,
			cwd: delegation.executionCwd ?? delegation.cwdSnapshot,
			...(delegation.workspaceId ? { workspaceId: delegation.workspaceId } : {}),
			// respond 恢复的是同一条 Run，导出目录仍按原 delegation 约定（§15.3）。
			delegationId: delegation.id,
		}, delegation);
		// Driver 需要 continuation token；PuddingClawDriver 在构造时持有，这里把
		// provider state 透传为 respond 的私有字段（Runtime 不接触明文）。
		invocationCtx.providerState = providerState;

		let sessionHandle = delegation.sessionHandle;
		this.responding.add(interactionId);
		// continuing=true：审批已受理，worker 即将续跑（可能很久），调用方应
		// 立即向 HTTP 返回受理态结果，续跑结果走 outcome 扇出通知。
		onAdmitted?.(true);
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
			const result: NormalizedResult = { agentId: delegation.agentId, status: "failed", errorCode: "no_boundary_event", error: "respond 无边界事件", recoverable: false };
			const transition = await this.withDelegationTransition(delegation.id, () =>
				this.sealTerminal(delegation, ["running", "waiting_input", "cancel_requested"], "reported_failed", result, invocationCtx),
			);
			if (transition.applied) {
				await this.delegations.updateInteraction(interaction.id, { status: "failed" });
				await this.secrets.removeProviderState(interaction.id).catch(() => undefined);
				await this.recordBoundary(delegation, { type: "failed", result });
			}
			return { status: "failed", result, delegation: transition.record ?? delegation, interaction };
		} catch (err) {
			if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
			const cancelling = await this.delegations.getDelegation(delegation.id);
			if (cancelling?.executionState === "cancel_requested") {
				const pending: NormalizedResult = { agentId: delegation.agentId, status: "failed", errorCode: "cancel_pending", error: "取消请求正在等待执行面确认", recoverable: true };
				return { status: "failed", result: pending, delegation: cancelling, interaction };
			}
			const result: NormalizedResult = { agentId: delegation.agentId, status: "failed", errorCode: "driver_error", error: err instanceof Error ? err.message : String(err), recoverable: false };
			const transition = await this.withDelegationTransition(delegation.id, () =>
				this.sealTerminal(delegation, ["running", "waiting_input", "cancel_requested"], "reported_failed", result, invocationCtx),
			);
			if (transition.applied) {
				await this.delegations.updateInteraction(interaction.id, { status: "failed" });
				await this.secrets.removeProviderState(interaction.id).catch(() => undefined);
				await this.recordBoundary(delegation, { type: "failed", result });
			}
			if (!transition.applied && transition.record?.executionState === "cancelled") {
				const cancelled: NormalizedResult = { agentId: delegation.agentId, status: "cancelled", errorCode: "cancelled", error: "任务已取消", recoverable: true };
				return { status: "failed", result: cancelled, delegation: transition.record, interaction };
			}
			return { status: "failed", result, delegation: transition.record ?? delegation, interaction };
		} finally {
			this.responding.delete(interactionId);
			this.runControllers.delete(delegation.id);
			// respond 可能回到 waiting_input（多轮审批）：仍挂起待下次 respond，
			// 保持活跃登记；只有真正终态才移除。
			const rec = await this.delegations.getDelegation(delegation.id);
			if (rec?.executionState !== "waiting_input") this.activeDelegations.delete(delegation.id);
			settleRun();
		}
	}

	private async respondEvent(
		event: AgentEvent,
		interaction: InteractionRecord,
		delegation: DelegationRecord,
		sessionHandle: string | undefined,
		ctx: InvocationContext,
	): Promise<{ terminal: boolean; outcome: RespondOutcome }> {
		return this.withDelegationTransition(delegation.id, () =>
			this.respondEventUnlocked(event, interaction, delegation, sessionHandle, ctx),
		);
	}

	private async respondEventUnlocked(
		event: AgentEvent,
		interaction: InteractionRecord,
		delegation: DelegationRecord,
		sessionHandle: string | undefined,
		ctx: InvocationContext,
	): Promise<{ terminal: boolean; outcome: RespondOutcome }> {
		const current = await this.delegations.getDelegation(delegation.id);
		if (current?.executionState === "cancelled") {
			if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
			const result: NormalizedResult = {
				agentId: delegation.agentId,
				status: "cancelled",
				errorCode: "cancelled",
				error: "任务已取消",
				recoverable: true,
			};
			return { terminal: true, outcome: { status: "failed", result, delegation: current, interaction } };
		}
		switch (event.type) {
			case "progress":
				ctx.onUpdate?.(redactText(event.message), { running: true });
				return { terminal: false, outcome: undefined as unknown as RespondOutcome };
			case "completed": {
				const publicResult = redactValue(event.result);
				const transitioned = await this.sealTerminal(
					current ?? delegation,
					["running", "waiting_input", "cancel_requested"],
					"reported_completed",
					publicResult,
					ctx,
					{ sessionHandle },
				);
				if (!transitioned.applied) {
					const record = transitioned.record ?? delegation;
					const result = this.conflictResult(record);
					return { terminal: true, outcome: { status: "failed", result, delegation: record, interaction } };
				}
				await this.secrets.removeProviderState(interaction.id);
				await this.delegations.updateInteraction(interaction.id, { status: "approved" });
				if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
				await this.recordBoundary(delegation, { ...event, result: publicResult });
				return {
					terminal: true,
					outcome: { status: "completed", result: publicResult, delegation: transitioned.record!, interaction },
				};
			}
			case "failed": {
				const publicResult = redactValue(event.result);
				const transitioned = await this.sealTerminal(
					current ?? delegation,
					["running", "waiting_input", "cancel_requested"],
					publicResult.status === "cancelled" ? "cancelled" : "reported_failed",
					publicResult,
					ctx,
				);
				if (!transitioned.applied) {
					const record = transitioned.record ?? delegation;
					const result = this.conflictResult(record);
					return { terminal: true, outcome: { status: "failed", result, delegation: record, interaction } };
				}
				await this.secrets.removeProviderState(interaction.id);
				await this.delegations.updateInteraction(interaction.id, { status: "failed" });
				if (sessionHandle) this.releaseSession(sessionHandle, delegation.id);
				await this.recordBoundary(delegation, { ...event, result: publicResult });
				return {
					terminal: true,
					outcome: { status: "failed", result: publicResult, delegation: transitioned.record!, interaction },
				};
			}
			case "input_required": {
				const publicResult = redactValue(event.result);
				const transitioned = await this.delegations.transitionDelegation(delegation.id, ["running", "waiting_input"], {
					executionState: "waiting_input",
					revision: (current?.revision ?? delegation.revision ?? 0) + 1,
				});
				if (!transitioned.applied) {
					const record = transitioned.record ?? delegation;
					const result = this.conflictResult(record);
					return { terminal: true, outcome: { status: "failed", result, delegation: record, interaction } };
				}
				// 再次需要输入：更新同一 interaction 的 request 集合，保持 pending，
				// 并刷新加密 provider state（新 continuation token）。
				const updated = await this.delegations.updateInteraction(interaction.id, {
					status: "pending",
					revision: interaction.revision + 1,
					requests: publicResult.interaction.requests,
					// L1：回到 pending 必须清掉 consumedRequestId，否则第二轮提交
					// 复用同一 requestId 会被误判为幂等重放。
					consumedRequestId: undefined,
					consumedPayloadHash: undefined,
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
				await this.recordBoundary(delegation, { ...event, result: publicResult });
				return {
					terminal: true,
					outcome: {
						status: "needs_input",
						result: publicResult,
						delegation: transitioned.record ?? delegation,
						interaction: updated ?? interaction,
					},
				};
			}
			case "started":
				return { terminal: false, outcome: undefined as unknown as RespondOutcome };
		}
	}

	private async expireDelegationInteractions(delegationId: string): Promise<void> {
		for (const interaction of await this.delegations.listInteractions()) {
			if (interaction.delegationId !== delegationId) continue;
			if (interaction.status === "pending" || interaction.status === "responding") {
				await this.delegations.updateInteraction(interaction.id, { status: "expired" });
			}
			await this.secrets.removeProviderState(interaction.id).catch(() => undefined);
		}
	}

	/** 取消先记 cancel_requested；只有 Driver 明确确认后才封存 cancelled Receipt。 */
	async cancel(delegationId: string, ctx: InvocationContext): Promise<boolean> {
		const before = await this.delegations.getDelegation(delegationId);
		if (!before) throw new Error("delegation not found");
		if (before.executionState === "waiting_admission") {
			const result: Exclude<NormalizedResult, NeedsInputResult> = {
				agentId: before.agentId,
				status: "cancelled",
				errorCode: "admission_cancelled",
				error: "Teams 准入请求已取消，Worker 未启动",
				recoverable: true,
			};
			const sealed = await this.withDelegationTransition(delegationId, () =>
				this.sealTerminal(before, ["waiting_admission"], "cancelled", result, ctx),
			);
			if (sealed.applied) {
				for (const interaction of await this.delegations.listInteractions()) {
					if (interaction.delegationId === delegationId && interaction.status === "pending") {
						await this.delegations.updateInteraction(interaction.id, {
							status: "rejected",
							decision: { chosenAction: "cancel", actorId: "local-user", decidedAt: new Date().toISOString(), requestId: `cancel:${interaction.id}` },
						});
					}
				}
			}
			return sealed.applied;
		}
		const requested = await this.withDelegationTransition(delegationId, async () => {
			const record = await this.delegations.getDelegation(delegationId);
			if (!record) throw new Error("delegation not found");
			if (["reported_completed", "reported_failed", "cancelled"].includes(record.executionState)) return { record, applied: false };
			return this.delegations.transitionDelegation(delegationId, ["admitted", "running", "waiting_input", "reconciling"], {
				executionState: "cancel_requested",
				revision: record.revision + 1,
			});
		});
		if (!requested.applied || !requested.record) return false;
		const delegation = requested.record;
		let driver: AgentDriver | undefined;
		let confirmation: "none" | "acknowledged" | "observable" = "none";
		let driverAcknowledged = false;
		try {
			driver = await this.resolveDriver(delegation.agentId);
			confirmation = (await driver?.capabilities())?.cancelConfirmation ?? "none";
		} catch {
			driver = undefined;
		}
		if (driver?.cancel && delegation.runHandle) {
			let timeout: NodeJS.Timeout | undefined;
			try {
				driverAcknowledged = await Promise.race([
					driver.cancel({ runHandle: delegation.runHandle }, { ...ctx, cwd: delegation.executionCwd ?? delegation.cwdSnapshot }).then(() => true, () => false),
					new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 5_000); }),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		}
		this.runControllers.get(delegationId)?.abort();
		let locallyObservedStopped = false;
		if (confirmation === "observable") {
			const settled = this.runSettled.get(delegationId);
			if (settled) {
				let settleTimeout: NodeJS.Timeout | undefined;
				try {
					locallyObservedStopped = await Promise.race([
						settled.then(() => true),
						new Promise<boolean>((resolve) => { settleTimeout = setTimeout(() => resolve(false), 5_000); }),
					]);
				} finally {
					if (settleTimeout) clearTimeout(settleTimeout);
				}
			}
		}
		const latest = await this.delegations.getDelegation(delegationId);
		if (!latest || latest.executionState !== "cancel_requested") return true;
		// acknowledged means the upstream explicitly promises that cancel has
		// taken effect. observable requires a real terminal event/reconciliation;
		// if that event had arrived it would already have won the CAS above.
		const localLifecycle = delegation.driverTransport === "spawn" || delegation.driverTransport === "sdk" || delegation.driverTransport === undefined;
		if ((driverAcknowledged && confirmation === "acknowledged") || (confirmation === "observable" && localLifecycle && locallyObservedStopped)) {
			const result: Exclude<NormalizedResult, NeedsInputResult> = {
				agentId: delegation.agentId,
				status: "cancelled",
				errorCode: "cancelled",
				error: locallyObservedStopped ? "本地执行进程已确认退出" : "上游已确认任务取消",
				recoverable: true,
			};
			const sealed = await this.withDelegationTransition(delegationId, () =>
				this.sealTerminal(latest, ["cancel_requested"], "cancelled", result, ctx),
			);
			if (sealed.applied) await this.recordBoundary(delegation, { type: "failed", result });
		} else {
			await this.withDelegationTransition(delegationId, () =>
				this.delegations.transitionDelegation(delegationId, ["cancel_requested"], {
					executionState: "observation_lost",
					revision: latest.revision + 1,
				}),
			);
			if (this.workspaceExecution && latest.workspaceExecutionScopeId) {
				const scope = await this.workspaceExecution.get(latest.workspaceExecutionScopeId);
				await this.workspaceExecution.fence(latest.workspaceExecutionScopeId, scope?.ownerToken).catch(() => undefined);
			}
		}
		// 清理该 delegation 名下所有 pending interactions 及其加密 token。
		await this.expireDelegationInteractions(delegationId);
		if (delegation.sessionHandle) this.releaseSession(delegation.sessionHandle, delegationId);
		this.activeDelegations.delete(delegationId);
		return true;
	}

	/** Startup recovery follows execution ownership: local processes are known dead,
	 * remote runs are queried/reattached, and unknowable effects become observation_lost. */
	async reconcileOrphanedRuns(
		notify?: (delegation: DelegationRecord, result: NormalizedResult) => Promise<void>,
		onlyDelegationId?: string,
	): Promise<number> {
		const orphans = (await this.delegations.listDelegations()).filter(
			(d) => (!onlyDelegationId || d.id === onlyDelegationId)
				&& (["admitted", "running", "waiting_input", "cancel_requested", "reconciling"].includes(d.executionState)
					|| (Boolean(onlyDelegationId) && d.executionState === "observation_lost")),
		);
		let reconciled = 0;
		for (const orphan of orphans) {
			const ctx: InvocationContext = { cwd: orphan.executionCwd ?? orphan.cwdSnapshot, env: process.env, delegationId: orphan.id, operationId: orphan.operationId };
			if (orphan.pendingTerminal) {
				const pending = orphan.pendingTerminal;
				const terminalOwner = pending.executionState === "reported_completed"
					? await this.markRecoveredWorkerStarted(orphan)
					: orphan;
				const transition = await this.withDelegationTransition(orphan.id, () => this.sealTerminal(terminalOwner, [terminalOwner.executionState], pending.executionState, pending.result, ctx));
				if (transition.applied) {
					await this.expireDelegationInteractions(orphan.id);
					await this.recordBoundary(orphan, pending.result.status === "completed" ? { type: "completed", result: pending.result } : { type: "failed", result: pending.result });
					if (notify) await notify(transition.record ?? orphan, pending.result).catch(() => undefined);
				}
				reconciled++;
				continue;
			}
			let driver: AgentDriver | undefined;
			try { driver = await this.resolveDriver(orphan.agentId); } catch { driver = undefined; }
			const capabilities = driver ? await driver.capabilities().catch(() => undefined) : undefined;
			const remote = orphan.driverTransport === "http" || orphan.driverTransport === "rpc" || orphan.driverTransport === "acp";

			if (remote && capabilities?.reconciliation === "query_run" && driver?.reconcileRun && orphan.runHandle) {
				const observed = await driver.reconcileRun({ runHandle: orphan.runHandle, lastObservedAt: orphan.updatedAt }, ctx)
					.catch((error: unknown) => ({ state: "unknown" as const, reason: error instanceof Error ? error.message : String(error) }));
				if (observed.state === "completed") {
					const observedOrphan = await this.markRecoveredWorkerStarted(orphan);
					const publicResult = redactValue(observed.result);
					const transition = await this.withDelegationTransition(orphan.id, () => this.sealTerminal(observedOrphan, [observedOrphan.executionState], "reported_completed", publicResult, ctx));
					if (transition.applied && notify) await notify(transition.record ?? orphan, publicResult).catch(() => undefined);
				} else if (observed.state === "failed" || observed.state === "cancelled") {
					const observedOrphan = await this.markRecoveredWorkerStarted(orphan);
					const publicResult = redactValue(observed.result);
					const transition = await this.withDelegationTransition(orphan.id, () => this.sealTerminal(observedOrphan, [observedOrphan.executionState], observed.state === "cancelled" ? "cancelled" : "reported_failed", publicResult, ctx));
					if (transition.applied && notify) await notify(transition.record ?? orphan, publicResult).catch(() => undefined);
				} else if (observed.state === "running") {
					const resumed = await this.delegations.transitionDelegation(orphan.id, [orphan.executionState], { executionState: "running", workerStarted: true, runHandle: observed.runHandle, sessionHandle: observed.sessionHandle, revision: orphan.revision + 1 });
					if (!resumed.applied) {
						reconciled++;
						continue;
					}
					this.activeDelegations.add(orphan.id);
					if (observed.sessionHandle) this.activeRuns.set(observed.sessionHandle, orphan.id);
				} else if (observed.state === "needs_input") {
					const publicResult = redactValue(observed.result);
					const effectiveRun = observed.result.runHandle ?? orphan.runHandle;
					const effectiveSession = observed.result.sessionHandle ?? orphan.sessionHandle;
					const waiting = await this.delegations.transitionDelegation(orphan.id, [orphan.executionState], { executionState: "waiting_input", workerStarted: true, runHandle: effectiveRun, sessionHandle: effectiveSession, result: undefined, revision: orphan.revision + 1 });
					if (!waiting.applied || !waiting.record) {
						reconciled++;
						continue;
					}
					await this.persistInteraction(waiting.record, publicResult, observed.providerState);
					this.activeDelegations.add(orphan.id);
					if (effectiveSession) this.activeRuns.set(effectiveSession, orphan.id);
				} else {
					const lost = await this.delegations.transitionDelegation(orphan.id, [orphan.executionState], { executionState: "observation_lost", revision: orphan.revision + 1 });
					if (this.workspaceExecution && orphan.workspaceExecutionScopeId) {
						const scope = await this.workspaceExecution.get(orphan.workspaceExecutionScopeId);
						await this.workspaceExecution.fence(orphan.workspaceExecutionScopeId, scope?.ownerToken).catch(() => undefined);
					}
					const reason = redactText("reason" in observed ? observed.reason : "remote_run_state_unknown");
					if (lost.applied && notify) await notify(lost.record ?? orphan, { agentId: orphan.agentId, status: "failed", errorCode: "observation_lost", error: reason, recoverable: true }).catch(() => undefined);
				}
				reconciled++;
				continue;
			}

			if (remote && capabilities?.reconciliation === "reattach_stream" && driver?.reattachRun && orphan.runHandle) {
				if (this.reattachInFlight.has(orphan.id)) continue;
				this.reattachInFlight.add(orphan.id);
				const attaching = await this.delegations.transitionDelegation(orphan.id, [orphan.executionState], { executionState: "reconciling", revision: orphan.revision + 1 });
				if (!attaching.applied) {
					this.reattachInFlight.delete(orphan.id);
					continue;
				}
				const observedOrphan = attaching.record ?? orphan;
				this.activeDelegations.add(orphan.id);
				if (observedOrphan.sessionHandle) this.activeRuns.set(observedOrphan.sessionHandle, orphan.id);
				void this.observeReattached(observedOrphan, driver, ctx, notify);
				reconciled++;
				continue;
			}

			if (remote) {
				const lost = await this.delegations.transitionDelegation(orphan.id, [orphan.executionState], { executionState: "observation_lost", revision: orphan.revision + 1 });
				if (this.workspaceExecution && orphan.workspaceExecutionScopeId) {
					const scope = await this.workspaceExecution.get(orphan.workspaceExecutionScopeId);
					await this.workspaceExecution.fence(orphan.workspaceExecutionScopeId, scope?.ownerToken).catch(() => undefined);
				}
				if (lost.applied && notify) await notify(lost.record ?? orphan, { agentId: orphan.agentId, status: "failed", errorCode: "observation_lost", error: "远端 Driver 不支持对账或重挂", recoverable: true }).catch(() => undefined);
				reconciled++;
				continue;
			}

			const result: Exclude<NormalizedResult, NeedsInputResult> = {
				agentId: orphan.agentId, status: "failed", errorCode: "server_restart",
				error: "PuddingTeams 服务重启；本地生命周期绑定进程已确认消失", recoverable: true,
			};
			const transition = await this.withDelegationTransition(orphan.id, () =>
				this.sealTerminal(orphan, [orphan.executionState], "reported_failed", result, ctx),
			);
			if (!transition.applied) continue;
			await this.expireDelegationInteractions(orphan.id);
			await this.recordBoundary(orphan, { type: "failed", result });
			reconciled++;
			if (notify) await notify(transition.record ?? orphan, result).catch(() => undefined);
		}
		return reconciled;
	}

	/** Explicit user action: retry the original Driver's reconciliation contract; never starts a replacement Run. */
	async reconcileDelegation(delegationId: string, notify?: (delegation: DelegationRecord, result: NormalizedResult) => Promise<void>): Promise<DelegationRecord> {
		const before = await this.delegations.getDelegation(delegationId);
		if (!before) throw new Error("delegation not found");
		if (before.executionState !== "observation_lost") throw new Error(`delegation is ${before.executionState}, not observation_lost`);
		const remote = before.driverTransport === "http" || before.driverTransport === "rpc" || before.driverTransport === "acp";
		const driver = await this.resolveDriver(before.agentId);
		if (!driver) throw new Error("原 Driver 不可用，无法重新对账；请先恢复 Connector 或人工接管");
		const capabilities = await driver.capabilities();
		if (!remote || capabilities.reconciliation === "none") throw new Error("该 Driver 没有可重试的远端对账能力，请确认上游已终止后人工接管");
		await this.reconcileOrphanedRuns(notify, delegationId);
		return (await this.delegations.getDelegation(delegationId)) ?? before;
	}

	/** Explicit human certification that the upstream execution has stopped.
	 * This is the only path that may release a fenced scope without a Driver terminal observation. */
	async confirmObservationLostStopped(delegationId: string, rationale: string): Promise<DelegationRecord> {
		const explanation = rationale.trim();
		if (explanation.length < 8) throw new Error("人工接管说明至少需要 8 个字符");
		const current = await this.delegations.getDelegation(delegationId);
		if (!current) throw new Error("delegation not found");
		if (current.executionState !== "observation_lost") throw new Error(`delegation is ${current.executionState}, not observation_lost`);
		const result: Exclude<NormalizedResult, NeedsInputResult> = {
			agentId: current.agentId,
			status: "cancelled",
			errorCode: "manual_reconciliation_confirmed_stopped",
			error: `人工已确认上游执行终止：${explanation}`,
			recoverable: true,
		};
		const ctx: InvocationContext = { cwd: current.executionCwd ?? current.cwdSnapshot, env: process.env, delegationId: current.id, operationId: current.operationId };
		const transition = await this.withDelegationTransition(current.id, () => this.sealTerminal(current, ["observation_lost"], "cancelled", result, ctx));
		if (!transition.applied || !transition.record) throw new Error("delegation changed during manual reconciliation");
		if (this.workspaceExecution && current.workspaceExecutionScopeId) {
			const scope = await this.workspaceExecution.get(current.workspaceExecutionScopeId);
			if (scope) await this.workspaceExecution.release(scope.id, { ownerToken: scope.ownerToken, allowFenced: true, cleanup: false });
		}
		await this.expireDelegationInteractions(current.id);
		return transition.record;
	}

	private async observeReattached(orphan: DelegationRecord, driver: AgentDriver, ctx: InvocationContext, notify?: (delegation: DelegationRecord, result: NormalizedResult) => Promise<void>): Promise<void> {
		let observedTerminal = false;
		let keepActiveForInput = false;
		let sessionHandle = orphan.sessionHandle;
		try {
			for await (const event of driver.reattachRun!({ runHandle: orphan.runHandle! }, ctx)) {
				orphan = await this.markRecoveredWorkerStarted(orphan);
				const outcome = await this.handleEvent(event, orphan, sessionHandle, ctx);
				if (event.type === "started" && event.sessionHandle) sessionHandle = event.sessionHandle;
				if (outcome.terminal) {
					observedTerminal = true;
					keepActiveForInput = outcome.outcome.status === "needs_input";
					if (!keepActiveForInput) {
						const latest = await this.delegations.getDelegation(orphan.id);
						if (latest?.sessionHandle) this.releaseSession(latest.sessionHandle, orphan.id);
						this.activeDelegations.delete(orphan.id);
					}
					if (notify) await notify(outcome.outcome.delegation, outcome.outcome.result).catch(() => undefined);
					break;
				}
			}
			if (!observedTerminal) throw new Error("reattach stream ended without terminal event");
		} catch {
			const current = await this.delegations.getDelegation(orphan.id);
			if (current && ["running", "waiting_input", "cancel_requested", "reconciling"].includes(current.executionState)) {
				const lost = await this.delegations.transitionDelegation(orphan.id, [current.executionState], { executionState: "observation_lost", revision: current.revision + 1 });
				if (this.workspaceExecution && current.workspaceExecutionScopeId) {
					const scope = await this.workspaceExecution.get(current.workspaceExecutionScopeId);
					await this.workspaceExecution.fence(current.workspaceExecutionScopeId, scope?.ownerToken).catch(() => undefined);
				}
				if (lost.applied && notify) await notify(lost.record ?? current, { agentId: current.agentId, status: "failed", errorCode: "observation_lost", error: "远端 Run 重挂流中断", recoverable: true }).catch(() => undefined);
			}
		} finally {
			this.reattachInFlight.delete(orphan.id);
			if (!keepActiveForInput) {
				const latest = await this.delegations.getDelegation(orphan.id);
				if (latest?.sessionHandle) this.releaseSession(latest.sessionHandle, orphan.id);
				this.activeDelegations.delete(orphan.id);
			}
		}
	}

	/** 校验当前 Session 是否可发起新 Run（锁 + 状态）。 */
	async canDelegate(sessionHandle: string): Promise<{ ok: boolean; reason?: string }> {
		if (this.activeRuns.has(sessionHandle)) {
			return { ok: false, reason: "Session already has an active Run or pending input (409)" };
		}
		const persisted = (await this.delegations.listDelegations()).find((item) => item.sessionHandle === sessionHandle && ["admitted", "running", "waiting_input", "cancel_requested", "reconciling"].includes(item.executionState));
		if (persisted) return { ok: false, reason: `Session has persisted active Delegation ${persisted.id} (409)` };
		return { ok: true };
	}

	async listDelegations(windowId?: string, managerSessionId?: string): Promise<DelegationRecord[]> {
		return this.delegations.listDelegations(windowId, managerSessionId);
	}

	/** Settle expired platform admissions without ever resolving or cancelling a Driver Run. */
	async expireAdmissionRequests(now = Date.now()): Promise<number> {
		let expired = 0;
		for (const interaction of await this.delegations.listInteractions()) {
			if (interaction.source !== "platform_policy" || interaction.status !== "pending" || !interaction.expiresAt || Date.parse(interaction.expiresAt) >= now) continue;
			const delegation = await this.delegations.getDelegation(interaction.delegationId);
			if (!delegation || delegation.executionState !== "waiting_admission") continue;
			const result: Exclude<NormalizedResult, NeedsInputResult> = {
				agentId: delegation.agentId,
				status: "cancelled",
				errorCode: "admission_expired",
				error: "Teams 准入请求已过期，Worker 未启动",
				recoverable: true,
			};
			const terminal = await this.withDelegationTransition(delegation.id, () =>
				this.sealTerminal(delegation, ["waiting_admission"], "cancelled", result, { cwd: delegation.cwdSnapshot, env: process.env }),
			);
			if (!terminal.applied) continue;
			const timestamp = new Date(now).toISOString();
			await this.delegations.updateInteraction(interaction.id, {
				status: "expired",
				decision: { chosenAction: "cancel", actorId: "system:ttl", decidedAt: timestamp, requestId: `expire:${interaction.id}` },
				application: { operationId: `admission:${delegation.id}`, status: "applied", updatedAt: timestamp },
			});
			expired++;
		}
		return expired;
	}

	/**
	 * Startup convergence for a decision that became durable before its start
	 * application journal did. We never guess or duplicate a Worker start: a
	 * pre-start delegation is cancelled and surfaced as a failed application;
	 * a delegation that crossed the atomic workerStarted boundary is recorded as
	 * applied and normal Run reconciliation remains authoritative.
	 */
	async reconcileAdmissionApplications(): Promise<number> {
		let reconciled = 0;
		const allDelegations = await this.delegations.listDelegations();
		for (const interaction of await this.delegations.listInteractions()) {
			if (interaction.source !== "platform_policy" || interaction.status !== "approved" || (interaction.application && interaction.application.status !== "applying")) continue;
			const operationId = interaction.application?.operationId ?? `admission:${interaction.delegationId}`;
			const delegation = await this.delegations.getDelegation(interaction.delegationId);
			if (!delegation) {
				await this.delegations.updateInteraction(interaction.id, {
					application: { operationId, status: "failed", failureCode: "delegation_missing", updatedAt: new Date().toISOString() },
				});
				reconciled++;
				continue;
			}
			if (interaction.decision?.chosenAction === "select_another_worker") {
				const replacements = allDelegations.filter((item) =>
					item.id !== delegation.id
					&& (item.operationId === operationId || item.parentDelegationId === delegation.id),
				);
				if (replacements.length === 1) {
					const replacement = replacements[0]!;
					const ready = replacement.replacementAdmissionReady === true;
					await this.delegations.transitionInteractionApplication(interaction.id, ["applying"], {
						operationId,
						status: ready ? "applied" : "failed",
						...(ready ? { failureCode: undefined } : { failureCode: "replacement_start_unconfirmed" }),
						replacementAgentId: replacement.agentId,
						replacementDelegationId: replacement.id,
					});
					reconciled++;
					continue;
				}
				if (replacements.length > 1) {
					await this.delegations.transitionInteractionApplication(interaction.id, ["applying"], {
						operationId,
						status: "failed",
						failureCode: "replacement_identity_conflict",
					});
					reconciled++;
					continue;
				}
			}
			if (delegation.workerStarted) {
				await this.delegations.updateInteraction(interaction.id, {
					application: { operationId, status: "applied", readOnlyAssessment: "unverified_user_accepted", updatedAt: new Date().toISOString() },
				});
				reconciled++;
				continue;
			}
			if (delegation.executionState === "waiting_admission" || delegation.executionState === "admitted") {
				const result: Exclude<NormalizedResult, NeedsInputResult> = {
					agentId: delegation.agentId,
					status: "cancelled",
					errorCode: "admission_application_interrupted",
					error: "Teams 准入决定已保存，但服务重启前未确认 Worker 启动；为避免重复执行，任务已取消",
					recoverable: true,
				};
				await this.withDelegationTransition(delegation.id, () =>
					this.sealTerminal(delegation, [delegation.executionState], "cancelled", result, { cwd: delegation.cwdSnapshot, env: process.env }),
				);
			}
			await this.delegations.updateInteraction(interaction.id, {
				application: { operationId, status: "failed", failureCode: "start_confirmation_lost", updatedAt: new Date().toISOString() },
			});
			reconciled++;
		}
		return reconciled;
	}

	async verificationObservations(delegationId: string): Promise<Array<{ id: string; delegationId: string; kind: "tool" | "file" | "search"; title: string; contentHash: string; itemId?: string }>> {
		if (!this.timeline) return [];
		return (await this.timeline.list(delegationId))
			.filter((event): event is typeof event & { kind: "tool" | "file" | "search" } =>
				(event.kind === "tool" || event.kind === "file" || event.kind === "search") && event.status === "completed",
			)
			.map((event) => ({
				id: `observation:${delegationId}:${event.seq}`,
				delegationId,
				kind: event.kind,
				title: event.title,
				contentHash: `sha256:${createHash("sha256").update(JSON.stringify({ kind: event.kind, title: event.title, content: event.content, metadata: event.metadata })).digest("hex")}`,
				...(event.itemId ? { itemId: event.itemId } : {}),
			}));
	}

	async getWorkspaceChangeSet(id: string | undefined): Promise<WorkspaceChangeSet | undefined> {
		return id && this.workspaceExecution ? this.workspaceExecution.getChangeSet(id) : undefined;
	}

	async createVerificationEnvironment(scopeId: string, verificationId: string, mode: "isolated_copy" | "same_target_guarded" = "isolated_copy"): Promise<VerificationEnvironmentCopy> {
		if (!this.workspaceExecution) throw new Error("WorkspaceExecutionCoordinator 未启用");
		const scope = await this.workspaceExecution.get(scopeId);
		if (!scope) throw new Error(`Workspace execution scope 不存在：${scopeId}`);
		return mode === "isolated_copy"
			? this.workspaceExecution.createVerificationCopy(scopeId, verificationId, scope.ownerToken)
			: this.workspaceExecution.createGuardedVerificationTarget(scopeId, verificationId, scope.ownerToken);
	}

	async createGoalVerificationEnvironment(input: { workspacePath: string; workspaceId?: string; verificationId: string; goalId: string; goalEpoch: number }): Promise<StandaloneVerificationEnvironment> {
		if (!this.workspaceExecution) throw new Error("WorkspaceExecutionCoordinator 未启用");
		return this.workspaceExecution.createStandaloneVerificationCopy(input);
	}

	async releaseVerificationEnvironment(copyId: string): Promise<void> {
		await this.workspaceExecution?.releaseVerificationCopy(copyId);
	}

	async observeVerificationEnvironment(copyId: string): Promise<VerificationEnvironmentObservation> {
		if (!this.workspaceExecution) throw new Error("WorkspaceExecutionCoordinator 未启用");
		return this.workspaceExecution.observeVerificationCopy(copyId);
	}

	async promoteWorkspaceChangeSet(scopeId: string, changeSetId: string): Promise<WorkspaceChangeSet> {
		if (!this.workspaceExecution) throw new Error("WorkspaceExecutionCoordinator 未启用");
		const scope = await this.workspaceExecution.get(scopeId);
		if (!scope) throw new Error(`Workspace execution scope 不存在：${scopeId}`);
		return this.workspaceExecution.promote(scopeId, changeSetId, scope.ownerToken);
	}

	async releaseWorkspaceExecutionScope(scopeId: string, cleanup = true): Promise<void> {
		if (!this.workspaceExecution) return;
		const scope = await this.workspaceExecution.get(scopeId);
		if (!scope) return;
		await this.workspaceExecution.release(scopeId, { ownerToken: scope.ownerToken, cleanup });
	}

	/**
	 * 该 delegation 的 Run 是否在本进程内存中活着（activeDelegations 登记所有
	 * 活 Run，含无 sessionHandle 的一次性 CLI driver）。持久化状态
	 *  running/waiting_input 跨重启后可能没有活 Run（进程重启即死），历史
	 * 重放的"仍在执行"标注必须以此为准，不能把陈旧记录标成运行中。
	 */
	isDelegationActive(delegationId: string): boolean {
		return this.activeDelegations.has(delegationId);
	}

	/** 列出窗口下的 interactions（审批卡列表对账，H3）。 */
	async listInteractions(windowId?: string): Promise<InteractionRecord[]> {
		await this.expireAdmissionRequests();
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
