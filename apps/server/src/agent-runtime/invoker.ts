import { TeamsStore, agentDisplayName, type AgentConfig, type WindowConfig } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { AgentRuntime, SessionConflictError } from "./runtime.js";
import type { DelegationRecord } from "./delegation-store.js";
import { DriverRegistry } from "./driver-registry.js";
import { PuddingClawDriver } from "./puddingclaw-driver.js";
import type { AgentDriver, DriverCapabilities, InvocationContext, NormalizedResult } from "./types.js";
import { ExtensionCatalog, resolveAgentCapabilityRuntime } from "./extensions.js";
import type { ProductSettingsStore } from "../store/product-settings.js";
import { resolveWorkerCodeSearch } from "../pi-bridge/code-search.js";
import type { WorkspaceExecutionPolicy } from "./workspace-execution.js";

export interface AgentInvokeParams {
	/** Internal stable operation identity (replacement/recovery); manager tools omit it. */
	operationId?: string;
	windowId: string;
	managerSessionId: string;
	managerToolCallId?: string;
	goalId?: string;
	workPlanId?: string;
	workItemId?: string;
	attempt?: number;
	goalEpoch?: number;
	goalRevision?: number;
	workItemRevision?: number;
	contractHash?: string;
	workspaceExecutionPolicy?: WorkspaceExecutionPolicy;
	purpose?: "execution" | "verification";
	verificationId?: string;
	verifiesSubmissionId?: string;
	environmentProfileId?: string;
	verificationEnvironmentId?: string;
	parentDelegationId?: string;
	handoffKind?: "request" | "followup";
	intent?: string;
	expectedOutcome?: string;
	evidenceRequirements?: string[];
	completionBoundary?: string;
	agent: AgentConfig;
	message: string;
	/** "new" starts a fresh worker session; "continue" resumes the recorded one. */
	mode: "run" | "continue";
	/** Worker-specific business model (e.g. analytics_model_id). */
	model?: string;
	signal?: AbortSignal;
	onUpdate?: (content: string, details?: unknown) => void;
	/** Internal admission-replacement barrier; not exposed to manager tools. */
	onDelegationCreated?: (delegation: DelegationRecord) => void;
	/** Durable WorkState reservation checked after record creation and before Driver invocation. */
	onBeforeDriverStart?: (delegation: DelegationRecord) => Promise<void>;
}

export interface ReplacementWorkerCandidate {
	agentId: string;
	displayName: string;
	readOnlyEnforcement: "sandbox" | "remote_policy";
	verificationSource: "connector_declared";
}

export interface AgentInvokeResult {
	status: string;
	content: string;
	details: Record<string, unknown>;
	delegationId?: string;
	interactionId?: string;
	runHandle?: string;
	sessionHandle?: string;
	/** True when the delegation is now waiting for a user approval. */
	waitingInput: boolean;
	/** 409 语义：同一 Session 已有 active/waiting Run，不能重跑任务。 */
	conflict?: boolean;
}

/**
 * AgentInvoker：pi 工具（per-agent delegation Extension）与 AgentRuntime 之间
 * 的唯一业务通道。
 *
 * 职责（§1.1 责任边界）：
 * - 解析 worker 的会话连续性（room Session-scoped workerBindings）、加密密钥与 workspace cwd；
 * - 入口二次校验启用状态与窗口成员关系（§10.2 两层门控）：旧 Session 的陈旧
 *   tool schema 也可能到达这里，必须拒绝越权/已撤权的调用；
 * - 调用 Runtime.delegate / respond；
 * - 把归一化结果投影成工具可读的 result + details；
 * - needs_input 时返回“等待审批”结构，绝不指导 manager 重跑任务。
 */
export class AgentInvoker {
	private readonly windowLifecycle = new Map<string, Promise<unknown>>();
	/**
	 * 完成后通知 manager Session（§6.3）：sendCustomMessage(triggerTurn:true)
	 * 让 manager 在同一 pi Session 继续汇总。由 index.ts 注入，避免循环依赖。
	 */
	private managerSender:
		| ((
				managerSessionId: string,
				message: {
					customType: string;
					content: string;
					details?: Record<string, unknown>;
				},
				options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		  ) => Promise<void>)
		| undefined;
	private durableManagerSender:
		| ((
				managerSessionId: string,
				eventId: string,
				message: { customType: string; content: string; details?: Record<string, unknown> },
				options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		  ) => Promise<void>)
		| undefined;
	private delegationStateObserver: (() => Promise<void>) | undefined;
	private replacementWindowResolver:
		| ((delegation: DelegationRecord, agent: AgentConfig) => Promise<string>)
		| undefined;
	private replacementStateGuard:
		| ((original: DelegationRecord, replacement: DelegationRecord, agent: AgentConfig, windowId: string) => Promise<void>)
		| undefined;

	constructor(
		private readonly teams: TeamsStore,
		private readonly runtime: AgentRuntime,
		private readonly drivers: DriverRegistry,
		private readonly credentials?: CredentialsStore,
		private readonly defaultCwd?: string,
		private readonly extensionCatalog?: ExtensionCatalog,
		private readonly capabilityStateRoot?: string,
		private readonly productSettings?: ProductSettingsStore,
		private readonly fffStateRoot?: string,
	) {}

	/** 注入 manager 会话通知器（PiSessionStore），启动时由 index.ts 调用。 */
	setManagerSender(
		sender: AgentInvoker["managerSender"],
	): void {
		this.managerSender = sender;
	}

	setDurableManagerSender(sender: NonNullable<AgentInvoker["durableManagerSender"]>): void {
		this.durableManagerSender = sender;
	}

	setDelegationStateObserver(observer: () => Promise<void>): void {
		this.delegationStateObserver = observer;
	}

	setReplacementWindowResolver(resolver: (delegation: DelegationRecord, agent: AgentConfig) => Promise<string>): void {
		this.replacementWindowResolver = resolver;
	}

	setReplacementStateGuard(guard: (original: DelegationRecord, replacement: DelegationRecord, agent: AgentConfig, windowId: string) => Promise<void>): void {
		this.replacementStateGuard = guard;
	}

	private observeDelegationState(): void {
		void this.delegationStateObserver?.().catch(() => undefined);
	}

	private async reconcileDelegationState(): Promise<void> {
		await this.delegationStateObserver?.();
	}

	/**
	 * 该 manager Session 里仍在执行的委托的工具调用 id 列表（历史重放修正
	 * "已中断"误标用）：以内存中的活 Run 为准（isDelegationActive），持久化
	 * 的 running/waiting_input 跨重启后不算数。
	 */
	async runningDelegateToolCallIds(managerSessionId: string): Promise<string[]> {
		const list = await this.runtime.listDelegations(undefined, managerSessionId);
		return list
			.filter((d) => (d.executionState === "running" || d.executionState === "waiting_input" || d.executionState === "reconciling") && this.runtime.isDelegationActive(d.id))
			.map((d) => d.managerToolCallId)
			.filter((id): id is string => Boolean(id));
	}

	/** Serialize the short transition boundary for one window. */
	private withWindowLifecycle<T>(windowId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.windowLifecycle.get(windowId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.windowLifecycle.set(windowId, tail);
		void tail.finally(() => {
			if (this.windowLifecycle.get(windowId) === tail) this.windowLifecycle.delete(windowId);
		});
		return run;
	}

	private withWindowLifecycles<T>(windowIds: string[], fn: () => Promise<T>): Promise<T> {
		const ids = [...new Set(windowIds)].sort();
		const enter = (index: number): Promise<T> =>
			index >= ids.length
				? fn()
				: this.withWindowLifecycle(ids[index]!, () => enter(index + 1));
		return enter(0);
	}

	/** Serialize admission with workspace switching and re-check active context inside the gate. */
	async withActiveSessionLifecycle<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
		const initial = await this.teams.contextForSession(sessionId);
		if (!initial) return action();
		return this.withWindowLifecycle(initial.window.id, async () => {
			const current = await this.teams.contextForSession(sessionId);
			if (!current || current.window.id !== initial.window.id || !current.active) {
				throw new Error("该会话所属项目未激活，请先切换回对应项目");
			}
			return action();
		});
	}

	private async envFor(agent: AgentConfig): Promise<NodeJS.ProcessEnv> {
		const secrets = this.credentials ? await this.credentials.getSecrets(agent.name) : {};
		return { ...process.env, ...(agent.env ?? {}), ...secrets };
	}

	/** 解析当前房间 Session 对该 worker 的 handle（continue 用）。 */
	async sessionHandleFor(windowId: string, managerSessionId: string, agent: AgentConfig): Promise<string | undefined> {
		const [target, ownerContext] = await Promise.all([
			this.teams.getWindow(windowId),
			this.teams.contextForSession(managerSessionId),
		]);
		const owner = ownerContext?.window;
		const binding = ownerContext?.workerBindings?.[managerSessionId]?.[agent.name];
		if (!target || !owner || !ownerContext.active || !binding) return undefined;
		const legalTarget = owner.type === "solo"
			? target.type === "direct" && target.members.includes(agent.name)
			: target.id === owner.id;
		if (!legalTarget || binding.targetWindowId !== target.id) return undefined;
		if (binding.workspaceId !== target.workspaceId) return undefined;
		if (binding.cwdSnapshot !== (await this.teams.workspaceFor(windowId))) return undefined;
		if (binding.agentRevision !== (agent.extensionRevision ?? 0)) return undefined;
		return binding.sessionHandle;
	}

	/** 该窗口可委托的 Agent（启用的成员）。 */
	async windowAgents(windowId: string): Promise<AgentConfig[]> {
		return this.teams.windowMembers(windowId);
	}

	async activeDelegations(windowId: string) {
		return (await this.runtime.listDelegations(windowId)).filter(
			(d) => d.executionState === "waiting_admission" || d.executionState === "running" || d.executionState === "waiting_input" || d.executionState === "cancel_requested" || d.executionState === "reconciling",
		);
	}

	/** Seal one conversation Session against new work, cancel its Runs, then mutate storage. */
	async closeManagerSession<T>(
		managerSessionId: string,
		preflight: () => Promise<void>,
		transition: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const owner = await this.teams.windowForSession(managerSessionId);
		const close = async () => {
			await preflight();
			const active = (await this.runtime.listDelegations(undefined, managerSessionId))
				.filter((item) => item.executionState === "waiting_admission" || item.executionState === "running" || item.executionState === "waiting_input" || item.executionState === "cancel_requested" || item.executionState === "reconciling");
			for (const item of active) await this.cancelUnlocked(item.id, signal);
			return transition();
		};
		return owner ? this.withWindowLifecycle(owner.id, close) : close();
	}

	/** Seal a Window against new work, cancel every owned/routed Run, then remove it. */
	async closeWindow<T>(
		windowId: string,
		preflight: () => Promise<void>,
		transition: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		return this.withWindowLifecycle(windowId, async () => {
			await preflight();
			const current = await this.teams.getWindow(windowId);
			const sessionIds = new Set(current?.sessions ?? []);
			const active = (await this.runtime.listDelegations()).filter(
				(item) =>
					(item.windowId === windowId || sessionIds.has(item.managerSessionId))
					&& (item.executionState === "waiting_admission" || item.executionState === "running" || item.executionState === "waiting_input" || item.executionState === "cancel_requested" || item.executionState === "reconciling"),
			);
			for (const item of active) await this.cancelUnlocked(item.id, signal);
			return transition();
		});
	}

	/** Goal reviewer 的只读证据投影：只返回属于该 manager Session 的委托。 */
	async delegationsForManagerSession(managerSessionId: string) {
		return this.runtime.listDelegations(undefined, managerSessionId);
	}

	/**
	 * Validate the target, quiesce and persist the source, then atomically swap
	 * the solo context. New message/delegate/respond admissions share this gate;
	 * the old in-memory Session is unloaded only after the commit succeeds.
	 */
	async switchWorkspaceInPlace(
		windowId: string,
		workspaceId: string | undefined,
		createSession: (source: WindowConfig, cwd: string) => Promise<{ id: string }>,
		prepareSessionForParking: (sessionId: string) => Promise<unknown>,
		validateStoredSession: (sessionId: string) => Promise<unknown>,
		suspendSession: (sessionId: string) => Promise<unknown>,
		removeSession: (sessionId: string) => Promise<unknown>,
	): Promise<{ window: WindowConfig; restored: boolean; existed: boolean }> {
		const initial = await this.teams.getWindow(windowId);
		if (!initial) throw new Error(`window not found: ${windowId}`);
		const initialRelated = (await this.runtime.listDelegations()).filter(
			(item) => item.windowId === initial.id || initial.sessions.includes(item.managerSessionId),
		);
		return this.withWindowLifecycles(
			[windowId, ...initialRelated.map((item) => item.windowId)],
			async () => {
				const source = await this.teams.getWindow(windowId);
				if (!source) throw new Error(`window not found: ${windowId}`);
				if (source.type !== "solo") throw new Error("只有全局 Solo 窗口支持原地切换项目；单聊和群聊请打开项目对应窗口");
				const target = await this.teams.contextForWorkspace(workspaceId);
				if (source.workspaceId === workspaceId && source.cwdSnapshot === target.cwdSnapshot) {
					return { window: source, restored: true, existed: true };
				}
				let created: { id: string } | undefined;
				let switched: Awaited<ReturnType<TeamsStore["replaceWindowWorkspace"]>>;
				try {
					const parked = await this.teams.parkedWindowContext(source.id, workspaceId);
					if (parked) {
						for (const id of parked.sessions) await validateStoredSession(id);
					} else {
						created = await createSession(source, target.cwdSnapshot);
					}
					const related = (await this.runtime.listDelegations()).filter(
						(item) =>
							(item.windowId === source.id || source.sessions.includes(item.managerSessionId)) &&
							(item.executionState === "waiting_admission" || item.executionState === "running" || item.executionState === "waiting_input" || item.executionState === "cancel_requested" || item.executionState === "reconciling"),
					);
					for (const delegation of related) await this.cancelUnlocked(delegation.id);
					for (const id of source.sessions) await prepareSessionForParking(id);
					switched = await this.teams.replaceWindowWorkspace(source.id, workspaceId, created?.id, source);
				} catch (err) {
					if (created) await removeSession(created.id).catch(() => undefined);
					throw err;
				}
				for (const id of source.sessions) await Promise.resolve(suspendSession(id)).catch(() => undefined);
				if (switched.restored && created) await removeSession(created.id).catch(() => undefined);
				return { ...switched, existed: switched.restored };
			},
		);
	}

	/**
	 * 读取最新 Agent 配置并校验启用状态（撤权入口，§3.3.6）。Extension 的
	 * ScopedAgentInvoker 与 delegate 入口都经此校验，禁用的 Agent 立即被拒；
	 * pinned 内置 manager 不是可委托的 worker（§10.5）。
	 */
	async requireAgent(agentName: string): Promise<AgentConfig> {
		const agent = await this.teams.getAgent(agentName);
		if (!agent) throw new Error(`agent「${agentName}」不存在，委托被拒绝`);
		if (agent.pinned || agent.invoke?.type === "pi") throw new Error(`agent「${agentName}」是内置 manager，不能被委托`);
		if (agent.enabled === false) throw new Error(`agent「${agentName}」已被禁用，委托被拒绝`);
		return agent;
	}

	/** 该 Agent 的 Driver capabilities（registry 命中或第一方 fallback）。 */
	async capabilitiesFor(agentName: string): Promise<DriverCapabilities | undefined> {
		const agent = await this.teams.getAgent(agentName);
		if (!agent) return undefined;
		const driver = this.drivers.get(agent.name) ?? this.resolveDriverFor(agent);
		if (!driver) return undefined;
		const capabilities = await driver.capabilities();
		this.assertBindingTransport(agent, capabilities);
		return capabilities;
	}

	/** Eligible alternatives are server-derived and must actually close the
	 * current read-only capability gap. The response path recomputes this list. */
	async replacementCandidates(interactionId: string): Promise<ReplacementWorkerCandidate[]> {
		const interaction = await this.runtime.getInteraction(interactionId);
		const delegation = await this.runtime.getDelegationById(interactionId);
		if (!interaction || interaction.source !== "platform_policy" || !delegation) return [];
		const owner = await this.teams.windowForSession(delegation.managerSessionId);
		const executionWindow = await this.teams.getWindow(delegation.windowId);
		if (!owner || !executionWindow) return [];
		if (owner.type !== "solo" && owner.id !== executionWindow.id) return [];
		const available = owner.type === "solo"
			? (await this.teams.listAgents()).filter((agent) => agent.enabled !== false && !agent.pinned)
			: await this.teams.windowMembers(executionWindow.id);
		const assessed = await Promise.all(available
			.filter((agent) => agent.name !== delegation.agentId)
			.map(async (agent): Promise<ReplacementWorkerCandidate | undefined> => {
				try {
					const capabilities = await this.capabilitiesFor(agent.name);
					const enforcement = capabilities?.workspace?.readOnlyEnforcement;
					if (!capabilities?.operations.includes("run") || capabilities.workspace?.honorsInvocationCwd !== true) return undefined;
					if (enforcement !== "sandbox" && enforcement !== "remote_policy") return undefined;
					return {
						agentId: agent.name,
						displayName: agentDisplayName(agent),
						readOnlyEnforcement: enforcement,
						verificationSource: "connector_declared",
					};
				} catch {
					return undefined;
				}
			}));
		return assessed.filter((item): item is ReplacementWorkerCandidate => Boolean(item));
	}

	/**
	 * 解析某个 Agent 当前可用的 Driver（§10 Connector 绑定优先；legacy
	 * command invoke 走第一方 fallback）。Runtime 的 resolveDriver、probe
	 * 路由都走这里；未安装对应 Connector 时返回 undefined（connector_missing，
	 * 不静默回退 Generic CLI，§9.3.8）。
	 */
	async driverFor(agentName: string): Promise<AgentDriver | undefined> {
		const agent = await this.teams.getAgent(agentName);
		if (!agent || agent.pinned) return undefined;
		const driver = this.drivers.get(agent.name) ?? this.resolveDriverFor(agent);
		if (!driver) return undefined;
		this.assertBindingTransport(agent, await driver.capabilities());
		return driver;
	}

	private assertBindingTransport(agent: AgentConfig, capabilities: DriverCapabilities): void {
		if (!agent.connector || capabilities.transport === agent.connector.transport) return;
		throw new Error(
			`Connector「${agent.connector.connectorId}」返回 transport:${capabilities.transport}，`
			+ `与 Worker 绑定 transport:${agent.connector.transport} 不一致`,
		);
	}

	/** 发起一次委托（run/continue）。 */
	async delegate(params: AgentInvokeParams): Promise<AgentInvokeResult> {
		const { windowId, managerSessionId, message, mode } = params;
		let agent: AgentConfig | undefined;
		let sessionHandle: string | undefined;
		let delegation;
		try {
			if (params.parentDelegationId) {
				const parent = await this.runtime.getDelegation(params.parentDelegationId);
				if (!parent || parent.managerSessionId !== managerSessionId) {
					throw new Error("parentDelegationId 必须指向当前 Session 的既有委托（请使用上一次委托返回文本中给出的 delegationId）");
				}
			}
			const managerOwner = await this.teams.windowForSession(managerSessionId);
			if (!managerOwner) throw new Error("manager Session 不属于任何窗口，委托被拒绝");
			const prepared = await this.withWindowLifecycles([windowId, managerOwner.id], async () => {
				// The gate covers the last authoritative window read and persistence of
				// the Run record. A switch therefore sees every accepted delegation.
				const freshAgent = await this.requireAgent(params.agent.name);
				const window = await this.teams.getWindow(windowId);
				if (!window) throw new Error(`窗口「${windowId}」不存在，委托被拒绝`);
				const freshManagerOwner = await this.teams.windowForSession(managerSessionId);
				if (!freshManagerOwner || freshManagerOwner.id !== managerOwner.id) {
					throw new Error("manager Session 的窗口生命周期已变化，委托被拒绝");
				}
				const managerContext = await this.teams.contextForSession(managerSessionId);
				if (!managerContext?.active) throw new Error("该会话所属项目未激活，请先切换回对应项目");
				if (params.purpose !== "verification" && window.type !== "solo" && !window.members.includes(freshAgent.name)) {
					throw new Error(`agent「${freshAgent.name}」不是当前窗口的成员，委托被拒绝`);
				}
				const driver = this.drivers.get(freshAgent.name) ?? this.resolveDriverFor(freshAgent);
				if (!driver) throw new Error(`agent「${freshAgent.name}」没有可用的 Driver（未安装对应 Connector）`);
				this.assertBindingTransport(freshAgent, await driver.capabilities());
				const cwd = await this.teams.workspaceFor(windowId);
				if (managerContext.workspaceId !== window.workspaceId || managerContext.cwdSnapshot !== cwd) {
					throw new Error("manager Session 与当前执行窗口的 Workspace 不一致，委托被拒绝");
				}
				const nextSession = mode === "continue" ? await this.sessionHandleFor(windowId, managerSessionId, freshAgent) : undefined;
				let createdResolve!: () => void;
				let createdReject!: (reason: unknown) => void;
				const created = new Promise<void>((resolve, reject) => {
					createdResolve = resolve;
					createdReject = reject;
				});
				const env = await this.envFor(freshAgent);
				const revisionCheck = await this.teams.getAgent(freshAgent.name);
				if ((revisionCheck?.extensionRevision ?? -1) !== (freshAgent.extensionRevision ?? 0)) {
					throw new Error(`agent「${freshAgent.name}」配置在委托创建时发生变化，请重试`);
				}
				const runPromise = this.runtime.delegate(
					{
						windowId,
						workspaceId: window.workspaceId,
						cwdSnapshot: cwd,
						managerSessionId,
						managerToolCallId: params.managerToolCallId,
						goalId: params.goalId,
						workPlanId: params.workPlanId,
						workItemId: params.workItemId,
						attempt: params.attempt,
						goalEpoch: params.goalEpoch,
						goalRevision: params.goalRevision,
						workItemRevision: params.workItemRevision,
						contractHash: params.contractHash,
						workspaceExecutionPolicy: params.workspaceExecutionPolicy,
						purpose: params.purpose,
						verificationId: params.verificationId,
						verifiesSubmissionId: params.verifiesSubmissionId,
						environmentProfileId: params.environmentProfileId,
						verificationEnvironmentId: params.verificationEnvironmentId,
						parentDelegationId: params.parentDelegationId,
						handoffKind: params.handoffKind,
						intent: params.intent,
						expectedOutcome: params.expectedOutcome,
						evidenceRequirements: params.evidenceRequirements,
						completionBoundary: params.completionBoundary,
						agentId: freshAgent.name,
						agentRevision: freshAgent.extensionRevision ?? 0,
						message,
						mode,
						sessionHandle: nextSession,
						requestId: params.operationId,
						options: params.model ? { model: params.model } : undefined,
						onCreated: (record) => {
							params.onDelegationCreated?.(record);
							createdResolve();
						},
						beforeDriverStart: params.onBeforeDriverStart,
						driver,
					},
					{
						cwd,
						env,
						signal: params.signal,
						onUpdate: params.onUpdate,
					},
				);
				// Runtime admission can itself produce a durable terminal result (for
				// example workspace_policy_blocked) before the Driver starts, so
				// onCreated is intentionally never fired on that path.  Release the
				// admission barrier on either signal: onCreated keeps normal long runs
				// non-blocking, while an early settled Runtime outcome prevents the
				// manager delegate tool from hanging forever over an already-terminal
				// Delegation.
				void runPromise.then(createdResolve, createdReject);
				await created;
				return { agent: freshAgent, sessionHandle: nextSession, runPromise };
			});
			agent = prepared.agent;
			sessionHandle = prepared.sessionHandle;
			delegation = await prepared.runPromise;
		} catch (err) {
			if (err instanceof SessionConflictError) {
				// M5：冲突时把该 session 已有的 pending interaction 一起带出，
				// 前端才能折叠/跳转到真正的审批卡（solo 派活时卡片在对方的单聊窗口）。
				const conflictAgent = agent ?? params.agent;
				const pending = await this.pendingInteractionFor(conflictAgent.name, windowId, managerSessionId);
				return {
					status: "conflict",
					content: `worker「${agentDisplayName(conflictAgent)}」的会话仍在等待上一个任务的审批，不能发起新任务（409）。请先在上一个审批卡上操作。`,
					details: {
						conflict: true,
						sessionHandle,
						...pending,
					},
					interactionId: pending?.interactionId,
					waitingInput: true,
					conflict: true,
				};
			}
			throw err;
		}
		if (!agent) throw new Error("delegation accepted without an agent snapshot");

		// 记录新的 session handle 到 window（multi-turn continuity）。
		if (delegation.delegation.sessionHandle) {
			this.rememberSession(delegation.delegation);
		}

		const d = delegation.delegation;
		const base: Omit<AgentInvokeResult, "status" | "content" | "waitingInput"> = {
			delegationId: d.id,
			runHandle: d.runHandle,
			sessionHandle: d.sessionHandle,
			details: { ...(d.goalId ? { goalId: d.goalId } : {}) },
		};

		switch (delegation.status) {
			case "needs_input": {
				const interaction = delegation.interaction!;
				const platformPolicy = interaction.source === "platform_policy";
				// §6.5：向 manager session 追加安全投影（无 token），前端按
				// interactionId 渲染/折叠审批卡。
				if (this.managerSender && managerSessionId) {
					void this.managerSender(
						managerSessionId,
						{
							customType: "pudding:interaction_required",
							content: platformPolicy
								? `Teams 无法验证 worker「${agentDisplayName(agent)}」满足本任务的只读预期；Worker 尚未启动。`
								: `worker「${agentDisplayName(agent)}」需要人工审批才能继续。`,
							details: {
								interactionId: interaction.id,
								source: interaction.source,
								workerStarted: d.workerStarted,
								delegationId: d.id,
								...(d.goalId ? { goalId: d.goalId } : {}),
								worker: agent.name,
								status: "pending",
								revision: interaction.revision,
								requests: interaction.requests.map((r) => ({
									requestId: r.requestId,
									prompt: r.prompt,
									...(r.command ? { command: r.command } : {}),
									...(r.path ? { path: r.path } : {}),
									risk: r.risk,
									options: r.options,
								})),
							},
						},
						{ triggerTurn: false },
					).catch(() => undefined);
				}
				return {
					...base,
					status: "needs_input",
					content: platformPolicy
						? `Teams 需要用户确认是否仍使用 worker「${agentDisplayName(agent)}」；Worker 尚未启动。`
						: `worker「${agentDisplayName(agent)}」需要人工审批才能继续（已保存待处理请求，不会重跑任务）。`,
					details: {
						interactionId: interaction.id,
						source: interaction.source,
						workerStarted: d.workerStarted,
						delegationId: d.id,
						...(d.goalId ? { goalId: d.goalId } : {}),
						kind: interaction.kind,
						revision: interaction.revision,
						requests: interaction.requests.map((r) => ({
							requestId: r.requestId,
							prompt: r.prompt,
							...(r.command ? { command: r.command } : {}),
							...(r.path ? { path: r.path } : {}),
							risk: r.risk,
							options: r.options,
						})),
						expiresAt: interaction.expiresAt,
					},
					interactionId: interaction.id,
					waitingInput: true,
				};
			}
			case "failed": {
				const result = delegation.result;
				const cancelled = result?.status === "cancelled";
				const err = result && "error" in result ? result.error : "worker 执行失败";
				return {
					...base,
					status: cancelled ? "cancelled" : "failed",
					content: cancelled ? `worker「${agentDisplayName(agent)}」任务已取消。` : `worker「${agentDisplayName(agent)}」执行出错：${err}`,
					details: {
						...(result?.meta ?? {}),
						errorCode: result && "errorCode" in result ? result.errorCode : undefined,
					},
					waitingInput: false,
				};
			}
			case "completed": {
				const result = delegation.result;
				const workspaceChangeSet = await this.runtime.getWorkspaceChangeSet(d.workspaceChangeSetId);
				return {
					...base,
					status: "completed",
					content: result?.content ?? "",
					details: {
						...(result?.meta ?? {}),
						artifacts: result?.artifacts,
						usage: result?.usage,
						executionReceipt: d.receipt,
						workspaceChangeSet,
					},
					waitingInput: false,
				};
			}
		}
	}

	/** 提交审批：用户点击允许/拒绝后调用（对应 /api/interactions/:id/responses）。 */
	async respond(
		interactionId: string,
		input: { requestId: string; revision: number; responses: Array<{ requestId: string; action: string; scope?: string; value?: unknown }> },
		signal?: AbortSignal,
	): Promise<AgentInvokeResult> {
		const delegation = await this.runtime.getDelegationById(interactionId);
		if (!delegation) throw new Error("interaction or delegation not found");
		const managerContext = await this.teams.contextForSession(delegation.managerSessionId);
		if (
			!managerContext?.active ||
			managerContext.workspaceId !== delegation.workspaceId ||
			managerContext.cwdSnapshot !== delegation.cwdSnapshot
		) {
			throw new Error("该审批所属项目未激活，请先切换回对应项目");
		}
		const interaction = await this.runtime.getInteraction(interactionId);
		const platformPolicy = interaction?.source === "platform_policy";
		const replacementResponse = platformPolicy
			? input.responses.find((response) => response.scope === "select_another_worker")
			: undefined;
		if (replacementResponse) {
			const replacementAgentId = typeof replacementResponse.value === "string" ? replacementResponse.value.trim() : "";
			return this.replaceAdmissionWorker(interactionId, input, delegation, replacementAgentId, signal);
		}
		const managerOwner = managerContext.window;
		if (!managerOwner) throw new Error("manager Session 已被删除，不能继续审批");
		const targets = await this.outcomeTargets(delegation);
		const workerLabel = agentDisplayName((await this.teams.getAgent(delegation.agentId)) ?? { name: delegation.agentId });
		const prepared = await this.withWindowLifecycles(
			[delegation.windowId, managerOwner.id],
			async () => {
				const [currentContext, currentTarget] = await Promise.all([
					this.teams.contextForSession(delegation.managerSessionId),
					this.teams.getWindow(delegation.windowId),
				]);
				const currentOwner = currentContext?.window;
				const legalTarget = currentOwner?.type === "solo"
					? currentTarget?.type === "direct" && currentTarget.members.includes(delegation.agentId)
					: currentTarget?.id === currentOwner?.id;
				if (
					currentOwner?.id !== managerOwner.id ||
					!currentContext?.active ||
					currentContext.workspaceId !== delegation.workspaceId ||
					currentContext.cwdSnapshot !== delegation.cwdSnapshot ||
					!currentTarget ||
					!legalTarget
				) {
					throw new Error("委托所属房间或执行窗口已被删除，不能继续审批");
				}
				// continuing=true 表示审批已受理、worker 即将续跑（可能跑很久）；
				// false 表示终态/冲突路径，完整结果紧随其后。
				let admittedResolve!: (continuing: boolean) => void;
				let admittedReject!: (reason: unknown) => void;
				const admitted = new Promise<boolean>((resolve, reject) => {
					admittedResolve = resolve;
					admittedReject = reject;
				});
				const responsePromise = this.respondUnlocked(interactionId, input, signal, (continuing) => {
					if (continuing) {
						this.observeDelegationState();
						// Approval is resolved at admission time, not when the resumed worker
						// eventually finishes. This immediately reconciles the task card in
						// both the manager room and the mirrored worker direct room.
						const resumed = {
							customType: "pudding:interaction_resolved",
							content: platformPolicy
								? `Teams 准入已确认，worker「${workerLabel}」开始执行；其只读能力仍为未验证。`
								: `worker「${workerLabel}」的审批已通过，任务继续执行中。`,
								details: {
									interactionId,
									delegationId: delegation.id,
									worker: delegation.agentId,
									status: "approved",
									source: platformPolicy ? "platform_policy" : "worker",
									workerStarted: true,
							},
						};
						if (targets.manager) this.sendOutcome(targets.manager, resumed, { triggerTurn: false });
						if (targets.direct) this.sendOutcome(targets.direct, resumed, { triggerTurn: false });
					}
					admittedResolve(continuing);
				});
				void responsePromise.catch((error) => {
					this.observeDelegationState();
					admittedReject(error);
				});
				await Promise.race([admitted, responsePromise.then(() => undefined)]);
				return { admitted, responsePromise };
			},
		);
		// 受理即返回：HTTP 不等 worker 续跑落定，立即给前端「已批准」反馈；
		// interaction_resolved(approved) 已在受理点即时扇出；续跑的后续边界
		// （completed/needs_input/failed）再由 respondUnlocked 投影 task_result
		// 或下一轮 interaction_required 到两边窗口。
		return Promise.race([
			prepared.admitted.then((continuing): Promise<AgentInvokeResult> | AgentInvokeResult =>
				continuing
					? {
							status: "approved",
							content: platformPolicy ? "Teams 准入决定已受理，Worker 开始执行。" : "审批已受理，任务继续执行中。",
							details: { interactionId, admitted: true },
							delegationId: delegation.id,
							waitingInput: false,
						}
					: prepared.responsePromise,
			),
			prepared.responsePromise,
		]);
	}

	private async replaceAdmissionWorker(
		interactionId: string,
		input: { requestId: string; revision: number; responses: Array<{ requestId: string; action: string; scope?: string; value?: unknown }> },
		original: DelegationRecord,
		replacementAgentId: string,
		signal?: AbortSignal,
	): Promise<AgentInvokeResult> {
		const currentInteraction = await this.runtime.getInteraction(interactionId);
		const replayCandidate = currentInteraction?.consumedRequestId === input.requestId;
		const candidate = replayCandidate
			? undefined
			: (await this.replacementCandidates(interactionId)).find((item) => item.agentId === replacementAgentId);
		if (!replayCandidate && !candidate) throw new Error("所选 Worker 已不可用或不能补足当前只读能力，请刷新后重选");
		const originalAgent = await this.teams.getAgent(original.agentId);
		const begun = await this.withActiveSessionLifecycle(original.managerSessionId, () =>
			this.runtime.beginAdmissionReplacement(
				interactionId,
				{
					requestId: input.requestId,
					revision: input.revision,
					responses: input.responses.map((response) => ({
						requestId: response.requestId,
						action: response.action as "approve" | "reject" | "answer" | "confirm",
						scope: response.scope,
						value: response.value,
					})),
				},
				replacementAgentId,
				{ cwd: original.cwdSnapshot, env: process.env, signal },
			),
		);
		if (begun.replayed) {
			const application = begun.interaction.application;
			if (application?.status === "failed") {
				throw new Error(`该改派请求已失败（${application.failureCode ?? "replacement_failed"}）`);
			}
			if (application?.status !== "applied") throw new Error("该改派请求正在处理中，请稍候刷新");
			const replacementDelegationId = application.replacementDelegationId;
			if (!replacementDelegationId) throw new Error("改派记录缺少 replacement Delegation，已拒绝伪造成功状态");
			const replacementLabel = (await this.teams.getAgent(replacementAgentId))?.displayName ?? replacementAgentId;
			return {
				status: "replaced",
				content: `任务已改派给 worker「${replacementLabel}」。`,
				details: { interactionId, originalDelegationId: original.id, replacementDelegationId, replacementWorker: replacementAgentId, replayed: true },
				delegationId: replacementDelegationId,
				waitingInput: false,
			};
		}
		if (!candidate) throw new Error("改派候选状态已失效，请刷新后重选");
		const replacementAgent = await this.requireAgent(replacementAgentId);
		const owner = await this.teams.windowForSession(original.managerSessionId);
		let replacementWindowId = original.windowId;
		try {
			if (owner?.type === "solo") {
				if (!this.replacementWindowResolver) throw new Error("无法为替代 Worker 创建执行窗口");
				replacementWindowId = await this.replacementWindowResolver(original, replacementAgent);
			}
		} catch (error) {
			await this.runtime.failAdmissionReplacement(interactionId, "replacement_window_unavailable");
			await this.reconcileDelegationState();
			await this.projectReplacementStartFailure(original, interactionId, replacementAgentId, error);
			throw error;
		}

		let createdResolve!: (delegation: DelegationRecord) => void;
		let createdReject!: (error: unknown) => void;
		let createdSeen = false;
		const created = new Promise<DelegationRecord>((resolve, reject) => {
			createdResolve = resolve;
			createdReject = reject;
		});
		const runPromise = this.delegate({
			operationId: `admission-replacement:${original.id}`,
			windowId: replacementWindowId,
			managerSessionId: original.managerSessionId,
			goalId: original.goalId,
			workPlanId: original.workPlanId,
			workItemId: original.workItemId,
			attempt: (original.attempt ?? 0) + 1,
			goalEpoch: original.goalEpoch,
			goalRevision: original.goalRevision,
			workItemRevision: original.workItemRevision,
			contractHash: original.contractHash,
			workspaceExecutionPolicy: original.workspaceExecutionPolicy,
			purpose: original.purpose,
			verificationId: original.verificationId,
			verifiesSubmissionId: original.verifiesSubmissionId,
			environmentProfileId: original.environmentProfileId,
			verificationEnvironmentId: original.verificationEnvironmentId,
			parentDelegationId: original.id,
			handoffKind: "request",
			intent: original.intent,
			expectedOutcome: original.expectedOutcome,
			evidenceRequirements: original.evidenceRequirements,
			completionBoundary: original.completionBoundary,
			agent: replacementAgent,
			message: original.task ?? "",
			mode: "run",
			model: typeof original.options?.model === "string" ? original.options.model : undefined,
			signal,
			onBeforeDriverStart: async (replacement) => {
				if (!this.replacementStateGuard) throw new Error("replacement WorkState guard is unavailable");
				await this.replacementStateGuard(original, replacement, replacementAgent, replacementWindowId);
			},
			onDelegationCreated: (replacement) => {
				createdSeen = true;
				createdResolve(replacement);
			},
		});
		void runPromise.then((outcome) => {
			if (!createdSeen) createdReject(new Error(outcome.content || "replacement Delegation failed before Driver start"));
		}, createdReject);
		let replacement: DelegationRecord | undefined;
		try {
			replacement = await created;
			if (replacement.replacementAdmissionReady !== true) {
				if (replacement.executionState === "waiting_admission") {
					await this.runtime.cancel(replacement.id, { cwd: replacement.cwdSnapshot, env: process.env }).catch(() => undefined);
					replacement = await this.runtime.getDelegation(replacement.id) ?? replacement;
				}
				throw new Error("替代 Worker 的能力或执行上下文在启动前发生变化，改派未生效");
			}
			await this.runtime.completeAdmissionReplacement(interactionId, replacement.id);
		} catch (error) {
			if (!replacement) {
				const matches = (await this.runtime.listDelegations(original.windowId, original.managerSessionId))
					.filter((item) => item.operationId === `admission-replacement:${original.id}` && item.parentDelegationId === original.id);
				if (matches.length === 1) replacement = matches[0];
			}
			await this.runtime.failAdmissionReplacement(interactionId, "replacement_start_failed", replacement?.id);
			await this.reconcileDelegationState().catch(() => undefined);
			await this.projectReplacementStartFailure(original, interactionId, replacementAgentId, error, replacement);
			throw error;
		}
		// WorkState projection is derived state. Once the application CAS is
		// applied, a transient projection error must not rewrite it to failed while
		// the replacement Worker continues running.
		await this.reconcileDelegationState().catch(() => undefined);
		const replacementWindow = await this.teams.getWindow(replacementWindowId);
		if (replacementWindow?.activeSession && replacementWindow.activeSession !== original.managerSessionId) {
			this.sendOutcome(replacementWindow.activeSession, {
				customType: "pudding:task_assign",
				content: `Teams 已将任务改派给 worker「${candidate.displayName}」。`,
				details: { taskId: replacement.id, delegationId: replacement.id, worker: replacement.agentId, status: "running", replacement: true, parentDelegationId: original.id, processView: true },
			}, { triggerTurn: false });
		}

		const originalLabel = agentDisplayName(originalAgent ?? { name: original.agentId });
		const targets = await this.outcomeTargets(original);
		const resolved = {
			customType: "pudding:interaction_resolved",
			content: `已将任务从 worker「${originalLabel}」改派给「${candidate.displayName}」；原 Worker 未启动。`,
			details: {
				interactionId,
				delegationId: original.id,
				replacementDelegationId: replacement.id,
				worker: original.agentId,
				replacementWorker: replacementAgentId,
				status: "replaced",
				source: "platform_policy",
				workerStarted: false,
			},
		};
		if (targets.manager) this.sendOutcome(targets.manager, resolved, { triggerTurn: false });
		if (targets.direct) this.sendOutcome(targets.direct, resolved, { triggerTurn: false });
		void runPromise.then(
			(outcome) => this.projectReplacementOutcome(replacement!.id, candidate.displayName, outcome).catch(() => undefined),
			(error: unknown) => this.projectReplacementFailure(replacement!.id, candidate.displayName, error).catch(() => undefined),
		);
		return {
			status: "replaced",
			content: `任务已改派给 worker「${candidate.displayName}」。`,
			details: { interactionId, originalDelegationId: original.id, replacementDelegationId: replacement.id, replacementWorker: replacementAgentId },
			delegationId: replacement.id,
			waitingInput: replacement.executionState === "waiting_admission" || replacement.executionState === "waiting_input",
		};
	}

	private async projectReplacementOutcome(delegationId: string, workerLabel: string, outcome: AgentInvokeResult): Promise<void> {
		await this.reconcileDelegationState();
		const delegation = await this.runtime.getDelegation(delegationId);
		if (!delegation) return;
		const targets = await this.outcomeTargets(delegation);
		if (outcome.status === "needs_input") {
			if (targets.direct) {
				this.sendOutcome(targets.direct, {
					customType: "pudding:interaction_required",
					content: `改派后的 worker「${workerLabel}」需要人工确认。`,
					details: { ...outcome.details, delegationId, worker: delegation.agentId, status: "pending", replacement: true },
				}, { triggerTurn: false });
			}
			return;
		}
		const owner = await this.teams.windowForSession(delegation.managerSessionId);
		const message = {
			customType: "pudding:task_result",
			content: outcome.status === "completed" ? outcome.content : `改派后的 worker「${workerLabel}」执行失败：${outcome.content}`,
			details: { delegationId, worker: delegation.agentId, status: outcome.status, replacement: true, ...outcome.details },
		};
		if (targets.manager) {
			const options = owner?.type === "direct" ? { triggerTurn: false } as const : { triggerTurn: true, deliverAs: "followUp" } as const;
			if (this.durableManagerSender) await this.durableManagerSender(targets.manager, `replacement-result:${delegation.id}:${delegation.revision}`, message, options);
			else this.sendOutcome(targets.manager, message, options);
		}
		if (targets.direct) {
			if (this.durableManagerSender) await this.durableManagerSender(targets.direct, `replacement-result:${delegation.id}:${delegation.revision}`, message, { triggerTurn: false });
			else this.sendOutcome(targets.direct, message, { triggerTurn: false });
		}
	}

	private async projectReplacementFailure(delegationId: string, workerLabel: string, error: unknown): Promise<void> {
		await this.reconcileDelegationState().catch(() => undefined);
		const delegation = await this.runtime.getDelegation(delegationId);
		if (!delegation) return;
		const targets = await this.outcomeTargets(delegation);
		const message = {
			customType: "pudding:task_result",
			content: `改派后的 worker「${workerLabel}」启动失败：${error instanceof Error ? error.message : String(error)}`,
			details: { delegationId, worker: delegation.agentId, status: "failed", replacement: true },
		};
		if (targets.manager) {
			if (this.durableManagerSender) await this.durableManagerSender(targets.manager, `replacement-result:${delegation.id}:${delegation.revision}`, message, { triggerTurn: true, deliverAs: "followUp" });
			else this.sendOutcome(targets.manager, message, { triggerTurn: true, deliverAs: "followUp" });
		}
		if (targets.direct) {
			if (this.durableManagerSender) await this.durableManagerSender(targets.direct, `replacement-result:${delegation.id}:${delegation.revision}`, message, { triggerTurn: false });
			else this.sendOutcome(targets.direct, message, { triggerTurn: false });
		}
	}

	private async projectReplacementStartFailure(original: DelegationRecord, interactionId: string, replacementAgentId: string, error: unknown, replacement?: DelegationRecord): Promise<void> {
		if (!this.durableManagerSender) return;
		const owner = await this.teams.windowForSession(original.managerSessionId);
		await this.durableManagerSender(
			original.managerSessionId,
			replacement ? `replacement-result:${replacement.id}:${replacement.revision}` : `replacement-start-failed:${original.id}:${interactionId}`,
			{
				customType: "pudding:task_result",
				content: `任务未能改派给 worker「${replacementAgentId}」：${error instanceof Error ? error.message : String(error)}`,
				details: { interactionId, delegationId: replacement?.id ?? original.id, originalDelegationId: original.id, replacementWorker: replacementAgentId, status: "failed", replacement: true },
			},
			owner?.type === "direct" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "followUp" },
		);
	}

	/**
	 * 审批结果扇出目标（两边同步）：manager session + delegation 所属窗口的
	 * active session（单聊镜像）。两者相同则只发 manager，窗口读取失败仅跳过镜像。
	 */
	private async outcomeTargets(d: DelegationRecord): Promise<{ manager?: string; direct?: string }> {
		const manager = d.managerSessionId || undefined;
		let direct: string | undefined;
		try {
			const window = await this.teams.getWindow(d.windowId);
			const active = window?.activeSession;
			if (active && active !== manager) direct = active;
		} catch {
			// 镜像目标解析失败不影响主流程。
		}
		return { manager, direct };
	}

	/** managerSender 的容错封装：通知失败不影响审批结果返回。 */
	private sendOutcome(
		sessionId: string,
		message: { customType: string; content: string; details?: Record<string, unknown> },
		options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		if (!this.managerSender) return;
		void this.managerSender(sessionId, message, options).catch(() => undefined);
	}

	private async respondUnlocked(
		interactionId: string,
		input: { requestId: string; revision: number; responses: Array<{ requestId: string; action: string; scope?: string; value?: unknown }> },
		signal?: AbortSignal,
		onAdmitted?: (continuing: boolean) => void,
	): Promise<AgentInvokeResult> {
		// H5：respond 也要用该 agent 的凭证 + workspace cwd，否则子进程裸环境
		// 无 token、无 PATH，且跑错目录。
		let ctxEnv: NodeJS.ProcessEnv = process.env;
		let cwd = this.defaultCwd ?? process.cwd();
		let driverSnapshot: AgentDriver | undefined;
		const delegation = await this.runtime.getDelegationById(interactionId);
		if (delegation) {
			const agent = await this.teams.getAgent(delegation.agentId);
			if (agent) {
				if ((agent.extensionRevision ?? 0) !== delegation.agentRevision) {
					throw new Error("Agent 配置已变化，不能用新配置恢复旧 Run；请取消旧任务后重试");
				}
				const window = await this.teams.getWindow(delegation.windowId);
				if (
					!window ||
					window.workspaceId !== delegation.workspaceId ||
					window.cwdSnapshot !== delegation.cwdSnapshot
				) {
					throw new Error("窗口项目已变化，不能恢复旧 Run");
				}
				await this.teams.workspaceFor(window.id);
				ctxEnv = await this.envFor(agent);
				driverSnapshot = this.drivers.get(agent.name) ?? this.resolveDriverFor(agent);
				if (!driverSnapshot) throw new Error(`agent「${agent.name}」没有可用的 Driver`);
				const revisionCheck = await this.teams.getAgent(agent.name);
				if ((revisionCheck?.extensionRevision ?? -1) !== delegation.agentRevision) {
					throw new Error("Agent 配置在恢复 Run 时发生变化，请重试");
				}
				// 恢复同一条 Run 必须使用 Delegation 创建时的不可变快照。
				cwd = delegation.cwdSnapshot;
			}
		}
		const outcome = await this.runtime.respond(
			interactionId,
			{
				requestId: input.requestId,
				revision: input.revision,
				responses: input.responses.map((r) => ({
					requestId: r.requestId,
					action: r.action as "approve" | "reject" | "answer" | "confirm",
					scope: r.scope,
					value: r.value,
				})),
			},
			{ cwd, env: ctxEnv, signal },
			driverSnapshot,
			onAdmitted,
		);
		const d = outcome.delegation;
		this.observeDelegationState();
		if (d.sessionHandle) {
			this.rememberSession(d);
		}
		// 两边同步：审批结果同时扇出到 manager session 和 delegation 所属窗口的
		// active session（单聊镜像），用户只在 solo 窗口也能看到全部结果。
		const targets = await this.outcomeTargets(d);
		// direct 直派（§5.2）：manager session 就是 direct 窗口自己的 session，
		// 窗口无 manager 回合，结果卡只展示、不唤醒 manager 汇总。
		const managerWindow = d.managerSessionId ? await this.teams.windowForSession(d.managerSessionId) : undefined;
		// 卡面文案渲染显示名；details.worker 保留内部 id（机器消费，前端映射）。
		const workerLabel = agentDisplayName((await this.teams.getAgent(d.agentId)) ?? { name: d.agentId });
		const taskResultOptions =
			managerWindow?.type === "direct"
				? ({ triggerTurn: false } as const)
				: ({ triggerTurn: true, deliverAs: "followUp" } as const);
		switch (outcome.status) {
			case "completed": {
				// §6.2/§6.3：完成后触发 manager follow-up 汇总（triggerTurn + followUp；
				// direct 窗口无 manager 回合，taskResultOptions 降级为仅展示），并把
				// worker 的真实结果带给 manager，否则汇总轮无内容可转述。
				const details = { ...(outcome.result.meta ?? {}), artifacts: outcome.result.artifacts, usage: outcome.result.usage };
				const taskResult = {
					customType: "pudding:task_result",
					content: outcome.result.content ?? "",
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "completed", ...details },
				};
				if (targets.manager) {
					// M5：manager 若在流式中，用 followUp 排队而不是 steer 打断。
					this.sendOutcome(targets.manager, taskResult, taskResultOptions);
				}
				if (targets.direct) {
					// 单聊窗口仅展示，不唤醒 turn。
					this.sendOutcome(targets.direct, taskResult, { triggerTurn: false });
				}
				return {
					status: "completed",
					content: outcome.result.content ?? "",
					details,
					delegationId: d.id,
					runHandle: d.runHandle,
					sessionHandle: d.sessionHandle,
					waitingInput: false,
				};
			}
			case "rejected": {
				const source = outcome.interaction?.source ?? "worker";
				const resolved = {
					customType: "pudding:interaction_resolved",
					content: source === "platform_policy" ? `用户未允许 Teams 使用 worker「${workerLabel}」，任务未启动。` : `worker「${workerLabel}」的审批被拒绝，任务已取消。`,
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "rejected", source, workerStarted: d.workerStarted },
				};
				const taskResult = {
					customType: "pudding:task_result",
					content: source === "platform_policy" ? "Teams 准入被取消，Worker 未启动。" : "审批被拒绝，任务已取消。",
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "cancelled", source, workerStarted: d.workerStarted },
				};
				if (targets.manager) {
					this.sendOutcome(targets.manager, resolved, { triggerTurn: false });
					this.sendOutcome(targets.manager, taskResult, taskResultOptions);
				}
				if (targets.direct) {
					this.sendOutcome(targets.direct, resolved, { triggerTurn: false });
					this.sendOutcome(targets.direct, taskResult, { triggerTurn: false });
				}
				return {
					status: "cancelled",
					content: "审批被拒绝，任务已取消。",
					details: {},
					delegationId: d.id,
					runHandle: d.runHandle,
					waitingInput: false,
				};
			}
			case "failed": {
				const errorText = outcome.result.status === "failed" ? outcome.result.error : "任务执行失败";
				const details = { ...(outcome.result.meta ?? {}), errorCode: "errorCode" in outcome.result ? outcome.result.errorCode : undefined };
				const taskResult = {
					customType: "pudding:task_result",
					content: errorText,
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "failed", ...details },
				};
				if (targets.manager) {
					this.sendOutcome(targets.manager, taskResult, taskResultOptions);
				}
				if (targets.direct) {
					this.sendOutcome(targets.direct, taskResult, { triggerTurn: false });
				}
				return {
					status: "failed",
					content: errorText,
					details,
					delegationId: d.id,
					runHandle: d.runHandle,
					waitingInput: false,
				};
			}
			case "needs_input": {
				// 又一轮审批：把新的 interaction（同 id、revision+1）投影到两边窗口，
				// 均不唤醒 turn，等用户再次操作。
				if (outcome.interaction) {
					const required = {
						customType: "pudding:interaction_required",
						content: `worker「${workerLabel}」需要更多审批才能继续。`,
							details: {
								interactionId: outcome.interaction.id,
								source: outcome.interaction.source,
								workerStarted: d.workerStarted,
							delegationId: d.id,
							worker: d.agentId,
							status: "pending",
							revision: outcome.interaction.revision,
							requests: outcome.interaction.requests.map((r) => ({
								requestId: r.requestId,
								prompt: r.prompt,
								...(r.command ? { command: r.command } : {}),
								...(r.path ? { path: r.path } : {}),
								risk: r.risk,
								options: r.options,
							})),
						},
					};
					if (targets.manager) this.sendOutcome(targets.manager, required, { triggerTurn: false });
					if (targets.direct) this.sendOutcome(targets.direct, required, { triggerTurn: false });
				}
				return {
					status: "needs_input",
					content: `worker「${workerLabel}」需要更多审批。`,
					details: {
						interactionId: outcome.interaction?.id,
						source: outcome.interaction?.source,
						workerStarted: d.workerStarted,
						delegationId: d.id,
						revision: outcome.interaction?.revision,
						requests: outcome.interaction?.requests,
					},
					interactionId: outcome.interaction?.id,
					delegationId: d.id,
					runHandle: d.runHandle,
					waitingInput: true,
				};
			}
		}
	}

	/** 取消一个 delegation（用户主动取消，非静默）。 */
	async cancel(delegationId: string, signal?: AbortSignal): Promise<void> {
		const delegation = await this.runtime.getDelegation(delegationId);
		if (!delegation) throw new Error("delegation not found");
		const managerOwner = await this.teams.windowForSession(delegation.managerSessionId);
		await this.withWindowLifecycles(
			[delegation.windowId, ...(managerOwner ? [managerOwner.id] : [])],
			() => this.cancelUnlocked(delegationId, signal),
		);
	}

	/** Delete/session lifecycle boundary: seal every active Run before its owner disappears. */
	async cancelManagerSession(managerSessionId: string, signal?: AbortSignal): Promise<number> {
		const candidateCount = (await this.runtime.listDelegations(undefined, managerSessionId))
			.filter((item) => item.executionState === "waiting_admission" || item.executionState === "running" || item.executionState === "waiting_input" || item.executionState === "cancel_requested" || item.executionState === "reconciling").length;
		await this.closeManagerSession(
			managerSessionId,
			async () => {
				const context = await this.teams.contextForSession(managerSessionId);
				if (context && !context.active) throw new Error("该会话所属项目未激活，请先切换回对应项目");
			},
			async () => undefined,
			signal,
		);
		return candidateCount;
	}

	getDelegation(delegationId: string): Promise<DelegationRecord | undefined> {
		return this.runtime.getDelegation(delegationId);
	}

	reconcileDelegation(delegationId: string, notify?: (delegation: DelegationRecord, result: NormalizedResult) => Promise<void>): Promise<DelegationRecord> {
		return this.runtime.reconcileDelegation(delegationId, notify);
	}

	confirmObservationLostStopped(delegationId: string, rationale: string): Promise<DelegationRecord> {
		return this.runtime.confirmObservationLostStopped(delegationId, rationale);
	}

	verificationObservations(delegationId: string) {
		return this.runtime.verificationObservations(delegationId);
	}

	createVerificationEnvironment(scopeId: string, verificationId: string, mode: "isolated_copy" | "same_target_guarded" = "isolated_copy") {
		return this.runtime.createVerificationEnvironment(scopeId, verificationId, mode);
	}

	createGoalVerificationEnvironment(input: { workspacePath: string; workspaceId?: string; verificationId: string; goalId: string; goalEpoch: number }) {
		return this.runtime.createGoalVerificationEnvironment(input);
	}

	releaseVerificationEnvironment(copyId: string): Promise<void> {
		return this.runtime.releaseVerificationEnvironment(copyId);
	}

	observeVerificationEnvironment(copyId: string) {
		return this.runtime.observeVerificationEnvironment(copyId);
	}

	promoteWorkspaceChangeSet(scopeId: string, changeSetId: string) {
		return this.runtime.promoteWorkspaceChangeSet(scopeId, changeSetId);
	}

	getWorkspaceChangeSet(changeSetId: string | undefined) {
		return this.runtime.getWorkspaceChangeSet(changeSetId);
	}

	releaseWorkspaceExecutionScope(scopeId: string, cleanup = true): Promise<void> {
		return this.runtime.releaseWorkspaceExecutionScope(scopeId, cleanup);
	}

	private async cancelUnlocked(delegationId: string, signal?: AbortSignal): Promise<void> {
		const delegation = await this.runtime.getDelegation(delegationId);
		if (!delegation) throw new Error("delegation not found");
		const wasWaitingInput = delegation.executionState === "waiting_input" || delegation.executionState === "waiting_admission";
		const agent = await this.teams.getAgent(delegation.agentId);
		const applied = await this.runtime.cancel(delegationId, {
			cwd: delegation.cwdSnapshot,
			env: agent ? await this.envFor(agent) : process.env,
			signal,
		});
		this.observeDelegationState();

		// running 委托仍占着 manager 的 delegate tool call：abort 后 delegate()
		// 会自然返回 cancelled toolResult，manager 随即继续生成，不另发重复卡。
		// waiting_input 的 tool call 已经在审批边界返回；此时若只封存
		// Delegation，manager 永远收不到新的终态。因此显式投影取消结果并唤醒
		// manager 完成本轮闭环，同时同步到 worker 单聊窗口。
		if (applied && wasWaitingInput) await this.notifyWaitingCancellation(delegation);
	}

	private async notifyWaitingCancellation(delegation: DelegationRecord): Promise<void> {
		const targets = await this.outcomeTargets(delegation);
		const managerWindow = delegation.managerSessionId
			? await this.teams.windowForSession(delegation.managerSessionId)
			: undefined;
		const workerLabel = agentDisplayName(
			(await this.teams.getAgent(delegation.agentId)) ?? { name: delegation.agentId },
		);
		const interactions = await this.runtime.listInteractions(delegation.windowId);
		const interaction = interactions.find((item) => item.delegationId === delegation.id);
		const details = {
			...(interaction ? { interactionId: interaction.id } : {}),
			delegationId: delegation.id,
			worker: delegation.agentId,
			status: "cancelled",
		};
		const resolved = {
			customType: "pudding:interaction_resolved",
			content: `用户已终止 worker「${workerLabel}」的待审批任务。`,
			details,
		};
		const taskResult = {
			customType: "pudding:task_result",
			content: `worker「${workerLabel}」任务已由用户取消。`,
			details,
		};
		if (targets.manager) {
			this.sendOutcome(targets.manager, resolved, { triggerTurn: false });
			this.sendOutcome(
				targets.manager,
				taskResult,
				managerWindow?.type === "direct"
					? { triggerTurn: false }
					: { triggerTurn: true, deliverAs: "followUp" },
			);
		}
		if (targets.direct) {
			this.sendOutcome(targets.direct, resolved, { triggerTurn: false });
			this.sendOutcome(targets.direct, taskResult, { triggerTurn: false });
		}
	}

	/** 查找某 worker 在当前房间 Session 下 pending 的 interaction（M5：409 时带出）。 */
	private async pendingInteractionFor(
		agentName: string,
		windowId: string,
		managerSessionId: string,
	): Promise<{ interactionId?: string; revision?: number; requests?: unknown[] }> {
		const interactions = await this.runtime.listInteractions(windowId);
		for (const interaction of interactions) {
			if (interaction.status !== "pending" && interaction.status !== "responding") continue;
			const delegation = await this.runtime.getDelegation(interaction.delegationId);
			if (delegation?.agentId !== agentName || delegation.managerSessionId !== managerSessionId) continue;
			return {
				interactionId: interaction.id,
				revision: interaction.revision,
				requests: interaction.requests,
			};
		}
		return {};
	}

	private rememberSession(delegation: { windowId: string; managerSessionId: string; agentId: string; sessionHandle?: string; workspaceId?: string; cwdSnapshot: string; agentRevision: number }): void {
		if (!delegation.sessionHandle) return;
		void this.teams.rememberWorkerSession(
			delegation.windowId,
			delegation.managerSessionId,
			delegation.agentId,
			delegation.sessionHandle,
			delegation.workspaceId,
			delegation.cwdSnapshot,
			delegation.agentRevision,
		).catch(() => undefined);
	}

	/**
	 * Fallback driver 解析：Connector 绑定优先（factory 按 binding config
	 * 构造，支持同一 Connector 多 Agent 实例）；legacy command invoke 退回
	 * 第一方 PuddingClaw Driver。
	 */
	private resolveDriverFor(agent: AgentConfig): AgentDriver | undefined {
		if (agent.connector) {
			const { connectorId, transport, config } = agent.connector;
			return this.drivers.create(
				connectorId,
				transport,
				connectorId === "pi"
					? {
							...(config ?? {}),
							piResources: agent.piResources,
							// 信任门判定单点（§7.2）：Driver 装配会话时按 workspaceId 实时判定。
							workspaceAccessFor: (workspaceId?: string) => this.teams.workspaces.resourceAccessFor(workspaceId),
							codeSearchFor: async (workspaceId?: string) => {
								const globalDefault = (await this.productSettings?.get())?.harness.codeSearch.defaultProvider ?? "builtin";
								const provider = resolveWorkerCodeSearch(agent.codeSearch, globalDefault);
								const workspace = workspaceId ? await this.teams.workspaces.get(workspaceId) : undefined;
								return {
									provider,
									...(workspace ? { workspace: { id: workspace.id, canonicalPath: workspace.canonicalPath, trusted: workspace.trust.state === "trusted" } } : {}),
								};
							},
							fffStateRoot: this.fffStateRoot,
							...(this.extensionCatalog && this.capabilityStateRoot
								? {
										capabilityRuntimeFor: (env: NodeJS.ProcessEnv, cwd: string) =>
											resolveAgentCapabilityRuntime({
												agent,
												catalog: this.extensionCatalog!,
												stateRoot: this.capabilityStateRoot!,
												cwd,
												env,
											}),
									}
								: {}),
						}
					: (config ?? {}),
				agent.connector.extensionId,
			);
		}
		if (agent.invoke?.type === "command") {
			const registered = this.drivers.get(agent.name) ?? this.drivers.get("puddingclaw");
			// 用户只配置 executable；命令参数是 Driver 代码的一部分（决策 §10）。
			return registered ?? new PuddingClawDriver({ command: agent.invoke.command, cwd: this.defaultCwd });
		}
		return undefined;
	}
}
