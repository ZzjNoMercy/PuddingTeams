import type { WorkStateStore } from "../store/work-state.js";
import type { DelegationRecord } from "./delegation-store.js";

/** Completion is a Driver fact; closing its WorkItem is a Harness decision. */
export async function isWorkspaceOwnerClosed(workStates: Pick<WorkStateStore, "getGoal">, owner: DelegationRecord): Promise<boolean> {
	if (!owner.goalId || !owner.workItemId) return false;
	const goal = await workStates.getGoal(owner.managerSessionId, owner.goalId);
	if (!goal?.plan || goal.plan.id !== owner.workPlanId) return false;
	if (goal.status === "cancelled" || goal.status === "superseded") return true;
	const item = goal.plan.items[owner.workItemId];
	if (item?.status === "cancelled") return true;
	if (item?.status !== "accepted") return false;
	const accepted = item.submissions.find((submission) => submission.id === item.acceptedSubmissionId);
	return !!owner.workspaceExecutionScopeId && accepted?.executionReceipt?.workspaceExecutionScopeId === owner.workspaceExecutionScopeId;
}
