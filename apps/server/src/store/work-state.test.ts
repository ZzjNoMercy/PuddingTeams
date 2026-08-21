import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkStateConflictError, WorkStateOperationConflictError, WorkStateStore } from "./work-state.js";

test("P3-G: Session Goal revision、业务决策与清理闭环", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-state-")));
	await store.init();
	const created = await store.create({
		sessionId: "s1",
		goal: "交付可审核版本",
		completionBoundary: "测试全绿且 Human 审核通过",
		participantAgentIds: ["codex", "codex"],
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
		status: "completed", revision: 2, updatedAt: new Date().toISOString(),
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

test("Goal v5: Manager 工作项必须开始、提交、验收，完成时逐条落 Goal 条件", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-manager-item-")));
	await store.init();
	const goal = await store.create({
		sessionId: "manager-item", goal: "汇总最终报告", completionBoundary: "报告已汇总\n结论有证据",
		reviewMode: "manager", operationId: "create",
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
	}, "boundary-a");
	const acceptedA = await store.reviewWorkItem("serial", "W1", submittedA.revision, { verdict: "accepted", summary: "A 已验收" }, "review-a", 1, goalA.goalId);
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
