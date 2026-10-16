import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerRoomsRoutes, type RoomSummary } from "./rooms.js";
import { registerChatRoutes } from "./chat.js";

/** Delegated contexts cannot be used as ordinary chats; audit facts survive. */

async function makeStack() {
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
		{ delegations });
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		activityStatePath: path.join(dir, "state", "room-activity.json"),
		sessionCreationStatePath: path.join(dir, "state", "session-creation-operations.json"),
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
		assert.equal(Object.hasOwn(summary.json().room, "workerSessions"), false);
		assert.equal(Object.hasOwn(summary.json().room, "activeWorkerView"), false);
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

test("pinned solo 窗口的最后一个会话可删除：服务端补新空会话；普通窗口仍拒绝", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		const solo = await teams.ensureSoloWindow(
			(workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
			async () => true,
		);
		assert.equal(solo.pinned, true);
		assert.equal(solo.sessions.length, 1);
		const doomed = solo.activeSession;
		const res = await app.inject({ method: "DELETE", url: `/api/rooms/${solo.id}/sessions/${doomed}` });
		assert.equal(res.statusCode, 204, res.body);
		const after = await teams.getWindow(solo.id);
		assert.ok(after);
		assert.equal(after.sessions.length, 1, "窗口始终保留至少一个会话");
		assert.equal(after.sessions[0], after.activeSession);
		assert.notEqual(after.activeSession, doomed, "删除后激活的是补位的新会话");
		const listed = (await sessions.list()).map((item) => item.id);
		assert.ok(listed.includes(after.activeSession));
		assert.ok(!listed.includes(doomed));

		// 非 pinned 窗口的最后一个会话仍受保护（UI 引导删整个窗口）。
		const first = await sessions.create(undefined, { type: "direct", members: ["alpha"], cwd: dir });
		const window = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: first.id });
		const blocked = await app.inject({ method: "DELETE", url: `/api/rooms/${window.id}/sessions/${first.id}` });
		assert.equal(blocked.statusCode, 400, blocked.body);
		assert.match(blocked.json().error, /至少要保留一个会话/);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("parked 上下文里的归档会话可删除：活跃上下文不受影响，空 parked 上下文整体移除", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		const solo = await teams.ensureSoloWindow(
			(workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
			async () => true,
		);
		const doomedA = solo.activeSession;
		const doomedB = await sessions.create(undefined, { type: "solo", members: [], cwd: teams.defaultContextCwd() });
		await teams.addWindowSession(solo.id, doomedB.id);
		// 切到项目工作区：默认工作目录上下文（doomedA + doomedB）整体 park。
		const workspace = await teams.workspaces.createManaged("parked-delete");
		const project = await sessions.create(undefined, { type: "solo", members: [], workspaceId: workspace.id, cwd: workspace.canonicalPath });
		await teams.replaceWindowWorkspace(solo.id, workspace.id, project.id);
		const parked = await teams.getWindow(solo.id);
		assert.ok(parked);
		assert.deepEqual(parked.sessions, [project.id]);
		const parkedContext = Object.values(parked.parkedContexts).find((context) => context.sessions.includes(doomedA));
		assert.ok(parkedContext, "切换后原上下文应 parked");
		assert.ok(parkedContext.sessions.includes(doomedB.id));

		// 多会话 parked 上下文：只移除目标会话。
		const first = await app.inject({ method: "DELETE", url: `/api/rooms/${solo.id}/sessions/${doomedA}` });
		assert.equal(first.statusCode, 204, first.body);
		const middle = await teams.getWindow(solo.id);
		assert.ok(middle);
		assert.deepEqual(middle.sessions, [project.id], "活跃上下文不受影响");
		const remaining = Object.values(middle.parkedContexts).flatMap((context) => context.sessions);
		assert.deepEqual(remaining, [doomedB.id]);

		// parked 上下文的最后一个会话：整个上下文移除，窗口不受影响。
		const second = await app.inject({ method: "DELETE", url: `/api/rooms/${solo.id}/sessions/${doomedB.id}` });
		assert.equal(second.statusCode, 204, second.body);
		const after = await teams.getWindow(solo.id);
		assert.ok(after);
		assert.deepEqual(after.sessions, [project.id]);
		assert.equal(after.activeSession, project.id);
		assert.equal(Object.keys(after.parkedContexts).length, 0);
		const listed = (await sessions.list()).map((item) => item.id);
		assert.ok(!listed.includes(doomedA));
		assert.ok(!listed.includes(doomedB.id));
		assert.ok(listed.includes(project.id));
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});
