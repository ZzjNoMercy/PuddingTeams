import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore, type DelegationRecord } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import type { AgentDriver, NormalizedResult } from "../agent-runtime/types.js";

/**
 * 启动对账（server_restart）：本地 running/waiting_input 的持久化
 * 记录对应的进程已确认消失。reconcileOrphanedRuns 必须封存 failed Receipt、
 * 过期挂起审批、清理加密 provider state，并逐条触发 notify 回调；终态记录
 * 不受影响，二次收割幂等。
 */

function setup() {
	const stateDir = mkdtempSync(path.join(tmpdir(), "puddingteams-reaper-"));
	const delegations = new DelegationStore(stateDir);
	const secrets = new InteractionSecretStore(mkdtempSync(path.join(tmpdir(), "puddingteams-reaper-secrets-")));
	const runtime = new AgentRuntime(delegations, secrets, () => undefined);
	return { delegations, runtime };
}

function baseDelegation(): Omit<DelegationRecord, "id" | "purpose" | "executionState" | "revision" | "createdAt" | "updatedAt"> {
	return {
		windowId: "window-1",
		cwdSnapshot: process.cwd(),
		managerSessionId: "manager-session-1",
		managerToolCallId: "call_1",
		agentId: "puddingclaw",
		agentRevision: 0,
		operation: "run",
	};
}

test("启动收割: running/waiting_input 转 failed(server_restart)，终态不动，审批过期，幂等", async () => {
	const { delegations, runtime } = setup();

	// running 孤儿
	const running = await delegations.createDelegation(baseDelegation());
	await delegations.transitionDelegation(running.id, ["admitted"], { executionState: "running" });
	// waiting_input 孤儿（带 pending 审批）
	const waiting = await delegations.createDelegation({ ...baseDelegation(), managerToolCallId: "call_2" });
	await delegations.transitionDelegation(waiting.id, ["admitted"], { executionState: "running" });
	await delegations.transitionDelegation(waiting.id, ["running"], { executionState: "waiting_input", runHandle: "run-2" });
	const interaction = await delegations.createInteraction({
		delegationId: waiting.id,
		kind: "permission",
		requests: [{ requestId: "perm-1", prompt: "允许执行？" }],
		providerStateRef: "ref-1",
	});
	// 终态对照
	const done = await delegations.createDelegation({ ...baseDelegation(), managerToolCallId: "call_3" });
	await delegations.transitionDelegation(done.id, ["admitted"], { executionState: "observation_lost" });

	const notified: Array<{ id: string; errorCode?: string }> = [];
	const reaped = await runtime.reconcileOrphanedRuns(async (d, result: NormalizedResult) => {
		notified.push({ id: d.id, errorCode: "errorCode" in result ? result.errorCode : undefined });
	});

	assert.equal(reaped, 2);
	assert.deepEqual(
		notified.map((n) => n.id).sort(),
		[running.id, waiting.id].sort(),
	);
	assert.ok(notified.every((n) => n.errorCode === "server_restart"));

	const runningAfter = await delegations.getDelegation(running.id);
	assert.equal(runningAfter?.executionState, "reported_failed");
	assert.equal(runningAfter?.receipt?.reportedOutcome, "failed");
	assert.equal(runningAfter?.result && "errorCode" in runningAfter.result ? runningAfter.result.errorCode : undefined, "server_restart");

	const waitingAfter = await delegations.getDelegation(waiting.id);
	assert.equal(waitingAfter?.executionState, "reported_failed");
	assert.ok(waitingAfter?.receipt?.sealedAt);

	const interactionAfter = (await delegations.listInteractions()).find((i) => i.id === interaction.id);
	assert.equal(interactionAfter?.status, "expired");

	assert.equal((await delegations.getDelegation(done.id))?.executionState, "observation_lost");

	// 幂等：第二次收割没有孤儿
	assert.equal(await runtime.reconcileOrphanedRuns(), 0);
});

test("启动恢复优先补封存 pending terminal journal，不把已完成 Worker 重跑或改成 server_restart", async () => {
	const { delegations, runtime } = setup();
	const completed = await delegations.createDelegation(baseDelegation());
	await delegations.transitionDelegation(completed.id, ["admitted"], {
		executionState: "running",
		pendingTerminal: {
			executionState: "reported_completed",
			result: { agentId: completed.agentId, status: "completed", content: "boundary already observed" },
			startedAt: new Date().toISOString(),
		},
		revision: 1,
	});
	assert.equal(await runtime.reconcileOrphanedRuns(), 1);
	const sealed = await delegations.getDelegation(completed.id);
	assert.equal(sealed?.executionState, "reported_completed");
	assert.equal(sealed?.result?.status, "completed");
	assert.equal(sealed?.receipt?.reportedOutcome, "completed");
	assert.equal(sealed?.pendingTerminal, undefined);
});

function remoteDriver(state: "completed" | "unknown"): AgentDriver {
	return {
		id: "remote",
		async capabilities() { return { operations: ["run", "continue"], interactionKinds: [], progress: "coarse", transport: "http", reconciliation: "query_run" }; },
		async *run() {},
		async *continue() {},
		async *respond() {},
		async reconcileRun() {
			return state === "completed"
				? { state: "completed", result: { agentId: "remote", status: "completed", content: "remote done", runHandle: "remote-run" } }
				: { state: "unknown", reason: "upstream history unavailable" };
		},
		async probe() { throw new Error("unused"); },
	};
}

test("启动对账: 可查询远端 Run 封存真实完成 Receipt，未知效果转 observation_lost", async () => {
	const stateDir = mkdtempSync(path.join(tmpdir(), "puddingteams-remote-reconcile-"));
	const delegations = new DelegationStore(stateDir);
	await delegations.init();
	const secrets = new InteractionSecretStore(mkdtempSync(path.join(tmpdir(), "puddingteams-remote-reconcile-secrets-")));
	await secrets.init();
	let result: "completed" | "unknown" = "completed";
	const runtime = new AgentRuntime(delegations, secrets, () => remoteDriver(result));
	const completed = await delegations.createDelegation({ ...baseDelegation(), agentId: "remote", managerToolCallId: "remote-completed", driverTransport: "http" });
	await delegations.transitionDelegation(completed.id, ["admitted"], { executionState: "running", runHandle: "remote-run" });
	assert.equal(await runtime.reconcileOrphanedRuns(), 1);
	assert.equal((await delegations.getDelegation(completed.id))?.executionState, "reported_completed");
	assert.equal((await delegations.getDelegation(completed.id))?.receipt?.reportedOutcome, "completed");

	result = "unknown";
	const unknown = await delegations.createDelegation({ ...baseDelegation(), agentId: "remote", managerToolCallId: "remote-unknown", driverTransport: "http" });
	await delegations.transitionDelegation(unknown.id, ["admitted"], { executionState: "running", runHandle: "remote-run-unknown" });
	assert.equal(await runtime.reconcileOrphanedRuns(), 1);
	assert.equal((await delegations.getDelegation(unknown.id))?.executionState, "observation_lost");
	assert.equal((await delegations.getDelegation(unknown.id))?.receipt, undefined, "effect_unknown 不得伪造 terminal Receipt");

	result = "completed";
	const reconciled = await runtime.reconcileDelegation(unknown.id);
	assert.equal(reconciled.executionState, "reported_completed");
	assert.equal(reconciled.receipt?.reportedOutcome, "completed");
});

test("手工重挂原 Run: 先进入 reconciling，异步终态到达后通知并封存 Receipt", async () => {
	const stateDir = mkdtempSync(path.join(tmpdir(), "puddingteams-remote-reattach-"));
	const delegations = new DelegationStore(stateDir);
	await delegations.init();
	const secrets = new InteractionSecretStore(mkdtempSync(path.join(tmpdir(), "puddingteams-remote-reattach-secrets-")));
	await secrets.init();
	let releaseStream!: () => void;
	const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
	let reattachCalls = 0;
	const driver: AgentDriver = {
		id: "remote-reattach",
		async capabilities() { return { operations: ["run", "continue"], interactionKinds: [], progress: "coarse", transport: "http", reconciliation: "reattach_stream" }; },
		async *run() {}, async *continue() {}, async *respond() {},
		async *reattachRun() {
			reattachCalls++;
			yield { type: "started", runHandle: "reattach-run", sessionHandle: "reattach-session" };
			await gate;
			yield { type: "completed", result: { agentId: "remote-reattach", status: "completed", content: "reattached done", runHandle: "reattach-run", sessionHandle: "reattach-session" } };
		},
		async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);
	const lost = await delegations.createDelegation({ ...baseDelegation(), agentId: driver.id, managerToolCallId: "reattach", driverTransport: "http" });
	await delegations.transitionDelegation(lost.id, ["admitted"], { executionState: "observation_lost", runHandle: "reattach-run", sessionHandle: "reattach-session" });
	let notified!: (value: NormalizedResult) => void;
	const terminalNotification = new Promise<NormalizedResult>((resolve) => { notified = resolve; });
	const immediate = await runtime.reconcileDelegation(lost.id, async (_delegation, result) => { notified(result); });
	assert.ok(immediate.executionState === "reconciling" || immediate.executionState === "running");
	assert.equal(immediate.receipt, undefined);
	await runtime.reconcileOrphanedRuns(undefined, lost.id);
	assert.equal(reattachCalls, 1, "同一 Delegation 同时只能重挂一条流");
	releaseStream();
	const result = await terminalNotification;
	assert.equal(result.status, "completed");
	const completed = await delegations.getDelegation(lost.id);
	assert.equal(completed?.executionState, "reported_completed");
	assert.equal(completed?.receipt?.reportedOutcome, "completed");
	assert.equal(runtime.isDelegationActive(lost.id), false);
});

test("重挂流 started 的新 Session handle 会传递给后续 needs_input 并保持并发锁", async () => {
	const stateDir = mkdtempSync(path.join(tmpdir(), "puddingteams-remote-reattach-input-"));
	const delegations = new DelegationStore(stateDir);
	await delegations.init();
	const secrets = new InteractionSecretStore(mkdtempSync(path.join(tmpdir(), "puddingteams-remote-reattach-input-secrets-")));
	await secrets.init();
	const driver: AgentDriver = {
		id: "remote-reattach-input",
		async capabilities() { return { operations: ["run", "continue", "respond"], interactionKinds: ["permission"], progress: "coarse", transport: "http", reconciliation: "reattach_stream" }; },
		async *run() {}, async *continue() {}, async *respond() {},
		async *reattachRun() {
			yield { type: "started", runHandle: "reattach-input-run", sessionHandle: "reattach-input-session" };
			yield { type: "input_required", result: { agentId: "remote-reattach-input", status: "needs_input", interaction: { id: "remote-input", kind: "permission", requests: [{ requestId: "permit", prompt: "允许继续？", options: ["once", "reject"] }] } } };
		},
		async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);
	const lost = await delegations.createDelegation({ ...baseDelegation(), agentId: driver.id, managerToolCallId: "reattach-input", driverTransport: "http" });
	await delegations.transitionDelegation(lost.id, ["admitted"], { executionState: "observation_lost", runHandle: "reattach-input-run" });
	let notified!: (value: NormalizedResult) => void;
	const boundary = new Promise<NormalizedResult>((resolve) => { notified = resolve; });
	await runtime.reconcileDelegation(lost.id, async (_delegation, result) => { notified(result); });
	assert.equal((await boundary).status, "needs_input");
	const waiting = await delegations.getDelegation(lost.id);
	assert.equal(waiting?.executionState, "waiting_input");
	assert.equal(waiting?.sessionHandle, "reattach-input-session");
	assert.equal((await runtime.canDelegate("reattach-input-session")).ok, false);
	assert.equal(runtime.isDelegationActive(lost.id), true);
});

test("Verification 环境预检失败不会泄漏 pending Session 锁或创建 Delegation", async () => {
	const stateDir = mkdtempSync(path.join(tmpdir(), "puddingteams-verification-preflight-"));
	const delegations = new DelegationStore(stateDir);
	await delegations.init();
	const secrets = new InteractionSecretStore(mkdtempSync(path.join(tmpdir(), "puddingteams-verification-preflight-secrets-")));
	await secrets.init();
	const driver: AgentDriver = {
		id: "local-preflight",
		async capabilities() { return { operations: ["run", "continue"], interactionKinds: [], progress: "none", transport: "spawn" }; },
		async *run() { yield { type: "completed", result: { agentId: "local-preflight", status: "completed", content: "ok" } }; },
		async *continue() { yield { type: "completed", result: { agentId: "local-preflight", status: "completed", content: "ok" } }; },
		async *respond() {}, async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);
	const common = { windowId: "window-1", managerSessionId: "manager-session-1", agentId: driver.id, agentRevision: 0, cwdSnapshot: process.cwd(), mode: "continue" as const, sessionHandle: "preflight-session", message: "verify" };
	await assert.rejects(() => runtime.delegate({ ...common, purpose: "verification", verificationId: "verification-1", verificationEnvironmentId: "missing-environment" }, { cwd: process.cwd(), env: {} }), /WorkspaceExecutionCoordinator 未启用/);
	assert.equal((await delegations.listDelegations()).length, 0);
	const completed = await runtime.delegate({ ...common, message: "ordinary continuation" }, { cwd: process.cwd(), env: {} });
	assert.equal(completed.status, "completed");
});

test("人工接管必须明确确认上游已停止，之后才封存 Receipt", async () => {
	const { delegations, runtime } = setup();
	const lost = await delegations.createDelegation({ ...baseDelegation(), managerToolCallId: "manual-takeover" });
	await delegations.transitionDelegation(lost.id, ["admitted"], { executionState: "observation_lost" });
	await assert.rejects(() => runtime.confirmObservationLostStopped(lost.id, "太短"), /至少需要 8 个字符/);
	const resolved = await runtime.confirmObservationLostStopped(lost.id, "已确认本地进程和外部副作用均已停止");
	assert.equal(resolved.executionState, "cancelled");
	assert.equal(resolved.receipt?.reportedOutcome, "cancelled");
	assert.equal(resolved.result && "errorCode" in resolved.result ? resolved.result.errorCode : undefined, "manual_reconciliation_confirmed_stopped");
});

test("取消: observable 但没有终态观察时转 observation_lost，不伪造 cancelled", async () => {
	const stateDir = mkdtempSync(path.join(tmpdir(), "puddingteams-cancel-observation-"));
	const delegations = new DelegationStore(stateDir);
	await delegations.init();
	const secrets = new InteractionSecretStore(mkdtempSync(path.join(tmpdir(), "puddingteams-cancel-observation-secrets-")));
	await secrets.init();
	const driver: AgentDriver = {
		id: "remote-cancel",
		async capabilities() { return { operations: ["run", "cancel"], interactionKinds: [], progress: "coarse", transport: "http", cancelConfirmation: "observable" }; },
		async *run() {}, async *continue() {}, async *respond() {}, async cancel() {},
		async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);
	const delegation = await delegations.createDelegation({ ...baseDelegation(), agentId: "remote-cancel", managerToolCallId: "cancel-observable", driverTransport: "http" });
	await delegations.transitionDelegation(delegation.id, ["admitted"], { executionState: "running", runHandle: "remote-cancel-run" });
	await runtime.cancel(delegation.id, { cwd: process.cwd(), env: {} });
	const current = await delegations.getDelegation(delegation.id);
	assert.equal(current?.executionState, "observation_lost");
	assert.equal(current?.receipt, undefined);
});
