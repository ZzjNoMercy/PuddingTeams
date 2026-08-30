import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { WorkspaceExecutionCoordinator } from "./workspace-execution.js";
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
			yield { type: "completed", result: { agentId: "worker", status: "completed", reportedEvidence: [{ requirement: "result exists", evidenceRefs: ["result.txt"] }] } };
		},
		async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, undefined, undefined, coordinator);
	const outcome = await runtime.delegate({
		windowId: "w", workspaceId: "workspace", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1,
		message: "write result", mode: "run", evidenceRequirements: ["result exists"], goalId: goal.goalId, workPlanId: planned.plan!.id,
		workItemId: item.id, goalEpoch: goal.execution.epoch, goalRevision: goal.goalRevision, workItemRevision: item.revision, contractHash: frozenContractHash,
		workspaceExecutionPolicy: policy,
	}, { cwd: root, env: {} });
	assert.equal(outcome.status, "completed");
	assert.notEqual(observedCwd, root);
	assert.equal(existsSync(path.join(root, "result.txt")), false, "验收前不得写入目标 Workspace");
	assert.equal(outcome.delegation.workspaceExecutionPolicy?.mode, "isolated_worktree");
	assert.ok(outcome.delegation.workspaceExecutionScopeId);
	assert.ok(outcome.delegation.workspaceChangeSetId);
	assert.equal(outcome.delegation.receipt?.integrity, "clean");
	assert.equal(outcome.delegation.receipt?.taskContractHash, frozenContractHash);
	assert.notEqual(outcome.delegation.receipt?.contractHash, frozenContractHash, "Runtime envelope 还必须绑定 Agent/执行身份");
	const changeSet = await runtime.getWorkspaceChangeSet(outcome.delegation.workspaceChangeSetId);
	assert.deepEqual(changeSet?.changedPaths, ["result.txt"]);
	assert.equal(changeSet?.promotionState, "pending");
	const submitted = await workStates.noteDelegation("s", { goalId: goal.goalId, workItemId: item.id, delegationId: outcome.delegation.id, delegationStatus: "completed", goalEpoch: goal.execution.epoch, executionReceipt: outcome.delegation.receipt, workspaceChangeSet: changeSet }, "boundary");
	assert.equal(submitted.plan?.items.W1?.status, "submitted", "Runtime Receipt 必须能通过 WorkState 的同一冻结契约门禁");
	const promoted = await runtime.promoteWorkspaceChangeSet(outcome.delegation.workspaceExecutionScopeId!, outcome.delegation.workspaceChangeSetId!);
	assert.equal(promoted.promotionState, "applied");
	assert.equal(readFileSync(path.join(root, "result.txt"), "utf8"), "result\n");
});

test("非 Git Workspace 且 Connector 不能强制只读时 fail closed，并封存 blocked Receipt", async () => {
	const root = temp("pt-runtime-nongit-");
	const state = temp("pt-runtime-nongit-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const coordinator = new WorkspaceExecutionCoordinator(state, { worktreeRoot: temp("pt-runtime-nongit-worktrees-") }); await coordinator.init();
	let invoked = false;
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: ["filesystem_diff"] } }; },
		async *run() { invoked = true; }, async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, undefined, undefined, coordinator);
	const outcome = await runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1, message: "inspect", mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "harness_default", reason: "default", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
	}, { cwd: root, env: {} });
	assert.equal(invoked, false);
	assert.equal(outcome.delegation.executionState, "reported_failed");
	assert.equal(outcome.result.status, "blocked");
	assert.equal(outcome.delegation.receipt?.reportedOutcome, "blocked");
});

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
