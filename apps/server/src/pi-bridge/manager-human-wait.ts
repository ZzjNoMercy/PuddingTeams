import type { AgentInvoker } from "../agent-runtime/invoker.js";
import type { WorkStateStore } from "../store/work-state.js";

export const MANAGER_HUMAN_WAIT_INSTRUCTION = "出现待处理的人工反馈卡时，停止推进并等待用户在原卡片中回答；不要重试、改派 Worker、修改计划或另建 request_human_decision。若用户明确废弃当前 Goal 或用新 Goal 取代它，可以调用 abandon_session_goal / supersede_session_goal 收敛旧卡片与委托。Teams 准入不是 Worker 不可用，也不需要用户另外启动 Worker。普通聊天中的“继续”不等于已提交卡片；卡片受理后由 Runtime 恢复原委托。";

/** Read durable card owners, rather than the derived waiting_human label or chat text. */
export async function managerHumanWait(
	sessionId: string,
	invoker?: Pick<AgentInvoker, "delegationsForManagerSession">,
	workStates?: Pick<WorkStateStore, "getActive" | "listDecisions">,
): Promise<string | undefined> {
	const [delegations, goal] = await Promise.all([
		invoker?.delegationsForManagerSession(sessionId) ?? [],
		workStates?.getActive(sessionId),
	]);
	const waiting = delegations.filter((item) => item.executionState === "waiting_admission" || item.executionState === "waiting_input");
	const decisions = goal && workStates
		? (await workStates.listDecisions(sessionId, goal.goalId)).filter((item) => item.status === "pending")
		: [];
	if (!waiting.length && !decisions.length) return undefined;
	return [
		MANAGER_HUMAN_WAIT_INSTRUCTION,
		...waiting.map((item) => `Worker ${item.agentId}：${item.executionState}，delegationId=${item.id}`),
		...decisions.map((item) => `人类决策 ${item.id}：${item.question}`),
	].join("\n");
}
