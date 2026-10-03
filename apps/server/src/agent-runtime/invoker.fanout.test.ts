import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { TeamsStore, type AgentConfig } from "../store/teams.js";
import { registerInteractionsRoutes } from "../routes/interactions.js";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { WorkspaceExecutionCoordinator } from "./workspace-execution.js";
import { DriverRegistry } from "./driver-registry.js";
import { AgentInvoker } from "./invoker.js";
import { PuddingClawDriver } from "./puddingclaw-driver.js";
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
	content: string;
	status?: unknown;
	revision?: unknown;
	details?: Record<string, unknown>;
	options: { triggerTurn: boolean; deliverAs?: string };
};

/** respond 后按 variant 产出不同终态的 mock driver。 */
function makeDriver(variant: "completed" | "failed" | "blocked" | "needs_input"): AgentDriver {
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
			} else if (variant === "blocked") {
				yield { type: "failed", result: { agentId: "puddingclaw", status: "blocked", errorCode: "workspace_policy_blocked", error: "execution scope is released: old-scope", recoverable: true, meta: { status: "completed", workerStarted: false, waitingInput: true } } };
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

async function makeStack(variant: "completed" | "failed" | "blocked" | "needs_input", managerSessionId = "manager-sess-1", prestartBlocked = false, twoWorkspaces = false, driverOverride?: (dir: string) => AgentDriver) {
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
	const projectA = twoWorkspaces ? await teams.workspaces.createManaged("project-a") : undefined;
	const projectB = twoWorkspaces ? await teams.workspaces.createManaged("project-b") : undefined;
	const window = await teams.createWindow({ type: "direct", members: ["puddingclaw"], sessionId: "direct-sess-1", ...(projectA ? { workspaceId: projectA.id } : {}) });
	if (managerSessionId !== window.activeSession) {
		await teams.ensureSoloWindow(async () => ({ id: projectA ? "manager-default-sess" : managerSessionId }), async () => true);
		if (projectA) await teams.replaceWindowWorkspace("solo", projectA.id, managerSessionId);
	}

	const delegationDir = path.join(dir, "delegations");
	const interactionSecretsDir = path.join(dir, "interaction-secrets");
	const delegations = new DelegationStore(delegationDir);
	await delegations.init();
	const secrets = new InteractionSecretStore(interactionSecretsDir);
	await secrets.init();
	const drivers = new DriverRegistry();
	drivers.register(driverOverride?.(dir) ?? makeDriver(variant));
	const scopes = prestartBlocked ? new WorkspaceExecutionCoordinator(freshDir("pt-fanout-scopes-")) : undefined;
	await scopes?.init();
	const runtime = new AgentRuntime(delegations, secrets, (agentId) => drivers.get(agentId), { ttlMs: 24 * 60 * 60 * 1000 }, undefined, undefined, scopes);
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sent: Sent[] = [];
	invoker.setManagerSender(async (sessionId, message, options) => {
		sent.push({
			sessionId,
			customType: message.customType,
			content: message.content,
			status: message.details?.status,
			revision: message.details?.revision,
			details: message.details,
			options,
		});
	});

	const delegated = await runtime.delegate(
		{
			windowId: window.id,
			...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
			cwdSnapshot: window.cwdSnapshot,
			managerSessionId,
			agentId: "puddingclaw",
			agentRevision: savedAgent?.extensionRevision ?? 0,
			message: "分析一下",
			mode: "run",
			...(prestartBlocked ? { workspaceExecutionScopeId: "missing-scope", workspaceExecutionPolicy: { mode: "read_only_shared" as const, source: "user" as const, reason: "inspect", baselineStrategy: "filesystem_manifest" as const, promoteOnAcceptance: false } } : {}),
		},
		{ cwd: window.cwdSnapshot, env: {} },
	);
	assert.equal(delegated.status, "needs_input");
	return { invoker, interaction: delegated.interaction!, interactionId: delegated.interaction!.id, delegationId: delegated.delegation.id, sent, window, teams, runtime, projectA, projectB, dir, delegationDir, interactionSecretsDir, drivers };
}

const approve = {
	requestId: "ui-1",
	revision: 0,
	responses: [{ requestId: "perm-1", action: "approve", scope: "once" }],
};

test("待审批取消无法确认上游终止时，历史须如实标记失去观测", async () => {
	const { invoker, delegationId, runtime, sent } = await makeStack("completed");
	await invoker.cancel(delegationId);
	assert.equal((await runtime.getDelegation(delegationId))?.executionState, "observation_lost");
	await waitForSent(sent, 4);
	for (const message of sent) {
		assert.equal(message.status, "observation_lost");
		assert.doesNotMatch(message.content, /已终止|已由用户取消/);
	}
});

test("待审批取消经 Driver 确认后，历史才可标记已取消", async () => {
	const { invoker, delegationId, runtime, sent } = await makeStack("completed", "manager-sess-1", false, false, () => ({
		...makeDriver("completed"),
		async capabilities() { return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: ["permission"], progress: "none", transport: "spawn", cancelConfirmation: "acknowledged" }; },
		async cancel() {},
	}));
	await invoker.cancel(delegationId);
	assert.equal((await runtime.getDelegation(delegationId))?.executionState, "cancelled");
	await waitForSent(sent, 4);
	assert.ok(sent.every((message) => message.status === "cancelled"));
	assert.ok(sent.every((message) => message.content.includes("已确认取消")));
});

test("parked manager Session 的待审批 Run 不得恢复", async () => {
	const { invoker, interactionId, teams, runtime } = await makeStack("completed");
	const workspace = await teams.workspaces.createManaged("other-project");
	await teams.replaceWindowWorkspace("solo", workspace.id, "manager-other");

	await assert.rejects(() => invoker.respond(interactionId, approve), /审批所属项目未激活/);
	assert.equal((await runtime.getInteraction(interactionId))?.status, "pending", "拒绝必须发生在消费审批或调用 Driver 之前");
});

test("T06 双 Workspace: A 的审批在 B 停放，返回 A 后续跑并扇出原会话", async () => {
	const { invoker, interactionId, sent, window, teams, runtime, projectA, projectB } = await makeStack("completed", "manager-sess-1", false, true);
	assert.ok(projectA && projectB);
	assert.equal(window.cwdSnapshot, projectA.canonicalPath);
	const switched = await teams.replaceWindowWorkspace("solo", projectB.id, "manager-sess-b");
	assert.equal(switched.window.activeSession, "manager-sess-b");
	await assert.rejects(() => invoker.respond(interactionId, approve), /审批所属项目未激活/);
	assert.equal((await runtime.getInteraction(interactionId))?.status, "pending");
	assert.equal(sent.length, 0, "停放期间不能向 B 或 A 发送伪审批结果");

	const restored = await teams.replaceWindowWorkspace("solo", projectA.id, undefined);
	assert.equal(restored.restored, true);
	assert.equal(restored.window.activeSession, "manager-sess-1");
	assert.equal(restored.window.cwdSnapshot, projectA.canonicalPath);
	const outcome = await invoker.respond(interactionId, approve);
	assert.equal(outcome.status, "approved");
	await waitForSent(sent, 4);
	assert.deepEqual(sent.filter((item) => item.sessionId === "manager-sess-1").map((item) => item.customType), ["pudding:interaction_resolved", "pudding:task_result"]);
	assert.deepEqual(sent.filter((item) => item.sessionId === "direct-sess-1").map((item) => item.customType), ["pudding:interaction_resolved", "pudding:task_result"]);
	assert.equal(sent.some((item) => item.sessionId === "manager-sess-b"), false);
});

test("T06 子进程 Driver: A→B→A 审批只在 A 的 cwd 续跑", async () => {
	const { invoker, interactionId, sent, teams, runtime, projectA, projectB, dir, delegationId } =
		await makeStack("completed", "manager-sess-1", false, true, (root) => {
			const cli = path.join(root, "fixture-worker.sh");
			const needsInput = JSON.stringify({
				status: "needs_input", run_id: "fixture-run", session_id: "fixture-session", continuation_token: "private-continuation",
				needs_input: { type: "permission", request_id: "perm-1", prompt: "允许执行？", options: [{ id: "once" }, { id: "reject" }] },
			});
			const completed = JSON.stringify({ status: "completed", run_id: "fixture-run", session_id: "fixture-session", final_response: "子进程任务完成" });
			writeFileSync(cli, [
				"#!/bin/sh",
				'if [ "$2" = "run" ]; then',
				`  /bin/cat > ${JSON.stringify(path.join(root, "run-input.json"))}`,
				`  pwd > ${JSON.stringify(path.join(root, "run-cwd.txt"))}`,
				`  printf '%s\\n' '${needsInput}'`,
				'elif [ "$2" = "respond" ]; then',
				`  /bin/cat > ${JSON.stringify(path.join(root, "respond-input.json"))}`,
				`  pwd > ${JSON.stringify(path.join(root, "respond-cwd.txt"))}`,
				`  printf '%s\\n' '${completed}'`,
				"fi",
				"",
			].join("\n"));
			chmodSync(cli, 0o755);
			return new PuddingClawDriver({ transport: "spawn", command: cli });
		});
	assert.ok(projectA && projectB);
	assert.equal(readFileSync(path.join(dir, "run-cwd.txt"), "utf8").trim(), projectA.canonicalPath);
	await teams.replaceWindowWorkspace("solo", projectB.id, "manager-sess-b");
	await assert.rejects(invoker.respond(interactionId, approve), /审批所属项目未激活/);
	assert.equal(existsSync(path.join(dir, "respond-input.json")), false, "停放期间不能启动 Worker 子进程续跑");
	assert.equal((await runtime.getInteraction(interactionId))?.status, "pending");
	await teams.replaceWindowWorkspace("solo", projectA.id, undefined);
	assert.equal((await invoker.respond(interactionId, approve)).status, "approved");
	await waitForSent(sent, 4);
	assert.equal(readFileSync(path.join(dir, "respond-cwd.txt"), "utf8").trim(), projectA.canonicalPath);
	const response = JSON.parse(readFileSync(path.join(dir, "respond-input.json"), "utf8")) as { continuation_token?: string };
	assert.equal(response.continuation_token, "private-continuation");
	assert.equal(sent.some((item) => item.sessionId === "manager-sess-b"), false);
	assert.equal(sent.some((item) => item.content.includes("private-continuation")), false);
	assert.equal((await runtime.listDelegations()).find((item) => item.id === delegationId)?.receipt?.reportedOutcome, "completed");
});

test("T06 重启对账: A 的本地待审批 Run 在 B 停放期间失效，不能继续批准或误投 B", async () => {
	const { invoker, runtime, interactionId, delegationId, sent, window, teams, projectA, projectB, dir, delegationDir, interactionSecretsDir, drivers } =
		await makeStack("completed", "manager-sess-1", false, true);
	assert.ok(projectA && projectB);
	const beforeApp = Fastify();
	registerInteractionsRoutes(beforeApp, runtime, invoker, teams);
	try {
		const pendingBefore = await beforeApp.inject({ method: "GET", url: `/api/interactions?windowId=${window.id}` });
		assert.equal(pendingBefore.statusCode, 200, pendingBefore.body);
		assert.equal(pendingBefore.json().interactions.some((item: { id: string }) => item.id === interactionId), true);
	} finally { await beforeApp.close(); }
	await teams.replaceWindowWorkspace("solo", projectB.id, "manager-sess-b");
	const restoredTeams = new TeamsStore({ state: dir, assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
	await restoredTeams.init();
	const restoredDelegations = new DelegationStore(delegationDir);
	await restoredDelegations.init();
	const restoredSecrets = new InteractionSecretStore(interactionSecretsDir);
	await restoredSecrets.init();
	const restoredRuntime = new AgentRuntime(restoredDelegations, restoredSecrets, (agentId) => drivers.get(agentId));
	assert.equal((await restoredRuntime.getInteraction(interactionId))?.status, "pending", "审批待办确实从磁盘恢复");
	assert.equal((await restoredRuntime.listDelegations()).find((item) => item.id === delegationId)?.executionState, "waiting_input");
	assert.equal((await restoredTeams.getWindow("solo"))?.activeSession, "manager-sess-b");
	const notified: Array<{ managerSessionId: string; errorCode: string | undefined }> = [];
	assert.equal(await restoredRuntime.reconcileOrphanedRuns(async (orphan, result) => {
		notified.push({ managerSessionId: orphan.managerSessionId, errorCode: result.status === "failed" ? result.errorCode : undefined });
	}), 1);
	assert.deepEqual(notified, [{ managerSessionId: "manager-sess-1", errorCode: "server_restart" }]);
	assert.equal(await restoredRuntime.reconcileOrphanedRuns(), 0, "重复启动对账不得再产生一份失败结果");
	const terminal = (await restoredRuntime.listDelegations()).find((item) => item.id === delegationId);
	assert.equal(terminal?.executionState, "reported_failed");
	assert.ok(terminal?.result && "errorCode" in terminal.result);
	assert.equal(terminal.result.errorCode, "server_restart");
	assert.equal(terminal.receipt?.reportedOutcome, "failed");
	assert.equal((await restoredRuntime.getInteraction(interactionId))?.status, "expired");
	const verifiedOnDisk = new DelegationStore(delegationDir);
	await verifiedOnDisk.init();
	assert.equal((await verifiedOnDisk.getDelegation(delegationId))?.receipt?.reportedOutcome, "failed");
	assert.equal((await verifiedOnDisk.getInteraction(interactionId))?.status, "expired");
	const restoredInvoker = new AgentInvoker(restoredTeams, restoredRuntime, drivers, undefined, dir);
	await assert.rejects(restoredInvoker.respond(interactionId, approve));
	await restoredTeams.replaceWindowWorkspace("solo", projectA.id, undefined);
	await assert.rejects(restoredInvoker.respond(interactionId, approve), "返回 A 也不能复活已终止的本地 Run");
	const app = Fastify();
	registerInteractionsRoutes(app, restoredRuntime, restoredInvoker, restoredTeams);
	try {
		const pending = await app.inject({ method: "GET", url: "/api/interactions" });
		assert.equal(pending.statusCode, 200, pending.body);
		assert.equal(pending.json().interactions.some((item: { id: string }) => item.id === interactionId), false);
		const history = await app.inject({ method: "GET", url: `/api/interactions/${interactionId}` });
		assert.equal(history.statusCode, 200, history.body);
		assert.equal(history.json().interaction.status, "expired");
		const rejected = await app.inject({ method: "POST", url: `/api/interactions/${interactionId}/responses`, payload: approve });
		assert.equal(rejected.statusCode, 409, rejected.body);
		assert.equal(rejected.json().code, "not_pending");
	} finally { await app.close(); }
	assert.equal(sent.length, 0, "重启前的内存 sender 不能向 B 或 A 伪造完成结果");
});

/** 受理即返回后，结果扇出在后台续跑：轮询直到消息到齐。 */
async function waitForSent(sent: Sent[], count: number): Promise<void> {
	for (let i = 0; i < 200 && sent.length < count; i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.equal(sent.length, count, "后台扇出应在期限内完成");
}

test("两边同步: 受理即返回 approved，completed 扇出 manager（唤醒汇总）+ 单聊（仅展示）", async () => {
	const { invoker, interactionId, delegationId, sent } = await makeStack("completed");
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
	assert.match(manager[1]!.content, new RegExp(`delegationId：${delegationId}`), "审批续跑的终态正文必须暴露 delegationId，供同 Run followup 使用");
	assert.equal(manager[1]!.options.triggerTurn, true, "manager 需要被唤醒做汇总");
	assert.equal(manager[1]!.options.deliverAs, "followUp");
	assert.deepEqual(
		direct.map((s) => s.customType),
		["pudding:interaction_resolved", "pudding:task_result"],
		"单聊窗口必须同步看到审批通过与 worker 结果",
	);
	assert.ok(direct.every((s) => s.options.triggerTurn === false), "单聊只展示不唤醒");
});

test("停用并保留待审批 Run 后仍可按原配置完成审批", async () => {
	const { invoker, interactionId, teams, runtime, sent } = await makeStack("completed");
	await teams.setEnabled("puddingclaw", false);
	assert.equal((await runtime.getInteraction(interactionId))?.status, "pending");
	const outcome = await invoker.respond(interactionId, approve);
	assert.equal(outcome.status, "approved");
	await waitForSent(sent, 4);
	assert.equal((await runtime.getInteraction(interactionId))?.status, "approved");
});

test("停用后若 Worker 配置再变化，旧 Run 仍不得按新配置恢复", async () => {
	const { invoker, interactionId, teams, runtime } = await makeStack("completed");
	await teams.setEnabled("puddingclaw", false);
	await teams.bumpAgentRevision("puddingclaw");
	await assert.rejects(invoker.respond(interactionId, approve), /Agent 配置已变化/);
	assert.equal((await runtime.getInteraction(interactionId))?.status, "pending");
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
	assert.equal(manager[0]!.status, "observation_lost");
	assert.equal(manager[0]!.options.triggerTurn, false);
	assert.equal(manager[1]!.status, "observation_lost");
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


test("审批后 blocked 的真实错误和执行事实进入 Manager 正文，Worker meta 不能覆盖平台状态", async () => {
	const { invoker, interactionId, delegationId, sent } = await makeStack("blocked");
	await invoker.respond(interactionId, approve);
	await waitForSent(sent, 4);
	const results = sent.filter((message) => message.customType === "pudding:task_result");
	assert.equal(results.length, 2);
	for (const result of results) {
		assert.match(result.content, /execution scope is released: old-scope/);
		assert.match(result.content, /workspace_policy_blocked/);
		assert.ok(result.content.includes(delegationId));
		assert.match(result.content, /"waitingInput":false/);
		assert.match(result.content, /"workerStarted":true/);
		assert.equal(result.status, "failed");
		assert.equal(result.details?.workerStarted, true);
		assert.equal(result.details?.waitingInput, false);
	}
});


test("未配置 MCP 时平台联网工厂仍进入 Pi Worker", async () => {
 const { teams, drivers, invoker } = await makeStack("completed");
 let config: Record<string, unknown> | undefined;
 drivers.registerFactory("pi", (options) => {
  config = options;
  return { ...makeDriver("completed"), async capabilities() { return { operations: ["run", "continue", "cancel"], interactionKinds: [], progress: "none", transport: "sdk" }; } };
 });
 await teams.upsertAgent({ name: "webpi", description: "", connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} } });
 invoker.setWebResearchExtension(id => ({ name: `web-${id}`, factory: () => {} }), async id => `permissions-${id}`);
 assert.ok(await invoker.driverFor("webpi"));
 const factoriesFor = config?.managedExtensionFactoriesFor as () => Promise<Array<{ name: string }>>;
 assert.deepEqual((await factoriesFor()).map(factory => factory.name), ["web-webpi"]);
 const fingerprintFor = config?.managedExtensionsFingerprintFor as () => Promise<string>;
 assert.equal(await fingerprintFor(), "permissions-webpi");
});
