import { randomUUID } from "node:crypto";
import type { AgentInvokeResult, AgentInvoker } from "./invoker.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore, WindowConfig } from "../store/teams.js";

/**
 * Direct 窗口直派（§5.2）：direct 窗口 = 纯 worker 通道，用户消息不再经
 * pi manager relay，直接委托给窗口成员 worker。窗口的 pi session 只作消息
 * 流容器（user 消息与 worker 卡片都是 custom message），永不触发 manager
 * 回合。委托的 managerSessionId 就是 direct 窗口自己的 active session——
 * owner 即本窗口，invoker 的 outcomeTargets 因此自然去重，HITL 审批卡也
 * 直接落回本窗口。
 */

export interface DirectDispatchDeps {
	teams: Pick<TeamsStore, "windowForSession" | "getAgent">;
	sessions: Pick<PiSessionStore, "sendCustomMessage" | "ensureSessionFile">;
	invoker: Pick<AgentInvoker, "requireAgent" | "delegate">;
	onError?: (sessionId: string, message: string) => void;
	log?: (message: string) => void;
}

/** direct 窗口的成员 worker（单成员且不是内置 manager）；非 direct 返回 undefined。 */
export async function directWorkerFor(
	teams: Pick<TeamsStore, "windowForSession" | "getAgent">,
	sessionId: string,
): Promise<{ window: WindowConfig; workerName: string; processView: boolean } | undefined> {
	const window = await teams.windowForSession(sessionId);
	if (!window || window.type !== "direct") return undefined;
	const workerName = window.members[0];
	if (!workerName) return undefined;
	const agent = await teams.getAgent(workerName);
	if (!agent || agent.pinned || agent.invoke?.type === "pi") return undefined;
	// pi worker（Connector 绑定 connectorId=pi）的会话支持执行过程可视化。
	return { window, workerName, processView: agent.connector?.connectorId === "pi" };
}

function resultCard(
	workerName: string,
	taskId: string,
	windowId: string,
	result: AgentInvokeResult,
	processView: boolean,
): { customType: string; content: string; details: Record<string, unknown> } {
	return {
		customType: "pudding:task_result",
		content: result.content,
		details: {
			taskId,
			worker: workerName,
			windowId,
			status: result.status,
			delegationId: result.delegationId,
			interactionId: result.interactionId,
			// 执行过程可视化入口（仅 pi worker）。
			sessionHandle: result.sessionHandle,
			processView,
			// 本任务 token 消耗（pi worker 按 Run 聚合；其他 driver 有则透传）。
			...(result.details.usage ? { usage: result.details.usage } : {}),
		},
	};
}

/**
 * direct 窗口消息入口：命中 direct 窗口时消费这条消息（返回 true），调用方
 * 不再走 session.prompt。worker 委托在后台执行，结果以卡片写回同一 session。
 * `content` 是完整委托文本（含附件冻结路径块）；`display` 是气泡展示文本
 * （用户正文 + 附件名），缺省与 content 相同。
 */
export async function dispatchDirectMessage(
	deps: DirectDispatchDeps,
	sessionId: string,
	content: string,
	display?: string,
): Promise<boolean> {
	const target = await directWorkerFor(deps.teams, sessionId);
	if (!target) return false;
	const { window, workerName, processView } = target;
	const displayText = display ?? content;

	await deps.sessions.sendCustomMessage(
		sessionId,
		{ customType: "pudding:user_message", content: displayText, details: { windowId: window.id } },
		{ triggerTurn: false },
	);
	// 全新 direct 窗口的 session 文件可能还没落盘（SDK 首条 assistant 消息前
	// 不持久化）：先复制 SDK 的首刷，避免重启后整段对话蒸发。
	await deps.sessions.ensureSessionFile(sessionId);
	const taskId = randomUUID();
	await deps.sessions.sendCustomMessage(
		sessionId,
		{
			customType: "pudding:task_assign",
			content: displayText,
			details: { taskId, worker: workerName, windowId: window.id, from: "direct", status: "running" },
		},
		{ triggerTurn: false },
	);

	const send = (message: { customType: string; content: string; details?: Record<string, unknown> }) =>
		deps.sessions.sendCustomMessage(sessionId, message, { triggerTurn: false });

	void (async () => {
		// 执行过程可视化：runtime 的 started 更新带回 delegationId/sessionHandle，
		// 补写一张同 taskId 的富化指派卡（前端按 taskId 去重，只留最新），
		// 让运行中的卡片也有「执行过程」入口。只补一次。
		let enriched = false;
		const agent = await deps.invoker.requireAgent(workerName);
		const result = await deps.invoker.delegate({
			agent,
			windowId: window.id,
			managerSessionId: sessionId,
			managerToolCallId: taskId,
			handoffKind: "request",
			message: content,
			// binding 有 handle 就 continue，没有/失效由 runtime 透明回退 run。
			mode: "continue",
			onUpdate: (_text, details) => {
				if (enriched || !processView) return;
				const d = details as { delegationId?: string; sessionHandle?: string } | undefined;
				if (!d?.delegationId || !d.sessionHandle) return;
				enriched = true;
				void send({
					customType: "pudding:task_assign",
					content: displayText,
					details: {
						taskId,
						worker: workerName,
						windowId: window.id,
						from: "direct",
						status: "running",
						delegationId: d.delegationId,
						sessionHandle: d.sessionHandle,
						processView: true,
					},
				});
			},
		});
		if (result.status === "needs_input") {
			// 审批卡已由 invoker 写进本 session（managerSessionId = 本窗口）。
			return;
		}
		await send(resultCard(workerName, taskId, window.id, result, processView));
		deps.log?.(`direct dispatch: ${sessionId} → ${workerName} (${result.status})`);
	})().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		deps.onError?.(sessionId, message);
		void send({
			customType: "pudding:task_result",
			content: `worker「${workerName}」执行出错：${message}`,
			details: { taskId, worker: workerName, windowId: window.id, status: "failed" },
		});
	});

	return true;
}
