import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { WorkerProcessService } from "../agent-runtime/worker-process.js";
import { registerWorkerProcessRoutes } from "./worker-process.js";

/** pi worker 执行过程可视化（只读）：按 delegationId 回放/订阅 worker 会话。 */

async function makeStack() {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-worker-process-"));
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const workerSessions = path.join(dir, "worker-sessions");
	const service = new WorkerProcessService(delegations, teams, workerSessions);
	const app = Fastify({ logger: false });
	await app.register(websocket);
	registerWorkerProcessRoutes(app, service);
	return { app, delegations, workerSessions, dir };
}

/** 造一个落盘的 worker 会话（user + assistant 两条消息），返回 sessionId。 */
function makeWorkerSession(workerSessions: string, cwd: string): string {
	const sm = SessionManager.create(cwd, workerSessions);
	sm.appendMessage({ role: "user", content: "查一下数据", timestamp: Date.now() } as never);
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "查完了" }],
		api: "openai",
		provider: "openai",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	return sm.getSessionId();
}

test("未知 delegation：process 与 messages 都 404", async () => {
	const { app } = await makeStack();
	const res = await app.inject({ method: "GET", url: "/api/delegations/nope/process" });
	assert.equal(res.statusCode, 404);
	const res2 = await app.inject({ method: "GET", url: "/api/delegations/nope/process/messages" });
	assert.equal(res2.statusCode, 404);
	await app.close();
});

test("已结束委托：从 JSONL 回放 worker 会话历史，live=false", async () => {
	const { app, delegations, workerSessions, dir } = await makeStack();
	const handle = makeWorkerSession(workerSessions, dir);
	const d = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: "s1",
		agentId: "pi-worker",
		agentRevision: 0,
		operation: "run",
	});
	await delegations.updateDelegation(d.id, { sessionHandle: handle });
	await delegations.transitionDelegation(d.id, ["running"], { status: "completed" });

	const info = await app.inject({ method: "GET", url: `/api/delegations/${d.id}/process` });
	assert.equal(info.statusCode, 200, info.body);
	assert.deepEqual(info.json(), {
		delegationId: d.id,
		agentId: "pi-worker",
		status: "completed",
		sessionHandle: handle,
		createdAt: d.createdAt,
		live: false,
	});

	const res = await app.inject({ method: "GET", url: `/api/delegations/${d.id}/process/messages` });
	assert.equal(res.statusCode, 200, res.body);
	const body = res.json();
	assert.equal(body.live, false);
	assert.equal(body.status, "completed");
	assert.equal(body.messages.length, 2);
	assert.equal(body.messages[0].role, "user");
	assert.equal(body.messages[1].role, "assistant");
	await app.close();
});

test("委托尚无 sessionHandle（worker 未启动）：messages 404", async () => {
	const { app, delegations, dir } = await makeStack();
	const d = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: "s1",
		agentId: "pi-worker",
		agentRevision: 0,
		operation: "run",
	});
	const res = await app.inject({ method: "GET", url: `/api/delegations/${d.id}/process/messages` });
	assert.equal(res.statusCode, 404);
	assert.deepEqual(res.json(), { error: "worker session not started" });
	await app.close();
});
