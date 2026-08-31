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
	const promoted = await runtime.promoteWorkspaceChangeSet(outcome.delegation.workspaceExecutionScopeId!, outcome.delegation.workspaceChangeSetId!);
	assert.equal(promoted.promotionState, "applied");
	assert.equal(readFileSync(path.join(root, "result.txt"), "utf8"), "result\n");
});

test("Connector 不能保证只读时先等待 Teams 准入；拒绝后 Worker 从未启动", async () => {
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
	assert.equal(outcome.status, "needs_input");
	assert.equal(outcome.delegation.executionState, "waiting_admission");
	assert.equal(outcome.delegation.workerStarted, false);
	assert.equal(outcome.interaction?.source, "platform_policy");
	const request = outcome.interaction!.requests[0]!;
	const rejected = await runtime.respond(outcome.interaction!.id, {
		requestId: "reject-admission",
		revision: outcome.interaction!.revision,
		responses: [{ requestId: request.requestId, action: "reject" }],
	}, { cwd: root, env: {} });
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.delegation.executionState, "cancelled");
	assert.equal(rejected.delegation.receipt?.reportedOutcome, "cancelled");
	assert.equal(rejected.delegation.receipt?.workerStarted, false);
	assert.equal(invoked, false);
});

test("Teams 准入只允许使用 Worker，不改变原只读契约；批准后才启动", async () => {
	const root = temp("pt-runtime-admission-approve-");
	const state = temp("pt-runtime-admission-approve-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const coordinator = new WorkspaceExecutionCoordinator(state, { worktreeRoot: temp("pt-runtime-admission-worktrees-") }); await coordinator.init();
	let invoked = 0;
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: ["filesystem_diff"] } }; },
		async *run() { invoked += 1; yield { type: "completed", result: { agentId: "worker", status: "completed", content: "inspected" } }; },
		async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, undefined, undefined, coordinator);
	const policy = { mode: "read_only_shared" as const, source: "harness_default" as const, reason: "inspect only", baselineStrategy: "filesystem_manifest" as const, promoteOnAcceptance: false };
	const pending = await runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1, message: "inspect", mode: "run", workspaceExecutionPolicy: policy,
	}, { cwd: root, env: {} });
	assert.equal(invoked, 0);
	const interaction = pending.interaction!;
	const approved = await runtime.respond(interaction.id, {
		requestId: "approve-admission",
		revision: interaction.revision,
		responses: [{ requestId: interaction.requests[0]!.requestId, action: "approve", scope: "proceed_with_worker" }],
	}, { cwd: root, env: {} });
	assert.equal(approved.status, "completed");
	assert.equal(invoked, 1);
	assert.equal(approved.delegation.workerStarted, true);
	assert.equal(approved.delegation.readOnlyAssessment, "unverified_user_accepted");
	assert.equal(approved.delegation.workspaceExecutionPolicy?.mode, "read_only_shared", "Teams 准入不得改写任务契约");
});

test("准入期间 Connector 能力变化会使决定失效，且不启动 Worker", async () => {
	const root = temp("pt-runtime-admission-stale-");
	const state = temp("pt-runtime-admission-stale-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	let readOnlyEnforcement: "none" | "sandbox" = "none";
	let invoked = false;
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement, mutationObservation: [] } }; },
		async *run() { invoked = true; }, async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 });
	const pending = await runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1, message: "inspect", mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "harness_default", reason: "inspect", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
	}, { cwd: root, env: {} });
	readOnlyEnforcement = "sandbox";
	await assert.rejects(() => runtime.respond(pending.interaction!.id, {
		requestId: "stale-admission",
		revision: pending.interaction!.revision,
		responses: [{ requestId: pending.interaction!.requests[0]!.requestId, action: "approve", scope: "proceed_with_worker" }],
	}, { cwd: root, env: {} }), /能力已变化/);
	assert.equal(invoked, false);
	assert.equal((await runtime.getDelegation(pending.delegation.id))?.workerStarted, false);
});

test("Teams 准入 TTL 过期会封存 pre-start cancelled，绝不调用 Driver", async () => {
	const root = temp("pt-runtime-admission-ttl-");
	const state = temp("pt-runtime-admission-ttl-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	let invoked = false;
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: [] } }; },
		async *run() { invoked = true; }, async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 1 });
	const pending = await runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1, message: "inspect", mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "harness_default", reason: "inspect", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
	}, { cwd: root, env: {} });
	assert.equal(await runtime.expireAdmissionRequests(Date.now() + 10_000), 1);
	const expired = await runtime.getDelegation(pending.delegation.id);
	assert.equal(expired?.executionState, "cancelled");
	assert.equal(expired?.workerStarted, false);
	assert.equal(expired?.receipt?.workerStarted, false);
	assert.equal(invoked, false);
});

test("旧式 approved 但缺 application 的崩溃窗口会 fail-closed 收敛，不会重启 Worker", async () => {
	const root = temp("pt-runtime-admission-journal-gap-");
	const state = temp("pt-runtime-admission-journal-gap-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	let invoked = false;
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: [] } }; },
		async *run() { invoked = true; }, async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 });
	const pending = await runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1, message: "inspect", mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "harness_default", reason: "inspect", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
	}, { cwd: root, env: {} });
	await delegations.updateInteraction(pending.interaction!.id, { status: "approved", revision: 1 });
	assert.equal(await runtime.reconcileAdmissionApplications(), 1);
	const closed = await runtime.getDelegation(pending.delegation.id);
	const interaction = await runtime.getInteraction(pending.interaction!.id);
	assert.equal(closed?.executionState, "cancelled");
	assert.equal(closed?.workerStarted, false);
	assert.equal(interaction?.application?.status, "failed");
	assert.equal(interaction?.application?.failureCode, "start_confirmation_lost");
	assert.equal(invoked, false);
});

test("Driver 在首事件前抛错时不得声称 Worker 已启动", async () => {
	const root = temp("pt-runtime-admission-start-throw-");
	const state = temp("pt-runtime-admission-start-throw-state-");
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: [] } }; },
		async *run() { throw new Error("spawn failed before first event"); }, async *continue() {}, async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: true, enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 });
	const pending = await runtime.delegate({
		windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1, message: "inspect", mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "harness_default", reason: "inspect", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
	}, { cwd: root, env: {} });
	await assert.rejects(() => runtime.respond(pending.interaction!.id, {
		requestId: "approve-start-throw",
		revision: pending.interaction!.revision,
		responses: [{ requestId: pending.interaction!.requests[0]!.requestId, action: "approve", scope: "proceed_with_worker" }],
	}, { cwd: root, env: {} }), /spawn failed/);
	const closed = await runtime.getDelegation(pending.delegation.id);
	const interaction = await runtime.getInteraction(pending.interaction!.id);
	assert.equal(closed?.executionState, "reported_failed");
	assert.equal(closed?.workerStarted, false);
	assert.equal(closed?.receipt?.workerStarted, false);
	assert.equal(interaction?.application?.status, "failed");
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
