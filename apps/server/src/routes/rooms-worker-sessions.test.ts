import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerRoomsRoutes, type RoomSummary } from "./rooms.js";
import { registerChatRoutes } from "./chat.js";
import type { LiveWorkerSessionLookup } from "../agent-runtime/worker-sessions.js";

/** Worker 执行 session 升为一等会话的数据面：枚举投影、查看指针、session 路由分流。 */

async function makeStack(liveLookup?: LiveWorkerSessionLookup) {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-worker-sessions-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	await teams.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const workerSessionDir = path.join(dir, "worker-sessions");
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, sessions, teams, undefined, undefined, invoker, undefined, undefined, undefined, undefined,
		{ delegations, sessionDir: workerSessionDir, ...(liveLookup ? { liveLookup } : {}) });
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		activityStatePath: path.join(dir, "state", "room-activity.json"),
		sessionCreationStatePath: path.join(dir, "state", "session-creation-operations.json"),
		delegations,
		workerSessionDir,
	});
	return { app, teams, sessions, delegations, invoker, dir, workerSessionDir };
}

/** 造一个落盘的 worker 执行 session（user + assistant），返回 sessionHandle。 */
function makeWorkerSession(workerSessionDir: string, cwd: string, userText = "查一下数据", name?: string): string {
	const sm = SessionManager.create(cwd, workerSessionDir);
	sm.appendMessage({ role: "user", content: userText, timestamp: Date.now() } as never);
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
	if (name) sm.appendSessionInfo(name);
	return sm.getSessionId();
}

async function makeDirectWindow(app: ReturnType<typeof Fastify>, member = "alpha") {
	const res = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: [member] } });
	assert.equal(res.statusCode, 200, res.body);
	return res.json().room as RoomSummary;
}

async function soloSessionId(app: ReturnType<typeof Fastify>): Promise<string> {
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	return listed.json().rooms.find((room: { type: string }) => room.type === "solo").activeSession as string;
}

function addDelegation(
	stack: Awaited<ReturnType<typeof makeStack>>,
	input: { windowId: string; managerSessionId: string; sessionHandle: string; task?: string },
) {
	return stack.delegations.createDelegation({
		cwdSnapshot: stack.dir,
		windowId: input.windowId,
		managerSessionId: input.managerSessionId,
		agentId: "alpha",
		agentRevision: 0,
		operation: "run",
		sessionHandle: input.sessionHandle,
		...(input.task ? { task: input.task } : {}),
	});
}

test("P2 委派上下文不枚举为聊天，输入/管理/历史不可达，审计与文件保留", async () => {
	const stack = await makeStack();
	try {
		const room = await makeDirectWindow(stack.app);
		const manager = await soloSessionId(stack.app);
		const handle = makeWorkerSession(stack.workerSessionDir, stack.dir);
		const record = await addDelegation(stack, { windowId: room.id, managerSessionId: manager, sessionHandle: handle });
		const summary = await stack.app.inject({ method: "GET", url: `/api/rooms/${room.id}` });
		assert.deepEqual(summary.json().room.workerSessions, []);
		assert.equal(summary.json().room.activeWorkerView, null);
		for (const operation of [
			{ method: "GET" as const, url: `/api/sessions/${handle}/messages` },
			{ method: "PATCH" as const, url: `/api/rooms/${room.id}/sessions/${handle}`, payload: { name: "不得重命名" } },
			{ method: "DELETE" as const, url: `/api/rooms/${room.id}/sessions/${handle}` },
			{ method: "POST" as const, url: `/api/rooms/${room.id}/sessions/${handle}/activate` },
		]) {
			const result = await stack.app.inject(operation);
			assert.ok([400, 404, 410].includes(result.statusCode), result.body);
		}
		assert.deepEqual(await stack.delegations.getDelegation(record.id), record);
		assert.equal((await SessionManager.listAll(stack.workerSessionDir)).some(session => session.id === handle), true, "关闭聊天入口不删除执行事实");
	} finally { await stack.app.close(); await stack.sessions.disposeAll(); rmSync(stack.dir, { recursive: true, force: true }); }
});

test("P2 Worker 与 Manager 共用记录目录时也不能枚举、读取、改模型或删除执行文件", async () => {
	const stack = await makeStack();
	try {
		const room = await makeDirectWindow(stack.app); const manager = await soloSessionId(stack.app);
		const sharedDirectory = path.join(stack.dir, "sessions");
		const handle = makeWorkerSession(sharedDirectory, stack.dir);
		await addDelegation(stack, { windowId: room.id, managerSessionId: manager, sessionHandle: handle });
		const listed = await stack.app.inject({ method: "GET", url: "/api/sessions" });
		assert.equal(listed.json().sessions.some((session: { id: string }) => session.id === handle), false);
		for (const operation of [
			{ method: "GET" as const, url: `/api/sessions/${handle}/messages` },
			{ method: "GET" as const, url: `/api/sessions/${handle}/commands` },
			{ method: "POST" as const, url: `/api/sessions/${handle}/model`, payload: { model: "fixture/model" } },
			{ method: "DELETE" as const, url: `/api/sessions/${handle}` },
		]) {
			const result = await stack.app.inject(operation); assert.equal(result.statusCode, 410, result.body);
		}
		assert.equal((await SessionManager.listAll(sharedDirectory)).some(session => session.id === handle), true);
	} finally { await stack.app.close(); await stack.sessions.disposeAll(); rmSync(stack.dir, { recursive: true, force: true }); }
});

test("P1 HTTP: group 创建与编辑至少两位 Worker，Manager 保留原生工具且不首发", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "echo", runArgs: [] } });
		for (const members of [[], ["alpha"], ["alpha", "alpha"]]) {
			const denied = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members } });
			assert.equal(denied.statusCode, 400, denied.body);
			assert.match(denied.json().error, /至少需要 2 个/);
		}
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(created.statusCode, 200, created.body);
		const room = created.json().room as RoomSummary;
		assert.equal(room.type, "group"); assert.equal(room.members.length, 2);
		for (const members of [[], ["alpha"], ["alpha", "alpha"]]) {
			const updated = await app.inject({ method: "PATCH", url: `/api/rooms/${room.id}`, payload: { members } });
			assert.equal(updated.statusCode, 400, updated.body);
			assert.deepEqual((await teams.getWindow(room.id))!.members, ["alpha", "beta"]);
		}
		const manager = await sessions.open(room.activeSession);
		for (const name of ["read", "grep", "find", "ls", "edit", "write", "bash"]) assert.ok(manager.getActiveToolNames().includes(name));
		assert.equal(manager.messages.filter((entry) => entry.role === "user").length, 0, "creating a group does not execute a first task");
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});
