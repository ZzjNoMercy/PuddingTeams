import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore, type AgentConfig } from "../store/teams.js";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { DriverRegistry } from "./driver-registry.js";
import { AgentInvoker } from "./invoker.js";
import type { AgentDriver, AgentEvent, DriverCapabilities } from "./types.js";

/**
 * 两边同步回归：审批（respond）后，结果必须同时扇出到 manager session 和
 * delegation 所属窗口的 active session（单聊镜像），用户只在 solo 窗口
 * 也能看到全部审批结果与 worker 输出。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

type Sent = {
	sessionId: string;
	customType: string;
	status?: unknown;
	revision?: unknown;
	options: { triggerTurn: boolean; deliverAs?: string };
};

/** respond 后按 variant 产出不同终态的 mock driver。 */
function makeDriver(variant: "completed" | "failed" | "needs_input"): AgentDriver {
	return {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: ["permission"], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: "worker-sess", runHandle: "run-1" };
			yield {
				type: "input_required",
				result: {
					agentId: "puddingclaw",
					status: "needs_input",
					sessionHandle: "worker-sess",
					runHandle: "run-1",
					interaction: {
						id: "int_placeholder",
						kind: "permission",
						requests: [{ requestId: "perm-1", prompt: "允许执行？", options: ["once", "reject"] }],
					},
				},
			};
		},
		async *continue(): AsyncIterable<AgentEvent> {
			throw new Error("unused");
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: "worker-sess", runHandle: "run-1" };
			if (variant === "completed") {
				yield { type: "completed", result: { agentId: "puddingclaw", status: "completed", sessionHandle: "worker-sess", runHandle: "run-1", content: "分析完成" } };
			} else if (variant === "failed") {
				yield { type: "failed", result: { agentId: "puddingclaw", status: "failed", sessionHandle: "worker-sess", runHandle: "run-1", errorCode: "boom", error: "worker 炸了", recoverable: false } };
			} else {
				yield {
					type: "input_required",
					result: {
						agentId: "puddingclaw",
						status: "needs_input",
						sessionHandle: "worker-sess",
						runHandle: "run-1",
						interaction: {
							id: "int_placeholder",
							kind: "permission",
							requests: [{ requestId: "perm-2", prompt: "还要再删一张表，允许？", options: ["once", "reject"] }],
						},
					},
				};
			}
		},
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const, enabled: true,
				compatibility: "supported" as const,
				capabilities: { operations: ["run", "continue", "respond"], interactionKinds: ["permission"], progress: "none" as const, transport: "spawn" as const },
				issues: [],
			};
		},
	};
}

async function makeStack(variant: "completed" | "failed" | "needs_input", managerSessionId = "manager-sess-1") {
	const dir = freshDir("pt-fanout-");
	const teams = new TeamsStore({ state: dir, assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	const agent: AgentConfig = {
		name: "puddingclaw",
		description: "test worker",
		invoke: { type: "command", command: "echo", runArgs: ["run"] },
		enabled: true,
	};
	await teams.upsertAgent(agent);
	const savedAgent = await teams.getAgent("puddingclaw");
	const window = await teams.createWindow({ type: "direct", members: ["puddingclaw"], sessionId: "direct-sess-1" });

	const delegations = new DelegationStore(freshDir("pt-fanout-dlg-"));
	await delegations.init();
	const secrets = new InteractionSecretStore(freshDir("pt-fanout-sec-"));
	await secrets.init();
	const drivers = new DriverRegistry();
	drivers.register(makeDriver(variant));
	const runtime = new AgentRuntime(delegations, secrets, (agentId) => drivers.get(agentId), { ttlMs: 24 * 60 * 60 * 1000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sent: Sent[] = [];
	invoker.setManagerSender(async (sessionId, message, options) => {
		sent.push({
			sessionId,
			customType: message.customType,
			status: message.details?.status,
			revision: message.details?.revision,
			options,
		});
	});

	const delegated = await runtime.delegate(
		{
			windowId: window.id,
			cwdSnapshot: window.cwdSnapshot,
			managerSessionId,
			agentId: "puddingclaw",
			agentRevision: savedAgent?.extensionRevision ?? 0,
			message: "分析一下",
			mode: "run",
		},
		{ cwd: window.cwdSnapshot, env: {} },
	);
	assert.equal(delegated.status, "needs_input");
	return { invoker, interactionId: delegated.interaction!.id, delegationId: delegated.delegation.id, sent, window };
}

const approve = {
	requestId: "ui-1",
	revision: 0,
	responses: [{ requestId: "perm-1", action: "approve", scope: "once" }],
};

/** 受理即返回后，结果扇出在后台续跑：轮询直到消息到齐。 */
async function waitForSent(sent: Sent[], count: number): Promise<void> {
	for (let i = 0; i < 200 && sent.length < count; i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.equal(sent.length, count, "后台扇出应在期限内完成");
}

test("两边同步: 受理即返回 approved，completed 扇出 manager（唤醒汇总）+ 单聊（仅展示）", async () => {
	const { invoker, interactionId, sent } = await makeStack("completed");
	const outcome = await invoker.respond(interactionId, approve);
	assert.equal(outcome.status, "approved", "approve 受理后立即返回，不等 worker 续跑落定");
	assert.equal(outcome.details.admitted, true);

	await waitForSent(sent, 4);
	const manager = sent.filter((s) => s.sessionId === "manager-sess-1");
	const direct = sent.filter((s) => s.sessionId === "direct-sess-1");
	assert.deepEqual(
		manager.map((s) => s.customType),
		["pudding:interaction_resolved", "pudding:task_result"],
	);
	assert.equal(manager[0]!.status, "approved");
	assert.equal(manager[0]!.options.triggerTurn, false);
	assert.equal(manager[1]!.status, "completed");
	assert.equal(manager[1]!.options.triggerTurn, true, "manager 需要被唤醒做汇总");
	assert.equal(manager[1]!.options.deliverAs, "followUp");
	assert.deepEqual(
		direct.map((s) => s.customType),
		["pudding:interaction_resolved", "pudding:task_result"],
		"单聊窗口必须同步看到审批通过与 worker 结果",
	);
	assert.ok(direct.every((s) => s.options.triggerTurn === false), "单聊只展示不唤醒");
});

test("两边同步: rejected 扇出 manager + 单聊（任务取消）", async () => {
	const { invoker, interactionId, sent } = await makeStack("completed");
	const outcome = await invoker.respond(interactionId, {
		requestId: "ui-rej",
		revision: 0,
		responses: [{ requestId: "perm-1", action: "reject" }],
	});
	assert.equal(outcome.status, "cancelled");

	for (const sessionId of ["manager-sess-1", "direct-sess-1"]) {
		const messages = sent.filter((s) => s.sessionId === sessionId);
		assert.deepEqual(
			messages.map((s) => s.customType),
			["pudding:interaction_resolved", "pudding:task_result"],
			`${sessionId} 必须收到 resolved + task_result`,
		);
		assert.equal(messages[0]!.status, "rejected");
		assert.equal(messages[1]!.status, "cancelled");
	}
});

test("两边同步: 主动取消待审批任务会通知并唤醒 manager 闭环", async () => {
	const { invoker, delegationId, sent } = await makeStack("completed");
	await invoker.cancel(delegationId);

	await waitForSent(sent, 4);
	const manager = sent.filter((s) => s.sessionId === "manager-sess-1");
	assert.deepEqual(manager.map((s) => s.customType), ["pudding:interaction_resolved", "pudding:task_result"]);
	assert.equal(manager[0]!.status, "cancelled");
	assert.equal(manager[0]!.options.triggerTurn, false);
	assert.equal(manager[1]!.status, "cancelled");
	assert.equal(manager[1]!.options.triggerTurn, true, "待审批 tool call 已结束，取消后必须唤醒 manager 闭环");
	assert.equal(manager[1]!.options.deliverAs, "followUp");

	const direct = sent.filter((s) => s.sessionId === "direct-sess-1");
	assert.deepEqual(direct.map((s) => s.customType), ["pudding:interaction_resolved", "pudding:task_result"]);
	assert.ok(direct.every((s) => s.options.triggerTurn === false), "worker 单聊只同步展示，不启动 manager 回合");
});

test("两边同步: failed 也会通知两边（不再静默）", async () => {
	const { invoker, interactionId, sent } = await makeStack("failed");
	const outcome = await invoker.respond(interactionId, approve);
	assert.equal(outcome.status, "approved", "受理即返回；失败结果走后台扇出");

	await waitForSent(sent, 4);
	const manager = sent.filter((s) => s.sessionId === "manager-sess-1");
	assert.deepEqual(manager.map((s) => s.customType), ["pudding:interaction_resolved", "pudding:task_result"]);
	assert.equal(manager[0]!.status, "approved", "审批受理时先恢复任务卡为执行中");
	assert.equal(manager[1]!.status, "failed");
	assert.equal(manager[1]!.options.triggerTurn, true, "失败同样唤醒 manager 汇总");
	const direct = sent.filter((s) => s.sessionId === "direct-sess-1");
	assert.deepEqual(direct.map((s) => s.customType), ["pudding:interaction_resolved", "pudding:task_result"]);
	assert.ok(direct.every((s) => s.options.triggerTurn === false));
});

test("两边同步: 多轮 needs_input 投影新审批卡到两边（不唤醒）", async () => {
	const { invoker, interactionId, sent } = await makeStack("needs_input");
	const outcome = await invoker.respond(interactionId, approve);
	assert.equal(outcome.status, "approved", "受理即返回；新一轮审批卡走后台扇出");

	await waitForSent(sent, 4);
	for (const sessionId of ["manager-sess-1", "direct-sess-1"]) {
		const messages = sent.filter((s) => s.sessionId === sessionId);
		assert.deepEqual(
			messages.map((s) => s.customType),
			["pudding:interaction_resolved", "pudding:interaction_required"],
			`${sessionId} 必须先恢复执行，再进入新一轮审批`,
		);
		assert.equal(messages[0]!.status, "approved");
		assert.equal(messages[1]!.status, "pending");
		assert.equal(messages[1]!.options.triggerTurn, false, "等用户再批，不唤醒 turn");
	}
});

test("两边同步: manager session 与单聊 active session 相同则只发一次", async () => {
	const { invoker, interactionId, sent } = await makeStack("completed", "direct-sess-1");
	const outcome = await invoker.respond(interactionId, approve);
	assert.equal(outcome.status, "approved");
	await waitForSent(sent, 2);
	assert.ok(sent.every((s) => s.sessionId === "direct-sess-1"));
	assert.ok(
		sent.every((s) => s.options.triggerTurn === false),
		"direct 直派（§5.2）：manager session 属 direct 窗口时无 manager 回合，结果只展示不唤醒",
	);
});
