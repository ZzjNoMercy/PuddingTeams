import {
	WorkStateConflictError,
	type SessionWorkState,
	type WorkItemReviewInput,
	type WorkspaceChangeSet,
	type WorkStateStore,
} from "../store/work-state.js";

/** Both the Manager tool and the human review endpoint settle the same Submission. */
export async function settleWorkItemReview(input: {
	workStates: WorkStateStore;
	sessionId: string;
	goalId: string;
	workItemId: string;
	expectedRevision: number;
	expectedEpoch: number;
	review: WorkItemReviewInput;
	operationId: string;
	promoteWorkspaceChangeSet: (scopeId: string, changeSetId: string) => Promise<WorkspaceChangeSet>;
}): Promise<{ state: SessionWorkState; verdict: WorkItemReviewInput["verdict"] }> {
	const { workStates, sessionId, goalId, workItemId, expectedRevision, expectedEpoch, operationId } = input;
	const review: WorkItemReviewInput = { ...input.review, summary: input.review.summary.trim(),
		evidenceRefs: [...new Set((input.review.evidenceRefs ?? []).map((ref) => ref.trim()).filter(Boolean))] };
	const current = await workStates.getActive(sessionId);
	if (!current || current.goalId !== goalId) throw new Error("当前 Goal 已变化，请重新读取目标状态后再验收");
	if (current.execution.epoch !== expectedEpoch) throw new WorkStateConflictError(current, expectedRevision, `验收所属 execution epoch 已变化（本次传入 ${expectedEpoch}，当前 ${current.execution.epoch}）`);
	const alreadyReviewed = current.plan?.items[workItemId];
	const reviewedSubmission = alreadyReviewed?.submissions.find((entry) => entry.id === review.expectedSubmissionId);
	const prior = reviewedSubmission?.review;
	const promotion = reviewedSubmission?.workspaceChangeSet?.promotionState;
	const promotedConflict = review.verdict === "accepted" && prior?.verdict === "blocked"
		&& (promotion === "conflict" || promotion === "failed")
		&& reviewedSubmission?.acceptanceIntent?.summary === review.summary
		&& JSON.stringify(reviewedSubmission.acceptanceIntent.evidenceRefs) === JSON.stringify(review.evidenceRefs ?? [])
		&& prior.summary === `${review.summary}\nWorkspace change-set 提升为 ${promotion}；已保留隔离 worktree/diff。`;
	if (prior && alreadyReviewed?.revision === review.expectedWorkItemRevision + 1
		&& ((prior.verdict === review.verdict && prior.summary === review.summary) || promotedConflict)
		&& JSON.stringify(prior.evidenceRefs) === JSON.stringify(review.evidenceRefs ?? [])) {
		return { state: current, verdict: prior.verdict };
	}
	let revision = expectedRevision;
	let verdict = review.verdict;
	let summary = review.summary;
	if (review.verdict === "accepted") {
		if (!current.plan) throw new Error("WorkPlan 不存在");
		const item = current.plan.items[workItemId];
		const submission = item?.submissions.find((entry) => entry.id === review.expectedSubmissionId && !entry.review);
		if (!item || item.status !== "submitted" || item.revision !== review.expectedWorkItemRevision || !submission) {
			const pending = item ? [...item.submissions].reverse().find((entry) => !entry.review) : undefined;
			throw new WorkStateConflictError(current, expectedRevision, `验收目标已变化（WorkItem ${workItemId} 当前 itemRevision=${item?.revision ?? "无"}、submissionId=${pending?.id ?? "无"}）`);
		}
		const needsPromotion = (item.workspaceExecutionPolicy.mode === "isolated_worktree" && item.workspaceExecutionPolicy.promoteOnAcceptance)
			|| submission.workspaceChangeSet?.mode === "isolated_worktree";
		if (needsPromotion) {
			const intentState = await workStates.recordAcceptanceIntent(sessionId, workItemId, revision, {
				expectedWorkItemRevision: review.expectedWorkItemRevision,
				expectedSubmissionId: review.expectedSubmissionId,
				summary: review.summary,
				evidenceRefs: review.evidenceRefs,
			}, `${operationId}:acceptance-intent`, expectedEpoch, goalId);
			revision = intentState.revision;
			const scopeId = submission.executionReceipt?.workspaceExecutionScopeId;
			const changeSetId = submission.workspaceChangeSetId;
			if (!scopeId || !changeSetId) throw new Error("isolated_worktree Submission 缺少可提升 change-set");
			const promoted = await input.promoteWorkspaceChangeSet(scopeId, changeSetId);
			const promotedState = await workStates.recordWorkspaceChangeSet(
				sessionId, workItemId, revision, promoted, `${operationId}:promotion`, expectedEpoch, goalId,
			);
			revision = promotedState.revision;
			if (promoted.promotionState !== "applied") {
				verdict = "blocked";
				summary = `${review.summary}\nWorkspace change-set 提升为 ${promoted.promotionState}；已保留隔离 worktree/diff。`;
			}
		}
	}
	const state = await workStates.reviewWorkItem(sessionId, workItemId, revision, {
		...review, verdict, summary,
	}, `${operationId}:review`, expectedEpoch, goalId);
	return { state, verdict };
}
