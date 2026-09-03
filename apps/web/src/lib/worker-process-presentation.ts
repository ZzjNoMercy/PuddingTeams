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
