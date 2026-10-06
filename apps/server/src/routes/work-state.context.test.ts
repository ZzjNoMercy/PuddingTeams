import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { TeamsStore } from "../store/teams.js";
import { WorkStateStore, workItemContractHash, type ExecutionReceipt } from "../store/work-state.js";
import { registerWorkStateRoutes } from "./work-state.js";

async function makeStack(promote?: (scopeId: string, changeSetId: string) => Promise<unknown>) {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-work-state-context-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const workStates = new WorkStateStore(path.join(dir, "work-state"));
	await workStates.init();
	const app = Fastify({ logger: false });
	registerWorkStateRoutes(app, workStates, teams, sessions, promote ? { promoteWorkspaceChangeSet: promote } as unknown as AgentRuntime : undefined);
	const solo = await teams.ensureSoloWindow(
		async (workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
		async () => false,
	);
	return { app, teams, sessions, invoker, workStates, solo };
}

test("页面验收 Git 写 Submission 时先记录意图、提升 change-set，再接受且可重放", async () => {
	let stack: Awaited<ReturnType<typeof makeStack>>;
	let promotions = 0;
	stack = await makeStack(async (scopeId, changeSetId) => {
		promotions += 1;
		const state = await stack.workStates.getActive(stack.solo.activeSession);
		const targetId = changeSetId === "cs-conflict" ? "W2" : "W1";
		assert.ok(state?.plan?.items[targetId]?.submissions[0]?.acceptanceIntent, "提升前必须冻结 accepted 意图");
		assert.ok(["scope-route", "scope-conflict"].includes(scopeId));
		assert.ok(["cs-route", "cs-conflict"].includes(changeSetId));
		if (changeSetId === "cs-route") {
			const item = state!.plan!.items.W1!;
			const competing = await stack.app.inject({ method: "POST", url: `/api/sessions/${stack.solo.activeSession}/work-items/W1/review`,
				headers: { "idempotency-key": "competing-revision" }, payload: { expectedGoalId: state!.goalId, expectedRevision: state!.revision,
					expectedEpoch: state!.execution.epoch, expectedWorkItemRevision: item.revision, expectedSubmissionId: item.submissions[0]!.id,
					verdict: "revision", summary: "并发要求返修" } });
			assert.equal(competing.statusCode, 400, competing.body);
			assert.equal((await stack.workStates.getActive(stack.solo.activeSession))?.plan?.items.W1?.status, "submitted");
			const unrelated = await stack.workStates.noteDelegation(stack.solo.activeSession, {
				goalId: state!.goalId, workItemId: "W2", delegationId: "D-conflict",
				delegationStatus: "running", goalEpoch: state!.execution.epoch,
			}, "unrelated-during-promotion");
			assert.ok(unrelated.revision > state!.revision, "无关 WorkItem 可以推进全局修订号");
		}
		return changeSetId === "cs-conflict"
			? { ...conflictChangeSet, promotionState: "conflict" as const }
			: { ...changeSet, promotionState: "applied" as const, promotedAt: new Date().toISOString() };
	});
	const sessionId = stack.solo.activeSession;
	const goal = await stack.workStates.create({ sessionId, goal: "交付 Git 文件", completionBoundary: "文件存在" });
	const planned = await stack.workStates.updatePlan(sessionId, goal.revision, {
		upsertItems: ["W1", "W2"].map((id) => ({ id, title: "写入文件", acceptanceCriteria: ["文件存在"], sourceGoalCriteria: ["goal:1:1"], workspaceExecutionClass: "git_write" as const,
			verificationPolicy: { mode: "manager_review" as const, trigger: "manager_request" as const, source: "user" as const, reason: "人工检查" } })), reason: "建立 Git 写任务",
	}, "plan-route");
	const item = planned.plan!.items.W1!;
	assert.equal(item.workspaceExecutionPolicy.mode, "isolated_worktree");
	const receipt: ExecutionReceipt = {
		id: "receipt-route", delegationId: "D-route", goalId: goal.goalId, workPlanId: planned.plan!.id, workItemId: item.id,
		goalRevision: planned.goalRevision, workItemRevision: item.revision, goalEpoch: planned.execution.epoch,
		taskContractHash: workItemContractHash(planned, planned.plan!, item), reportedOutcome: "completed",
		requirementResults: [{ requirement: "文件存在", status: "provided", evidenceRefs: ["D-route"] }], artifactCapture: [],
		collectionStatus: "complete", integrity: "clean", issues: [], sealedAt: new Date().toISOString(), workspaceExecutionScopeId: "scope-route",
	};
	const changeSet = { id: "cs-route", executionScopeId: "scope-route", delegationIds: ["D-route"], mode: "isolated_worktree" as const,
		baselineFingerprint: "base", outputFingerprint: "out", changedPaths: ["result.txt"], promotionState: "pending" as const, createdAt: new Date().toISOString() };
	const conflictChangeSet = { ...changeSet, id: "cs-conflict", executionScopeId: "scope-conflict", delegationIds: ["D-conflict"] };
	const submitted = await stack.workStates.noteDelegation(sessionId, { goalId: goal.goalId, workItemId: "W1", delegationId: "D-route",
		delegationStatus: "completed", goalEpoch: 1, executionReceipt: receipt, workspaceChangeSet: changeSet }, "submit-route");
	const target = submitted.plan!.items.W1!;
	const body = { expectedGoalId: goal.goalId, expectedRevision: submitted.revision, expectedEpoch: 1,
		expectedWorkItemRevision: target.revision, expectedSubmissionId: target.submissions[0]!.id,
		verdict: "accepted", summary: "文件已验证", evidenceRefs: ["delegation:D-route"] };
	try {
		const url = `/api/sessions/${sessionId}/work-items/W1/review`;
		const response = await stack.app.inject({ method: "POST", url, headers: { "idempotency-key": "review-route" }, payload: body });
		assert.equal(response.statusCode, 200, response.body);
		assert.equal(response.json().workItem.status, "accepted");
		assert.equal(response.json().workItem.submissions[0].workspaceChangeSet.promotionState, "applied");
		assert.equal(promotions, 1);
		const replay = await stack.app.inject({ method: "POST", url, headers: { "idempotency-key": "review-route" }, payload: body });
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(promotions, 1);
		const beforeConflict = await stack.workStates.getActive(sessionId);
		const conflictItem = beforeConflict!.plan!.items.W2!;
		const conflictReceipt: ExecutionReceipt = { ...receipt, id: "receipt-conflict", delegationId: "D-conflict", workItemId: "W2",
			workItemRevision: conflictItem.revision, taskContractHash: workItemContractHash(beforeConflict!, beforeConflict!.plan!, conflictItem),
			workspaceExecutionScopeId: "scope-conflict" };
		const conflictSubmitted = await stack.workStates.noteDelegation(sessionId, { goalId: goal.goalId, workItemId: "W2", delegationId: "D-conflict",
			delegationStatus: "completed", goalEpoch: 1, executionReceipt: conflictReceipt, workspaceChangeSet: conflictChangeSet }, "submit-conflict");
		const conflictTarget = conflictSubmitted.plan!.items.W2!;
		const conflictResponse = await stack.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/work-items/W2/review`,
			headers: { "idempotency-key": "review-conflict" }, payload: { ...body, expectedRevision: conflictSubmitted.revision,
				expectedWorkItemRevision: conflictTarget.revision, expectedSubmissionId: conflictTarget.submissions[0]!.id } });
		assert.equal(conflictResponse.statusCode, 200, conflictResponse.body);
		assert.equal(conflictResponse.json().workItem.status, "blocked");
		assert.equal(conflictResponse.json().workItem.submissions[0].workspaceChangeSet.promotionState, "conflict");
		assert.equal(promotions, 2);
		const conflictReplay = await stack.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/work-items/W2/review`,
			headers: { "idempotency-key": "review-conflict" }, payload: { ...body, expectedRevision: conflictSubmitted.revision,
				expectedWorkItemRevision: conflictTarget.revision, expectedSubmissionId: conflictTarget.submissions[0]!.id } });
		assert.equal(conflictReplay.statusCode, 200, conflictReplay.body);
		assert.equal(conflictReplay.json().workItem.status, "blocked");
		assert.equal(promotions, 2);
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

async function parkSolo(
	stack: Awaited<ReturnType<typeof makeStack>>,
): Promise<void> {
	const workspace = await stack.teams.workspaces.createManaged("park-target");
	await stack.invoker.switchWorkspaceInPlace(
		stack.solo.id,
		workspace.id,
		async (source, cwd) => stack.sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd }),
		(id) => stack.sessions.prepareForParking(id),
		(id) => stack.sessions.validateStoredContext(id),
		(id) => stack.sessions.suspend(id),
		(id) => stack.sessions.remove(id),
	);
}

test("parked Session 不能恢复 Goal，且不会改变 durable work-state", async () => {
	const stack = await makeStack();
	const created = await stack.workStates.create({
		sessionId: stack.solo.activeSession,
		goal: "恢复测试",
		completionBoundary: "完成",
	});
	const interrupted = await stack.workStates.interruptGoal(
		stack.solo.activeSession,
		created.revision,
		{ kind: "user", fingerprint: "parked-resume", delegationIds: [] },
		"interrupt-before-park",
		created.goalId,
	);
	await parkSolo(stack);
	const response = await stack.app.inject({
		method: "POST",
		url: `/api/sessions/${stack.solo.activeSession}/goal/resume`,
		headers: { "idempotency-key": "resume-while-parked" },
		payload: { expectedGoalId: created.goalId, expectedRevision: interrupted.revision },
	});
	assert.equal(response.statusCode, 409, response.body);
	assert.deepEqual(response.json(), { error: "session_context_inactive" });
	assert.equal((await stack.workStates.getGoal(stack.solo.activeSession, created.goalId))?.execution.status, "interrupted");
	await stack.sessions.disposeAll();
	await stack.app.close();
});

test("parked Session 的 Decision 不能被回答，也不会提前消费恢复事件", async () => {
	const stack = await makeStack();
	const goal = await stack.workStates.create({
		sessionId: stack.solo.activeSession,
		goal: "决策测试",
		completionBoundary: "完成",
	});
	const decision = await stack.workStates.createDecision({
		sessionId: stack.solo.activeSession,
		requestedBy: "manager",
		question: "是否继续？",
		context: "测试",
		blockedAction: "继续执行",
		resumeHint: "按答案继续",
	}, "create-decision", goal.revision, goal.goalId);
	await parkSolo(stack);
	const response = await stack.app.inject({
		method: "POST",
		url: `/api/decision-requests/${decision.id}/answer`,
		headers: { "idempotency-key": "answer-while-parked" },
		payload: { answer: "继续" },
	});
	assert.equal(response.statusCode, 409, response.body);
	assert.deepEqual(response.json(), { error: "session_context_inactive" });
	assert.equal((await stack.workStates.getDecision(decision.id))?.status, "pending");
	assert.equal((await stack.workStates.pendingOutbox()).some((event) => event.id === `decision-answered:${goal.goalId}:${decision.id}`), false);
	await stack.sessions.disposeAll();
	await stack.app.close();
});

test("Goal abandon/supersede 路由释放 active 门禁并原子链接新旧 Goal", async () => {
	const stack = await makeStack();
	const sessionId = stack.solo.activeSession;
	const first = await stack.workStates.create({ sessionId, goal: "旧 Goal", completionBoundary: "旧任务完成" });
	const abandon = await stack.app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/goal/abandon`,
		headers: { "idempotency-key": "route-abandon" },
		payload: { expectedGoalId: first.goalId, expectedRevision: first.revision, reason: "用户不再继续" },
	});
	assert.equal(abandon.statusCode, 200, abandon.body);
	assert.equal(abandon.json().workState.status, "cancelled");
	assert.equal(await stack.workStates.getActive(sessionId), undefined);
	const abandonReplay = await stack.app.inject({
		method: "POST", url: `/api/sessions/${sessionId}/goal/abandon`, headers: { "idempotency-key": "route-abandon" },
		payload: { expectedGoalId: first.goalId, expectedRevision: first.revision, reason: "用户不再继续" },
	});
	assert.equal(abandonReplay.statusCode, 200, abandonReplay.body);
	assert.equal(abandonReplay.json().workState.revision, abandon.json().workState.revision);

	const second = await stack.workStates.create({ sessionId, goal: "中间 Goal", completionBoundary: "中间任务完成" });
	const supersede = await stack.app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/goal/supersede`,
		headers: { "idempotency-key": "route-supersede" },
		payload: {
			expectedGoalId: second.goalId,
			expectedRevision: second.revision,
			reason: "用户改做图片任务",
			goal: "生成图片",
			completionBoundary: "图片已交付",
			reviewMode: "manager",
		},
	});
	assert.equal(supersede.statusCode, 200, supersede.body);
	const body = supersede.json();
	assert.equal(body.previous.status, "superseded");
	assert.equal(body.previous.supersededByGoalId, body.workState.goalId);
	assert.equal(body.workState.supersedesGoalId, second.goalId);
	assert.equal((await stack.workStates.getActive(sessionId))?.goal, "生成图片");
	const supersedeReplay = await stack.app.inject({
		method: "POST", url: `/api/sessions/${sessionId}/goal/supersede`, headers: { "idempotency-key": "route-supersede" },
		payload: { expectedGoalId: second.goalId, expectedRevision: second.revision, reason: "用户改做图片任务", goal: "生成图片", completionBoundary: "图片已交付", reviewMode: "manager" },
	});
	assert.equal(supersedeReplay.statusCode, 200, supersedeReplay.body);
	assert.equal(supersedeReplay.json().workState.goalId, body.workState.goalId);
	await stack.sessions.disposeAll();
	await stack.app.close();
});

test("WorkItem review 路由返回结构化冲突，并对未变化的 Submission 安全 rebase", async () => {
	const stack = await makeStack();
	const sessionId = stack.solo.activeSession;
	const goal = await stack.workStates.create({ sessionId, goal: "汇总报告", completionBoundary: "报告已验收" });
	const planned = await stack.workStates.updatePlan(sessionId, goal.revision, {
		upsertItems: [{ id: "W1", title: "Manager 汇总", assignedAgentId: "manager", acceptanceCriteria: ["报告完整"], sourceGoalCriteria: ["goal:1:1"] }],
		reason: "建立验收目标",
	}, "route-review-plan", goal.execution.epoch, goal.goalId);
	const running = await stack.workStates.advanceManagerWorkItem(sessionId, "W1", planned.revision, { status: "in_progress" }, "route-review-start", goal.execution.epoch, goal.goalId);
	const submitted = await stack.workStates.advanceManagerWorkItem(sessionId, "W1", running.revision, {
		status: "submitted", summary: "报告正文", evidenceRefs: ["message:report"],
	}, "route-review-submit", goal.execution.epoch, goal.goalId);
	const item = submitted.plan!.items.W1!;
	const submission = item.submissions.at(-1)!;
	const advanced = await stack.workStates.update(sessionId, submitted.revision, { currentBrief: "observer 更新摘要" }, "route-review-observer", goal.execution.epoch, goal.goalId);

	const conflict = await stack.app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/work-items/W1/review`,
		headers: { "idempotency-key": "route-review-conflict" },
		payload: {
			expectedGoalId: goal.goalId,
			expectedRevision: submitted.revision,
			expectedEpoch: goal.execution.epoch,
			expectedWorkItemRevision: item.revision,
			expectedSubmissionId: "submission-other",
			verdict: "accepted",
			summary: "错误目标",
		},
	});
	assert.equal(conflict.statusCode, 409, conflict.body);
	assert.equal(conflict.json().code, "stale_goal_state");
	assert.equal(conflict.json().expectedRevision, submitted.revision);
	assert.equal(conflict.json().currentRevision, advanced.revision);
	assert.equal(conflict.json().current.revision, advanced.revision);

	const accepted = await stack.app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/work-items/W1/review`,
		headers: { "idempotency-key": "route-review-rebase" },
		payload: {
			expectedGoalId: goal.goalId,
			expectedRevision: submitted.revision,
			expectedEpoch: goal.execution.epoch,
			expectedWorkItemRevision: item.revision,
			expectedSubmissionId: submission.id,
			verdict: "accepted",
			summary: "目标未变化，允许对齐",
		},
	});
	assert.equal(accepted.statusCode, 200, accepted.body);
	assert.equal(accepted.json().workItem.status, "accepted");
	assert.equal(accepted.json().workItem.submissions.at(-1).review.rebasedFromRevision, submitted.revision);
	await stack.sessions.disposeAll();
	await stack.app.close();
});
