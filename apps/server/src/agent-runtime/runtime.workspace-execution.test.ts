import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { ArtifactStore } from "./artifact-store.js";
import { WorkspaceExecutionCoordinator } from "./workspace-execution.js";
import { settleWorkItemReview } from "./work-item-settlement.js";
import { WorkStateStore, workItemContractHash } from "../store/work-state.js";
import type { AgentDriver } from "./types.js";

function temp(prefix: string): string { return mkdtempSync(path.join(tmpdir(), prefix)); }
function git(cwd: string, ...args: string[]): string { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }

test("Runtime 在 Driver 启动前把无只读强制能力的 Git 任务路由到 dirty-baseline worktree", async () => {
	const root = temp("pt-runtime-workspace-");
	git(root, "init"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test");
	writeFileSync(path.join(root, "input.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-m", "base");
	writeFileSync(path.join(root, "input.txt"), "dirty-visible\n");
	const state = temp("pt-runtime-workspace-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const artifacts = new ArtifactStore(state, path.join(state, "artifact-blobs")); await artifacts.init();
	const coordinator = new WorkspaceExecutionCoordinator(state, { worktreeRoot: temp("pt-runtime-worktrees-") }); await coordinator.init();
	const workStates = new WorkStateStore(temp("pt-runtime-work-state-")); await workStates.init();
	const goal = await workStates.create({ sessionId: "s", goal: "write result", completionBoundary: "result exists", operationId: "create-goal" });
	const policy = { mode: "isolated_worktree" as const, source: "user" as const, reason: "write task", baselineStrategy: "git_tree" as const, promoteOnAcceptance: true };
	const planned = await workStates.updatePlan("s", goal.revision, { upsertItems: [{ id: "W1", title: "write", acceptanceCriteria: ["result exists"], sourceGoalCriteria: ["goal:1:1"], workspaceExecutionPolicy: policy }], reason: "plan" }, "plan", goal.execution.epoch, goal.goalId);
	const item = planned.plan!.items.W1!;
	const frozenContractHash = workItemContractHash(planned, planned.plan!, item);
	let observedCwd = "";
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: ["git_diff"] } }; },
		async *run(_input, ctx) {
			observedCwd = ctx.cwd;
			assert.equal(readFileSync(path.join(ctx.cwd, "input.txt"), "utf8"), "dirty-visible\n");
			writeFileSync(path.join(ctx.cwd, "result.txt"), "result\n");
			yield { type: "completed", result: { agentId: "worker", status: "completed", reportedEvidence: [{ requirement: "result exists", evidenceRefs: ["result.txt"] }], artifacts: [{ name: "result.txt", path: "result.txt", origin: "observe" }] } };
		},
		async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, artifacts, undefined, coordinator);
	const outcome = await runtime.delegate({
		windowId: "w", workspaceId: "workspace", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1,
		message: "write result", mode: "run", evidenceRequirements: ["result exists"], goalId: goal.goalId, workPlanId: planned.plan!.id,
		workItemId: item.id, goalEpoch: goal.execution.epoch, goalRevision: goal.goalRevision, workItemRevision: item.revision, contractHash: frozenContractHash,
		workspaceExecutionPolicy: policy,
	}, { cwd: root, env: {} });
	assert.equal(outcome.status, "completed", JSON.stringify(outcome.result));
	assert.notEqual(observedCwd, root);
	assert.equal(existsSync(path.join(root, "result.txt")), false, "验收前不得写入目标 Workspace");
	assert.equal(outcome.delegation.workspaceExecutionPolicy?.mode, "isolated_worktree");
	assert.ok(outcome.delegation.workspaceExecutionScopeId);
	assert.ok(outcome.delegation.workspaceChangeSetId);
	assert.equal(outcome.delegation.receipt?.integrity, "clean");
	assert.equal(outcome.delegation.receipt?.collectionStatus, "complete");
	assert.equal(outcome.delegation.receipt?.artifactCapture[0]?.status, "captured", "Artifact 必须从隔离执行 cwd 捕获，而不是提前读取目标 checkout");
	assert.equal(outcome.delegation.receipt?.taskContractHash, frozenContractHash);
	assert.notEqual(outcome.delegation.receipt?.contractHash, frozenContractHash, "Runtime envelope 还必须绑定 Agent/执行身份");
	const changeSet = await runtime.getWorkspaceChangeSet(outcome.delegation.workspaceChangeSetId);
	assert.deepEqual(changeSet?.changedPaths, ["result.txt"]);
	assert.equal(changeSet?.promotionState, "pending");
	const submitted = await workStates.noteDelegation("s", { goalId: goal.goalId, workItemId: item.id, delegationId: outcome.delegation.id, delegationStatus: "completed", goalEpoch: goal.execution.epoch, executionReceipt: outcome.delegation.receipt, workspaceChangeSet: changeSet }, "boundary");
	assert.equal(submitted.plan?.items.W1?.status, "submitted", "Runtime Receipt 必须能通过 WorkState 的同一冻结契约门禁");
	const { state: accepted } = await settleWorkItemReview({
		workStates, sessionId: "s", goalId: goal.goalId, workItemId: "W1", expectedRevision: submitted.revision,
		expectedEpoch: 1, review: { expectedWorkItemRevision: submitted.plan!.items.W1!.revision,
			expectedSubmissionId: submitted.plan!.items.W1!.submissions[0]!.id, verdict: "accepted",
			summary: "已检查 result.txt", evidenceRefs: ["delegation:" + outcome.delegation.id] },
		operationId: "review-real-git-write",
		promoteWorkspaceChangeSet: (scopeId, changeSetId) => runtime.promoteWorkspaceChangeSet(scopeId, changeSetId),
	});
	assert.equal(accepted.plan?.items.W1?.status, "accepted");
	assert.equal(accepted.plan?.items.W1?.submissions[0]?.workspaceChangeSet?.promotionState, "applied");
	assert.equal(readFileSync(path.join(root, "result.txt"), "utf8"), "result\n");
});

async function inspectionStack(options: { enforcement?: "none" | "sandbox"; write?: boolean; honorsCwd?: boolean; coordinator?: boolean } = {}) {
	const root = temp("pt-readonly-decision-");
	const state = temp("pt-readonly-decision-state-");
	writeFileSync(path.join(root, "input.txt"), "base");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const scopes = new WorkspaceExecutionCoordinator(state); await scopes.init();
	let starts = 0;
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: options.honorsCwd ?? true, readOnlyEnforcement: options.enforcement ?? "none", mutationObservation: [] } }; },
		async *run(_input, ctx) {
			starts++;
			if (options.write) writeFileSync(path.join(ctx.cwd, "unexpected.txt"), "mutation");
			yield { type: "completed", result: { agentId: "worker", status: "completed", content: "inspected" } };
		},
		async *continue() {}, async *respond() {}, async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, undefined, undefined, options.coordinator === false ? undefined : scopes);
	const run = (policy: import("./workspace-execution.js").WorkspaceExecutionPolicy = { mode: "read_only_shared", source: "harness_default", reason: "inspection", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false }) => runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1, message: "inspect", mode: "run", workspaceExecutionPolicy: policy,
	}, { cwd: root, env: {} });
	return { root, runtime, scopes, delegations, run, starts: () => starts };
}

test("普通只读任务自动执行：无准入交互、保留只读契约并释放观测租约，重复执行不询问", async () => {
	const s = await inspectionStack();
	for (let i = 0; i < 2; i++) {
		const result = await s.run();
		assert.equal(result.status, "completed", JSON.stringify(result.result));
		assert.equal(result.interaction, undefined);
		assert.equal(result.delegation.admissionInteractionId, undefined);
		assert.equal(result.delegation.readOnlyAssessment, "unverified_observed");
		assert.equal(result.delegation.workspaceExecutionPolicy?.mode, "read_only_shared");
		assert.equal(result.delegation.receipt?.integrity, "clean");
		const scope = await s.scopes.get(result.delegation.workspaceExecutionScopeId!);
		assert.equal(scope?.mode, "exclusive_write", "观测租约不等于增加 Worker 权限");
		assert.equal(scope?.state, "released");
	}
	assert.equal(s.starts(), 2);
});

test("自动查阅仍记录意外写入为契约违规，不能当成干净只读或待提升产物", async () => {
	const s = await inspectionStack({ write: true });
	const result = await s.run();
	assert.equal(result.status, "completed");
	assert.equal(result.delegation.receipt?.integrity, "violation");
	assert.match(result.delegation.receipt?.issues.join(" ") ?? "", /Workspace 写入/);
	const changes = await s.runtime.getWorkspaceChangeSet(result.delegation.workspaceChangeSetId!);
	assert.deepEqual(changes?.changedPaths, ["unexpected.txt"]);
	assert.equal(changes?.promotionState, "not_required");
	assert.equal(changes?.integrity, "violation");
});

for (const source of ["user", "manager_derived"] as const) {
	test(`强制只读能力缺口返回 Manager 可恢复失败，不要求无效确认（source=${source}）`, async () => {
		const s = await inspectionStack();
		const result = await s.run({ mode: "read_only_shared", source, ...(source === "manager_derived" ? { readOnlyRequirement: "enforced" as const } : {}), reason: "must never write", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false });
		assert.equal(result.status, "failed");
		assert.equal(result.result.status, "blocked");
		assert.equal(result.result.meta?.userDecisionRequired, false);
		assert.equal(result.interaction, undefined);
		assert.equal(result.delegation.workerStarted, false);
		assert.equal(result.delegation.receipt?.workerStarted, false);
		assert.equal(result.delegation.workspaceExecutionScopeId, undefined);
		assert.equal(result.delegation.readOnlyAssessment, "unverified");
		assert.equal(s.starts(), 0);
	});
}

test("真实只读能力自动执行强制只读任务并使用共享 scope", async () => {
	const s = await inspectionStack({ enforcement: "sandbox" });
	const result = await s.run({ mode: "read_only_shared", source: "user", reason: "never write", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false });
	assert.equal(result.status, "completed");
	assert.equal(result.delegation.readOnlyAssessment, "verified");
	assert.equal((await s.scopes.get(result.delegation.workspaceExecutionScopeId!))?.mode, "read_only_shared");
});

for (const options of [{ honorsCwd: false }, { coordinator: false }]) {
	test(`没有可靠目录观测时不伪造自动只读保障：${JSON.stringify(options)}`, async () => {
		const s = await inspectionStack(options);
		const result = await s.run();
		assert.equal(result.status, "failed");
		assert.equal(result.interaction, undefined);
		assert.equal(s.starts(), 0);
	});
}

test("Goal Verifier 使用平台签发的非 Git 隔离副本，任意 cwd/跨 Verification 复用均被拒绝", async () => {
	const root = temp("pt-runtime-goal-verification-");
	writeFileSync(path.join(root, "input.txt"), "integrated\n");
	const state = temp("pt-runtime-goal-verification-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const coordinator = new WorkspaceExecutionCoordinator(state, { worktreeRoot: temp("pt-runtime-goal-verification-copies-") }); await coordinator.init();
	let observedCwd = "";
	const driver: AgentDriver = {
		id: "verifier",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", verification: { modalities: ["cli"], freshSession: true, workspaceIsolation: ["isolated_copy"], commandExecution: true, guiObservation: false, networkObservation: false } }; },
		async *run(_input, ctx) {
			observedCwd = ctx.cwd;
			assert.equal(readFileSync(path.join(ctx.cwd, "input.txt"), "utf8"), "integrated\n");
			writeFileSync(path.join(ctx.cwd, "verifier-output.txt"), "observation only\n");
			yield { type: "completed", result: { agentId: "verifier", status: "completed", content: "verified" } };
		},
		async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, undefined, undefined, coordinator);
	const prepared = await runtime.createGoalVerificationEnvironment({ workspacePath: root, verificationId: "goal-v1", goalId: "G1", goalEpoch: 1 });
	const before = (await runtime.listDelegations()).length;
	await assert.rejects(() => runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "verifier", agentRevision: 1,
		message: "verify", mode: "run", purpose: "verification", verificationId: "goal-v2", verificationEnvironmentId: prepared.environment.id,
	}, { cwd: root, env: {} }), /another VerificationRecord/);
	assert.equal((await runtime.listDelegations()).length, before, "非法环境绑定不得留下 admitted 幽灵");
	const outcome = await runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "verifier", agentRevision: 1,
		message: "verify", mode: "run", purpose: "verification", verificationId: "goal-v1", verificationEnvironmentId: prepared.environment.id,
	}, { cwd: root, env: {} });
	assert.equal(outcome.status, "completed");
	assert.notEqual(observedCwd, root);
	assert.equal(existsSync(path.join(root, "verifier-output.txt")), false, "Verifier 产物不得写回目标 Workspace");
	assert.equal(outcome.delegation.verificationEnvironmentId, prepared.environment.id);
	await runtime.releaseVerificationEnvironment(prepared.environment.id);
	await runtime.releaseWorkspaceExecutionScope(prepared.sourceScopeId);
});

test("远端 Verifier 在协议支持签名环境回显前不能声明 environment_verified", async () => {
	const root = temp("pt-runtime-remote-verifier-");
	writeFileSync(path.join(root, "input.txt"), "input\n");
	const state = temp("pt-runtime-remote-verifier-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const coordinator = new WorkspaceExecutionCoordinator(state, { worktreeRoot: temp("pt-runtime-remote-verifier-copies-") }); await coordinator.init();
	const driver: AgentDriver = {
		id: "remote-verifier",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "stream", transport: "http", verification: { modalities: ["cli"], freshSession: true, workspaceIsolation: ["isolated_copy"], commandExecution: true, guiObservation: false, networkObservation: true } }; },
		async *run() { yield { type: "completed", result: { agentId: "remote-verifier", status: "completed", content: "claimed" } }; },
		async *continue() {}, async *respond() {}, async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, undefined, undefined, coordinator);
	const prepared = await runtime.createGoalVerificationEnvironment({ workspacePath: root, verificationId: "remote-v1", goalId: "G1", goalEpoch: 1 });
	await assert.rejects(() => runtime.delegate({ windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: driver.id, agentRevision: 1, message: "verify", mode: "run", purpose: "verification", verificationId: "remote-v1", verificationEnvironmentId: prepared.environment.id }, { cwd: root, env: {} }), /只允许本地 spawn\/sdk Driver/);
	assert.equal((await runtime.listDelegations()).length, 0);
});
