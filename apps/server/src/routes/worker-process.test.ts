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
import { DelegationTimelineStore } from "../agent-runtime/delegation-timeline-store.js";
import { registerWorkerProcessRoutes } from "./worker-process.js";
import { WorkStateStore } from "../store/work-state.js";

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
	const timelines = new DelegationTimelineStore(path.join(dir, "timelines"));
	await timelines.init();
	const service = new WorkerProcessService(delegations, teams, workerSessions, timelines);
	const workStates = new WorkStateStore(path.join(dir, "goal-state"));
	await workStates.init();
	const app = Fastify({ logger: false });
	const cancellations: string[] = [];
	await app.register(websocket);
	registerWorkerProcessRoutes(app, service, {
		cancel: async (delegationId) => {
			cancellations.push(delegationId);
			await delegations.transitionDelegation(delegationId, ["running", "waiting_input"], { status: "cancelled" });
		},
	}, workStates);
	return { app, delegations, timelines, workerSessions, workStates, dir, cancellations };
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

test("房间执行过程索引：按当前 manager session 返回并保留并行 worker", async () => {
	const { app, delegations, dir } = await makeStack();
	const first = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: "s1",
		agentId: "codex",
		agentRevision: 0,
		operation: "run",
		task: "实现执行过程的任务摘要",
		intent: "实现接口",
	});
	const second = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: "s1",
		agentId: "pi-worker",
		agentRevision: 0,
		operation: "run",
		expectedOutcome: "给出审查结论",
	});
	await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: "other-session",
		agentId: "puddingclaw",
		agentRevision: 0,
		operation: "run",
	});

	const response = await app.inject({
		method: "GET",
		url: "/api/rooms/w1/delegation-processes?managerSessionId=s1",
	});
	assert.equal(response.statusCode, 200, response.body);
	const items = response.json().delegations as Array<{ delegationId: string; agentId: string; task?: string; intent?: string; expectedOutcome?: string }>;
	assert.deepEqual(new Set(items.map((item) => item.delegationId)), new Set([first.id, second.id]));
	assert.equal(items.find((item) => item.agentId === "codex")?.task, "实现执行过程的任务摘要");
	assert.equal(items.find((item) => item.agentId === "codex")?.intent, "实现接口");
	assert.equal(items.find((item) => item.agentId === "pi-worker")?.expectedOutcome, "给出审查结论");
	await app.close();
});

test("房间执行过程索引：manager 房间与镜像 worker 单聊都能看到同一委托", async () => {
	const { app, delegations, dir } = await makeStack();
	const managerSessionId = "manager-current";
	const directSession = SessionManager.create(dir, dir);
	const delegation = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "worker-direct",
		managerSessionId,
		managerToolCallId: "tool-1",
		agentId: "puddingclaw",
		agentRevision: 0,
		operation: "run",
		task: "批准后继续执行的任务",
	});
	// PiSessionStore.ensureSessionFile 会先建立可被 listAll() 发现的 Session
	// 文件；原生 SessionManager 则到首个 assistant 消息才刷盘，测试里先
	// 建立等价的可发现会话，再追加 direct 的任务镜像。
	directSession.appendMessage({ role: "user", content: "请执行任务", timestamp: Date.now() } as never);
	directSession.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "开始委托" }],
		api: "openai",
		provider: "openai",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	directSession.appendCustomMessageEntry("pudding:task_assign", "批准后继续执行的任务", true, {
		taskId: "tool-1",
		delegationId: delegation.id,
	});

	const managerView = await app.inject({
		method: "GET",
		url: `/api/rooms/solo/delegation-processes?managerSessionId=${managerSessionId}`,
	});
	assert.deepEqual(managerView.json().delegations.map((item: { delegationId: string }) => item.delegationId), [delegation.id]);

	const directView = await app.inject({
		method: "GET",
		url: `/api/rooms/worker-direct/delegation-processes?managerSessionId=${directSession.getSessionId()}`,
	});
	assert.deepEqual(directView.json().delegations.map((item: { delegationId: string }) => item.delegationId), [delegation.id]);
	await app.close();
});

test("房间执行过程索引：旧委托从聊天镜像恢复任务摘要", async () => {
	const { app, delegations, dir } = await makeStack();
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "user", content: "安排旧任务", timestamp: Date.now() } as never);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "开始委托" }],
		api: "openai",
		provider: "openai",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	const taskId = "legacy-task-call";
	const delegation = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: manager.getSessionId(),
		managerToolCallId: taskId,
		agentId: "codex",
		agentRevision: 0,
		operation: "run",
	});
	manager.appendCustomMessageEntry("pudding:task_assign", "核对旧任务的时间线摘要", true, {
		taskId,
		delegationId: delegation.id,
	});

	const response = await app.inject({
		method: "GET",
		url: `/api/rooms/w1/delegation-processes?managerSessionId=${manager.getSessionId()}`,
	});
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(response.json().delegations[0]?.task, "核对旧任务的时间线摘要");
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
		managerSessionId: "s1",
		agentId: "pi-worker",
		status: "completed",
		sessionHandle: handle,
		createdAt: d.createdAt,
		live: false,
		view: "session",
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

test("POST delegation cancel：只取消指定的活动 Run，终态拒绝重复取消", async () => {
	const { app, delegations, dir, cancellations } = await makeStack();
	const d = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: "s1",
		agentId: "puddingclaw",
		agentRevision: 0,
		operation: "run",
	});
	const cancelled = await app.inject({ method: "POST", url: `/api/delegations/${d.id}/cancel` });
	assert.equal(cancelled.statusCode, 200, cancelled.body);
	assert.deepEqual(cancelled.json(), { cancelled: true, delegationId: d.id });
	assert.deepEqual(cancellations, [d.id]);
	assert.equal((await delegations.getDelegation(d.id))?.status, "cancelled");

	const repeated = await app.inject({ method: "POST", url: `/api/delegations/${d.id}/cancel` });
	assert.equal(repeated.statusCode, 409);
	assert.deepEqual(cancellations, [d.id]);
	await app.close();
});

test("spawn worker：process 选择追加式 timeline，REST 按 seq 回放", async () => {
	const { app, delegations, timelines, dir } = await makeStack();
	const d = await delegations.createDelegation({
		cwdSnapshot: dir,
		windowId: "w1",
		managerSessionId: "s1",
		agentId: "codex",
		agentRevision: 0,
		operation: "run",
	});
	await timelines.append(d.id, { source: "codex", sourceEvent: "turn.started", kind: "lifecycle", status: "started", title: "Turn 开始" });
	await timelines.append(d.id, { source: "codex", sourceEvent: "item.completed", kind: "tool", status: "completed", title: "命令完成" });

	const info = await app.inject({ method: "GET", url: `/api/delegations/${d.id}/process` });
	assert.equal(info.json().view, "timeline");
	const history = await app.inject({ method: "GET", url: `/api/delegations/${d.id}/process/timeline?afterSeq=1` });
	assert.equal(history.statusCode, 200, history.body);
	assert.deepEqual(history.json().events.map((event: { seq: number; title: string }) => [event.seq, event.title]), [[2, "命令完成"]]);
	await app.close();
});

test("Goal v5：历史 Goal 的 Delegation 只能查看，不能再取消", async () => {
	const { app, delegations, workStates, dir, cancellations } = await makeStack();
	const goalA = await workStates.create({ sessionId: "s-goal", goal: "A", completionBoundary: "A 完成", reviewMode: "manager", operationId: "create-a" });
	const delegation = await delegations.createDelegation({
		cwdSnapshot: dir, windowId: "w1", managerSessionId: "s-goal", goalId: goalA.goalId,
		agentId: "codex", agentRevision: 0, operation: "run",
	});
	await workStates.update("s-goal", goalA.revision, { status: "cancelled", currentBrief: "A 已结束" }, "cancel-a", goalA.execution.epoch, goalA.goalId);
	await workStates.create({ sessionId: "s-goal", goal: "B", completionBoundary: "B 完成", operationId: "create-b" });
	const response = await app.inject({
		method: "POST", url: `/api/delegations/${delegation.id}/cancel`,
		headers: { "content-type": "application/json" }, body: { expectedGoalId: goalA.goalId },
	});
	assert.equal(response.statusCode, 409, response.body);
	assert.equal(response.json().code, "stale_goal_state");
	assert.deepEqual(cancellations, []);
	assert.equal((await delegations.getDelegation(delegation.id))?.status, "running");
	await app.close();
});
