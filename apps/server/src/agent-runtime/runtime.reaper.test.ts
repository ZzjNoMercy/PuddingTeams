import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore, type DelegationRecord } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import type { NormalizedResult } from "../agent-runtime/types.js";

/**
 * 启动收割器（server_restart）：进程重启后 running/waiting_input 的持久化
 * 记录都是孤儿（内存 Run 已灭）。reapOrphanedRuns 必须把它们统一转 failed、
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

function baseDelegation(): Omit<DelegationRecord, "id" | "status" | "revision" | "createdAt" | "updatedAt"> {
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
	// waiting_input 孤儿（带 pending 审批）
	const waiting = await delegations.createDelegation({ ...baseDelegation(), managerToolCallId: "call_2" });
	await delegations.transitionDelegation(waiting.id, ["running"], { status: "waiting_input", runHandle: "run-2" });
	const interaction = await delegations.createInteraction({
		delegationId: waiting.id,
		kind: "permission",
		requests: [{ requestId: "perm-1", prompt: "允许执行？" }],
		providerStateRef: "ref-1",
	});
	// 终态对照
	const done = await delegations.createDelegation({ ...baseDelegation(), managerToolCallId: "call_3" });
	await delegations.transitionDelegation(done.id, ["running"], { status: "completed" });

	const notified: Array<{ id: string; errorCode?: string }> = [];
	const reaped = await runtime.reapOrphanedRuns(async (d, result: NormalizedResult) => {
		notified.push({ id: d.id, errorCode: "errorCode" in result ? result.errorCode : undefined });
	});

	assert.equal(reaped, 2);
	assert.deepEqual(
		notified.map((n) => n.id).sort(),
		[running.id, waiting.id].sort(),
	);
	assert.ok(notified.every((n) => n.errorCode === "server_restart"));

	const runningAfter = await delegations.getDelegation(running.id);
	assert.equal(runningAfter?.status, "failed");
	assert.equal(runningAfter?.result && "errorCode" in runningAfter.result ? runningAfter.result.errorCode : undefined, "server_restart");

	const waitingAfter = await delegations.getDelegation(waiting.id);
	assert.equal(waitingAfter?.status, "failed");

	const interactionAfter = (await delegations.listInteractions()).find((i) => i.id === interaction.id);
	assert.equal(interactionAfter?.status, "expired");

	assert.equal((await delegations.getDelegation(done.id))?.status, "completed");

	// 幂等：第二次收割没有孤儿
	assert.equal(await runtime.reapOrphanedRuns(), 0);
});
