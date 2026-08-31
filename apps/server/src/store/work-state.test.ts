import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkStateConflictError, WorkStateOperationConflictError, WorkStateStore, workItemContractHash, type ExecutionReceipt, type SessionWorkState, type WorkItem } from "./work-state.js";

function sealedReceipt(state: SessionWorkState, item: WorkItem, delegationId: string): ExecutionReceipt {
	return {
		id: `receipt-${delegationId}`, delegationId, goalId: state.goalId, workPlanId: state.plan?.id, workItemId: item.id,
		goalRevision: state.goalRevision, workItemRevision: item.revision, goalEpoch: state.execution.epoch,
		taskContractHash: workItemContractHash(state, state.plan!, item), contractHash: "sha256:runtime-envelope", reportedOutcome: "completed",
		requirementResults: item.acceptanceCriteria.map((requirement) => ({ requirement, status: "provided" as const, evidenceRefs: [delegationId] })),
		artifactCapture: [], collectionStatus: "complete", integrity: "clean", issues: [], sealedAt: new Date().toISOString(),
	};
}

test("P3-G: Session Goal revision、业务决策与清理闭环", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-state-")));
	await store.init();
	const created = await store.create({
		sessionId: "s1",
		goal: "交付可审核版本",
		completionBoundary: "测试全绿且 Human 审核通过",
		participantAgentIds: ["codex", "codex"],
		reviewMode: "independent",
		verificationPolicy: { minimumWorkItemMode: "manager_review", finalGoalMode: "manager_review", trigger: "manager_request", source: "user", reason: "本用例单独验证 Completion Review 状态机" },
	});
	assert.equal(created.revision, 0);
	assert.equal(created.goalRevision, 1);
	assert.equal(created.execution.epoch, 1);
	assert.equal(created.execution.status, "idle");
	assert.equal(created.contractProvenance.criteriaOrigin, "user_input");
	assert.equal(created.reviewMode, "independent");
	assert.deepEqual(created.completionReviews, []);
	assert.deepEqual(created.participantAgentIds, ["codex"]);
	const updated = await store.update("s1", 0, { currentBrief: "实现完成", nextAction: "请求审核" });
	assert.equal(updated.revision, 1);
	await assert.rejects(() => store.update("s1", 0, { currentBrief: "旧状态覆盖" }), WorkStateConflictError);
	await assert.rejects(() => store.update("s1", 1, { status: "resolved", currentBrief: "" }), /resolved/);
	await assert.rejects(() => store.update("s1", 1, { status: "resolved", currentBrief: "完成" }), /只能通过完成复核/);

	const rejected = await store.applyCompletionReview("s1", 1, {
		currentBrief: "实现完成，仍缺少人工确认",
		review: {
			id: "review-1",
			goalRevision: 1,
			mode: "independent",
			verdict: "not_satisfied",
			criteria: [{ criterion: "测试全绿", status: "unsatisfied", evidenceRefs: [], explanation: "缺少测试证据" }],
			gaps: ["补充测试证据"],
			reviewerModel: "provider/reviewer",
			reviewerSessionId: "review-session-1",
			reviewedAt: new Date().toISOString(),
		},
	});
	assert.equal(rejected.status, "active");
	assert.equal(rejected.completionReviews.length, 1);

	const reviewed = await store.applyCompletionReview("s1", 2, {
		currentBrief: "实现完成，测试证据见 run-1",
		review: {
			id: "review-2",
			goalRevision: 1,
			mode: "independent",
			verdict: "satisfied",
			criteria: [{ criterion: "测试全绿", status: "satisfied", evidenceRefs: ["run-1"], explanation: "测试成功" }],
			gaps: [],
			reviewerModel: "provider/reviewer",
			reviewerSessionId: "review-session-2",
			reviewedAt: new Date().toISOString(),
		},
	});
	assert.equal(reviewed.status, "resolved");
	assert.deepEqual(reviewed.completionReviews.map((item) => item.id), ["review-1", "review-2"]);
	const nextGoal = await store.create({
		sessionId: "s1",
		goal: "再次交付可审核版本",
		completionBoundary: "测试全绿且 Human 再次审核通过",
		operationId: "create-next-goal",
	});
	assert.equal(nextGoal.status, "active");
	assert.notEqual(nextGoal.goalId, reviewed.goalId);
	assert.equal(nextGoal.goalRevision, 1);
	assert.equal((await store.getGoal("s1", reviewed.goalId))?.status, "resolved");

	const decision = await store.createDecision({
		sessionId: "s1",
		requestedBy: "manager",
		question: "是否发布？",
		context: "测试已通过",
		options: [{ id: "yes", label: "发布" }],
		blockedAction: "发布",
		resumeHint: "按答案继续",
	});
	assert.equal(decision.status, "pending");
	const answered = await store.answerDecision(decision.id, "yes");
	assert.equal(answered.answer, "yes");
	await store.removeSession("s1");
	assert.equal(await store.get("s1"), undefined);
	assert.deepEqual(await store.listDecisions("s1"), []);
});

test("Goal 验收模式：省略旧 reviewMode 时跟随 verificationPolicy.finalGoalMode", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-goal-review-mode-")));
	await store.init();
	const manager = await store.create({
		sessionId: "manager-review", goal: "Manager 验收", completionBoundary: "完成",
		verificationPolicy: { minimumWorkItemMode: "manager_review", finalGoalMode: "manager_review", trigger: "manager_request", source: "user", reason: "不启动独立 reviewer" },
	});
	assert.equal(manager.reviewMode, "manager");
	const independent = await store.create({
		sessionId: "independent-review", goal: "独立验收", completionBoundary: "完成",
		verificationPolicy: { minimumWorkItemMode: "manager_review", finalGoalMode: "independent_evidence_review", trigger: "manager_request", source: "user", reason: "需要独立 reviewer" },
	});
	assert.equal(independent.reviewMode, "independent");
});

test("Goal v5: WorkItem DAG、Submission、验收与幂等闭环", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-plan-")));
	await store.init();
	const goal = await store.create({
		sessionId: "plan",
		goal: "交付报告",
		completionBoundary: "报告完成\n引用可追溯",
		operationId: "create-plan",
	});
	const planned = await store.updatePlan("plan", goal.revision, {
		upsertItems: [
			{ id: "W1", title: "调研", dependsOn: [], acceptanceCriteria: ["资料齐全"], sourceGoalCriteria: ["goal:1:2"] },
			{ id: "W2", title: "写作", dependsOn: ["W1"], acceptanceCriteria: ["报告完成"], sourceGoalCriteria: ["goal:1:1"] },
		],
		reason: "拆解依赖",
	}, "plan-1");
	assert.equal(planned.plan?.items.W1?.status, "ready");
	assert.equal(planned.plan?.items.W2?.status, "planned");
	await assert.rejects(
		() => store.updatePlan("plan", planned.revision, {
			upsertItems: [{ id: "W1", title: "调研", dependsOn: ["W2"], acceptanceCriteria: ["资料齐全"], sourceGoalCriteria: ["goal:1:2"] }],
			reason: "制造环",
		}, "cycle"),
		/无环 DAG/,
	);
	const submitted = await store.noteDelegation("plan", {
		goalId: goal.goalId,
		workItemId: "W1",
		delegationId: "D1",
		delegationStatus: "completed",
		goalEpoch: 1,
		summary: "资料完成",
		executionReceipt: sealedReceipt(planned, planned.plan!.items.W1!, "D1"),
	}, "delegation-boundary:D1:1");
	assert.equal(submitted.plan?.items.W1?.status, "submitted");
	assert.equal(submitted.plan?.items.W2?.status, "planned", "submitted 不能解锁下游");
	const accepted = await store.reviewWorkItem("plan", "W1", submitted.revision, {
		verdict: "accepted",
		summary: "证据充分",
		evidenceRefs: ["D1"],
	}, "review-D1", 1);
	assert.equal(accepted.plan?.items.W1?.status, "accepted");
	assert.equal(accepted.plan?.items.W2?.status, "ready", "只有 accepted 解锁下游");
	const lateWaiting = await store.noteDelegation("plan", {
		goalId: goal.goalId, workItemId: "W1", delegationId: "D-late", delegationStatus: "waiting_input", goalEpoch: 1,
	}, "late-waiting-after-accepted");
	assert.equal(lateWaiting.plan?.items.W1?.status, "accepted", "迟到 waiting_input 不能回退 accepted");
	await store.reconcileDelegations([{
		id: "D1", managerSessionId: "plan", goalId: goal.goalId, workItemId: "W1", goalEpoch: 1,
		executionState: "reported_completed", revision: 2, updatedAt: new Date().toISOString(),
	}]);
	assert.equal((await store.get("plan"))?.plan?.items.W1?.status, "accepted", "启动对账不能把已验收项退回 submitted");
	const revisedPlan = await store.updatePlan("plan", accepted.revision, {
		upsertItems: [{ id: "W2", title: "成稿写作", dependsOn: [], acceptanceCriteria: ["报告完成"], sourceGoalCriteria: ["goal:1:1"] }],
		cancelItemIds: ["W1"],
		reason: "调研产物已并入输入，后续不再依赖该计划项",
	}, "plan-revise", 1);
	assert.equal(revisedPlan.plan?.items.W1?.status, "cancelled");
	assert.equal(revisedPlan.plan?.items.W1?.lastChange?.reason, "调研产物已并入输入，后续不再依赖该计划项");
	assert.equal(revisedPlan.plan?.items.W2?.title, "成稿写作");
	assert.equal(revisedPlan.plan?.items.W2?.lastChange?.previousRevision, 0);
	const secondSubmission = await store.noteDelegation("plan", {
		goalId: goal.goalId, workItemId: "W2", delegationId: "D2", delegationStatus: "completed", goalEpoch: 1,
		executionReceipt: sealedReceipt(revisedPlan, revisedPlan.plan!.items.W2!, "D2"),
	}, "delegation-boundary:D2:completed");
	const blocked = await store.reviewWorkItem("plan", "W2", secondSubmission.revision, {
		verdict: "blocked", summary: "等待外部资料",
	}, "review-D2", 1);
	const reopened = await store.updatePlan("plan", blocked.revision, {
		upsertItems: [], reopenItemIds: ["W2"], reason: "外部资料已到齐",
	}, "reopen-W2", 1);
	assert.equal(reopened.plan?.items.W2?.status, "revision");
	const replay = await store.reviewWorkItem("plan", "W1", submitted.revision, {
		verdict: "accepted",
		summary: "证据充分",
		evidenceRefs: ["D1"],
	}, "review-D1", 1);
	assert.equal(replay.revision, accepted.revision, "相同 operationId+payload 不重复增加 revision");
	await assert.rejects(
		() => store.reviewWorkItem("plan", "W1", submitted.revision, {
			verdict: "blocked",
			summary: "不同载荷",
		}, "review-D1", 1),
		(error: unknown) => error instanceof WorkStateOperationConflictError && error.code === "idempotency_conflict",
	);
});

test("启动对账: reconciling/waiting_input/waiting_admission 都投影为活跃工作项且不触发 effect_unknown", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-reconcile-active-")));
	await store.init();
	const goal = await store.create({ sessionId: "active-reconcile", goal: "恢复远端任务", completionBoundary: "任务有可信边界" });
	const planned = await store.updatePlan("active-reconcile", goal.revision, {
		upsertItems: [
			{ id: "W1", title: "重挂中", dependsOn: [], acceptanceCriteria: ["有终态"] },
			{ id: "W2", title: "待输入", dependsOn: [], acceptanceCriteria: ["输入后继续"] },
			{ id: "W3", title: "待准入", dependsOn: [], acceptanceCriteria: ["准入后继续"] },
		],
		reason: "覆盖恢复态投影",
	}, "plan-active", 1, goal.goalId);
	const outcome = await store.reconcileDelegations([
		{ id: "D-reconciling", managerSessionId: "active-reconcile", goalId: goal.goalId, workItemId: "W1", goalEpoch: 1, executionState: "reconciling", revision: 2, updatedAt: new Date().toISOString() },
		{ id: "D-input", managerSessionId: "active-reconcile", goalId: goal.goalId, workItemId: "W2", goalEpoch: 1, executionState: "waiting_input", revision: 3, updatedAt: new Date().toISOString() },
		{ id: "D-admission", managerSessionId: "active-reconcile", goalId: goal.goalId, workItemId: "W3", goalEpoch: 1, executionState: "waiting_admission", revision: 4, updatedAt: new Date().toISOString() },
	]);
	assert.equal(outcome.projected, 3);
	assert.equal(outcome.interrupted, 0);
	const current = await store.get("active-reconcile");
	assert.equal(current?.plan?.items.W1?.status, "in_progress");
	assert.equal(current?.plan?.items.W2?.status, "waiting_input");
	assert.equal(current?.plan?.items.W3?.status, "waiting_admission");
	assert.equal(current?.execution.status, "waiting_human");
	assert.equal(current?.execution.interruption, undefined);
	assert.ok((current?.revision ?? 0) > planned.revision);
});

test("启动对账: verification Delegation 只提供证据，不得被重放为执行 Submission", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-reconcile-verification-")));
	await store.init();
	const goal = await store.create({ sessionId: "verify-reconcile", goal: "验证交付", completionBoundary: "独立复验通过" });
	const planned = await store.updatePlan("verify-reconcile", goal.revision, {
		upsertItems: [{ id: "W1", title: "实现", dependsOn: [], acceptanceCriteria: ["文件存在"] }],
		reason: "plan",
	}, "plan-verification", goal.execution.epoch, goal.goalId);
	const item = planned.plan!.items.W1!;
	const verifierReceipt = sealedReceipt(planned, item, "D-verifier");
	verifierReceipt.taskContractHash = undefined;

	const outcome = await store.reconcileDelegations([{
		id: "D-verifier",
		managerSessionId: "verify-reconcile",
		purpose: "verification",
		goalId: goal.goalId,
		workItemId: "W1",
		goalEpoch: goal.execution.epoch,
		executionState: "reported_completed",
		revision: 4,
		updatedAt: new Date().toISOString(),
		receipt: verifierReceipt,
	}]);

	assert.deepEqual(outcome, { projected: 0, interrupted: 0 });
	const current = await store.get("verify-reconcile");
	assert.equal(current?.plan?.items.W1?.submissions.length, 0);
	assert.equal(current?.plan?.items.W1?.status, "ready");
});

test("改派 reservation 原子切换 active Delegation，旧终态不得清除或回退新任务", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-state-replacement-")));
	await store.init();
	const goal = await store.create({ sessionId: "replace", goal: "只读检查", completionBoundary: "检查完成", operationId: "create" });
	const planned = await store.updatePlan("replace", goal.revision, {
		upsertItems: [{ id: "W1", title: "检查", assignedAgentId: "unsafe", dependsOn: [], acceptanceCriteria: ["检查完成"], sourceGoalCriteria: ["goal:1:1"] }],
		reason: "plan",
	}, "plan", goal.execution.epoch, goal.goalId);
	const item = planned.plan!.items.W1!;
	await store.noteDelegation("replace", { goalId: goal.goalId, workItemId: "W1", delegationId: "D-old", delegationStatus: "waiting_admission", goalEpoch: goal.execution.epoch }, "old-waiting");
	await assert.rejects(() => store.reserveReplacementDelegation({
		sessionId: "replace", goalId: goal.goalId, workItemId: "W1", goalEpoch: goal.execution.epoch,
		goalRevision: goal.goalRevision + 1, workItemRevision: item.revision,
		originalDelegationId: "D-old", replacementDelegationId: "D-stale",
	}), (error: unknown) => error instanceof WorkStateOperationConflictError && error.code === "stale_goal_state");
	const reserved = await store.reserveReplacementDelegation({
		sessionId: "replace",
		goalId: goal.goalId,
		workItemId: "W1",
		goalEpoch: goal.execution.epoch,
		goalRevision: goal.goalRevision,
		workItemRevision: item.revision,
		originalDelegationId: "D-old",
		replacementDelegationId: "D-new",
	});
	assert.equal(reserved.plan?.items.W1?.activeDelegationId, "D-new");
	assert.equal(reserved.plan?.items.W1?.status, "in_progress");
	const afterOldTerminal = await store.noteDelegation("replace", { goalId: goal.goalId, workItemId: "W1", delegationId: "D-old", delegationStatus: "cancelled", goalEpoch: goal.execution.epoch }, "old-cancelled");
	assert.equal(afterOldTerminal.plan?.items.W1?.activeDelegationId, "D-new");
	assert.equal(afterOldTerminal.plan?.items.W1?.status, "in_progress");
	assert.deepEqual(afterOldTerminal.plan?.items.W1?.delegationIds, ["D-old", "D-new"]);
	const currentItem = afterOldTerminal.plan!.items.W1!;
	const afterNewTerminal = await store.noteDelegation("replace", {
		goalId: goal.goalId,
		workItemId: "W1",
		delegationId: "D-new",
		delegationStatus: "completed",
		goalEpoch: goal.execution.epoch,
		executionReceipt: sealedReceipt(afterOldTerminal, currentItem, "D-new"),
	}, "new-completed");
	assert.equal(afterNewTerminal.plan?.items.W1?.status, "submitted");
	const afterLateOldTerminal = await store.noteDelegation("replace", {
		goalId: goal.goalId,
		workItemId: "W1",
		delegationId: "D-old",
		delegationStatus: "cancelled",
		goalEpoch: goal.execution.epoch,
	}, "old-cancelled-after-new");
	assert.equal(afterLateOldTerminal.plan?.items.W1?.status, "submitted", "replacement 已提交后，旧终态只能作为审计事实");
	assert.equal(afterLateOldTerminal.plan?.items.W1?.submissions.at(-1)?.delegationId, "D-new");
});

test("Goal v5: Manager 工作项必须开始、提交、验收，完成时逐条落 Goal 条件", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-manager-item-")));
	await store.init();
	const goal = await store.create({
		sessionId: "manager-item", goal: "汇总最终报告", completionBoundary: "报告已汇总\n结论有证据",
		reviewMode: "manager", operationId: "create",
		verificationPolicy: { minimumWorkItemMode: "manager_review", finalGoalMode: "manager_review", trigger: "manager_request", source: "user", reason: "本用例验证 Manager Completion" },
	});
	const planned = await store.updatePlan("manager-item", goal.revision, {
		upsertItems: [{
			id: "W3", title: "Manager 汇总", assignedAgentId: "manager", dependsOn: [],
			acceptanceCriteria: ["报告完整"], sourceGoalCriteria: ["goal:1:1", "goal:1:2"],
		}],
		reason: "Manager 负责最终汇总",
	}, "plan", 1, goal.goalId);
	const running = await store.advanceManagerWorkItem("manager-item", "W3", planned.revision, {
		status: "in_progress",
	}, "start-w3", 1, goal.goalId);
	assert.equal(running.plan?.items.W3?.status, "in_progress");
	assert.equal(running.execution.status, "running");
	const submitted = await store.advanceManagerWorkItem("manager-item", "W3", running.revision, {
		status: "submitted", summary: "最终报告已内联交付", evidenceRefs: ["message:final-report"],
	}, "submit-w3", 1, goal.goalId);
	assert.equal(submitted.plan?.items.W3?.status, "submitted");
	assert.equal(submitted.plan?.items.W3?.submissions[0]?.source, "manager");
	assert.deepEqual(submitted.plan?.items.W3?.submissions[0]?.resultRef, { kind: "manager_summary", evidenceRefs: ["message:final-report"] });
	const accepted = await store.reviewWorkItem("manager-item", "W3", submitted.revision, {
		verdict: "accepted", summary: "汇总符合验收条件", evidenceRefs: ["message:final-report"],
	}, "review-w3", 1, goal.goalId);
	await assert.rejects(() => store.updatePlan("manager-item", accepted.revision, {
		upsertItems: [], removeItemIds: ["W3"], reason: "错误地删除已完成的 Manager 工作项",
	}, "remove-w3", 1, goal.goalId), /已经开始，不能删除/);
	await assert.rejects(() => store.update("manager-item", accepted.revision, {
		status: "resolved", currentBrief: "绕过逐项复核",
	}, "bypass-completion", 1, goal.goalId), /只能通过完成复核/);
	await assert.rejects(() => store.applyManagerCompletion("manager-item", accepted.revision, {
		currentBrief: "完成", criteria: [{ criterion: "报告已汇总", status: "satisfied", evidenceRefs: [], explanation: "已交付" }],
	}, "bad-completion", 1, goal.goalId), /逐项复核全部 2 条/);
	await assert.rejects(() => store.applyManagerCompletion("manager-item", accepted.revision, {
		currentBrief: "完成", criteria: [
			{ criterion: "报告已汇总", status: "satisfied", evidenceRefs: [], explanation: "已交付" },
			{ criterion: "结论有证据", status: "satisfied", evidenceRefs: ["message:final-report"], explanation: "有证据" },
		],
	}, "empty-evidence", 1, goal.goalId), /必须引用至少一条证据/);
	const completed = await store.applyManagerCompletion("manager-item", accepted.revision, {
		currentBrief: "最终报告已汇总并附证据",
		criteria: [
			{ criterion: "报告已汇总", status: "satisfied", evidenceRefs: ["message:final-report"], explanation: "报告正文已经交付" },
			{ criterion: "结论有证据", status: "satisfied", evidenceRefs: ["message:final-report"], explanation: "每项结论均附证据" },
		],
	}, "complete", 1, goal.goalId);
	assert.equal(completed.status, "resolved");
	assert.ok(completed.plan?.items.W3, "W3 必须保留在 WorkPlan 历史中");
	assert.equal(completed.plan?.items.W3?.status, "accepted");
	assert.equal(completed.completionReviews.at(-1)?.mode, "manager");
	assert.deepEqual(completed.completionReviews.at(-1)?.criteria.map((item) => item.status), ["satisfied", "satisfied"]);
});

test("Goal v5: 中断 epoch fence 与 resume lease", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-goal-recovery-")));
	await store.init();
	const goal = await store.create({ sessionId: "recover", goal: "持续任务", completionBoundary: "完成", operationId: "create" });
	const interrupted = await store.interruptGoal("recover", goal.revision, {
		kind: "server_restart",
		fingerprint: "restart:one",
		delegationIds: ["D-old"],
	}, "interrupt");
	assert.equal(interrupted.execution.epoch, 2);
	assert.equal(interrupted.execution.status, "interrupted");
	await assert.rejects(
		() => store.noteDelegation("recover", {
			goalId: goal.goalId,
			workItemId: "W1",
			delegationId: "D-old",
			delegationStatus: "completed",
			goalEpoch: 1,
		}, "old-boundary"),
		/WorkPlan 不存在|旧 epoch/,
	);
	const recovering = await store.resumeGoal("recover", interrupted.revision, { ownerId: "owner-a", leaseMs: 30_000 }, "resume-a");
	assert.equal(recovering.execution.status, "recovering");
	await assert.rejects(
		() => store.resumeGoal("recover", recovering.revision, { ownerId: "owner-b", leaseMs: 30_000 }, "resume-b"),
		(error: unknown) => error instanceof WorkStateOperationConflictError && error.code === "stale_goal_state",
	);
});

test("Goal v5: 同一 Session 串行多个 Goal，旧执行事实不能写入新 Goal", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-goal-history-")));
	await store.init();
	const goalA = await store.create({ sessionId: "serial", goal: "目标 A", completionBoundary: "A 完成", reviewMode: "manager", operationId: "create-a" });
	const planA = await store.updatePlan("serial", goalA.revision, {
		upsertItems: [{ id: "W1", title: "A 工作", dependsOn: [], acceptanceCriteria: ["A 完成"], sourceGoalCriteria: ["goal:1:1"] }],
		reason: "建立 A 计划",
	}, "shared-plan-operation", 1, goalA.goalId);
	const submittedA = await store.noteDelegation("serial", {
		goalId: goalA.goalId, workItemId: "W1", delegationId: "D-A", delegationStatus: "completed", goalEpoch: 1,
		executionReceipt: sealedReceipt(planA, planA.plan!.items.W1!, "D-A"),
	}, "boundary-a");
	const acceptedA = await store.reviewWorkItem("serial", "W1", submittedA.revision, { verdict: "accepted", summary: "A 已验收", evidenceRefs: ["delegation:D-A"] }, "review-a", 1, goalA.goalId);
	const decisionA = await store.createDecision({
		sessionId: "serial", requestedBy: "manager", question: "是否归档 A？", context: "", blockedAction: "完成 A", resumeHint: "按决定继续",
	}, "decision-a", acceptedA.revision, goalA.goalId);
	const waitingA = await store.getActive("serial");
	const resolvedA = await store.update("serial", waitingA!.revision, { status: "cancelled", currentBrief: "A 已结束" }, "cancel-a", 1, goalA.goalId);
	assert.equal(resolvedA.status, "cancelled");
	assert.equal((await store.listDecisions("serial", goalA.goalId))[0]?.status, "cancelled");
	await assert.rejects(() => store.answerDecision(decisionA.id, "是", undefined, "late-answer-a"), /已处理/);

	const goalB = await store.create({ sessionId: "serial", goal: "目标 B", completionBoundary: "B 完成", reviewMode: "manager", operationId: "create-b" });
	assert.notEqual(goalB.goalId, goalA.goalId);
	assert.equal((await store.getActive("serial"))?.goalId, goalB.goalId);
	assert.deepEqual((await store.listSessionGoals("serial")).map((goal) => goal.goalId), [goalB.goalId, goalA.goalId]);
	await assert.rejects(
		() => store.create({ sessionId: "serial", goal: "目标 C", completionBoundary: "C 完成", operationId: "create-c" }),
		/正在进行的 Goal/,
	);
	const planB = await store.updatePlan("serial", goalB.revision, {
		upsertItems: [{ id: "W1", title: "B 工作", dependsOn: [], acceptanceCriteria: ["B 完成"], sourceGoalCriteria: ["goal:1:1"] }],
		reason: "建立 B 计划",
	}, "shared-plan-operation", 1, goalB.goalId);
	await assert.rejects(
		() => store.updatePlan("serial", planB.revision, { upsertItems: [], reason: "A 的迟到写入" }, "late-plan-a", 1, goalA.goalId),
		(error: unknown) => error instanceof WorkStateOperationConflictError && error.code === "stale_goal_state",
	);
	await assert.rejects(
		() => store.noteDelegation("serial", {
			goalId: goalA.goalId, workItemId: "W1", delegationId: "D-A-late", delegationStatus: "completed", goalEpoch: 1,
		}, "late-a"),
		(error: unknown) => error instanceof WorkStateOperationConflictError && error.code === "stale_goal_state",
	);
	assert.equal((await store.getActive("serial"))?.revision, planB.revision);
	assert.equal((await store.getActive("serial"))?.plan?.items.W1?.submissions.length, 0);
});

test("Goal v5: Goal 契约变化后 WorkPlan 必须逐项对账新条件引用", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-goal-reconcile-")));
	await store.init();
	const goal = await store.create({ sessionId: "contract", goal: "交付", completionBoundary: "旧条件", operationId: "create" });
	const planned = await store.updatePlan("contract", goal.revision, {
		upsertItems: [{ id: "W1", title: "执行", acceptanceCriteria: ["满足旧条件"], sourceGoalCriteria: ["goal:1:1"] }],
		reason: "初始拆解",
	}, "plan");
	const changed = await store.update("contract", planned.revision, { completionBoundary: "新条件" }, "goal-change");
	assert.equal(changed.plan?.needsReconcile, true);
	assert.equal(changed.status, "active");
	await assert.rejects(() => store.updatePlan("contract", changed.revision, {
		upsertItems: [], reason: "错误地直接确认覆盖",
	}, "stale-plan"), /尚未对账当前 Goal 条件/);
	const reconciled = await store.updatePlan("contract", changed.revision, {
		upsertItems: [{ id: "W1", title: "执行", acceptanceCriteria: ["满足新条件"], sourceGoalCriteria: ["goal:2:1"] }],
		reason: "按新 Goal 条件重建验收映射",
	}, "reconciled-plan");
	assert.equal(reconciled.plan?.coveredGoalRevision, 2);
	assert.equal(reconciled.plan?.needsReconcile, false);
	assert.deepEqual(reconciled.plan?.items.W1?.sourceGoalCriteria, ["goal:2:1"]);
});

test("Goal v5: Goal 创建 operationId 不得跨 Session 重复生效", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-goal-create-idem-")));
	await store.init();
	await store.create({ sessionId: "S1", goal: "目标", completionBoundary: "完成", operationId: "same-create" });
	await assert.rejects(
		() => store.create({ sessionId: "S2", goal: "目标", completionBoundary: "完成", operationId: "same-create" }),
		(error: unknown) => error instanceof WorkStateOperationConflictError && error.code === "idempotency_conflict",
	);
});

test("Goal v6: sealed Receipt、VerificationRecord 与 isolated worktree 提升门禁", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-plan-v6-")));
	await store.init();
	const goal = await store.create({ sessionId: "v6", goal: "交付代码", completionBoundary: "测试通过", operationId: "create-v6", verificationPolicy: { minimumWorkItemMode: "independent_evidence_review", finalGoalMode: "environment_verified", reason: "代码交付需独立证据" } });
	const planned = await store.updatePlan("v6", goal.revision, {
		upsertItems: [{ id: "W1", title: "实现并测试", acceptanceCriteria: ["测试通过"], sourceGoalCriteria: ["goal:1:1"], verificationPolicy: { mode: "environment_verified", trigger: "manager_request", source: "manager_derived", reason: "需要环境复验" }, workspaceExecutionPolicy: { mode: "isolated_worktree", source: "harness_default", reason: "代码隔离执行", baselineStrategy: "git_tree", promoteOnAcceptance: true } }], reason: "建立 v6 计划",
	}, "plan-v6");
	const item = planned.plan!.items.W1!;
	const changeSet = { id: "cs-v6", executionScopeId: "scope-v6", delegationIds: ["D-v6"], mode: "isolated_worktree" as const, baselineFingerprint: "base", outputFingerprint: "out", changedPaths: ["src/a.ts"], promotionState: "applied" as const, createdAt: new Date().toISOString(), promotedAt: new Date().toISOString() };
	const submitted = await store.noteDelegation("v6", { goalId: goal.goalId, workItemId: "W1", delegationId: "D-v6", delegationStatus: "completed", goalEpoch: 1, executionReceipt: sealedReceipt(planned, item, "D-v6"), workspaceChangeSet: changeSet }, "boundary-v6");
	await assert.rejects(() => store.reviewWorkItem("v6", "W1", submitted.revision, { verdict: "accepted", summary: "先验收" }, "review-before-v6"), /VerificationRecord/);
	const submission = submitted.plan!.items.W1!.submissions[0]!;
	const verified = await store.recordVerification("v6", submitted.revision, {
		id: "verification-v6", goalId: goal.goalId, workPlanId: submitted.plan!.id, workItemId: "W1", submissionId: submission.id,
		goalRevision: 1, workItemRevision: submission.workItemRevision, goalEpoch: 1, mode: "environment_verified", status: "passed",
		environmentMode: "isolated_copy", inputFingerprint: submission.inputFingerprint, criteria: [{ criterion: "测试通过", status: "satisfied", evidenceRefs: ["test-v6"], explanation: "测试成功" }], evidenceRefs: ["test-v6"], integrity: "clean", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
		}, "verification-v6");
	await assert.rejects(
		() => store.reviewWorkItem("v6", "W1", verified.revision, { verdict: "accepted", summary: "跳过两阶段提升" }, "review-without-intent-v6"),
		/accepted 意图记录/,
	);
	const intended = await store.recordAcceptanceIntent("v6", "W1", verified.revision, { summary: "独立证据充分" }, "intent-v6");
	await assert.rejects(
		() => store.recordAcceptanceIntent("v6", "W1", intended.revision, { summary: "尝试覆盖意图" }, "intent-v6-overwrite"),
		/不允许覆盖/,
	);
	const accepted = await store.reviewWorkItem("v6", "W1", intended.revision, { verdict: "accepted", summary: "独立证据充分" }, "review-after-v6");
	assert.equal(accepted.plan?.items.W1?.status, "accepted");
});

test("manager_review 可验收普通 Connector 的 partial Receipt，但必须记录 Manager 证据引用", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-manager-review-partial-")));
	await store.init();
	const goal = await store.create({ sessionId: "manager-review", goal: "检查 Worker 输出", completionBoundary: "结果已由 Manager 验收" });
	const planned = await store.updatePlan("manager-review", goal.revision, {
		upsertItems: [{
			id: "W1",
			title: "普通 CLI Worker 输出",
			acceptanceCriteria: ["返回分支和 HEAD"],
			sourceGoalCriteria: ["goal:1:1"],
			verificationPolicy: { mode: "manager_review", trigger: "manager_request", source: "user", reason: "由 Manager 读回结果" },
		}],
		reason: "验证 manager_review 信任边界",
	}, "plan-manager-review");
	const item = planned.plan!.items.W1!;
	const receipt = sealedReceipt(planned, item, "D-plain");
	receipt.requirementResults = [{ requirement: "返回分支和 HEAD", status: "missing", evidenceRefs: [] }];
	receipt.collectionStatus = "partial";
	receipt.integrity = "suspect";
	receipt.issues = ["普通 Connector 未输出结构化 reportedEvidence"];
	const submitted = await store.noteDelegation("manager-review", {
		goalId: goal.goalId,
		workItemId: "W1",
		delegationId: "D-plain",
		delegationStatus: "completed",
		goalEpoch: 1,
		summary: "分支 main，HEAD abc123",
		executionReceipt: receipt,
	}, "boundary-manager-review");
	await assert.rejects(
		() => store.reviewWorkItem("manager-review", "W1", submitted.revision, { verdict: "accepted", summary: "已读回结果" }, "review-without-evidence"),
		/必须引用至少一条/,
	);
	const accepted = await store.reviewWorkItem("manager-review", "W1", submitted.revision, {
		verdict: "accepted",
		summary: "已读回 Worker 结果，分支与 HEAD 完整",
		evidenceRefs: ["delegation:D-plain"],
	}, "review-with-manager-evidence");
	assert.equal(accepted.plan?.items.W1?.status, "accepted");
});

test("Goal v6: Harness trigger 与三类 Workspace 默认值冻结进新 WorkItem", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-plan-v6-defaults-")));
	await store.init();
	store.configureVerificationDefaults({
		trigger: "auto_on_submission",
		workspaceExecution: { readOnlyMode: "read_only_shared", gitWriteMode: "exclusive_write", nonGitWriteMode: "exclusive_write" },
	});
	const goal = await store.create({ sessionId: "defaults", goal: "验证默认值", completionBoundary: "完成", operationId: "create-defaults" });
	const planned = await store.updatePlan("defaults", goal.revision, {
		reason: "按执行类别解析 Harness 默认值",
		upsertItems: [
			{ id: "R", title: "只读", acceptanceCriteria: ["完成"], sourceGoalCriteria: ["goal:1:1"], workspaceExecutionClass: "read_only" },
			{ id: "G", title: "Git 写", acceptanceCriteria: ["完成"], sourceGoalCriteria: ["goal:1:1"], workspaceExecutionClass: "git_write" },
			{ id: "N", title: "非 Git 写", acceptanceCriteria: ["完成"], sourceGoalCriteria: ["goal:1:1"], workspaceExecutionClass: "non_git_write" },
		],
	}, "plan-defaults");
	assert.equal(planned.plan?.items.R?.workspaceExecutionPolicy.mode, "read_only_shared");
	assert.equal(planned.plan?.items.G?.workspaceExecutionPolicy.mode, "exclusive_write");
	assert.equal(planned.plan?.items.G?.workspaceExecutionPolicy.baselineStrategy, "git_tree");
	assert.equal(planned.plan?.items.N?.workspaceExecutionPolicy.mode, "exclusive_write");
	assert.equal(planned.plan?.items.N?.workspaceExecutionPolicy.baselineStrategy, "filesystem_manifest");
	assert.ok(Object.values(planned.plan?.items ?? {}).every((item) => item.verificationPolicy.trigger === "auto_on_submission"));
});
