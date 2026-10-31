import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { UploadStore } from "../store/uploads.js";
import { registerRoomsRoutes, type RoomSummary } from "./rooms.js";
import { registerChatRoutes } from "./chat.js";

/** Delegated contexts cannot be used as ordinary chats; audit facts survive. */

async function makeStack(roomRunner?: { run: (input: { markInputDurable(): Promise<void>; prompt: string }) => Promise<{ status: "completed"; finalContent?: string }> }) {
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
	const uploads = new UploadStore(path.join(dir, "uploads"));
	await uploads.init();
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, sessions, teams, undefined, undefined, invoker, undefined, undefined, undefined, undefined,
		{ delegations });
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		attachmentRoot: path.join(dir, "uploads"),
		uploads,
		activityStatePath: path.join(dir, "state", "room-activity.json"),
		sessionCreationStatePath: path.join(dir, "state", "session-creation-operations.json"),
		roomSessionsStatePath: path.join(dir, "state", "room-sessions"),
		roomActivityStatePath: path.join(dir, "state", "room-session-activity.json"),
		roomRunner: roomRunner ?? { run: async (input) => { await input.markInputDurable(); return { status: "completed" as const, finalContent: "房间结论" }; } },
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
		const manager = await sessions.open((await teams.managerSession(room.id))!);
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

test("v4 HTTP: group Manager PS 不能经 Agent API 删除；单 RoomSession 整房删除可用", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(created.statusCode, 200, created.body);
		const room = created.json().room as RoomSummary;
		const manager = (await teams.managerSession(room.id))!;
		const roomSessionId = room.activeRoomSessionId!;
		assert.ok(await teams.participantSession(manager));

		const agentDelete = await app.inject({ method: "DELETE", url: `/api/sessions/${manager}` });
		assert.equal(agentDelete.statusCode, 409, agentDelete.body);
		for (const operation of [
			{ method: "POST" as const, url: `/api/sessions/${manager}/messages`, payload: { content: "绕过房间" } },
			{ method: "POST" as const, url: `/api/sessions/${manager}/abort` },
			{ method: "POST" as const, url: `/api/sessions/${manager}/queued-inputs/op-1`, payload: { action: "cancel" } },
		]) {
			const denied = await app.inject(operation);
			assert.equal(denied.statusCode, 409, denied.body);
			assert.equal(denied.json().code, "participant_session_managed");
		}
		assert.equal(agentDelete.json().code, "participant_session_managed");
		assert.ok(await teams.participantSession(manager), "Manager binding 必须保留");
		assert.equal((await teams.getWindow(room.id))?.activeRoomSessionId, roomSessionId);

		const roomDeleteByManager = await app.inject({ method: "DELETE", url: `/api/rooms/${room.id}/sessions/${manager}` });
		assert.equal(roomDeleteByManager.statusCode, 409, roomDeleteByManager.body);

		const wholeRoom = await app.inject({ method: "DELETE", url: `/api/rooms/${room.id}?onlySession=${roomSessionId}` });
		assert.equal(wholeRoom.statusCode, 204, wholeRoom.body);
		assert.equal(await teams.getWindow(room.id), undefined);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: group 建房写入 RoomSession 创建账本与空公共事件文件", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(created.statusCode, 200, created.body);
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		const root = path.join(dir, "state", "room-sessions", roomSessionId);
		assert.equal(existsSync(path.join(root, "events.jsonl")), true);
		const operations = JSON.parse(readFileSync(path.join(root, "operations.json"), "utf8")) as { creation: Record<string, { phase: string }> };
		assert.deepEqual(Object.values(operations.creation).map((item) => item.phase), ["attached"]);
		const manager = (await teams.managerSession(room.id))!;
		assert.equal((await teams.participantSession(manager))?.roomSessionId, roomSessionId);
		assert.equal((await teams.roomSession(roomSessionId))?.roomId, room.id);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: 最小 timeline 返回公共事件、Turn 与 Manager Participant", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
		assert.equal(timeline.statusCode, 200, timeline.body);
		const snapshot = timeline.json();
		assert.deepEqual(snapshot.events, []);
		assert.deepEqual(snapshot.turns, []);
		assert.equal(snapshot.managerParticipantSessionId, await teams.managerSession(room.id));
		assert.equal(snapshot.participants.length, 1);
		assert.equal(snapshot.participants[0].role, "manager");
		assert.equal(snapshot.lastEventSeq, 0);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: 房间公开消息准入、幂等与 final 投影", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		const missingKey = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`, payload: { content: "x" } });
		assert.equal(missingKey.statusCode, 428);

		const key = randomUUID();
		const first = await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`,
			headers: { "idempotency-key": key },
			payload: { content: "请检查", mentions: ["alpha"] },
		});
		assert.equal(first.statusCode, 202, first.body);
		const accepted = first.json() as { roomEventId: string; participantTurnId: string };
		assert.ok(accepted.roomEventId);
		assert.ok(accepted.participantTurnId);

		let events: Array<{ kind: string; content: string }> = [];
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
			events = timeline.json().events;
			if (events.length >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(events.length, 2, JSON.stringify(events));
		assert.equal(events[0]!.kind, "message");
		assert.equal(events[1]!.kind, "message");
		assert.equal(events[1]!.content, "房间结论");

		const replay = await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`,
			headers: { "idempotency-key": key },
			payload: { content: "请检查", mentions: ["alpha"] },
		});
		assert.equal(replay.statusCode, 202, replay.body);
		assert.equal(replay.json().roomEventId, accepted.roomEventId);
		assert.equal(replay.json().participantTurnId, accepted.participantTurnId);
		const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
		assert.equal(timeline.json().events.length, 2);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: reuseEmpty / 幂等新建 RoomSession 都建 events，首条消息不 500", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;

		const reuse = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions`, payload: { reuseEmpty: true } });
		assert.equal(reuse.statusCode, 200, reuse.body);
		const reuseRoomId = reuse.json().roomSessionId as string;
		assert.ok(reuseRoomId);
		assert.equal(existsSync(path.join(dir, "state", "room-sessions", reuseRoomId, "events.jsonl")), true);

		const idempotent = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions`, headers: { "idempotency-key": randomUUID() }, payload: {} });
		assert.equal(idempotent.statusCode, 200, idempotent.body);
		const idemRoomId = idempotent.json().roomSessionId as string;
		assert.ok(idemRoomId);
		assert.equal(existsSync(path.join(dir, "state", "room-sessions", idemRoomId, "events.jsonl")), true);

		const send = await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${reuseRoomId}/messages`,
			headers: { "idempotency-key": randomUUID() }, payload: { content: "首条", mentions: ["alpha"] },
		});
		assert.equal(send.statusCode, 202, send.body);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: abort 收敛当前公开回合；close-unknown 解除锁", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const { app, teams, sessions, dir } = await makeStack({
		run: async (input) => {
			await input.markInputDurable();
			await pending;
			return { status: "completed", finalContent: "太晚了" };
		},
	});
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		const sent = await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`,
			headers: { "idempotency-key": randomUUID() }, payload: { content: "慢慢做", mentions: ["alpha"] },
		});
		assert.equal(sent.statusCode, 202, sent.body);
		const aborted = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/abort` });
		assert.equal(aborted.statusCode, 200, aborted.body);
		const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
		assert.equal(timeline.json().turns[0].status, "cancelled");
		assert.equal(timeline.json().events.at(-1).kind, "terminal");
		release();
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: runner 未确认输入时 409，close-unknown 写 terminal", async () => {
	const { app, teams, sessions, dir } = await makeStack({
		run: async () => { throw new Error("provider down"); },
	});
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		const sent = await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`,
			headers: { "idempotency-key": randomUUID() }, payload: { content: "执行", mentions: ["alpha"] },
		});
		assert.equal(sent.statusCode, 409, sent.body);
		assert.equal(sent.json().code, "message_delivery_unconfirmed");
		const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
		const turn = timeline.json().turns[0];
		assert.equal(turn.status, "unknown");
		const closed = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/turns/${turn.id}/close-unknown`, payload: { reason: "确认无运行" } });
		assert.equal(closed.statusCode, 200, closed.body);
		const after = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
		assert.equal(after.json().turns[0].status, "interrupted_unknown");
		assert.equal(after.json().events.at(-1).kind, "terminal");
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: 房间消息附件冻结为引用并进入组合输入", async () => {
	const prompts: string[] = [];
	const { app, teams, sessions, dir } = await makeStack({
		run: async (input) => {
			prompts.push(input.prompt);
			await input.markInputDurable();
			return { status: "completed", finalContent: "收到了附件" };
		},
	});
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		const data = Buffer.from("hello attachment").toString("base64");
		const sent = await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`,
			headers: { "idempotency-key": randomUUID() },
			payload: {
				content: "看附件", mentions: ["alpha"],
				attachments: [{ filename: "note.txt", mediaType: "text/plain", data }],
			},
		});
		assert.equal(sent.statusCode, 202, sent.body);
		const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
		const userEvent = timeline.json().events[0];
		assert.equal(userEvent.attachments[0].name, "note.txt");
		assert.ok(userEvent.attachments[0].path.startsWith(path.join(dir, "uploads")));
		assert.match(prompts[0]!, /附件：note\.txt（text\/plain，sha256=/);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: RoomSession 摘要与改名，不写 Manager PS 的 sessionName", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		assert.equal(room.roomSessions?.length, 1);
		assert.equal(room.roomSessions![0]!.name, "新对话");
		const roomSessionId = room.roomSessionIds![0]!;
		const manager = (await teams.managerSession(room.id))!;
		const renamed = await app.inject({ method: "PATCH", url: `/api/rooms/${room.id}/sessions/${manager}`, payload: { name: "方案讨论" } });
		assert.equal(renamed.statusCode, 200, renamed.body);
		assert.equal(renamed.json().roomSessionId, roomSessionId);
		const listed = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions` });
		assert.equal(listed.json().roomSessions[0].name, "方案讨论");
		assert.equal(listed.json().activeRoomSessionId, roomSessionId);
		assert.equal((await teams.roomSession(roomSessionId))?.customName, "方案讨论");
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: 房间活动/未读投影与已读", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`,
			headers: { "idempotency-key": randomUUID() }, payload: { content: "请检查", mentions: ["alpha"] },
		});
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
			if (timeline.json().events.length >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		let activity = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/activity` });
		for (let attempt = 0; attempt < 50 && activity.json().entry?.revision !== 2; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			activity = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/activity` });
		}
		assert.equal(activity.statusCode, 200, activity.body);
		assert.equal(activity.json().hasUnreadActivity, true);
		assert.equal(activity.json().entry.revision, 2);
		const summary = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room as RoomSummary;
		assert.equal(summary.hasUnreadActivity, true);
		assert.equal(summary.activitySessionId, roomSessionId);
		assert.equal(summary.roomSessions![0]!.hasUnreadActivity, true);
		assert.equal((await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/read` })).statusCode, 200);
		assert.equal((await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/activity` })).json().hasUnreadActivity, false);
		assert.equal(((await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room as RoomSummary).hasUnreadActivity, false);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: 房间公开事件搜索", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const roomSessionId = room.roomSessionIds![0]!;
		await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/messages`,
			headers: { "idempotency-key": randomUUID() }, payload: { content: "请检查登录逻辑", mentions: ["alpha"] },
		});
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/timeline` });
			if (timeline.json().events.length >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const search = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/search?q=${encodeURIComponent("登录")}` });
		assert.equal(search.statusCode, 200, search.body);
		assert.equal(search.json().hits.length, 1);
		assert.match(search.json().hits[0].content, /登录/);
		const miss = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/search?q=none` });
		assert.equal(miss.json().hits.length, 0);
		const invalid = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${roomSessionId}/search` });
		assert.equal(invalid.statusCode, 400);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("v4 HTTP: 从 RoomSession fork 公共事件到新房间会话", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		const room = created.json().room as RoomSummary;
		const sourceId = room.roomSessionIds![0]!;
		await app.inject({
			method: "POST", url: `/api/rooms/${room.id}/sessions/${sourceId}/messages`,
			headers: { "idempotency-key": randomUUID() }, payload: { content: "原始问题", mentions: ["alpha"] },
		});
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const timeline = await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${sourceId}/timeline` });
			if (timeline.json().events.length >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const sourceTimeline = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${sourceId}/timeline` })).json();
		const forked = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions/${sourceId}/fork`, payload: { name: "分支讨论" } });
		assert.equal(forked.statusCode, 201, forked.body);
		const targetId = forked.json().roomSessionId as string;
		const targetTimeline = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${targetId}/timeline` })).json();
		assert.equal(targetTimeline.events.length, sourceTimeline.events.length);
		assert.deepEqual(targetTimeline.events.map((event: { content: string }) => event.content), sourceTimeline.events.map((event: { content: string }) => event.content));
		assert.notEqual(targetTimeline.events[0].id, sourceTimeline.events[0].id);
		const summary = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room as RoomSummary;
		assert.equal(summary.roomSessionIds!.length, 2);
		assert.equal(summary.activeRoomSessionId, targetId);
		assert.equal(summary.roomSessions!.find((item) => item.roomSessionId === targetId)?.name, "分支讨论");

		const cutoff = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions/${sourceId}/fork`, payload: { throughEventSeq: 1 } });
		assert.equal(cutoff.statusCode, 201, cutoff.body);
		const cutoffTimeline = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}/sessions/${cutoff.json().roomSessionId}/timeline` })).json();
		assert.equal(cutoffTimeline.events.length, 1);
	} finally { await app.close(); await sessions.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
});
