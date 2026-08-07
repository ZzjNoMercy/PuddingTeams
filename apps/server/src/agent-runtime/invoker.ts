import { TeamsStore, type AgentConfig, type WindowConfig } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { AgentRuntime, SessionConflictError } from "./runtime.js";
import { DriverRegistry } from "./driver-registry.js";
import { PuddingClawDriver } from "./puddingclaw-driver.js";
import type { AgentDriver, InvocationContext } from "./types.js";

export interface AgentInvokeParams {
	windowId: string;
	managerSessionId: string;
	managerToolCallId?: string;
	agent: AgentConfig;
	message: string;
	/** "new" starts a fresh worker session; "continue" resumes the recorded one. */
	mode: "run" | "continue";
	/** Worker-specific business model (e.g. analytics_model_id). */
	model?: string;
	signal?: AbortSignal;
	onUpdate?: (content: string, details?: unknown) => void;
	/** Workspace root override (defaults to window workspace or platform default). */
	cwd?: string;
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
 * AgentInvoker：pi 工具（team_task / per-agent delegation）与 AgentRuntime 之间
 * 的唯一业务通道。
 *
 * 职责（§1.1 责任边界）：
 * - 解析 worker 的会话连续性（window.workerBindings）、加密密钥与 workspace cwd；
 * - 调用 Runtime.delegate / respond；
 * - 把归一化结果投影成工具可读的 result + details；
 * - needs_input 时返回“等待审批”结构，绝不指导 manager 重跑任务。
 */
export class AgentInvoker {
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

	private async envFor(agent: AgentConfig): Promise<NodeJS.ProcessEnv> {
		const secrets = this.credentials ? await this.credentials.getSecrets(agent.name) : {};
		return { ...process.env, ...(agent.env ?? {}), ...secrets };
	}

	/** 解析 worker 最近一次会话 handle（continue 用）。 */
	async sessionHandleFor(windowId: string, agentName: string): Promise<string | undefined> {
		const w = await this.teams.getWindow(windowId);
		return w?.workerBindings?.[agentName]?.sessionHandle;
	}

	/** 该窗口可委托的 Agent（启用的成员）。 */
	async windowAgents(windowId: string): Promise<AgentConfig[]> {
		return this.teams.windowMembers(windowId);
	}

	/** 发起一次委托（run/continue）。 */
	async delegate(params: AgentInvokeParams): Promise<AgentInvokeResult> {
		const { agent, windowId, managerSessionId, message, mode } = params;
		const driver = this.drivers.get(agent.name) ?? this.resolveDriverFor(agent);
		if (!driver) {
			throw new Error(`agent「${agent.name}」没有可用的 Driver（未安装对应 Connector）`);
		}

		// workspace cwd：显式 > window.workspace > 平台默认。
		const window = await this.teams.getWindow(windowId);
		const cwd = params.cwd ?? window?.workspace ?? this.defaultCwd ?? process.cwd();

		const sessionHandle =
			mode === "continue" ? await this.sessionHandleFor(windowId, agent.name) : undefined;

		const ctx: InvocationContext = {
			cwd,
			env: await this.envFor(agent),
			signal: params.signal,
			onUpdate: params.onUpdate,
		};

		let delegation;
		try {
			delegation = await this.runtime.delegate(
				{
					windowId,
					managerSessionId,
					managerToolCallId: params.managerToolCallId,
					agentId: agent.name,
					message,
					mode,
					sessionHandle,
					requestId: undefined,
					options: params.model ? { model: params.model } : undefined,
				},
				ctx,
			);
		} catch (err) {
			if (err instanceof SessionConflictError) {
				// M5：冲突时把该 session 已有的 pending interaction 一起带出，
				// 前端才能折叠/跳转到真正的审批卡（solo 派活时卡片在对方的单聊窗口）。
				const pending = await this.pendingInteractionFor(agent.name, windowId);
				return {
					status: "conflict",
					content: `worker「${agent.name}」的会话仍在等待上一个任务的审批，不能发起新任务（409）。请先在上一个审批卡上操作。`,
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

		// 记录新的 session handle 到 window（multi-turn continuity）。
		if (delegation.delegation.sessionHandle) {
			this.rememberSession(windowId, agent.name, delegation.delegation.sessionHandle);
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
							content: `worker「${agent.name}」需要人工审批才能继续。`,
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
					content: `worker「${agent.name}」需要人工审批才能继续（已保存待处理请求，不会重跑任务）。`,
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
					content: `worker「${agent.name}」执行出错：${err}`,
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
		// H5：respond 也要用该 agent 的凭证 + workspace cwd，否则子进程裸环境
		// 无 token、无 PATH，且跑错目录。
		let ctxEnv: NodeJS.ProcessEnv = process.env;
		let cwd = this.defaultCwd ?? process.cwd();
		const delegation = await this.runtime.getDelegationById(interactionId);
		if (delegation) {
			const agent = await this.teams.getAgent(delegation.agentId);
			if (agent) {
				ctxEnv = await this.envFor(agent);
				const window = await this.teams.getWindow(delegation.windowId);
				cwd = window?.workspace ?? this.defaultCwd ?? process.cwd();
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
					scope: r.scope as "once" | "run" | "session" | undefined,
				})),
			},
			{ cwd, env: ctxEnv, signal },
		);
		const d = outcome.delegation;
		if (d.sessionHandle) this.rememberSession(d.windowId, d.agentId, d.sessionHandle);
		switch (outcome.status) {
			case "completed": {
				// §6.2/§6.3：完成后触发 manager follow-up 汇总（triggerTurn + followUp），
				// 并把 worker 的真实结果带给 manager，否则汇总轮无内容可转述。
				const details = { ...(outcome.result.meta ?? {}), artifacts: outcome.result.artifacts, usage: outcome.result.usage };
				if (this.managerSender && d.managerSessionId) {
					void this.managerSender(
						d.managerSessionId,
						{
							customType: "pudding:interaction_resolved",
							content: `worker「${d.agentId}」的审批已通过。`,
							details: {
								interactionId,
								delegationId: d.id,
								worker: d.agentId,
								status: "approved",
							},
						},
						{ triggerTurn: false },
					).catch(() => undefined);
					void this.managerSender(
						d.managerSessionId,
						{
							customType: "pudding:task_result",
							content: outcome.result.content ?? "",
							details: { interactionId, delegationId: d.id, worker: d.agentId, status: "completed", ...details },
						},
						// M5：manager 若在流式中，用 followUp 排队而不是 steer 打断。
						{ triggerTurn: true, deliverAs: "followUp" },
					).catch(() => undefined);
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
			case "rejected":
				if (this.managerSender && d.managerSessionId) {
					void this.managerSender(
						d.managerSessionId,
						{
							customType: "pudding:interaction_resolved",
							content: `worker「${d.agentId}」的审批被拒绝，任务已取消。`,
							details: { interactionId, delegationId: d.id, worker: d.agentId, status: "rejected" },
						},
						{ triggerTurn: true },
					).catch(() => undefined);
				}
				return {
					status: "cancelled",
					content: "审批被拒绝，任务已取消。",
					details: {},
					delegationId: d.id,
					runHandle: d.runHandle,
					waitingInput: false,
				};
			case "failed":
				return {
					status: "failed",
					content: outcome.result.status === "failed" ? outcome.result.error : "任务执行失败",
					details: { ...(outcome.result.meta ?? {}), errorCode: "errorCode" in outcome.result ? outcome.result.errorCode : undefined },
					delegationId: d.id,
					runHandle: d.runHandle,
					waitingInput: false,
				};
			case "needs_input":
				return {
					status: "needs_input",
					content: `worker「${d.agentId}」需要更多审批。`,
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

	/** 取消一个 delegation（用户主动取消，非静默）。 */
	async cancel(delegationId: string, signal?: AbortSignal): Promise<void> {
		await this.runtime.cancel(delegationId, { cwd: process.cwd(), env: {}, signal });
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

	private rememberSession(windowId: string, agentName: string, sessionHandle: string): void {
		void this.teams.rememberWorkerSession(windowId, agentName, sessionHandle).catch(() => undefined);
	}

	/** Fallback driver resolution: registry by agent name, else first-party
	 * PuddingClaw Driver bound to the agent's configured executable. */
	private resolveDriverFor(agent: AgentConfig): AgentDriver | undefined {
		if (agent.invoke.type === "command") {
			const registered = this.drivers.get(agent.name) ?? this.drivers.get("puddingclaw");
			// 用户只配置 executable；命令参数是 Driver 代码的一部分（决策 §10）。
			return registered ?? new PuddingClawDriver({ command: agent.invoke.command, cwd: this.defaultCwd });
		}
		return undefined;
	}
}
