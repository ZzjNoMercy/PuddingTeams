import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { TeamsStore } from "../store/teams.js";
import { WorkStateStore } from "../store/work-state.js";
import { delegationOwnerIds, WorkspaceExecutionCoordinator } from "../agent-runtime/workspace-execution.js";
import { settleWorkItemReview } from "../agent-runtime/work-item-settlement.js";
import { NativeToolExecution } from "./native-tool-execution.js";

async function fixture(options: { git?: boolean; now?: () => number } = {}) {
	const root = await mkdtemp(path.join(tmpdir(), "pt-native-"));
	const cwd = path.join(root, "project"); await mkdir(cwd);
	await writeFile(path.join(cwd, "existing.txt"), "user dirty baseline\n");
	if (options.git) {
		execFileSync("git", ["init", "-q", cwd]);
		execFileSync("git", ["-C", cwd, "-c", "user.email=test@example.test", "-c", "user.name=test", "commit", "--allow-empty", "-qm", "baseline"]);
	}
	const stateDir = path.join(root, "state");
	const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "managed") }, cwd); await teams.init();
	await teams.ensureSoloWindow(async () => ({ id: "manager-session" }), async () => true);
	const states = new WorkStateStore(stateDir); await states.init();
	const coordinator = new WorkspaceExecutionCoordinator(stateDir, { worktreeRoot: path.join(root, "worktrees"), now: options.now, leaseTimeoutMs: 5_000 }); await coordinator.init();
	const native = new NativeToolExecution(stateDir, coordinator, teams, states); await native.init();
	const identity = () => ({ sessionId: "manager-session", turnId: "turn-1" });
	const ctx = { cwd, sessionManager: { getSessionId: () => "manager-session", getSessionFile: () => undefined } } as unknown as ExtensionToolContext;
	const write = native.wrap(createWriteToolDefinition, cwd, identity);
	const read = native.wrap(createReadToolDefinition, cwd, identity);
	const edit = native.wrap(createEditToolDefinition, cwd, identity);
	const bash = native.wrap(createBashToolDefinition, cwd, identity);
	const goal = async (mode: "exclusive_write" | "isolated_worktree" | "read_only_shared" = "exclusive_write", enforced = false) => {
		const created = await states.create({ sessionId: "manager-session", goal: "produce result", completionBoundary: "result verified", verificationPolicy: { minimumWorkItemMode: "manager_review", finalGoalMode: "manager_review", trigger: "manager_request", source: "user", reason: "test" } });
		const planned = await states.updatePlan("manager-session", created.revision, { upsertItems: [{ id: "W1", title: "produce result", assignedAgentId: "manager", acceptanceCriteria: ["result verified"], verificationPolicy: { mode: "manager_review", trigger: "manager_request", source: "user", reason: "test" }, workspaceExecutionPolicy: { mode, source: enforced ? "user" : "manager_derived", reason: "test", readOnlyRequirement: enforced ? "enforced" : "best_effort", baselineStrategy: mode === "isolated_worktree" ? "git_tree" : "filesystem_manifest", promoteOnAcceptance: mode === "isolated_worktree" } }], reason: "test plan" }, "plan", created.execution.epoch, created.goalId);
		return states.advanceManagerWorkItem("manager-session", "W1", planned.revision, { status: "in_progress" }, "start", planned.execution.epoch, planned.goalId);
	};
	return { root, cwd, stateDir, teams, states, coordinator, native, ctx, write, read, edit, bash, goal, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("native writes preserve dirty baseline, release leases and carry actual evidence without delegation identity", async () => {
	const f = await fixture();
	try {
		const result = await f.write.execute("write-1", { path: "result.txt", content: "first\n" }, undefined, undefined, f.ctx);
		const change = (result.details as unknown as { workspaceChangeSet: { id: string } }).workspaceChangeSet;
		const observed = await f.coordinator.getChangeSet(change.id); assert(observed);
		assert.deepEqual(observed.changedPaths, ["result.txt"]);
		assert.deepEqual(delegationOwnerIds(observed), []);
		assert.equal(observed.ownerRefs[0]?.kind, "native_session");
		assert.equal((await f.coordinator.get(observed.executionScopeId))?.state, "released");
		assert.equal(await readFile(path.join(f.cwd, "existing.txt"), "utf8"), "user dirty baseline\n");
		await f.native.assertDelegationReady("manager-session");
		await assert.rejects(() => f.write.execute("write-1", { path: "result.txt", content: "replayed" }, undefined, undefined, f.ctx), /不能自动重放/);
		assert.equal(await readFile(path.join(f.cwd, "result.txt"), "utf8"), "first\n");
	} finally { await f.cleanup(); }
});

test("Manager Goal submission freezes write/read/bash evidence and uses the same review/promotion gate", async () => {
	const f = await fixture({ git: true });
	try {
		const running = await f.goal("isolated_worktree");
		await f.write.execute("write", { path: "result.txt", content: "before\n" }, undefined, undefined, f.ctx);
		await f.edit.execute("edit", { path: path.join(f.cwd, "result.txt"), edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, f.ctx);
		const read = await f.read.execute("read", { path: "result.txt" }, undefined, undefined, f.ctx);
		assert.match(JSON.stringify(read.content), /after/);
		await f.bash.execute("bash", { command: "test \"$(cat result.txt)\" = after" }, undefined, undefined, f.ctx);
		await assert.rejects(() => readFile(path.join(f.cwd, "result.txt")), /ENOENT/);
		const submitted = await f.states.advanceManagerWorkItem("manager-session", "W1", running.revision, { status: "submitted", summary: "verified" }, "submit", running.execution.epoch, running.goalId);
		const submission = submitted.plan!.items.W1!.submissions[0]!;
		assert.equal(submission.nativeExecutions?.length, 4);
		assert.equal(new Set(submission.nativeExecutions?.map((entry) => entry.scopeId)).size, 1);
		assert.equal(submission.executionReceipt, undefined, "Manager must not forge a Worker receipt");
		const scope = (await f.coordinator.get(submission.workspaceChangeSet!.executionScopeId))!;
		await f.native.assertDelegationReady("manager-session");
		const settled = await settleWorkItemReview({ workStates: f.states, sessionId: "manager-session", goalId: submitted.goalId, workItemId: "W1", expectedRevision: submitted.revision, expectedEpoch: submitted.execution.epoch,
			review: { expectedWorkItemRevision: submitted.plan!.items.W1!.revision, expectedSubmissionId: submission.id, verdict: "accepted", summary: "actual result verified", evidenceRefs: submission.nativeExecutions!.map((entry) => entry.id) }, operationId: "accept",
			promoteWorkspaceChangeSet: (id, changeId) => f.coordinator.promote(id, changeId, scope.ownerToken) });
		assert.equal(settled.verdict, "accepted");
		assert.equal(settled.state.plan!.items.W1!.submissions[0]!.workspaceChangeSet!.promotionState, "applied");
		assert.equal(await readFile(path.join(f.cwd, "result.txt"), "utf8"), "after\n");
		assert.equal(await readFile(path.join(f.cwd, "existing.txt"), "utf8"), "user dirty baseline\n");
	} finally { await f.cleanup(); }
});

test("begin conflict never executes, tool exceptions seal observed mutations, abort fences effects", async () => {
	const f = await fixture();
	try {
		const occupied = await f.coordinator.begin({ workspacePath: f.cwd, mode: "exclusive_write", owner: { kind: "delegation", delegationId: "worker" } });
		await assert.rejects(() => f.write.execute("blocked", { path: "blocked.txt", content: "no" }, undefined, undefined, f.ctx), /leased/);
		await assert.rejects(() => readFile(path.join(f.cwd, "blocked.txt")), /ENOENT/);
		await f.coordinator.release(occupied.id, { ownerToken: occupied.ownerToken });
		const failing = f.native.wrap((cwd) => ({ ...createWriteToolDefinition(cwd), execute: async () => { await writeFile(path.join(cwd, "partial.txt"), "observed"); throw new Error("tool failed after writing"); } }), f.cwd, () => ({ sessionId: "manager-session", turnId: "turn-2" }));
		await assert.rejects(() => failing.execute("partial", { path: "partial.txt", content: "" }, undefined, undefined, f.ctx), /tool failed/);
		const records = JSON.parse(await readFile(path.join(f.stateDir, "native-executions.json"), "utf8")).executions;
		const partial = records.find((entry: { toolCallId: string }) => entry.toolCallId === "partial");
		assert.equal(partial.status, "failed"); assert.deepEqual(partial.changeSet.changedPaths, ["partial.txt"]);
		const controller = new AbortController();
		const cancelled = f.native.wrap((cwd) => ({ ...createWriteToolDefinition(cwd), execute: async () => { await writeFile(path.join(cwd, "cancelled.txt"), "effect"); controller.abort(); return { content: [{ type: "text" as const, text: "stopped" }], details: undefined }; } }), f.cwd, () => ({ sessionId: "manager-session", turnId: "turn-3" }));
		await assert.rejects(() => cancelled.execute("cancelled", { path: "cancelled.txt", content: "" }, controller.signal, undefined, f.ctx), /reconcile effects/);
		await assert.rejects(() => f.native.assertDelegationReady("manager-session"), /效果未知/);
		assert.equal((await f.coordinator.getBlockingScope(undefined, f.cwd))?.state, "fenced");
	} finally { await f.cleanup(); }
});

test("enforced read-only and stale Goal evidence cannot be submitted as Manager writes", async () => {
	const f = await fixture();
	try {
		const running = await f.goal("read_only_shared", true);
		await assert.rejects(() => f.bash.execute("bash", { command: "echo bypass" }, undefined, undefined, f.ctx), /强制只读/);
		await f.read.execute("read", { path: "existing.txt" }, undefined, undefined, f.ctx);
		const entries = await f.native.forWorkItem("manager-session", running.goalId, "W1");
		assert.equal(entries.length, 1); assert.equal(entries[0]!.integrity, "clean");
	} finally { await f.cleanup(); }
});

test("expired native leases are fenced and startup never replays interrupted writes", async () => {
	let clock = Date.now(); const f = await fixture({ now: () => clock });
	try {
		const delayed = f.native.wrap((cwd) => ({ ...createWriteToolDefinition(cwd), execute: async () => { await writeFile(path.join(cwd, "expired.txt"), "effect"); clock += 10_000; return { content: [{ type: "text" as const, text: "done" }], details: undefined }; } }), f.cwd, () => ({ sessionId: "manager-session", turnId: "turn-expired" }));
		await assert.rejects(() => delayed.execute("expired", { path: "expired.txt", content: "" }, undefined, undefined, f.ctx), /expired/);
		assert.equal((await f.coordinator.getBlockingScope(undefined, f.cwd))?.state, "fenced");
		const ledger = JSON.parse(await readFile(path.join(f.stateDir, "native-executions.json"), "utf8"));
		ledger.executions[0].status = "started";
		await writeFile(path.join(f.stateDir, "native-executions.json"), JSON.stringify(ledger));
		await new NativeToolExecution(f.stateDir, f.coordinator, f.teams, f.states).init();
		const recovered = JSON.parse(await readFile(path.join(f.stateDir, "native-executions.json"), "utf8"));
		assert.equal(recovered.executions[0].status, "unknown");
		assert.equal(await readFile(path.join(f.cwd, "expired.txt"), "utf8"), "effect");
	} finally { await f.cleanup(); }
});


test("SDK ordinary absolute-path semantics remain available; Goal policy and epoch remain authoritative", async () => {
	const f = await fixture();
	try {
		const outside = path.join(f.root, "outside.txt");
		await f.write.execute("outside", { path: outside, content: "native SDK path" }, undefined, undefined, f.ctx);
		assert.equal(await readFile(outside, "utf8"), "native SDK path");
		const running = await f.goal();
		await assert.rejects(() => f.write.execute("goal-outside", { path: outside, content: "no" }, undefined, undefined, f.ctx), /Workspace 执行策略/);
		const begin = f.coordinator.begin.bind(f.coordinator);
		f.coordinator.begin = async (input) => {
			const scope = await begin(input);
			await f.states.interruptGoal("manager-session", running.revision, { kind: "user", fingerprint: "stop", delegationIds: [] }, "stop", running.goalId);
			return scope;
		};
		await assert.rejects(() => f.write.execute("stale", { path: "stale.txt", content: "no" }, undefined, undefined, f.ctx), /epoch\/contract 已变化/);
		await assert.rejects(() => readFile(path.join(f.cwd, "stale.txt")), /ENOENT/);
		await assert.rejects(() => f.states.advanceManagerWorkItem("manager-session", "W1", running.revision, { status: "submitted", summary: "stale" }, "stale-submit", running.execution.epoch, running.goalId), /epoch|revision/);
	} finally { await f.cleanup(); }
});


test("promotion cannot run over an active native writer, including an overlapping subdirectory", async () => {
	const f = await fixture({ git: true });
	try {
		const scope = await f.coordinator.begin({ workspacePath: f.cwd, mode: "isolated_worktree", owner: { kind: "delegation", delegationId: "worker" } });
		await writeFile(path.join(scope.executionCwd, "existing.txt"), "worker output");
		const change = await f.coordinator.capture(scope.id, scope.ownerToken);
		const sub = path.join(f.cwd, "sub"); await mkdir(sub);
		const writer = await f.coordinator.begin({ workspacePath: sub, mode: "exclusive_write", owner: { kind: "native_session", sessionId: "manager-session", turnId: "turn-1" } });
		await assert.rejects(() => f.coordinator.promote(scope.id, change.id, scope.ownerToken), /active or fenced writer/);
		await assert.rejects(() => f.coordinator.begin({ workspacePath: f.cwd, mode: "exclusive_write", owner: { kind: "delegation", delegationId: "another" } }), /leased/);
		await writeFile(path.join(f.cwd, "existing.txt"), "user replacement");
		await f.coordinator.release(writer.id, { ownerToken: writer.ownerToken });
		assert.equal((await f.coordinator.promote(scope.id, change.id, scope.ownerToken)).promotionState, "conflict");
		assert.equal(await readFile(path.join(f.cwd, "existing.txt"), "utf8"), "user replacement");
	} finally { await f.cleanup(); }
});


test("native admission shares closed-owner reconciliation and a failed begin does not poison later submission", async () => {
	const f = await fixture();
	try {
		const running = await f.goal();
		const worker = await f.coordinator.begin({ workspacePath: f.cwd, mode: "exclusive_write", owner: { kind: "delegation", delegationId: "worker" } });
		await assert.rejects(() => f.write.execute("blocked", { path: "result.txt", content: "blocked" }, undefined, undefined, f.ctx), /leased/);
		// This resolver represents both a sealed terminal receipt and accepted
		// WorkItem; the coordinator, not an actor-specific caller, releases it.
		f.coordinator.setOwnerClosedResolver(async (owner) => owner.kind === "delegation" && owner.delegationId === "worker");
		await f.write.execute("retry", { path: "result.txt", content: "verified" }, undefined, undefined, f.ctx);
		assert.equal((await f.coordinator.get(worker.id))!.state, "released");
		const submitted = await f.states.advanceManagerWorkItem("manager-session", "W1", running.revision, { status: "submitted", summary: "verified" }, "submit", running.execution.epoch, running.goalId);
		const executions = submitted.plan!.items.W1!.submissions[0]!.nativeExecutions!;
		assert.equal(executions.length, 2); assert.equal(executions[0]!.status, "failed"); assert.equal(executions[0]!.integrity, "clean"); assert.equal(executions[1]!.status, "completed");
	} finally { await f.cleanup(); }
});
