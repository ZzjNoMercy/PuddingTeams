import type { ExecutionState } from "./api";

export type WorkerProcessPresentation =
	| "waiting_admission"
	| "starting"
	| "terminal_without_start_evidence"
	| "process";

const PRE_START_TERMINAL_STATES = new Set<ExecutionState>([
	"reported_failed",
	"cancelled",
]);

export function workerProcessEmptyState(state: ExecutionState, connected: boolean, connectionError: boolean): { text: string; pending: boolean } {
	if (connectionError) return { text: "执行记录尚未确认完整", pending: false };
	switch (state) {
		case "waiting_admission": return { text: "等待任务开始…", pending: true };
		case "admitted": return { text: "Worker 正在启动…", pending: true };
		case "running": return { text: connected ? "模型响应中…" : "正在连接 Worker 执行过程…", pending: true };
		case "waiting_input": return { text: "等待补充信息或审批", pending: false };
		case "cancel_requested": return { text: "正在终止任务…", pending: true };
		case "reconciling": return { text: "正在核对任务状态…", pending: true };
		case "reported_completed": return { text: "任务已完成，暂无可展示的执行消息", pending: false };
		case "reported_failed": return { text: "任务执行失败，可查看执行详情", pending: false };
		case "cancelled": return { text: "任务已终止", pending: false };
		default: return { text: "任务状态待确认，可查看执行详情", pending: false };
	}
}

/**
 * Project the durable execution state into the process drawer.
 *
 * executionState is the lifecycle authority. workerStarted is only evidence
 * about whether Teams observed the Worker start boundary; it must never be
 * interpreted as an admission state by itself.
 */
export function workerProcessPresentation(input: {
	executionState: ExecutionState;
	workerStarted: boolean;
}): WorkerProcessPresentation {
	if (input.executionState === "waiting_admission") return "waiting_admission";
	if (input.workerStarted) return "process";
	if (input.executionState === "admitted" || input.executionState === "running") return "starting";
	if (PRE_START_TERMINAL_STATES.has(input.executionState)) return "terminal_without_start_evidence";
	return "process";
}
