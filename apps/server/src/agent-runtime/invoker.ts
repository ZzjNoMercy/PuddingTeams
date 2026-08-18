import { TeamsStore, agentDisplayName, type AgentConfig, type WindowConfig } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { AgentRuntime, SessionConflictError } from "./runtime.js";
import type { DelegationRecord } from "./delegation-store.js";
import { DriverRegistry } from "./driver-registry.js";
import { PuddingClawDriver } from "./puddingclaw-driver.js";
import type { AgentDriver, DriverCapabilities, InvocationContext } from "./types.js";

export interface AgentInvokeParams {
	windowId: string;
	managerSessionId: string;
	managerToolCallId?: string;
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
 * - 解析 worker 的会话连续性（window.workerBindings）、加密密钥与 workspace cwd；
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

	constructor(
		private readonly teams: TeamsStore,
		private readonly runtime: AgentRuntime,
		private readonly drivers: DriverRegistry,
		private readonly credentials?: CredentialsStore,
		private readonly defaultCwd?: string,
	) {}

	/** 注入 manager 会话通知器（PiSessionStore），启动时由 index.ts 调用。 */
	setManagerSender(
		sender: AgentInvoker["managerSender"],
	): void {
		this.managerSender = sender;
	}

	/**
	 * 该 manager Session 里仍在执行的委托的工具调用 id 列表（历史重放修正
	 * "已中断"误标用）：以内存中的活 Run 为准（isDelegationActive），持久化
	 * 的 running/waiting_input 跨重启后不算数。
	 */
	async runningDelegateToolCallIds(managerSessionId: string): Promise<string[]> {
		const list = await this.runtime.listDelegations(undefined, managerSessionId);
		return list
			.filter((d) => (d.status === "running" || d.status === "waiting_input") && this.runtime.isDelegationActive(d.id))
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

	private async envFor(agent: AgentConfig): Promise<NodeJS.ProcessEnv> {
		const secrets = this.credentials ? await this.credentials.getSecrets(agent.name) : {};
		return { ...process.env, ...(agent.env ?? {}), ...secrets };
	}

	/** 解析 worker 最近一次会话 handle（continue 用）。 */
	async sessionHandleFor(windowId: string, agent: AgentConfig): Promise<string | undefined> {
		const w = await this.teams.getWindow(windowId);
		const binding = w?.workerBindings?.[agent.name];
		if (!w || !binding) return undefined;
		if (binding.workspaceId !== w.workspaceId) return undefined;
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
			(d) => d.status === "running" || d.status === "waiting_input",
		);
	}

	/** Goal reviewer 的只读证据投影：只返回属于该 manager Session 的委托。 */
	async delegationsForManagerSession(managerSessionId: string) {
		return this.runtime.listDelegations(undefined, managerSessionId);
	}

	/**
	 * Stop every Run owned by the window (including solo→direct routed Runs),
	 * create a manager Session from the latest window state, then commit the
	 * workspace swap. New delegate/respond/cancel transitions share this gate.
	 */
	async switchWorkspaceInPlace(
		windowId: string,
		workspaceId: string | undefined,
		createSession: (source: WindowConfig, cwd: string) => Promise<{ id: string }>,
		removeSession: (sessionId: string) => Promise<unknown>,
	): Promise<{ window: WindowConfig; previousSessionIds: string[]; existed: boolean }> {
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
				const target = await this.teams.contextForWorkspace(workspaceId);
				if (source.workspaceId === workspaceId && source.cwdSnapshot === target.cwdSnapshot) {
					return { window: source, previousSessionIds: [], existed: true };
				}
				const related = (await this.runtime.listDelegations()).filter(
					(item) =>
						(item.windowId === source.id || source.sessions.includes(item.managerSessionId)) &&
						(item.status === "running" || item.status === "waiting_input"),
				);
				for (const delegation of related) await this.cancelUnlocked(delegation.id);

				const created = await createSession(source, target.cwdSnapshot);
				let switched;
				try {
					switched = await this.teams.replaceWindowWorkspace(source.id, workspaceId, created.id, source);
				} catch (err) {
					await removeSession(created.id).catch(() => undefined);
					throw err;
				}
				for (const id of switched.previousSessionIds) {
					await removeSession(id).catch(() => undefined);
				}
				return { ...switched, existed: false };
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
		return driver?.capabilities();
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
		return this.drivers.get(agent.name) ?? this.resolveDriverFor(agent);
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
				if (window.type !== "solo" && !window.members.includes(freshAgent.name)) {
					throw new Error(`agent「${freshAgent.name}」不是当前窗口的成员，委托被拒绝`);
				}
				const driver = this.drivers.get(freshAgent.name) ?? this.resolveDriverFor(freshAgent);
				if (!driver) throw new Error(`agent「${freshAgent.name}」没有可用的 Driver（未安装对应 Connector）`);
				const cwd = await this.teams.workspaceFor(windowId);
				const nextSession = mode === "continue" ? await this.sessionHandleFor(windowId, freshAgent) : undefined;
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
						requestId: undefined,
						options: params.model ? { model: params.model } : undefined,
						onCreated: () => createdResolve(),
						driver,
					},
					{
						cwd,
						env,
						signal: params.signal,
						onUpdate: params.onUpdate,
					},
				);
				void runPromise.catch(createdReject);
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
				const pending = await this.pendingInteractionFor(conflictAgent.name, windowId);
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
			details: {},
		};

		switch (delegation.status) {
			case "needs_input": {
				const interaction = delegation.interaction!;
				// §6.5：向 manager session 追加安全投影（无 token），前端按
				// interactionId 渲染/折叠审批卡。
				if (this.managerSender && managerSessionId) {
					void this.managerSender(
						managerSessionId,
						{
							customType: "pudding:interaction_required",
							content: `worker「${agentDisplayName(agent)}」需要人工审批才能继续。`,
							details: {
								interactionId: interaction.id,
								delegationId: d.id,
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
					content: `worker「${agentDisplayName(agent)}」需要人工审批才能继续（已保存待处理请求，不会重跑任务）。`,
					details: {
						interactionId: interaction.id,
						delegationId: d.id,
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
				const err =
					result && result.status === "failed"
						? result.error
						: result && result.status === "cancelled"
							? result.error
							: "worker 执行失败";
				return {
					...base,
					status: "failed",
					content: `worker「${agentDisplayName(agent)}」执行出错：${err}`,
					details: {
						...(result?.meta ?? {}),
						errorCode: result && "errorCode" in result ? result.errorCode : undefined,
					},
					waitingInput: false,
				};
			}
			case "completed": {
				const result = delegation.result;
				return {
					...base,
					status: "completed",
					content: result?.content ?? "",
					details: {
						...(result?.meta ?? {}),
						artifacts: result?.artifacts,
						usage: result?.usage,
					},
					waitingInput: false,
				};
			}
		}
	}

	/** 提交审批：用户点击允许/拒绝后调用（对应 /api/interactions/:id/responses）。 */
	async respond(
		interactionId: string,
		input: { requestId: string; revision: number; responses: Array<{ requestId: string; action: string; scope?: string }> },
		signal?: AbortSignal,
	): Promise<AgentInvokeResult> {
		const delegation = await this.runtime.getDelegationById(interactionId);
		if (!delegation) throw new Error("interaction or delegation not found");
		const managerOwner = await this.teams.windowForSession(delegation.managerSessionId);
		const prepared = await this.withWindowLifecycles(
			[delegation.windowId, ...(managerOwner ? [managerOwner.id] : [])],
			async () => {
				let admittedResolve!: () => void;
				let admittedReject!: (reason: unknown) => void;
				const admitted = new Promise<void>((resolve, reject) => {
					admittedResolve = resolve;
					admittedReject = reject;
				});
				const responsePromise = this.respondUnlocked(interactionId, input, signal, admittedResolve);
				void responsePromise.catch(admittedReject);
				await Promise.race([admitted, responsePromise.then(() => undefined)]);
				return { responsePromise };
			},
		);
		return prepared.responsePromise;
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
		input: { requestId: string; revision: number; responses: Array<{ requestId: string; action: string; scope?: string }> },
		signal?: AbortSignal,
		onAdmitted?: () => void,
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
				})),
			},
			{ cwd, env: ctxEnv, signal },
			driverSnapshot,
			onAdmitted,
		);
		const d = outcome.delegation;
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
				const resolved = {
					customType: "pudding:interaction_resolved",
					content: `worker「${workerLabel}」的审批已通过。`,
					details: {
						interactionId,
						delegationId: d.id,
						worker: d.agentId,
						status: "approved",
					},
				};
				const taskResult = {
					customType: "pudding:task_result",
					content: outcome.result.content ?? "",
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "completed", ...details },
				};
				if (targets.manager) {
					this.sendOutcome(targets.manager, resolved, { triggerTurn: false });
					// M5：manager 若在流式中，用 followUp 排队而不是 steer 打断。
					this.sendOutcome(targets.manager, taskResult, taskResultOptions);
				}
				if (targets.direct) {
					// 单聊窗口仅展示，不唤醒 turn。
					this.sendOutcome(targets.direct, resolved, { triggerTurn: false });
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
				const resolved = {
					customType: "pudding:interaction_resolved",
					content: `worker「${workerLabel}」的审批被拒绝，任务已取消。`,
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "rejected" },
				};
				const taskResult = {
					customType: "pudding:task_result",
					content: "审批被拒绝，任务已取消。",
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "cancelled" },
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
				const resolved = {
					customType: "pudding:interaction_resolved",
					content: `worker「${workerLabel}」的审批已通过，但任务执行失败。`,
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "failed" },
				};
				const taskResult = {
					customType: "pudding:task_result",
					content: errorText,
					details: { interactionId, delegationId: d.id, worker: d.agentId, status: "failed", ...details },
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

	private async cancelUnlocked(delegationId: string, signal?: AbortSignal): Promise<void> {
		const delegation = await this.runtime.getDelegation(delegationId);
		if (!delegation) throw new Error("delegation not found");
		const agent = await this.teams.getAgent(delegation.agentId);
		await this.runtime.cancel(delegationId, {
			cwd: delegation.cwdSnapshot,
			env: agent ? await this.envFor(agent) : process.env,
			signal,
		});
	}

	/** 查找某 worker 在该窗口下当前 pending 的 interaction（M5：409 时带出）。 */
	private async pendingInteractionFor(
		agentName: string,
		windowId: string,
	): Promise<{ interactionId?: string; revision?: number; requests?: unknown[] }> {
		const interactions = await this.runtime.listInteractions(windowId);
		for (const interaction of interactions) {
			if (interaction.status !== "pending" && interaction.status !== "responding") continue;
			const delegation = await this.runtime.getDelegation(interaction.delegationId);
			if (delegation?.agentId !== agentName) continue;
			return {
				interactionId: interaction.id,
				revision: interaction.revision,
				requests: interaction.requests,
			};
		}
		return {};
	}

	private rememberSession(delegation: { windowId: string; agentId: string; sessionHandle?: string; workspaceId?: string; cwdSnapshot: string; agentRevision: number }): void {
		if (!delegation.sessionHandle) return;
		void this.teams.rememberWorkerSession(
			delegation.windowId,
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
			const { connectorId, config } = agent.connector;
			return this.drivers.create(
				connectorId,
				connectorId === "pi"
					? {
							...(config ?? {}),
							piResources: agent.piResources,
							// 信任门判定单点（§7.2）：Driver 装配会话时按 workspaceId 实时判定。
							workspaceAccessFor: (workspaceId?: string) => this.teams.workspaces.resourceAccessFor(workspaceId),
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
