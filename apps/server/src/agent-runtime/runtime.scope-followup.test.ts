import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkStateStore, workItemContractHash } from "../store/work-state.js";
import { isWorkspaceOwnerClosed } from "./workspace-owner-lifecycle.js";
import { AgentRuntime, type DelegateInput } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { WorkspaceExecutionCoordinator, type WorkspaceAccessMode } from "./workspace-execution.js";
import type { AgentDriver } from "./types.js";

async function stack(mode: WorkspaceAccessMode = "read_only_shared", strong = false) {
	const temp = () => mkdtempSync(path.join(tmpdir(), "pt-scope-followup-"));
	const root = realpathSync(temp());
	writeFileSync(path.join(root, "input.txt"), "base");
	if (mode === "isolated_worktree") {
		const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
		git("init"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
	}
	const state = temp();
	const store = new DelegationStore(state); await store.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const scopes = new WorkspaceExecutionCoordinator(state, { worktreeRoot: temp() }); await scopes.init();
	const cwdSeen: string[] = [];
	const driver: AgentDriver = {
		id: "worker",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: strong ? "sandbox" : "none", mutationObservation: [] } }; },
		async *run(_input, ctx) { cwdSeen.push(ctx.cwd); yield { type: "completed", result: { agentId: "worker", status: "completed", content: "done" } }; },
		async *continue() {}, async *respond() {},
		async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(store, secrets, () => driver, { ttlMs: 60_000 }, undefined, undefined, scopes);
	const input: DelegateInput = {
		windowId: "w", workspaceId: "workspace", cwdSnapshot: root, managerSessionId: "s", agentId: "worker", agentRevision: 1,
		message: "inspect", mode: "run", goalId: "g", goalEpoch: 1, workPlanId: "p", workItemId: "i",
		workspaceExecutionPolicy: { mode, source: "user", reason: "test", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: mode === "isolated_worktree" },
	};
	const ctx = { cwd: root, env: {} };
	const approve = async (pending: Awaited<ReturnType<typeof runtime.delegate>>) => {
		const interaction = pending.interaction!;
		return runtime.respond(interaction.id, { requestId: `approve:${interaction.id}`, revision: interaction.revision, responses: [{ requestId: interaction.requests[0]!.requestId, action: "approve", scope: "proceed_with_worker" }] }, ctx);
	};
	const run = async (patch: Partial<DelegateInput> = {}) => {
		const result = await runtime.delegate({ ...input, ...patch }, ctx);
		return result.status === "needs_input" ? approve(result) : result;
	};
	return { runtime, input, ctx, approve, run, scopes, store, cwdSeen, root };
}

for (const strong of [false, true]) {
	test(`released readonly parent gives followup a fresh scope (enforced=${strong})`, async () => {
		const s = await stack("read_only_shared", strong);
		const first = await s.run();
		const old = await s.scopes.get(first.delegation.workspaceExecutionScopeId!);
		assert.equal(old?.state, "released");
		const next = await s.run({ parentDelegationId: first.delegation.id });
		assert.equal(next.status, "completed", JSON.stringify(next.result));
		assert.equal(next.delegation.workerStarted, true);
		assert.notEqual(next.delegation.workspaceExecutionScopeId, old?.id);
		assert.deepEqual(s.cwdSeen, [s.root, s.root]);
		assert.deepEqual((await s.scopes.get(old!.id))?.delegationIds, [first.delegation.id]);
	});
}

test("active same WorkItem isolated scope preserves files; different ownership creates a new checkout", async () => {
	const s = await stack("isolated_worktree");
	const first = await s.run();
	writeFileSync(path.join(first.delegation.executionCwd!, "draft.txt"), "preserve me");
	const next = await s.run({ parentDelegationId: first.delegation.id });
	assert.equal(next.status, "completed");
	assert.equal(next.delegation.workspaceExecutionScopeId, first.delegation.workspaceExecutionScopeId);
	assert.equal(readFileSync(path.join(next.delegation.executionCwd!, "draft.txt"), "utf8"), "preserve me");
	for (const patch of [{ workItemId: "other" }, { workItemId: undefined }, { workPlanId: "other" }, { goalId: "other" }, { goalEpoch: 2 }, { managerSessionId: "other" }, { workspaceId: "other" }]) {
		const other = await s.run({ parentDelegationId: first.delegation.id, ...patch });
		assert.equal(other.status, "completed", JSON.stringify(other.result));
		assert.notEqual(other.delegation.workspaceExecutionScopeId, first.delegation.workspaceExecutionScopeId);
	}
});

test("active exclusive scope is retained for same item and never reclaimed merely because its owner finished", async () => {
	const s = await stack("exclusive_write");
	const closed = new Set<string>();
	s.runtime.setWorkspaceOwnerClosedResolver(async (owner) => closed.has(owner.workItemId!));
	const first = await s.run();
	const next = await s.run({ parentDelegationId: first.delegation.id });
	assert.equal(next.status, "completed", JSON.stringify(next.result));
	assert.equal(next.delegation.workspaceExecutionScopeId, first.delegation.workspaceExecutionScopeId);
	const other = await s.run({ parentDelegationId: first.delegation.id, workItemId: "other" });
	assert.equal(other.status, "failed");
	assert.equal(other.delegation.workspaceExecutionScopeId, undefined);
	assert.equal((await s.scopes.get(first.delegation.workspaceExecutionScopeId!))?.state, "active");
	closed.add("i"); // Durable WorkItem acceptance/cancellation closes all its attempts.
	const acceptedNext = await s.run({ parentDelegationId: first.delegation.id, workItemId: "other" });
	assert.equal(acceptedNext.status, "completed", JSON.stringify(acceptedNext.result));
	assert.notEqual(acceptedNext.delegation.workspaceExecutionScopeId, first.delegation.workspaceExecutionScopeId);
	assert.equal((await s.scopes.get(first.delegation.workspaceExecutionScopeId!))?.state, "released");
});

test("fenced scope cannot be bypassed, and an unresolved co-owner prevents reuse via an older parent", async () => {
	const s = await stack("isolated_worktree");
	const first = await s.run();
	const scope = (await s.scopes.get(first.delegation.workspaceExecutionScopeId!))!;
	const pending = await s.store.createDelegation({ windowId: "w", cwdSnapshot: s.root, managerSessionId: "s", agentId: "worker", agentRevision: 1, driverId: "worker", operation: "run", workspaceId: "workspace", goalId: "g", goalEpoch: 1, workPlanId: "p", workItemId: "i", workspaceExecutionPolicy: s.input.workspaceExecutionPolicy });
	await s.scopes.begin({ workspacePath: s.root, workspaceId: "workspace", goalId: "g", goalEpoch: 1, mode: scope.mode, executionScopeId: scope.id, ownerToken: scope.ownerToken, delegationId: pending.id });
	const busy = await s.run({ parentDelegationId: first.delegation.id });
	assert.equal(busy.status, "failed");
	assert.match("error" in busy.result ? busy.result.error : "", /active or unresolved owner/);
	await s.scopes.fence(scope.id, scope.ownerToken);
	const fenced = await s.run({ parentDelegationId: first.delegation.id });
	assert.equal(fenced.status, "failed");
	assert.match("error" in fenced.result ? fenced.result.error : "", /fenced/);
	assert.equal((await s.scopes.get(scope.id))?.state, "fenced");
	assert.equal(s.cwdSeen.length, 1);
});

test("explicit foreign or stale scope requests survive admission but never acquire, capture, or release ownership", async () => {
	const s = await stack();
	const foreign = await s.scopes.begin({ workspacePath: s.root, mode: "exclusive_write", delegationId: "foreign", goalId: "foreign", goalEpoch: 1 });
	for (const id of [foreign.id, "missing-scope"]) {
		const pending = await s.runtime.delegate({ ...s.input, workspaceExecutionScopeId: id }, s.ctx);
		assert.equal(pending.status, "needs_input");
		assert.equal(pending.delegation.requestedWorkspaceExecutionScopeId, id);
		assert.equal(pending.delegation.workspaceExecutionScopeId, undefined);
		const result = await s.approve(pending);
		assert.equal(result.status, "failed");
		assert.equal(result.delegation.workerStarted, false);
		assert.equal(result.delegation.workspaceExecutionScopeId, undefined);
		assert.equal(result.delegation.workspaceChangeSetId, undefined);
		assert.equal((await s.scopes.get(foreign.id))?.state, "active");
	}
	assert.equal(s.cwdSeen.length, 0);
});


test("promoted parent starts a new scope; explicit stale ids and binding changes cannot reopen an old scope", async () => {
	const s = await stack("isolated_worktree");
	const first = await s.run();
	const scope = (await s.scopes.get(first.delegation.workspaceExecutionScopeId!))!;
	await s.scopes.promote(scope.id, first.delegation.workspaceChangeSetId, scope.ownerToken);
	assert.equal((await s.scopes.get(scope.id))?.state, "promoted");
	const next = await s.run({ parentDelegationId: first.delegation.id });
	assert.equal(next.status, "completed");
	assert.notEqual(next.delegation.workspaceExecutionScopeId, scope.id);
	const explicit = await s.run({ workspaceExecutionScopeId: scope.id });
	assert.equal(explicit.status, "failed");
	assert.equal(explicit.delegation.workspaceExecutionScopeId, undefined);
	const active = (await s.scopes.get(next.delegation.workspaceExecutionScopeId!))!;
	const request = { workspacePath: s.root, workspaceId: "workspace", goalId: "g", goalEpoch: 1, mode: active.mode, executionScopeId: active.id, ownerToken: active.ownerToken, delegationId: "intruder" };
	for (const patch of [{ goalId: "other" }, { goalEpoch: 2 }, { workspaceId: "other" }]) {
		await assert.rejects(() => s.scopes.begin({ ...request, ...patch }), /binding is immutable/);
	}
	await s.scopes.fence(active.id, active.ownerToken);
	await assert.rejects(() => s.scopes.begin(request), /fenced/);
	assert.deepEqual((await s.scopes.get(active.id))?.delegationIds, [next.delegation.id]);
});


test("standalone exclusive Runs close their own lease at terminal without WorkItem acceptance", async () => {
	const s = await stack("exclusive_write");
	const first = await s.run({ workItemId: undefined });
	assert.equal((await s.scopes.get(first.delegation.workspaceExecutionScopeId!))?.state, "released");
	const next = await s.run({ workItemId: undefined, parentDelegationId: first.delegation.id });
	assert.equal(next.status, "completed");
	assert.notEqual(next.delegation.workspaceExecutionScopeId, first.delegation.workspaceExecutionScopeId);
});

test("even a closed WorkItem cannot release a scope with an unresolved owner", async () => {
	const s = await stack("exclusive_write");
	const pending = await s.store.createDelegation({ windowId: "w", cwdSnapshot: s.root, managerSessionId: "s", agentId: "worker", agentRevision: 1, driverId: "worker", operation: "run", workItemId: "i" });
	const scope = await s.scopes.begin({ workspacePath: s.root, mode: "exclusive_write", delegationId: pending.id });
	s.runtime.setWorkspaceOwnerClosedResolver(async () => true);
	const next = await s.run({ workItemId: "other" });
	assert.equal(next.status, "failed");
	assert.equal((await s.scopes.get(scope.id))?.state, "active");
	assert.equal(s.cwdSeen.length, 0);
});


test("durable WorkState acceptance unlocks the next exclusive WorkItem, including after resolver reattachment", async () => {
	const s = await stack("exclusive_write");
	const workStates = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-scope-workstate-"))); await workStates.init();
	const goal = await workStates.create({ sessionId: "s", goal: "inspect", completionBoundary: "done", operationId: "create" });
	const planned = await workStates.updatePlan("s", goal.revision, { upsertItems: [{ id: "W1", title: "inspect", acceptanceCriteria: ["done"], sourceGoalCriteria: ["goal:1:1"], workspaceExecutionPolicy: s.input.workspaceExecutionPolicy }], reason: "plan" }, "plan", goal.execution.epoch, goal.goalId);
	const item = planned.plan!.items.W1!;
	const first = await s.run({ goalId: goal.goalId, workPlanId: planned.plan!.id, workItemId: item.id, goalEpoch: goal.execution.epoch, goalRevision: goal.goalRevision, workItemRevision: item.revision, contractHash: workItemContractHash(planned, planned.plan!, item) });
	const submitted = await workStates.noteDelegation("s", { goalId: goal.goalId, workItemId: item.id, delegationId: first.delegation.id, delegationStatus: "completed", goalEpoch: goal.execution.epoch, executionReceipt: first.delegation.receipt, workspaceChangeSet: await s.runtime.getWorkspaceChangeSet(first.delegation.workspaceChangeSetId) }, "boundary");
	assert.equal(submitted.plan?.items.W1?.status, "submitted");
	assert.equal(await isWorkspaceOwnerClosed(workStates, first.delegation), false);
	await workStates.reviewWorkItem("s", "W1", submitted.revision, {
		expectedWorkItemRevision: submitted.plan!.items.W1!.revision,
		expectedSubmissionId: submitted.plan!.items.W1!.submissions.at(-1)!.id,
		verdict: "accepted",
		summary: "inspected result",
		evidenceRefs: [first.delegation.id],
	}, "review", goal.execution.epoch, goal.goalId);
	assert.equal(await isWorkspaceOwnerClosed(workStates, first.delegation), true);
	assert.equal(await isWorkspaceOwnerClosed(workStates, { ...first.delegation, workspaceExecutionScopeId: "foreign" }), false);
	// No release ran during review: admission must reconcile the durable closure.
	s.runtime.setWorkspaceOwnerClosedResolver((owner) => isWorkspaceOwnerClosed(workStates, owner));
	const next = await s.run({ workItemId: "W2", parentDelegationId: first.delegation.id });
	assert.equal(next.status, "completed", JSON.stringify(next.result));
	assert.equal((await s.scopes.get(first.delegation.workspaceExecutionScopeId!))?.state, "released");
});
