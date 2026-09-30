import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerRoomsRoutes, type RoomSummary } from "./rooms.js";
import { registerChatRoutes } from "./chat.js";
import { registerWorkspacesRoutes } from "./workspaces.js";
import { UploadStore } from "../store/uploads.js";

function roomSource(room: RoomSummary) {
	return { type: room.type, name: room.name, members: room.members.map((member) => member.name), prompt: room.prompt, workspaceId: room.workspace?.id ?? null, cwdSnapshot: room.cwdSnapshot };
}

async function makeStack(
	nativePicker?: (initialPath: string) => Promise<string | undefined>,
	fileOpener?: (targetPath: string) => Promise<void>,
	attachmentRoot?: string,
	withChat = false,
	existingDir?: string,
) {
	const dir = existingDir ?? mkdtempSync(path.join(tmpdir(), "pt-workspace-routes-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
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
	const app = Fastify({ logger: false });
	const uploads = withChat ? new UploadStore(path.join(dir, "uploads")) : undefined;
	if (withChat) {
		await uploads!.init();
		await app.register(websocket);
		await registerChatRoutes(app, sessions, teams, undefined, uploads, invoker);
	}
	registerWorkspacesRoutes(app, teams.workspaces, nativePicker);
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		open: fileOpener,
		attachmentRoot,
		uploads,
		activityStatePath: path.join(dir, "state", "room-activity.json"),
		sessionCreationStatePath: path.join(dir, "state", "session-creation-operations.json"),
	});
	return { app, teams, sessions, delegations, invoker, dir };
}

test("停用 Worker 不能经旧 direct 复用路径或新群聊绕过发起门禁", async () => {
	const { app, teams, sessions } = await makeStack();
	try {
		const first = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(first.statusCode, 200, first.body);
		const roomId = first.json().room.id as string;
		await teams.upsertAgent({ ...(await teams.getAgent("alpha"))!, enabled: false });
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		await teams.upsertAgent({ name: "gamma", description: "gamma", invoke: { type: "command", command: "gamma", runArgs: [] } });

		for (const payload of [
			{ type: "direct", members: ["alpha"] },
			{ type: "group", members: ["alpha", "beta"] },
		]) {
			const blocked = await app.inject({ method: "POST", url: "/api/rooms", headers: payload.type === "group" ? { "idempotency-key": randomUUID() } : {}, payload });
			assert.equal(blocked.statusCode, 409, blocked.body);
			assert.equal(blocked.json().code, "worker_disabled");
		}
		const history = await app.inject({ method: "GET", url: `/api/rooms/${roomId}` });
		assert.equal(history.statusCode, 200, history.body);
		assert.equal(history.json().room.id, roomId);
		const targetPath = mkdtempSync(path.join(tmpdir(), "pt-disabled-switch-"));
		const workspace = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: targetPath } });
		assert.equal(workspace.statusCode, 200, workspace.body);
		const blockedSwitch = await app.inject({
			method: "POST", url: `/api/rooms/${roomId}/switch-workspace`,
			payload: { workspaceId: workspace.json().workspace.id, source: roomSource(first.json().room) },
		});
		assert.equal(blockedSwitch.statusCode, 409, blockedSwitch.body);
		assert.equal(blockedSwitch.json().code, "worker_disabled");
		const group = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["beta", "gamma"] } });
		assert.equal(group.statusCode, 200, group.body);
		const groupId = group.json().room.id as string;
		const blockedPatch = await app.inject({ method: "PATCH", url: `/api/rooms/${groupId}`, payload: { members: ["alpha", "beta", "gamma"] } });
		assert.equal(blockedPatch.statusCode, 409, blockedPatch.body);
		assert.equal(blockedPatch.json().code, "worker_disabled");
		const unchanged = await app.inject({ method: "GET", url: `/api/rooms/${groupId}` });
		assert.deepEqual(unchanged.json().room.members.map((member: { name: string }) => member.name).sort(), ["beta", "gamma"]);

		await teams.upsertAgent({ ...(await teams.getAgent("alpha"))!, enabled: true });
		const reused = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(reused.statusCode, 200, reused.body);
		assert.equal(reused.json().room.id, roomId);
		assert.equal(reused.json().existed, true);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("建房前 Worker 或 Workspace 失效返回可刷新选择的错误码", async () => {
	const { app, sessions } = await makeStack();
	try {
		const missingWorker = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["removed-worker"] } });
		assert.equal(missingWorker.statusCode, 400, missingWorker.body);
		assert.equal(missingWorker.json().code, "worker_unavailable");
		const root = mkdtempSync(path.join(tmpdir(), "pt-stale-room-workspace-"));
		const created = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
		assert.equal(created.statusCode, 200, created.body);
		const workspaceId = created.json().workspace.id as string;
		renameSync(root, `${root}-moved`);
		const staleWorkspace = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"], workspaceId } });
		assert.equal(staleWorkspace.statusCode, 400, staleWorkspace.body);
		assert.equal(staleWorkspace.json().code, "workspace_unavailable");
		const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
		assert.equal(listed.statusCode, 200, listed.body);
		assert.equal(listed.json().workspaces.find((item: { id: string }) => item.id === workspaceId)?.available, false);
		const rooms = await app.inject({ method: "GET", url: "/api/rooms" });
		assert.equal(rooms.json().rooms.filter((room: { type: string }) => room.type !== "solo").length, 0);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Workspace 在预检后失效时 direct/group 均返回可刷新错误且不留下 Session", async () => {
	const { app, teams, sessions } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const original = teams.contextForWorkspace.bind(teams);
		const beforeSessions = (await sessions.list()).map((session) => session.id).sort();
		for (const type of ["direct", "group"] as const) {
			const root = mkdtempSync(path.join(tmpdir(), `pt-workspace-race-${type}-`));
			const workspace = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
			assert.equal(workspace.statusCode, 200, workspace.body);
			let checks = 0;
			teams.contextForWorkspace = async (id) => {
				checks += 1;
				if (checks === 2) renameSync(root, `${root}-moved`);
				return original(id);
			};
			const failed = await app.inject({
				method: "POST", url: "/api/rooms",
				...(type === "group" ? { headers: { "idempotency-key": randomUUID() } } : {}),
				payload: { type, members: type === "group" ? ["alpha", "beta"] : ["alpha"], workspaceId: workspace.json().workspace.id },
			});
			teams.contextForWorkspace = original;
			assert.equal(checks, 2);
			assert.equal(failed.statusCode, 400, failed.body);
			assert.equal(failed.json().code, "workspace_unavailable");
			assert.equal((await teams.listWindows()).filter((room) => room.type !== "solo").length, 0);
			assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSessions);
		}
		const source = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(source.statusCode, 200, source.body);
		const switchRoot = mkdtempSync(path.join(tmpdir(), "pt-workspace-race-switch-"));
		const target = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: switchRoot } });
		assert.equal(target.statusCode, 200, target.body);
		const beforeSwitchSessions = (await sessions.list()).map((session) => session.id).sort();
		let switchChecks = 0;
		teams.contextForWorkspace = async (id) => {
			switchChecks += 1;
			if (switchChecks === 2) renameSync(switchRoot, `${switchRoot}-moved`);
			return original(id);
		};
		const switched = await app.inject({ method: "POST", url: `/api/rooms/${source.json().room.id}/switch-workspace`, headers: { "idempotency-key": randomUUID() }, payload: { workspaceId: target.json().workspace.id, mode: "new_window", source: roomSource(source.json().room) } });
		teams.contextForWorkspace = original;
		assert.equal(switchChecks, 2);
		assert.equal(switched.statusCode, 400, switched.body);
		assert.equal(switched.json().code, "workspace_unavailable");
		assert.equal((await teams.listWindows()).filter((room) => room.type === "group").length, 1);
		assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSwitchSessions);
	} finally { await sessions.disposeAll(); await app.close(); }
});

test("群聊创建同键同意图跨并发与冷启动只保留一个 Room/Session", async () => {
	const first = await makeStack();
	const key = "11111111-1111-4111-8111-111111111111";
	try {
		await first.teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const missingKey = await first.app.inject({ method: "POST", url: "/api/rooms", payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(missingKey.statusCode, 400, missingKey.body);
		assert.equal(missingKey.json().code, "room_operation_invalid");
		const send = (members = ["alpha", "beta"], name = "") => first.app.inject({
			method: "POST", url: "/api/rooms", headers: { "idempotency-key": key },
			payload: { type: "group", members, name },
		});
		const [created, simultaneous] = await Promise.all([send(), send(["beta", "alpha"])]);
		assert.equal(created.statusCode, 200, created.body);
		assert.equal(simultaneous.statusCode, 200, simultaneous.body);
		assert.equal(created.json().room.id, simultaneous.json().room.id);
		assert.deepEqual([created.json().existed, simultaneous.json().existed].sort(), [false, true]);
		const changed = await send(["alpha", "beta"], "第二个意图");
		assert.equal(changed.statusCode, 409, changed.body);
		assert.equal(changed.json().code, "room_operation_conflict");
		const beforeRestart = await first.app.inject({ method: "GET", url: "/api/rooms" });
		assert.equal(beforeRestart.json().rooms.filter((room: { type: string }) => room.type === "group").length, 1);
	} finally { await first.sessions.disposeAll(); await first.app.close(); }
	const restarted = await makeStack(undefined, undefined, undefined, false, first.dir);
	try {
		const replay = await restarted.app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": key }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().existed, true);
		const rooms = await restarted.app.inject({ method: "GET", url: "/api/rooms" });
		const groups = rooms.json().rooms.filter((room: { type: string }) => room.type === "group");
		assert.equal(groups.length, 1);
		assert.equal(groups[0].id, replay.json().room.id);
		assert.equal(groups[0].sessions.length, 1);
		const removed = await restarted.app.inject({ method: "DELETE", url: `/api/rooms/${groups[0].id}` });
		assert.equal(removed.statusCode, 204, removed.body);
		const deletedReplay = await restarted.app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": key }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(deletedReplay.statusCode, 409, deletedReplay.body);
		assert.equal(deletedReplay.json().code, "room_operation_gone");
		const newIntent = await restarted.app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": "22222222-2222-4222-8222-222222222222" }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(newIntent.statusCode, 200, newIntent.body);
		assert.notEqual(newIntent.json().room.id, groups[0].id);
	} finally { await restarted.sessions.disposeAll(); await restarted.app.close(); }
	const afterDeletionRestart = await makeStack(undefined, undefined, undefined, false, first.dir);
	try {
		const stale = await afterDeletionRestart.app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": key }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(stale.statusCode, 409, stale.body);
		assert.equal(stale.json().code, "room_operation_gone");
	} finally { await afterDeletionRestart.sessions.disposeAll(); await afterDeletionRestart.app.close(); }
});

test("群聊跨项目新开同键回放只保留一个目标 Room/Session", async () => {
	const first = await makeStack();
	const key = "33333333-3333-4333-8333-333333333333";
	let sourceId = "";
	let targetWorkspaceId = "";
	let targetRoomId = "";
	let sourceIdentity: ReturnType<typeof roomSource>;
	try {
		await first.teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const source = await first.app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(source.statusCode, 200, source.body);
		sourceId = source.json().room.id;
		sourceIdentity = roomSource(source.json().room);
		targetWorkspaceId = (await first.teams.workspaces.createManaged("目标项目")).id;
		const url = `/api/rooms/${sourceId}/switch-workspace`;
		const payload = { workspaceId: targetWorkspaceId, mode: "new_window", source: sourceIdentity };
		const missingKey = await first.app.inject({ method: "POST", url, payload });
		assert.equal(missingKey.statusCode, 400, missingKey.body);
		assert.equal(missingKey.json().code, "room_operation_invalid");
		const send = (operationId = key, target: string | null = targetWorkspaceId) => first.app.inject({ method: "POST", url, headers: { "idempotency-key": operationId }, payload: { workspaceId: target, mode: "new_window", source: sourceIdentity } });
		const [created, concurrent] = await Promise.all([send(), send()]);
		assert.equal(created.statusCode, 200, created.body);
		assert.equal(concurrent.statusCode, 200, concurrent.body);
		assert.equal(created.json().room.id, concurrent.json().room.id);
		assert.deepEqual([created.json().existed, concurrent.json().existed].sort(), [false, true]);
		targetRoomId = created.json().room.id;
		const conflict = await send(key, null);
		assert.equal(conflict.statusCode, 409, conflict.body);
		assert.equal(conflict.json().code, "room_operation_conflict");
		assert.equal((await first.teams.listWindows()).filter((room) => room.type === "group").length, 2);
	} finally { await first.sessions.disposeAll(); await first.app.close(); }
	const restarted = await makeStack(undefined, undefined, undefined, false, first.dir);
	try {
		const replay = await restarted.app.inject({ method: "POST", url: `/api/rooms/${sourceId}/switch-workspace`, headers: { "idempotency-key": key }, payload: { workspaceId: targetWorkspaceId, mode: "new_window", source: sourceIdentity } });
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().room.id, targetRoomId);
		assert.equal(replay.json().existed, true);
		assert.equal(replay.json().room.sessions.length, 1);
		const removed = await restarted.app.inject({ method: "DELETE", url: `/api/rooms/${targetRoomId}` });
		assert.equal(removed.statusCode, 204, removed.body);
		const gone = await restarted.app.inject({ method: "POST", url: `/api/rooms/${sourceId}/switch-workspace`, headers: { "idempotency-key": key }, payload: { workspaceId: targetWorkspaceId, mode: "new_window", source: sourceIdentity } });
		assert.equal(gone.statusCode, 409, gone.body);
		assert.equal(gone.json().code, "room_operation_gone");
	} finally { await restarted.sessions.disposeAll(); await restarted.app.close(); }
});

test("跨项目发起拒绝过期来源快照，写入排队期间来源变化也不创建目标", async () => {
	const { app, teams, sessions } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const created = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(created.statusCode, 200, created.body);
		const source = created.json().room as RoomSummary;
		const target = await teams.workspaces.createManaged("目标项目");
		const sourceIdentity = roomSource(source);
		const beforeSessions = (await sessions.list()).map((session) => session.id).sort();
		await teams.updateWindow(source.id, { name: "后来改名" });
		const stale = await app.inject({ method: "POST", url: `/api/rooms/${source.id}/switch-workspace`, headers: { "idempotency-key": randomUUID() }, payload: { workspaceId: target.id, source: sourceIdentity } });
		assert.equal(stale.statusCode, 409, stale.body);
		assert.equal(stale.json().code, "room_source_changed");

		const fresh = await app.inject({ method: "GET", url: `/api/rooms/${source.id}` });
		const originalCreate = teams.createWindow.bind(teams);
		teams.createWindow = async (opts) => {
			teams.createWindow = originalCreate;
			await teams.updateWindow(source.id, { name: "排队期间再改名" });
			return originalCreate(opts);
		};
		const raced = await app.inject({ method: "POST", url: `/api/rooms/${source.id}/switch-workspace`, headers: { "idempotency-key": randomUUID() }, payload: { workspaceId: target.id, source: roomSource(fresh.json().room) } });
		assert.equal(raced.statusCode, 409, raced.body);
		assert.equal(raced.json().code, "room_source_changed");
		assert.equal((await teams.listWindows()).filter((room) => room.type === "group").length, 1);
		assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSessions);
	} finally { await sessions.disposeAll(); await app.close(); }
});

test("跨项目 direct 来源在写入排队期间删除，不能打开旧目标或创建 Session", async () => {
	const { app, teams, sessions } = await makeStack();
	try {
		const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(created.statusCode, 200, created.body);
		const source = created.json().room as RoomSummary;
		const target = await teams.workspaces.createManaged("目标项目");
		const beforeSessions = (await sessions.list()).map((session) => session.id).sort();
		const originalEnsure = teams.ensureDirectWindow.bind(teams);
		teams.ensureDirectWindow = async (member, workspaceId, createSession, opts) => {
			teams.ensureDirectWindow = originalEnsure;
			await teams.removeWindow(source.id);
			return originalEnsure(member, workspaceId, createSession, opts);
		};
		const raced = await app.inject({ method: "POST", url: `/api/rooms/${source.id}/switch-workspace`, payload: { workspaceId: target.id, source: roomSource(source) } });
		assert.equal(raced.statusCode, 404, raced.body);
		assert.equal(raced.json().code, "room_source_unavailable");
		assert.equal((await teams.listWindows()).filter((room) => room.type === "direct").length, 0);
		assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSessions);
	} finally { await sessions.disposeAll(); await app.close(); }
});

test("发起校验后停用 Worker：写入队列复核并且不创建孤立 Session", async () => {
	const { app, teams, sessions } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const first = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(first.statusCode, 200, first.body);
		const directId = first.json().room.id as string;
		const originalListAgents = teams.listAgents.bind(teams);
		const disableAfterSnapshot = () => {
			teams.listAgents = async () => {
				const snapshot = await originalListAgents();
				teams.listAgents = originalListAgents;
				await teams.upsertAgent({ ...(await teams.getAgent("alpha"))!, enabled: false });
				return snapshot;
			};
		};

		disableAfterSnapshot();
		const reused = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(reused.statusCode, 409, reused.body);
		assert.equal(reused.json().code, "worker_disabled");
		assert.equal((await teams.getWindow(directId))?.id, directId);

		await teams.upsertAgent({ ...(await teams.getAgent("alpha"))!, enabled: true });
		const beforeRooms = (await teams.listWindows()).map((room) => room.id).sort();
		const beforeSessions = (await sessions.list()).map((session) => session.id).sort();
		disableAfterSnapshot();
		const group = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(group.statusCode, 409, group.body);
		assert.equal(group.json().code, "worker_disabled");
		assert.deepEqual((await teams.listWindows()).map((room) => room.id).sort(), beforeRooms);
		assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSessions);

		await teams.upsertAgent({ ...(await teams.getAgent("alpha"))!, enabled: true });
		const targetPath = mkdtempSync(path.join(tmpdir(), "pt-disabled-race-switch-"));
		const workspace = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: targetPath } });
		assert.equal(workspace.statusCode, 200, workspace.body);
		disableAfterSnapshot();
		const switched = await app.inject({
			method: "POST", url: `/api/rooms/${directId}/switch-workspace`,
			payload: { workspaceId: workspace.json().workspace.id, source: roomSource(first.json().room) },
		});
		assert.equal(switched.statusCode, 409, switched.body);
		assert.equal(switched.json().code, "worker_disabled");
		assert.deepEqual((await teams.listWindows()).map((room) => room.id).sort(), beforeRooms);
		assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSessions);

		await teams.upsertAgent({ ...(await teams.getAgent("alpha"))!, enabled: true });
		const originalAfterSwitch = teams.listAgents.bind(teams);
		teams.listAgents = async () => {
			const snapshot = await originalAfterSwitch();
			teams.listAgents = originalAfterSwitch;
			await teams.removeAgent("beta");
			return snapshot;
		};
		const removedMember = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(removedMember.statusCode, 400, removedMember.body);
		assert.equal(removedMember.json().code, "worker_unavailable");
		assert.deepEqual((await teams.listWindows()).map((room) => room.id).sort(), beforeRooms);
		assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSessions);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("房间写入在提交前失败时清理新 Session；提交结果不确定时保留供重启回读", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	try {
		await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const internals = teams as unknown as {
			writeJsonFile: (file: string, data: unknown) => Promise<void>;
			windowsFile: string;
			persistenceUncertain: boolean;
		};
		const writeJsonFile = internals.writeJsonFile.bind(teams);
		const beforeSessions = (await sessions.list()).map((session) => session.id).sort();
		for (const payload of [
			{ type: "direct", members: ["alpha"] },
			{ type: "group", members: ["alpha", "beta"] },
		]) {
			internals.writeJsonFile = async (file, data) => {
				if (file === internals.windowsFile) {
					internals.writeJsonFile = writeJsonFile;
					throw new Error("injected pre-rename failure");
				}
				return writeJsonFile(file, data);
			};
			const failed = await app.inject({ method: "POST", url: "/api/rooms", headers: payload.type === "group" ? { "idempotency-key": randomUUID() } : {}, payload });
			assert.equal(failed.statusCode, 400, failed.body);
			assert.match(failed.json().error, /injected pre-rename failure/);
			assert.equal((await teams.listWindows()).length, 0);
			assert.deepEqual((await sessions.list()).map((session) => session.id).sort(), beforeSessions);
		}

		internals.writeJsonFile = async (file, data) => {
			await writeJsonFile(file, data);
			if (file === internals.windowsFile) {
				internals.writeJsonFile = writeJsonFile;
				internals.persistenceUncertain = true;
				throw new Error("injected post-rename sync failure");
			}
		};
		const uncertain = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(uncertain.statusCode, 409, uncertain.body);
		assert.equal(uncertain.json().code, "room_creation_uncertain");
		const persisted = JSON.parse(readFileSync(path.join(dir, "teams", "windows.json"), "utf8")) as { windows: Record<string, { activeSession: string }> };
		const persistedSessionId = Object.values(persisted.windows)[0]?.activeSession;
		assert.ok(persistedSessionId, "rename 后已落盘的窗口必须可回读");
		assert.ok((await sessions.list()).some((session) => session.id === persistedSessionId), "不确定提交不得删除窗口引用的 Session");
		const uncertainGroup = await app.inject({ method: "POST", url: "/api/rooms", headers: { "idempotency-key": randomUUID() }, payload: { type: "group", members: ["alpha", "beta"] } });
		assert.equal(uncertainGroup.statusCode, 409, uncertainGroup.body);
		assert.equal(uncertainGroup.json().code, "room_creation_uncertain");
		const restarted = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
		await restarted.init();
		assert.equal((await restarted.listWindows())[0]?.activeSession, persistedSessionId, "冷启动回读必须保留已提交窗口的 Session 引用");
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("房间写入与 Session 清理同时失败时明确返回服务端恢复错误", async () => {
	const { app, teams, sessions } = await makeStack();
	try {
		const internals = teams as unknown as { writeJsonFile: (file: string, data: unknown) => Promise<void>; windowsFile: string };
		const writeJsonFile = internals.writeJsonFile.bind(teams);
		internals.writeJsonFile = async (file, data) => {
			if (file === internals.windowsFile) throw new Error("injected window write failure");
			return writeJsonFile(file, data);
		};
		const remove = sessions.remove.bind(sessions);
		sessions.remove = async () => { throw new Error("injected Session cleanup failure"); };
		const failed = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		sessions.remove = remove;
		assert.equal(failed.statusCode, 500, failed.body);
		assert.equal(failed.json().code, "room_session_cleanup_failed");
		assert.equal((await teams.listWindows()).length, 0);
		assert.equal((await sessions.list()).length, 1, "清理失败的 Session 必须显式留下待恢复证据");
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("消息附件从房间 cwd 解析并仅打开允许目录内的文件", async () => {
	const opened: string[] = [];
	const attachmentRoot = mkdtempSync(path.join(tmpdir(), "pt-upload-file-"));
	const { app, sessions, dir } = await makeStack(
		undefined,
		async (targetPath) => {
			opened.push(targetPath);
		},
		attachmentRoot,
	);
	const created = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "direct", members: ["alpha"] },
	});
	const roomId = created.json().room.id as string;
	const activeSession = created.json().room.activeSession as string;
	const localFile = path.join(dir, "add.py");
	writeFileSync(localFile, "print('ok')\n");

	const openedResponse = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: "add.py" },
	});
	assert.equal(openedResponse.statusCode, 200, openedResponse.body);
	assert.deepEqual(opened, [realpathSync(localFile)]);
	const localDirectory = path.join(dir, "reports");
	mkdirSync(localDirectory);
	const openedDirectoryResponse = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: "reports" },
	});
	assert.equal(openedDirectoryResponse.statusCode, 200, openedDirectoryResponse.body);
	assert.deepEqual(opened, [realpathSync(localFile), realpathSync(localDirectory)]);
	const activeAttachmentDir = path.join(attachmentRoot, activeSession);
	mkdirSync(activeAttachmentDir);
	const uploadedFile = path.join(activeAttachmentDir, "frozen.pdf");
	writeFileSync(uploadedFile, "pdf\n");
	const uploadedResponse = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: uploadedFile },
	});
	assert.equal(uploadedResponse.statusCode, 200, uploadedResponse.body);
	assert.deepEqual(opened, [realpathSync(localFile), realpathSync(localDirectory), realpathSync(uploadedFile)]);

	const nextSession = await app.inject({ method: "POST", url: `/api/rooms/${roomId}/sessions`, payload: {} });
	assert.equal(nextSession.statusCode, 200, nextSession.body);
	const historicalRejected = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: uploadedFile },
	});
	assert.equal(historicalRejected.statusCode, 400, historicalRejected.body);

	const outsideDir = mkdtempSync(path.join(tmpdir(), "pt-outside-file-"));
	const outsideFile = path.join(outsideDir, "secret.txt");
	writeFileSync(outsideFile, "secret\n");
	const rejected = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: outsideFile },
	});
	assert.equal(rejected.statusCode, 400, rejected.body);
	assert.deepEqual(opened, [realpathSync(localFile), realpathSync(localDirectory), realpathSync(uploadedFile)]);

	await sessions.disposeAll();
	await app.close();
});

test("未选择 Workspace 时保持默认 cwd，且与显式项目的 direct Session 隔离", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const createWithoutWorkspace = () =>
		app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
	const first = await createWithoutWorkspace();
	assert.equal(first.statusCode, 200, first.body);
	assert.equal(first.json().room.workspace, null);
	assert.equal(first.json().existed, false);
	const windowId = first.json().room.id as string;
	assert.equal((await teams.getWindow(windowId))?.workspaceId, undefined);
	assert.equal(await teams.workspaceFor(windowId), realpathSync(dir));

	const again = await createWithoutWorkspace();
	assert.equal(again.statusCode, 200, again.body);
	assert.equal(again.json().room.id, windowId);
	assert.equal(again.json().existed, true);

	const project = await teams.workspaces.createManaged("A");
	const explicit = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "direct", members: ["alpha"], workspaceId: project.id },
	});
	assert.equal(explicit.statusCode, 200, explicit.body);
	assert.notEqual(explicit.json().room.id, windowId);
	assert.equal(explicit.json().room.workspace.id, project.id);

	await sessions.disposeAll();
	await app.close();
});

test("产品验收冻结: 首启未落盘的 solo Session 不会被连续房间读取换号", async () => {
	const { app, sessions } = await makeStack();
	const first = await app.inject({ method: "GET", url: "/api/rooms" });
	assert.equal(first.statusCode, 200, first.body);
	const firstSolo = first.json().rooms.find((room: { type: string }) => room.type === "solo") as { activeSession: string };
	assert.ok(sessions.isOpen(firstSolo.activeSession));

	const second = await app.inject({ method: "GET", url: "/api/rooms" });
	assert.equal(second.statusCode, 200, second.body);
	const secondSolo = second.json().rooms.find((room: { type: string }) => room.type === "solo") as { activeSession: string };
	assert.equal(secondSolo.activeSession, firstSolo.activeSession);
	await sessions.disposeAll();
	await app.close();
});

test("窗口内 Session 可重命名，且只接受所属 Session 与非空名称", async () => {
	const { app, sessions } = await makeStack();
	const created = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "direct", members: ["alpha"] },
	});
	assert.equal(created.statusCode, 200, created.body);
	const room = created.json().room as { id: string; activeSession: string };

	const renamed = await app.inject({
		method: "PATCH",
		url: `/api/rooms/${room.id}/sessions/${room.activeSession}`,
		payload: { name: "新的会话名称" },
	});
	assert.equal(renamed.statusCode, 200, renamed.body);
	assert.equal(renamed.json().session.name, "新的会话名称");

	const fetched = await app.inject({ method: "GET", url: `/api/rooms/${room.id}` });
	assert.equal(fetched.json().room.sessions[0].name, "新的会话名称");

	const empty = await app.inject({
		method: "PATCH",
		url: `/api/rooms/${room.id}/sessions/${room.activeSession}`,
		payload: { name: "   " },
	});
	assert.equal(empty.statusCode, 400);

	const outsider = await app.inject({
		method: "PATCH",
		url: `/api/rooms/${room.id}/sessions/not-owned`,
		payload: { name: "x" },
	});
	assert.equal(outsider.statusCode, 404);

	await sessions.disposeAll();
	await app.close();
});

test("项目目录浏览只返回可进入的服务端文件夹", async () => {
	const { app, sessions, dir } = await makeStack();
	mkdirSync(path.join(dir, "project-a"));
	writeFileSync(path.join(dir, "not-a-folder.txt"), "x");
	const response = await app.inject({
		method: "GET",
		url: `/api/workspaces/browse?path=${encodeURIComponent(dir)}`,
	});
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(response.json().path, realpathSync(dir));
	assert.deepEqual(
		response.json().directories.filter((entry: { name: string }) => entry.name === "project-a"),
		[{ name: "project-a", path: path.join(realpathSync(dir), "project-a") }],
	);
	assert.equal(response.json().directories.some((entry: { name: string }) => entry.name === "not-a-folder.txt"), false);
	await sessions.disposeAll();
	await app.close();
});

test("系统目录选择 API 回传原生选择结果，取消不报错", async () => {
	const selectedDir = mkdtempSync(path.join(tmpdir(), "pt-native-selected-"));
	const selectedStack = await makeStack(async () => selectedDir);
	const selected = await selectedStack.app.inject({
		method: "POST",
		url: "/api/workspaces/pick-directory",
		payload: { initialPath: selectedStack.dir },
	});
	assert.equal(selected.statusCode, 200, selected.body);
	assert.deepEqual(selected.json(), { path: realpathSync(selectedDir), cancelled: false });
	await selectedStack.sessions.disposeAll();
	await selectedStack.app.close();

	const cancelledStack = await makeStack(async () => undefined);
	const cancelled = await cancelledStack.app.inject({
		method: "POST",
		url: "/api/workspaces/pick-directory",
		payload: { initialPath: cancelledStack.dir },
	});
	assert.equal(cancelled.statusCode, 200, cancelled.body);
	assert.deepEqual(cancelled.json(), { cancelled: true });
	await cancelledStack.sessions.disposeAll();
	await cancelledStack.app.close();
});

test("历史 cwd 失效不阻断启动，且只有可读目录才标记为可用", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
	assert.equal(created.statusCode, 200, created.body);
	const roomId = created.json().room.id as string;
	await sessions.disposeAll();
	await app.close();

	const moved = `${dir}-moved`;
	renameSync(dir, moved);
	writeFileSync(dir, "not a directory");
	const restarted = new TeamsStore({ state: path.join(moved, "teams"), assets: path.join(moved, "teams"), managedWorkspaces: path.join(moved, "managed") }, moved);
	await restarted.init();
	const restartedSessions = new PiSessionStore(moved, path.join(moved, "sessions"), restarted);
	const restartedApp = Fastify({ logger: false });
	registerRoomsRoutes(restartedApp, restartedSessions, restarted);
	const rooms = await restartedApp.inject({ method: "GET", url: "/api/rooms" });
	assert.equal(rooms.statusCode, 200, rooms.body);
	assert.equal(rooms.json().rooms.find((room: { id: string }) => room.id === roomId).contextAvailable, false);
	await restartedSessions.disposeAll();
	await restartedApp.close();
});

test("P3-1 API: 项目创建/最近列表与 direct Window 按 (worker, workspaceId) 隔离", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const projectA = mkdtempSync(path.join(tmpdir(), "pt-route-a-"));
	const projectB = mkdtempSync(path.join(tmpdir(), "pt-route-b-"));
	const create = async (root: string) => {
		const res = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
		assert.equal(res.statusCode, 200, res.body);
		return res.json().workspace as { id: string; canonicalPath: string };
	};
	const a = await create(projectA);
	const b = await create(projectB);
	assert.equal(a.canonicalPath, realpathSync(projectA));

	const room = async (workspaceId: string) => {
		const res = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"], workspaceId } });
		assert.equal(res.statusCode, 200, res.body);
		return res.json() as { room: RoomSummary; existed: boolean };
	};
	const firstA = await room(a.id);
	const againA = await room(a.id);
	const firstB = await room(b.id);
	assert.equal(againA.room.id, firstA.room.id);
	assert.equal(againA.existed, true);
	assert.notEqual(firstB.room.id, firstA.room.id, "同一 worker 在不同项目必须得到不同 Window/manager Session");

	const switched = await app.inject({
		method: "POST",
		url: `/api/rooms/${firstA.room.id}/switch-workspace`,
		payload: { workspaceId: b.id, source: roomSource(firstA.room) },
	});
	assert.equal(switched.statusCode, 200, switched.body);
	assert.equal(switched.json().room.id, firstB.room.id, "默认切换应打开已有的项目窗口，不污染原窗口");
	assert.equal(switched.json().existed, true);
	await sessions.ensureSessionFile(firstA.room.activeSession);
	const directInPlace = await app.inject({
		method: "POST",
		url: `/api/rooms/${firstA.room.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(directInPlace.statusCode, 400, directInPlace.body);
	assert.equal((await teams.getWindow(firstA.room.id))?.workspaceId, a.id);
	const directInfo = (await sessions.list()).find((session) => session.id === firstA.room.activeSession);
	assert.ok(directInfo && existsSync(directInfo.sessionFile), "拒绝 direct 原地切换不得删除原 JSONL");

	await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
	const groupCreated = await app.inject({
		method: "POST",
		url: "/api/rooms",
		headers: { "idempotency-key": randomUUID() },
		payload: { type: "group", members: ["alpha", "beta"], workspaceId: a.id },
	});
	assert.equal(groupCreated.statusCode, 200, groupCreated.body);
	const group = groupCreated.json().room as { id: string; activeSession: string };
	await sessions.ensureSessionFile(group.activeSession);
	const groupInPlace = await app.inject({
		method: "POST",
		url: `/api/rooms/${group.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(groupInPlace.statusCode, 400, groupInPlace.body);
	assert.equal((await teams.getWindow(group.id))?.workspaceId, a.id);
	const groupInfo = (await sessions.list()).find((session) => session.id === group.activeSession);
	assert.ok(groupInfo && existsSync(groupInfo.sessionFile), "拒绝 group 原地切换不得删除原 JSONL");

	const list = await app.inject({ method: "GET", url: "/api/workspaces" });
	assert.equal(list.statusCode, 200);
	assert.ok(list.json().workspaces.length >= 2);
	await sessions.disposeAll();
	await app.close();
	void dir;
});

test("P3-1 API: solo 切换项目会恢复该项目 Session，并可恢复未选项目", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const a = await teams.workspaces.createManaged("A");
	const b = await teams.workspaces.createManaged("B");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };

	const enteredA = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	assert.equal(enteredA.statusCode, 200, enteredA.body);
	assert.equal(enteredA.json().restored, false);
	const sessionA = enteredA.json().room.activeSession as string;

	const enteredB = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(enteredB.statusCode, 200, enteredB.body);
	assert.notEqual(enteredB.json().room.activeSession, sessionA);
	const persistedA = (await sessions.list()).find((session) => session.id === sessionA);
	assert.ok(persistedA && existsSync(persistedA.sessionFile), "切走项目不得删除原 Session JSONL");
	assert.equal((await teams.contextForSession(sessionA))?.active, false, "切走后原 Session 必须进入停驻上下文");

	const restoredA = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	assert.equal(restoredA.statusCode, 200, restoredA.body);
	assert.equal(restoredA.json().restored, true);
	assert.equal(restoredA.json().room.activeSession, sessionA);

	const detached = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: null, mode: "in_place" },
	});
	assert.equal(detached.statusCode, 200, detached.body);
	const plain = detached.json().room as { workspace: null; cwdSnapshot: string; activeSession: string };
	assert.equal(plain.workspace, null);
	assert.equal(plain.cwdSnapshot, realpathSync(dir));
	assert.equal(plain.activeSession, solo.activeSession);
	await sessions.disposeAll();
	await app.close();
});

test("M1 全局搜索索引包含停放项目的 Manager 工作，排除空容器与孤立 Session", async () => {
	const first = await makeStack();
	const { app, teams, sessions, dir } = first;
	try {
		const a = await teams.workspaces.createManaged("搜索项目 A");
		const b = await teams.workspaces.createManaged("搜索项目 B");
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const work = async (workspaceId: string, content: string) => {
			const switched = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/switch-workspace`, payload: { workspaceId, mode: "in_place" } });
			assert.equal(switched.statusCode, 200, switched.body);
			const id = switched.json().room.activeSession as string;
			(await sessions.open(id)).sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: content }], timestamp: Date.now() } as never);
			return id;
		};
		const sessionA = await work(a.id, "项目 A 的旧工作");
		await sessions.rename(sessionA, "发布核对");
		const sessionB = await work(b.id, "项目 B 的当前工作");
		const orphan = await sessions.create();
		(await sessions.open(orphan.id)).sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "不属于任何房间" }], timestamp: Date.now() } as never);
		const indexed = await app.inject({ method: "GET", url: `/api/rooms/${solo.id}/work-index` });
		assert.equal(indexed.statusCode, 200, indexed.body);
		assert.deepEqual(indexed.json().works.map((item: { sessionId: string }) => item.sessionId).sort(), [sessionA, sessionB].sort());
		assert.deepEqual(indexed.json().works.map((item: { workspaceName: string }) => item.workspaceName).sort(), [a.name, b.name].sort());
		assert.equal(indexed.json().works.find((item: { sessionId: string }) => item.sessionId === sessionA).active, false);
		assert.equal(indexed.json().works.find((item: { sessionId: string }) => item.sessionId === sessionA).firstMessage, "项目 A 的旧工作");
		assert.equal(indexed.json().works.find((item: { sessionId: string }) => item.sessionId === sessionB).active, true);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
	const restarted = await makeStack(undefined, undefined, undefined, false, dir);
	try {
		const indexed = await restarted.app.inject({ method: "GET", url: "/api/rooms/solo/work-index" });
		assert.equal(indexed.statusCode, 200, indexed.body);
		assert.deepEqual(indexed.json().works.map((item: { title: string }) => item.title).sort(), ["发布核对", "项目 B 的当前工作"].sort());
		assert.equal(indexed.json().works.find((item: { title: string }) => item.title === "发布核对").firstMessage, "项目 A 的旧工作");
	} finally {
		await restarted.sessions.disposeAll();
		await restarted.app.close();
	}
});

test("M1 全局搜索索引可在首个 rooms 请求前初始化 solo 且不创建工作", async () => {
	const { app, sessions } = await makeStack();
	try {
		const indexed = await app.inject({ method: "GET", url: "/api/rooms/solo/work-index" });
		assert.equal(indexed.statusCode, 200, indexed.body);
		assert.deepEqual(indexed.json().works, []);
		const listed = await app.inject({ method: "GET", url: "/api/rooms" });
		assert.equal(listed.statusCode, 200, listed.body);
		assert.equal(listed.json().rooms.filter((room: { type: string }) => room.type === "solo").length, 1);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("solo 恢复在提交前校验目标 JSONL cwd，损坏时保留当前项目", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const a = await teams.workspaces.createManaged("guard-A");
	const b = await teams.workspaces.createManaged("guard-B");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string };
	const enteredA = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	const sessionA = enteredA.json().room.activeSession as string;
	const enteredB = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(enteredB.statusCode, 200, enteredB.body);
	const sessionB = enteredB.json().room.activeSession as string;
	const infoA = (await sessions.list()).find((session) => session.id === sessionA)!;
	await sessions.open(sessionA);
	assert.equal(sessions.isOpen(sessionA), true, "测试必须覆盖驻留缓存不能绕过 JSONL 强校验");
	const lines = readFileSync(infoA.sessionFile, "utf8").trimEnd().split("\n");
	const header = JSON.parse(lines[0]!) as { cwd: string };
	header.cwd = realpathSync(dir);
	lines[0] = JSON.stringify(header);
	writeFileSync(infoA.sessionFile, `${lines.join("\n")}\n`, "utf8");

	const rejected = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	assert.equal(rejected.statusCode, 400, rejected.body);
	assert.match(rejected.body, /Session cwd does not match its Window context/);
	const current = (await teams.getWindow(solo.id))!;
	assert.equal(current.workspaceId, b.id, "校验失败不得先提交目标上下文");
	assert.equal(current.activeSession, sessionB);
	assert.equal((await teams.contextForSession(sessionA))?.active, false);
	await sessions.disposeAll();
	await app.close();
});

test("solo 切换与消息接纳共享生命周期闸，提交后旧 Session 无法再次接纳", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("barrier-target");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	let markEntered!: () => void;
	const entered = new Promise<void>((resolve) => { markEntered = resolve; });
	let admitted = false;
	const admission = invoker.withActiveSessionLifecycle(solo.activeSession, async () => {
		markEntered();
		await hold;
		admitted = true;
	});
	await entered;
	let switched = false;
	const switching = app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: workspace.id, mode: "in_place" },
	}).then((response) => {
		switched = true;
		return response;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(switched, false, "切换必须等待已进入闸门的消息完成接纳");
	release();
	await admission;
	const response = await switching;
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(admitted, true);
	await assert.rejects(
		() => invoker.withActiveSessionLifecycle(solo.activeSession, async () => undefined),
		/所属项目未激活/,
		"切换提交后旧 Session 不得重新进入消息接纳闸门",
	);
	await sessions.disposeAll();
	await app.close();
});

test("solo 切换在 parking 准备失败时清理新 Session，并保持源 context active", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("prepare-failure");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let createdId: string | undefined;
	let removedId: string | undefined;
	await assert.rejects(
		() => invoker.switchWorkspaceInPlace(
			solo.id,
			workspace.id,
			async (source, cwd) => {
				const created = await sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd });
				createdId = created.id;
				return created;
			},
			async () => { throw new Error("prepare failed"); },
			(id) => sessions.validateStoredContext(id),
			(id) => sessions.suspend(id),
			async (id) => { removedId = id; return sessions.remove(id); },
		),
		/prepare failed/,
	);
	assert.ok(createdId);
	assert.equal(removedId, createdId, "create 之后任一提交前失败都必须清理 orphan Session");
	assert.equal(sessions.isOpen(createdId!), false);
	const current = (await teams.getWindow(solo.id))!;
	assert.equal(current.workspaceId, undefined);
	assert.equal(current.activeSession, solo.activeSession);
	assert.equal((await teams.contextForSession(solo.activeSession))?.active, true);
	await sessions.disposeAll();
	await app.close();
});

test("内部 triggerTurn 投递输掉切换竞态后只写 parked 审计，不唤醒旧 Session", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("internal-delivery-race");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let continueCreate!: () => void;
	let markSwitchInsideGate!: () => void;
	const createHold = new Promise<void>((resolve) => { continueCreate = resolve; });
	const switchInsideGate = new Promise<void>((resolve) => { markSwitchInsideGate = resolve; });
	const switching = invoker.switchWorkspaceInPlace(
		solo.id,
		workspace.id,
		async (source, cwd) => {
			const created = await sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd });
			markSwitchInsideGate();
			await createHold;
			return created;
		},
		(id) => sessions.prepareForParking(id),
		(id) => sessions.validateStoredContext(id),
		(id) => sessions.suspend(id),
		(id) => sessions.remove(id),
	);
	await switchInsideGate;
	const delivery = sessions.sendCustomMessage(
		solo.activeSession,
		{ customType: "pudding:race_audit", content: "切换后的迟到终态" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	continueCreate();
	const switched = await switching;
	assert.equal(switched.window.workspaceId, workspace.id);
	await delivery;
	assert.equal((await teams.contextForSession(solo.activeSession))?.active, false);
	assert.equal(sessions.isOpen(solo.activeSession), false, "迟到审计写完必须卸载 parked Session");
	const oldInfo = (await sessions.list()).find((session) => session.id === solo.activeSession)!;
	assert.match(readFileSync(oldInfo.sessionFile, "utf8"), /pudding:race_audit/);
	await sessions.disposeAll();
	await app.close();
});

test("durable triggerTurn 输掉切换竞态时不消费真实 eventId，等待项目恢复后重试", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("durable-delivery-race");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let continueCreate!: () => void;
	let markSwitchInsideGate!: () => void;
	const createHold = new Promise<void>((resolve) => { continueCreate = resolve; });
	const switchInsideGate = new Promise<void>((resolve) => { markSwitchInsideGate = resolve; });
	const switching = invoker.switchWorkspaceInPlace(
		solo.id,
		workspace.id,
		async (source, cwd) => {
			const created = await sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd });
			markSwitchInsideGate();
			await createHold;
			return created;
		},
		(id) => sessions.prepareForParking(id),
		(id) => sessions.validateStoredContext(id),
		(id) => sessions.suspend(id),
		(id) => sessions.remove(id),
	);
	await switchInsideGate;
	const delivery = sessions.appendCustomMessageIfAbsent(
		solo.activeSession,
		"durable-race",
		{ customType: "pudding:goal_recovery", content: "恢复执行" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	continueCreate();
	await switching;
	assert.equal(await delivery, "deferred");
	const oldInfo = (await sessions.list()).find((session) => session.id === solo.activeSession)!;
	const persisted = readFileSync(oldInfo.sessionFile, "utf8");
	assert.match(persisted, /durable-race:deferred-audit/);
	assert.doesNotMatch(persisted, /"eventId":"durable-race"/,
		"审计记录不得占用真实 eventId，否则恢复项目后无法重试唤醒");
	assert.equal(sessions.isOpen(solo.activeSession), false);
	await sessions.disposeAll();
	await app.close();
});

test("durable triggerTurn 只在入队边界持有 Window 生命周期锁", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { activeSession: string };
	const session = await sessions.open(solo.activeSession);
	let markStarted!: () => void;
	let finishTurn!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const heldTurn = new Promise<void>((resolve) => { finishTurn = resolve; });
	const originalSend = session.sendCustomMessage.bind(session);
	session.sendCustomMessage = async () => {
		markStarted();
		await heldTurn;
	};

	const delivery = sessions.appendCustomMessageIfAbsent(
		solo.activeSession,
		"durable-long-turn",
		{ customType: "pudding:goal_recovery", content: "恢复执行" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	await started;
	const lifecycleProbe = invoker.withActiveSessionLifecycle(solo.activeSession, async () => "available");
	const probeResult = await Promise.race([
		lifecycleProbe,
		new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
	]);
	assert.equal(probeResult, "available", "模型回合运行期间读取/切换所需的 Window 生命周期锁必须已经释放");

	finishTurn();
	assert.equal(await delivery, "delivered");
	session.sendCustomMessage = originalSend;
	await sessions.disposeAll();
	await app.close();
});

test("P3-1 API: solo 原地切换会取消由 solo 路由到 direct 的 Delegation", async () => {
	const { app, teams, sessions, delegations } = await makeStack();
	const b = await teams.workspaces.createManaged("B");
	const solo = await teams.ensureSoloWindow(
		async () => sessions.create(undefined, { type: "solo", members: [] }),
		async () => false,
	);
	const sourceCwd = await teams.workspaceFor(solo.id);
	const directSession = await sessions.create(undefined, { type: "direct", members: ["alpha"], cwd: sourceCwd });
	const direct = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: directSession.id });
	const delegation = await delegations.createDelegation({
		windowId: direct.id,
		cwdSnapshot: sourceCwd,
		managerSessionId: solo.activeSession,
		agentId: "alpha",
		agentRevision: (await teams.getAgent("alpha"))?.extensionRevision ?? 0,
		operation: "run",
	});
	await delegations.transitionDelegation(delegation.id, ["admitted"], { executionState: "running" });

	const switched = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(switched.statusCode, 200, switched.body);
	assert.equal((await delegations.getDelegation(delegation.id))?.executionState, "observation_lost");
	await sessions.disposeAll();
	await app.close();
});

test("房间列表由跨 Session 持久业务活动排序，改名与模型元数据不置顶", async () => {
	const { app, sessions, dir } = await makeStack();
	try {
		const initial = await app.inject({ method: "GET", url: "/api/rooms" });
		assert.equal(initial.statusCode, 200);
		const solo = initial.json().rooms.find((room: { type: string }) => room.type === "solo");
		const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(created.statusCode, 200, created.body);
		const direct = created.json().room;
		const files = new Map((await sessions.list()).map((session) => [session.id, session.sessionFile]));
		const append = (sessionId: string, id: string, secondsAhead: number, type: string, content: string) => {
			appendFileSync(files.get(sessionId)!, `${JSON.stringify({
				type: "custom_message", id, parentId: null,
				timestamp: new Date(Date.now() + secondsAhead * 1000).toISOString(),
				customType: type, content, display: true,
			})}\n`);
		};
		append(solo.activeSession, "solo-user", 10, "pudding:user_message", "Manager 新消息");
		let listed = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms;
		assert.equal(listed[0].id, solo.id);
		append(direct.activeSession, "direct-result", 20, "pudding:task_result", "Worker 已完成");
		listed = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms;
		assert.equal(listed[0].id, direct.id);
		assert.equal(listed[0].activitySessionId, direct.activeSession);
		assert.equal(listed[0].lastMessagePreview, "Worker 已完成");
		assert.ok(existsSync(path.join(dir, "state", "room-activity.json")));
		assert.ok(listed[0].activityRevision > 0);
		append(solo.activeSession, "solo-title", 30, "pudding:late_audit", "内部审计");
		listed = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms;
		assert.equal(listed[0].id, direct.id);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("历史活动深链只允许激活所属房间 Session", async () => {
	const { app, sessions } = await makeStack();
	try {
		const soloList = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = soloList.json().rooms.find((room: { type: string }) => room.type === "solo");
		const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		const direct = created.json().room as { id: string; activeSession: string };
		const olderSession = direct.activeSession;
		const next = await app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions`, payload: {} });
		assert.equal(next.statusCode, 200, next.body);
		assert.notEqual(next.json().session.id, olderSession);
		const activated = await app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${olderSession}/activate` });
		assert.equal(activated.statusCode, 200, activated.body);
		const current = await app.inject({ method: "GET", url: `/api/rooms/${direct.id}` });
		assert.equal(current.json().room.activeSession, olderSession);
		const foreign = await app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${solo.activeSession}/activate` });
		assert.equal(foreign.statusCode, 400);
		const unchanged = await app.inject({ method: "GET", url: `/api/rooms/${direct.id}` });
		assert.equal(unchanged.json().room.activeSession, olderSession);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("已读水位只确认客户端呈现的修订，新后台进展仍保持未读且不改变排序", async () => {
	const { app, sessions } = await makeStack();
	try {
		const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		const room = created.json().room as { id: string; activeSession: string };
		const file = (await sessions.list()).find((session) => session.id === room.activeSession)!.sessionFile;
		const append = (id: string, offset: number) => appendFileSync(file, `${JSON.stringify({
			type: "custom_message", id, parentId: null,
			timestamp: new Date(Date.now() + offset * 1000).toISOString(),
			customType: "pudding:task_result", content: id, display: true,
		})}\n`);
		append("first", 1);
		const initial = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room;
		assert.equal(initial.hasUnreadActivity, true);
		append("second", 2);
		const newer = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room;
		assert.equal(newer.activityRevision, initial.activityRevision + 1);
		const staleRead = await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/read-watermark`, payload: { sessionId: room.activeSession, activityRevision: initial.activityRevision } });
		assert.equal(staleRead.statusCode, 200, staleRead.body);
		assert.equal(staleRead.json().hasUnreadActivity, true);
		const afterStale = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms;
		const current = afterStale.find((item: { id: string }) => item.id === room.id);
		assert.equal(current.readRevision, initial.activityRevision);
		assert.equal(current.hasUnreadActivity, true);
		assert.equal(afterStale[0].id, room.id);
		const latestRead = await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/read-watermark`, payload: { sessionId: room.activeSession, activityRevision: newer.activityRevision } });
		assert.equal(latestRead.json().hasUnreadActivity, false);
		assert.equal((await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms[0].id, room.id);
		append("late-third", 0);
		const delayed = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room;
		assert.equal(delayed.activityRevision, newer.activityRevision + 1);
		assert.equal(delayed.lastActivityAt, newer.lastActivityAt, "迟到进展不能让房间活动时间倒退");
		assert.equal(delayed.lastMessagePreview, "late-third", "未读预览应指向刚落盘的进展");
		assert.equal(delayed.hasUnreadActivity, true);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("房间列表不把用户回答与审批处理当成新未读，随后 Worker 结果仍提示", async () => {
	const { app, sessions } = await makeStack();
	try {
		const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		assert.equal(created.statusCode, 200, created.body);
		const room = created.json().room as { id: string; activeSession: string };
		const file = (await sessions.list()).find((session) => session.id === room.activeSession)!.sessionFile;
		const append = (id: string, offset: number, customType: string, content: string) => appendFileSync(file, `${JSON.stringify({
			type: "custom_message", id, parentId: null,
			timestamp: new Date(Date.now() + offset * 1000).toISOString(), customType, content, display: true,
		})}\n`);
		append("request", 1, "pudding:interaction_required", "请确认");
		const initial = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room;
		const read = await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/read-watermark`, payload: { sessionId: room.activeSession, activityRevision: initial.activityRevision } });
		assert.equal(read.statusCode, 200, read.body);
		append("answer", 2, "pudding:decision_answered", "用户已回答");
		append("approved", 3, "pudding:interaction_resolved", "用户已批准");
		const afterOwnAction = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((item: { id: string }) => item.id === room.id);
		assert.equal(afterOwnAction.lastMessagePreview, "用户已批准");
		assert.equal(afterOwnAction.activityRevision, initial.activityRevision + 1);
		assert.equal(afterOwnAction.hasUnreadActivity, false);
		append("worker-result", 4, "pudding:task_result", "Worker 已完成");
		const afterWorker = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((item: { id: string }) => item.id === room.id);
		assert.equal(afterWorker.hasUnreadActivity, true);
		assert.equal(afterWorker.lastMessagePreview, "Worker 已完成");
		assert.equal(afterWorker.activitySessionId, room.activeSession);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("已读确认只清目标 Session，房间列表继续定位另一个未读历史会话", async () => {
	const { app, sessions } = await makeStack();
	try {
		const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		const room = created.json().room as { id: string; activeSession: string };
		const olderSession = room.activeSession;
		const newer = await app.inject({ method: "POST", url: `/api/rooms/${room.id}/sessions`, payload: {} });
		assert.equal(newer.statusCode, 200, newer.body);
		const newerSession = newer.json().session.id as string;
		const files = new Map((await sessions.list()).map((session) => [session.id, session.sessionFile]));
		const append = (sessionId: string, id: string, secondsAhead: number) => appendFileSync(files.get(sessionId)!, `${JSON.stringify({
			type: "custom_message", id, parentId: null, timestamp: new Date(Date.now() + secondsAhead * 1000).toISOString(),
			customType: "pudding:task_result", content: id, display: true,
		})}\n`);
		append(olderSession, "old-progress", 10);
		append(newerSession, "new-progress", 20);
		const initial = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room;
		assert.equal(initial.activitySessionId, newerSession);
		const wrong = await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/read-watermark`, payload: { sessionId: "foreign", activityRevision: initial.activityRevision } });
		assert.equal(wrong.statusCode, 400);
		const readNewer = await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/read-watermark`, payload: { sessionId: newerSession, activityRevision: initial.activityRevision } });
		assert.equal(readNewer.statusCode, 200, readNewer.body);
		assert.equal(readNewer.json().hasUnreadActivity, true);
		const remaining = (await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).json().room;
		assert.equal(remaining.activitySessionId, olderSession);
		assert.equal(remaining.lastMessagePreview, "old-progress");
		const readOlder = await app.inject({ method: "PUT", url: `/api/rooms/${room.id}/read-watermark`, payload: { sessionId: olderSession, activityRevision: initial.activityRevision } });
		assert.equal(readOlder.json().hasUnreadActivity, false);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("新工作 Session 创建按操作键幂等，优先复用空 solo 容器", async () => {
	const { app, sessions, teams } = await makeStack();
	try {
		const listed = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
		const first = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions`, headers: { "idempotency-key": "new-work-0001" }, payload: {} });
		assert.equal(first.statusCode, 200, first.body);
		assert.equal(first.json().session.id, solo.activeSession, "无业务内容的初始容器应复用");
		const replay = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions`, headers: { "idempotency-key": "new-work-0001" }, payload: {} });
		assert.equal(replay.json().session.id, first.json().session.id);
		const second = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions`, headers: { "idempotency-key": "new-work-0002" }, payload: {} });
		assert.equal(second.statusCode, 200, second.body);
		assert.notEqual(second.json().session.id, first.json().session.id, "不同操作不能共享同一初始 Session");
		assert.equal((await teams.windowSessionList(solo.id)).sessions.length, 2);
		const sameKeyOtherRoom = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		const conflict = await app.inject({ method: "POST", url: `/api/rooms/${sameKeyOtherRoom.json().room.id}/sessions`, headers: { "idempotency-key": "new-work-0001" }, payload: {} });
		assert.equal(conflict.statusCode, 409);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("新工作在 Session 创建或房间挂载后中断，重启同键补齐同一个 Session", async (t) => {
	for (const stage of ["before_attach", "after_attach"] as const) {
		await t.test(stage, async () => {
			const first = await makeStack();
			let roomId = "";
			let reservedId = "";
			const operationKey = `recovery-${stage}-0001`;
			try {
				const listed = await first.app.inject({ method: "GET", url: "/api/rooms" });
				const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
				roomId = solo.id as string;
				const seed = await first.app.inject({ method: "POST", url: `/api/rooms/${roomId}/sessions`, headers: { "idempotency-key": "recovery-seed-0001" }, payload: {} });
				assert.equal(seed.statusCode, 200, seed.body);
				const originalAttach = first.teams.addWindowSession.bind(first.teams);
				first.teams.addWindowSession = async (windowId, sessionId) => {
					if (sessionId.startsWith("work-")) {
						if (stage === "after_attach") await originalAttach(windowId, sessionId);
						throw new Error(`injected ${stage} interruption`);
					}
					await originalAttach(windowId, sessionId);
				};
				const interrupted = await first.app.inject({ method: "POST", url: `/api/rooms/${roomId}/sessions`, headers: { "idempotency-key": operationKey }, payload: {} });
				assert.equal(interrupted.statusCode, 409, interrupted.body);
				const ledger = JSON.parse(readFileSync(path.join(first.dir, "state", "session-creation-operations.json"), "utf8")) as Record<string, { sessionId: string; phase: string }>;
				reservedId = ledger[operationKey]!.sessionId;
				assert.equal(ledger[operationKey]!.phase, "reserved");
				assert.ok((await first.sessions.list()).some((item) => item.id === reservedId), "created Session must remain available for repair");
				assert.equal(Boolean(await first.teams.windowForSession(reservedId)), stage === "after_attach");
			} finally {
				await first.sessions.disposeAll();
				await first.app.close();
			}
			const restarted = await makeStack(undefined, undefined, undefined, false, first.dir);
			try {
				const retry = () => restarted.app.inject({ method: "POST", url: `/api/rooms/${roomId}/sessions`, headers: { "idempotency-key": operationKey }, payload: {} });
				const recovered = await retry();
				assert.equal(recovered.statusCode, 200, recovered.body);
				assert.equal(recovered.json().session.id, reservedId);
				assert.equal((await retry()).json().session.id, reservedId);
				const windowSessions = await restarted.teams.windowSessionList(roomId);
				assert.equal(windowSessions.sessions.filter((id) => id === reservedId).length, 1);
				assert.equal((await restarted.sessions.list()).filter((item) => item.id === reservedId).length, 1);
				const ledger = JSON.parse(readFileSync(path.join(first.dir, "state", "session-creation-operations.json"), "utf8")) as Record<string, { phase: string }>;
				assert.equal(ledger[operationKey]!.phase, "attached");
			} finally {
				await restarted.sessions.disposeAll();
				await restarted.app.close();
			}
		});
	}
});

test("新工作不会复用已有内存消息但尚未投影到 JSONL 的 solo Session", async () => {
	const { app, sessions, teams } = await makeStack();
	try {
		const listed = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
		const resident = await sessions.open(solo.activeSession);
		resident.state.messages.push({ role: "user", content: [{ type: "text", text: "已存在但尚未落盘" }], timestamp: Date.now() } as never);
		const created = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions`, headers: { "idempotency-key": "memory-work-0001" }, payload: {} });
		assert.equal(created.statusCode, 200, created.body);
		assert.notEqual(created.json().session.id, solo.activeSession);
		assert.equal((await teams.windowSessionList(solo.id)).sessions.length, 2);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 深链定位可识别停放项目且拒绝其他房间 Session", async () => {
	const { app, sessions } = await makeStack();
	try {
		const initial = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = initial.json().rooms.find((room: { type: string }) => room.type === "solo");
		const secondSession = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions`, payload: {} });
		assert.equal(secondSession.statusCode, 200, secondSession.body);
		const root = mkdtempSync(path.join(tmpdir(), "pt-link-workspace-"));
		const created = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
		const workspaceId = created.json().workspace.id as string;
		const switched = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/switch-workspace`, payload: { workspaceId, mode: "in_place" } });
		assert.equal(switched.statusCode, 200, switched.body);
		const parked = await app.inject({ method: "GET", url: `/api/rooms/${solo.id}/sessions/${solo.activeSession}/location` });
		assert.deepEqual(parked.json(), { roomId: solo.id, sessionId: solo.activeSession, workspaceId: null, active: false });
		const currentId = switched.json().room.activeSession as string;
		const staleActivation = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions/${solo.activeSession}/activate` });
		assert.equal(staleActivation.statusCode, 400, staleActivation.body);
		assert.equal((await app.inject({ method: "GET", url: `/api/rooms/${solo.id}` })).json().room.activeSession, currentId);
		const current = await app.inject({ method: "GET", url: `/api/rooms/${solo.id}/sessions/${currentId}/location` });
		assert.deepEqual(current.json(), { roomId: solo.id, sessionId: currentId, workspaceId, active: true });
		const direct = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
		const foreign = await app.inject({ method: "GET", url: `/api/rooms/${solo.id}/sessions/${direct.json().room.activeSession}/location` });
		assert.equal(foreign.statusCode, 404);
		const missing = await app.inject({ method: "GET", url: `/api/rooms/${solo.id}/sessions/missing/location` });
		assert.equal(missing.statusCode, 404);
		const restored = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/switch-workspace`, payload: { workspaceId: null, mode: "in_place" } });
		assert.equal(restored.statusCode, 200, restored.body);
		assert.ok(restored.json().room.sessions.some((session: { id: string }) => session.id === solo.activeSession));
		assert.equal(restored.json().room.activeSession, secondSession.json().session.id);
		const activated = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions/${solo.activeSession}/activate` });
		assert.equal(activated.statusCode, 200, activated.body);
		assert.equal((await app.inject({ method: "GET", url: `/api/rooms/${solo.id}` })).json().room.activeSession, solo.activeSession);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 新工作首次发送失败后重试复用 Session 且内容冲突被拒绝", async () => {
	const { app, sessions, teams } = await makeStack(undefined, undefined, undefined, true);
	sessions.hasModelAuth = async () => false;
	try {
		const listed = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
		const send = (content: string) => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`,
			headers: { "idempotency-key": "new-work-send-0001" }, payload: { content, workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const [first, replay] = await Promise.all([send("检查这个项目"), send("检查这个项目")]);
		assert.equal(first.statusCode, 400, first.body);
		assert.equal(replay.statusCode, 400, replay.body);
		assert.match(first.body, /请先为 Manager 配置模型/);
		assert.equal(first.json().sessionId, replay.json().sessionId);
		assert.equal((await teams.windowSessionList(solo.id)).sessions.length, 1);
		const conflict = await send("不同的工作");
		assert.equal(conflict.statusCode, 409);
		assert.equal((await teams.windowSessionList(solo.id)).sessions.length, 1);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发选择模型写入预留 Session，同键改模型或省略模型均冲突", async () => {
	const { app, sessions, teams } = await makeStack(undefined, undefined, undefined, true);
	sessions.hasModelAuth = async () => false;
	try {
		const models = await sessions.listModels();
		assert.ok(models.length > 1, "测试需要两个可解析的模型");
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const send = (modelRef?: string) => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`,
			headers: { "idempotency-key": "new-work-model-0001" },
			payload: { content: "检查选定模型", modelRef, workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const first = await send(models[0]!.id);
		assert.equal(first.statusCode, 400, first.body);
		const sessionId = first.json().sessionId as string;
		const session = await sessions.open(sessionId);
		assert.equal(`${session.model?.provider}/${session.model?.id}`, models[0]!.id);
		const replay = await send(models[0]!.id);
		assert.equal(replay.statusCode, 400, replay.body);
		assert.equal(replay.json().sessionId, sessionId);
		const changed = await send(models[1]!.id);
		assert.equal(changed.statusCode, 409, changed.body);
		const omitted = await send();
		assert.equal(omitted.statusCode, 409, omitted.body);
		assert.equal((await teams.windowSessionList(solo.id)).sessions.length, 1);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发失败后若预约 Session 被写入另一条用户消息，同键重试不能假报原文已发送", async () => {
	const { app, sessions } = await makeStack(undefined, undefined, undefined, true);
	sessions.hasModelAuth = async () => false;
	try {
		const listed = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`,
			headers: { "idempotency-key": "work-other-user-message-0001" },
			payload: { content: "原工作内容", workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const first = await send();
		assert.equal(first.statusCode, 400, first.body);
		const session = await sessions.open(first.json().sessionId as string);
		const different = { role: "user", content: [{ type: "text", text: "另一条消息" }], timestamp: Date.now() };
		session.sessionManager.appendMessage(different as never);
		session.state.messages.push(different as never);
		const replay = await send();
		assert.equal(replay.statusCode, 409, replay.body);
		assert.equal(replay.json().code, "first_message_conflict");
		assert.equal(replay.json().sessionId, session.sessionId);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发预约的 Session 被删除后，同键重试不得创建替代 Session", async () => {
	const { app, sessions, teams } = await makeStack(undefined, undefined, undefined, true);
	sessions.hasModelAuth = async () => false;
	try {
		const listed = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`,
			headers: { "idempotency-key": "work-deleted-session-0001" },
			payload: { content: "原工作", workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const first = await send();
		assert.equal(first.statusCode, 400, first.body);
		const reservedId = first.json().sessionId as string;
		const other = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/sessions`, payload: {} });
		assert.equal(other.statusCode, 200, other.body);
		const removed = await app.inject({ method: "DELETE", url: `/api/rooms/${solo.id}/sessions/${reservedId}` });
		assert.equal(removed.statusCode, 204, removed.body);
		const beforeRetry = await teams.windowSessionList(solo.id);
		const retry = await send();
		assert.equal(retry.statusCode, 409, retry.body);
		assert.equal(retry.json().code, "session_creation_deleted");
		assert.equal(retry.json().sessionId, reservedId);
		assert.deepEqual(await teams.windowSessionList(solo.id), beforeRetry);
		assert.equal((await teams.windowSessionList(solo.id)).sessions.includes(reservedId), false);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 切换项目后拒绝旧项目草稿，且不创建新 Session", async () => {
	const { app, sessions, teams } = await makeStack(undefined, undefined, undefined, true);
	try {
		const listed = await app.inject({ method: "GET", url: "/api/rooms" });
		const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
		const root = mkdtempSync(path.join(tmpdir(), "pt-stale-workspace-"));
		const created = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
		assert.equal(created.statusCode, 200, created.body);
		const switched = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/switch-workspace`, payload: { workspaceId: created.json().workspace.id, mode: "in_place" } });
		assert.equal(switched.statusCode, 200, switched.body);
		const before = await teams.windowSessionList(solo.id);
		const stale = await app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`,
			headers: { "idempotency-key": "stale-project-work-0001" },
			payload: { content: "只属于旧项目的草稿", workspaceId: null, cwdSnapshot: solo.cwdSnapshot },
		});
		assert.equal(stale.statusCode, 409, stale.body);
		assert.equal(stale.json().code, "workspace_context_changed");
		assert.deepEqual(await teams.windowSessionList(solo.id), before);
		const missing = await app.inject({ method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "missing-project-work-0001" }, payload: { content: "没有项目身份" } });
		assert.equal(missing.statusCode, 400, missing.body);
		assert.deepEqual(await teams.windowSessionList(solo.id), before);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发响应丢失后重启重试，仍只有一条用户意图", async () => {
	const first = await makeStack(undefined, undefined, undefined, true);
	const content = "检查这个项目的交付边界";
	const attachments = [
		{ filename: "../需求.md", mediaType: "text/markdown", data: Buffer.from("先确认验收门槛").toString("base64") },
		{ filename: "证据.txt", mediaType: "text/plain", data: Buffer.from("second attachment").toString("base64") },
	];
	const key = "response-lost-work-0001";
	const modelRef = (await first.sessions.listModels())[0]!.id;
	let roomId = "";
	let sessionId = "";
	let cwdSnapshot = "";
	try {
		const listed = await first.app.inject({ method: "GET", url: "/api/rooms" });
		const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo");
		roomId = solo.id as string;
		cwdSnapshot = solo.cwdSnapshot as string;
		const session = await first.sessions.open(listed.json().rooms.find((room: { type: string }) => room.type === "solo").activeSession as string);
		first.sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			const userMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			session.sessionManager.appendMessage(userMessage as never);
			session.state.messages.push(userMessage as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		Object.defineProperty(first.sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const accepted = await first.app.inject({
			method: "POST", url: `/api/rooms/${roomId}/new-work`,
			headers: { "idempotency-key": key }, payload: { content, modelRef, attachments, workspaceId: null, cwdSnapshot },
		});
		assert.equal(accepted.statusCode, 200, accepted.body);
		sessionId = accepted.json().sessionId as string;
		assert.equal(sessionId, session.sessionId);
		assert.equal(`${session.model?.provider}/${session.model?.id}`, modelRef);
		// Discard the successful response as if it were lost after acceptance.
	} finally {
		await first.sessions.disposeAll();
		await first.app.close();
	}
	const restarted = await makeStack(undefined, undefined, undefined, true, first.dir);
	try {
		const retry = () => restarted.app.inject({
			method: "POST", url: `/api/rooms/${roomId}/new-work`,
			headers: { "idempotency-key": key }, payload: { content, modelRef, attachments, workspaceId: null, cwdSnapshot },
		});
		const recovered = await retry();
		assert.equal(recovered.statusCode, 200, recovered.body);
		assert.deepEqual(recovered.json(), { sessionId, accepted: true });
		const repeated = await retry();
		assert.equal(repeated.statusCode, 200, repeated.body);
		assert.equal(repeated.json().sessionId, sessionId);
		assert.equal((await restarted.teams.windowSessionList(roomId)).sessions.length, 1);
		assert.equal((await restarted.sessions.list()).find((item) => item.id === sessionId)?.model, modelRef);
		const sessionFile = (await restarted.sessions.list()).find((item) => item.id === sessionId)?.sessionFile;
		assert.ok(sessionFile);
		const userEntries = readFileSync(sessionFile, "utf8").trim().split("\n")
			.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } })
			.filter((entry) => entry.type === "message" && entry.message?.role === "user");
		assert.equal(userEntries.length, 1, "重试不得追加第二条用户消息");
		const changedAttachment = await restarted.app.inject({
			method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key },
			payload: { content, modelRef, attachments: [{ ...attachments[0]!, data: Buffer.from("different bytes").toString("base64") }, attachments[1]], workspaceId: null, cwdSnapshot },
		});
		assert.equal(changedAttachment.statusCode, 409, changedAttachment.body);
		const reordered = await restarted.app.inject({
			method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key },
			payload: { content, modelRef, attachments: [...attachments].reverse(), workspaceId: null, cwdSnapshot },
		});
		assert.equal(reordered.statusCode, 409, reordered.body);
		const conflict = await restarted.app.inject({
			method: "POST", url: `/api/rooms/${roomId}/new-work`,
			headers: { "idempotency-key": key }, payload: { content: "另一项工作", workspaceId: null, cwdSnapshot },
		});
		assert.equal(conflict.statusCode, 409, conflict.body);
	} finally {
		await restarted.sessions.disposeAll();
		await restarted.app.close();
	}
});

test("Manager 首发冻结 Workspace 外路径后，即使源文件删除也能同键冷启动恢复", async () => {
	const first = await makeStack(undefined, undefined, undefined, true);
	const sourceRoot = mkdtempSync(path.join(tmpdir(), "pt-first-work-local-path-"));
	const source = path.join(sourceRoot, "evidence.txt");
	writeFileSync(source, "original bytes");
	const content = `请分析外部证据：\`${source}\``;
	const attachments = [{ filename: "browser.txt", mediaType: "text/plain", data: Buffer.from("browser bytes").toString("base64") }];
	const key = "first-work-external-path-0001";
	let sessionId = "";
	let roomId = "";
	let cwdSnapshot = "";
	try {
		const solo = (await first.app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		roomId = solo.id;
		cwdSnapshot = solo.cwdSnapshot;
		const session = await first.sessions.open(solo.activeSession);
		first.sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			session.sessionManager.appendMessage(message as never);
			session.state.messages.push(message as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		Object.defineProperty(first.sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const accepted = await first.app.inject({ method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key }, payload: { content, attachments, workspaceId: null, cwdSnapshot } });
		assert.equal(accepted.statusCode, 200, accepted.body);
		sessionId = accepted.json().sessionId;
		const firstUser = session.messages.find((message) => message.role === "user") as unknown as { content: Array<{ text?: string }> };
		assert.notEqual(firstUser.content[0]?.text, content);
	} finally { await first.sessions.disposeAll(); await first.app.close(); }
	unlinkSync(source);
	const restarted = await makeStack(undefined, undefined, undefined, true, first.dir);
	try {
		const replay = await restarted.app.inject({ method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key }, payload: { content, attachments, workspaceId: null, cwdSnapshot } });
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().sessionId, sessionId);
		const sessionFile = (await restarted.sessions.list()).find((item) => item.id === sessionId)?.sessionFile;
		assert.ok(sessionFile);
		assert.equal(readFileSync(sessionFile, "utf8").split("\n").filter((line) => line && JSON.parse(line).type === "message" && JSON.parse(line).message?.role === "user").length, 1);
	} finally { await restarted.sessions.disposeAll(); await restarted.app.close(); }
});

test("Manager 首发经 Workspace 内符号链接冻结外部文件，链接删除后同键恢复", async () => {
	const first = await makeStack(undefined, undefined, undefined, true);
	const outside = path.join(mkdtempSync(path.join(tmpdir(), "pt-first-work-symlink-")), "source.txt");
	writeFileSync(outside, "source contents");
	let roomId = "";
	let cwdSnapshot = "";
	let sessionId = "";
	let content = "";
	const key = "first-work-symlink-path-0001";
	try {
		const solo = (await first.app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		roomId = solo.id;
		cwdSnapshot = solo.cwdSnapshot;
		assert.equal(cwdSnapshot, realpathSync(first.dir));
		const link = path.join(cwdSnapshot, "outside-link.txt");
		symlinkSync(outside, link);
		content = `请分析链接文件：\`${link}\``;
		const session = await first.sessions.open(solo.activeSession);
		first.sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			session.sessionManager.appendMessage(message as never);
			session.state.messages.push(message as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		Object.defineProperty(first.sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const accepted = await first.app.inject({ method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key }, payload: { content, workspaceId: null, cwdSnapshot } });
		assert.equal(accepted.statusCode, 200, accepted.body);
		sessionId = accepted.json().sessionId;
		unlinkSync(link);
	} finally { await first.sessions.disposeAll(); await first.app.close(); }
	const restarted = await makeStack(undefined, undefined, undefined, true, first.dir);
	try {
		const replay = await restarted.app.inject({ method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key }, payload: { content, workspaceId: null, cwdSnapshot } });
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().sessionId, sessionId);
	} finally { await restarted.sessions.disposeAll(); await restarted.app.close(); }
});

test("Manager 首发准入先于 user 落盘时不提前返回成功", async () => {
	const { app, sessions } = await makeStack(undefined, undefined, undefined, true);
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		const content = "等待首条消息落盘";
		let releaseAppend: (() => void) | undefined;
		const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
		let signalPreflight: (() => void) | undefined;
		const preflightSeen = new Promise<void>((resolve) => { signalPreflight = resolve; });
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (_text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			options?.preflightResult?.(true);
			signalPreflight?.();
			await appendGate;
			const user = { role: "user", content: [{ type: "text", text: content }], timestamp: Date.now() };
			session.sessionManager.appendMessage(user as never);
			session.state.messages.push(user as never);
		}, configurable: true });
		Object.defineProperty(sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		let responded = false;
		const sent = app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "preflight-before-user-0001" },
			payload: { content, workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		}).then((response) => { responded = true; return response; });
		await preflightSeen;
		assert.equal(responded, false, "preflight callback alone cannot acknowledge the work");
		releaseAppend?.();
		const accepted = await sent;
		assert.equal(accepted.statusCode, 200, accepted.body);
		const file = (await sessions.list()).find((item) => item.id === accepted.json().sessionId)?.sessionFile;
		assert.ok(file);
		assert.equal(readFileSync(file, "utf8").split("\n").filter((line) => line.includes(content)).length, 1);
		const replay = await app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "preflight-before-user-0001" },
			payload: { content, workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().sessionId, accepted.json().sessionId);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发准入但没有 user 条目时不假报成功，原键仍可重试", async () => {
	const { app, sessions, dir } = await makeStack(undefined, undefined, undefined, true);
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		const content = "必须形成一条用户意图";
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (_text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			options?.preflightResult?.(true);
		}, configurable: true });
		Object.defineProperty(sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "preflight-no-user-0001" },
			payload: { content, attachments: [{ filename: "draft.txt", data: Buffer.from("draft bytes").toString("base64") }], workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const falseSuccess = await send();
		assert.equal(falseSuccess.statusCode, 400, falseSuccess.body);
		assert.match(falseSuccess.body, /首次发送尚未写入会话记录/);
		const reservedId = falseSuccess.json().sessionId as string;
		const uploadDirectory = path.join(dir, "uploads", reservedId);
		const abandoned = readdirSync(uploadDirectory);
		assert.equal(abandoned.length, 1);
		const originalIsRunning = sessions.isRunning.bind(sessions);
		sessions.isRunning = () => true;
		const stillRunning = await send();
		assert.equal(stillRunning.statusCode, 400, stillRunning.body);
		assert.match(stillRunning.body, /仍在处理/);
		assert.deepEqual(readdirSync(uploadDirectory), abandoned, "在途首发不得冻结第二份附件或清理第一份");
		sessions.isRunning = originalIsRunning;
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			session.sessionManager.appendMessage(user as never);
			session.state.messages.push(user as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		const retried = await send();
		assert.equal(retried.statusCode, 200, retried.body);
		assert.equal(retried.json().sessionId, reservedId);
		assert.equal(readdirSync(uploadDirectory).length, 1, "原未接纳冻结副本已回收，只保留成功首发引用");
		assert.equal(existsSync(path.join(uploadDirectory, abandoned[0]!)), false);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发成功后同进程重试仍须复核已落盘 user", async () => {
	const { app, sessions } = await makeStack(undefined, undefined, undefined, true);
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		let promptCount = 0;
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			promptCount++;
			const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			session.sessionManager.appendMessage(user as never);
			session.state.messages.push(user as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "durable-success-recheck-0001" },
			payload: { content: "成功后也要核对磁盘", workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const accepted = await send();
		assert.equal(accepted.statusCode, 200, accepted.body);
		const replay = await send();
		assert.equal(replay.statusCode, 200, replay.body);
		const file = (await sessions.list()).find((item) => item.id === accepted.json().sessionId)?.sessionFile;
		assert.ok(file);
		const remaining = readFileSync(file, "utf8").split("\n").filter((line) => {
			if (!line) return false;
			const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
			return !(entry.type === "message" && entry.message?.role === "user");
		});
		writeFileSync(file, `${remaining.join("\n")}\n`);
		const lost = await send();
		assert.equal(lost.statusCode, 400, lost.body);
		assert.match(lost.body, /首次发送尚未写入会话记录/);
		assert.equal(lost.json().sessionId, accepted.json().sessionId);
		assert.equal(promptCount, 1, "复核失败不得制造第二条用户意图");
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发 preflight 后无 user 事件满五秒只返回可重试错误", async () => {
	const { app, sessions, dir } = await makeStack(undefined, undefined, undefined, true);
	let releasePrompt: (() => void) | undefined;
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		const pending = new Promise<void>((resolve) => { releasePrompt = resolve; });
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (_text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
			options?.preflightResult?.(true);
			await pending;
		}, configurable: true });
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "preflight-no-user-timeout-0001" },
			payload: { content: "等待 user 事件直到超时", attachments: [{ filename: "draft.txt", data: Buffer.from("timeout bytes").toString("base64") }], workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const startedAt = Date.now();
		const timedOut = await send();
		assert.equal(timedOut.statusCode, 400, timedOut.body);
		assert.match(timedOut.body, /首次发送尚未写入会话记录/);
		assert.ok(Date.now() - startedAt >= 4_800, "必须实际等待 user 事件超时，不能由完成回调提前返回");
		const reservedId = timedOut.json().sessionId as string;
		const uploadDirectory = path.join(dir, "uploads", reservedId);
		const abandoned = readdirSync(uploadDirectory);
		assert.equal(abandoned.length, 1);
		const inFlight = await send();
		assert.equal(inFlight.statusCode, 400, inFlight.body);
		assert.match(inFlight.body, /首次发送仍在处理/);
		assert.equal(inFlight.json().sessionId, reservedId);
		assert.deepEqual(readdirSync(uploadDirectory), abandoned);
	} finally {
		releasePrompt?.();
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发 JSONL 条目 ID 相同但正文不同时不能确认接纳", async () => {
	const { app, sessions } = await makeStack(undefined, undefined, undefined, true);
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			Object.defineProperty(session.sessionManager, "_persist", { value: (entry: { type: string; message?: { role: string } }) => {
				if (entry.type === "message" && entry.message?.role === "user") {
					appendFileSync(session.sessionFile!, `${JSON.stringify({ ...entry, message: { ...entry.message, content: [{ type: "text", text: "磁盘上的另一条意图" }] } })}\n`);
				}
			}, configurable: true });
			session.sessionManager.appendMessage(user as never);
			session.state.messages.push(user as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "disk-user-content-mismatch-0001" },
			payload: { content: "本次要发送的正文", workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const first = await send();
		assert.equal(first.statusCode, 400, first.body);
		assert.match(first.body, /首次发送尚未写入会话记录/);
		const retried = await send();
		assert.equal(retried.statusCode, 409, retried.body);
		assert.equal(retried.json().code, "first_message_conflict");
		assert.equal(retried.json().sessionId, first.json().sessionId);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 内存 user 未写入 JSONL 时同键重试不能假报成功", async () => {
	const { app, sessions, dir } = await makeStack(undefined, undefined, undefined, true);
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		const content = "内存已有用户消息但没有持久证据";
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "memory-only-user-0001" },
			payload: { content, attachments: [{ filename: "draft.txt", data: Buffer.from("memory only bytes").toString("base64") }], workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		let prompted = false;
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			prompted = true;
			const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			Object.defineProperty(session.sessionManager, "_persist", { value: () => undefined, configurable: true });
			session.sessionManager.appendMessage(user as never);
			session.state.messages.push(user as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		const first = await send();
		assert.equal(prompted, true);
		assert.equal(first.statusCode, 400, first.body);
		assert.match(first.body, /首次发送尚未写入会话记录/);
		const reservedId = first.json().sessionId as string;
		const uploadDirectory = path.join(dir, "uploads", reservedId);
		const abandoned = readdirSync(uploadDirectory);
		assert.equal(abandoned.length, 1);
		const retried = await send();
		assert.equal(retried.statusCode, 400, retried.body);
		assert.match(retried.body, /首次发送尚未写入会话记录/);
		assert.equal(retried.json().sessionId, reservedId);
		assert.deepEqual(readdirSync(uploadDirectory), abandoned);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 未接纳首发的冻结批次在冷启动后同键重试时回收", async () => {
	const first = await makeStack(undefined, undefined, undefined, true);
	const key = "preflight-no-user-cold-retry-0001";
	const content = "冷启动后继续原工作";
	const attachments = [{ filename: "draft.txt", data: Buffer.from("cold retry bytes").toString("base64") }];
	let roomId = "";
	let cwdSnapshot = "";
	let reservedId = "";
	let abandoned = "";
	try {
		const solo = (await first.app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		roomId = solo.id;
		cwdSnapshot = solo.cwdSnapshot;
		const session = await first.sessions.open(solo.activeSession as string);
		first.sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (_text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			options?.preflightResult?.(true);
		}, configurable: true });
		Object.defineProperty(first.sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const rejected = await first.app.inject({
			method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key },
			payload: { content, attachments, workspaceId: null, cwdSnapshot },
		});
		assert.equal(rejected.statusCode, 400, rejected.body);
		reservedId = rejected.json().sessionId as string;
		const names = readdirSync(path.join(first.dir, "uploads", reservedId));
		assert.equal(names.length, 1);
		abandoned = names[0]!;
	} finally { await first.sessions.disposeAll(); await first.app.close(); }

	const restarted = await makeStack(undefined, undefined, undefined, true, first.dir);
	try {
		const session = await restarted.sessions.open(reservedId);
		restarted.sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			session.sessionManager.appendMessage(user as never);
			session.state.messages.push(user as never);
			options?.preflightResult?.(true);
		}, configurable: true });
		Object.defineProperty(restarted.sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const accepted = await restarted.app.inject({
			method: "POST", url: `/api/rooms/${roomId}/new-work`, headers: { "idempotency-key": key },
			payload: { content, attachments, workspaceId: null, cwdSnapshot },
		});
		assert.equal(accepted.statusCode, 200, accepted.body);
		assert.equal(accepted.json().sessionId, reservedId);
		const uploadDirectory = path.join(first.dir, "uploads", reservedId);
		assert.equal(existsSync(path.join(uploadDirectory, abandoned)), false);
		assert.equal(readdirSync(uploadDirectory).length, 1);
	} finally { await restarted.sessions.disposeAll(); await restarted.app.close(); }
});

test("Manager 首发不能把另一条已落盘 user 消息当成本次工作", async () => {
	const { app, sessions } = await makeStack(undefined, undefined, undefined, true);
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		const content = "这次工作的原文";
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (_text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			options?.preflightResult?.(true);
			const foreign = { role: "user", content: [{ type: "text", text: "另一条用户消息" }], timestamp: Date.now() };
			await (session as unknown as { _handleAgentEvent: (event: never) => Promise<void> })._handleAgentEvent({ type: "message_end", message: foreign } as never);
			session.state.messages.push(foreign as never);
		}, configurable: true });
		Object.defineProperty(sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const send = () => app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "preflight-foreign-user-0001" },
			payload: { content, workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		const rejected = await send();
		assert.equal(rejected.statusCode, 400, rejected.body);
		assert.match(rejected.body, /首次发送尚未写入会话记录/);
		const replay = await send();
		assert.equal(replay.statusCode, 409, replay.body);
		assert.equal(replay.json().code, "first_message_conflict");
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Manager 首发在 user 条目落盘后返回，不等待整轮模型完成", async () => {
	const { app, sessions } = await makeStack(undefined, undefined, undefined, true);
	let releaseModel: (() => void) | undefined;
	try {
		const solo = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms.find((room: { type: string }) => room.type === "solo");
		const session = await sessions.open(solo.activeSession as string);
		const content = "模型继续运行，但输入已保存";
		const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
		let modelFinished = false;
		sessions.hasModelAuth = async () => true;
		Object.defineProperty(session, "prompt", { value: async (_text: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
			options?.preflightResult?.(true);
			const user = { role: "user", content: [{ type: "text", text: content }], timestamp: Date.now() };
			await (session as unknown as { _handleAgentEvent: (event: never) => Promise<void> })._handleAgentEvent({ type: "message_end", message: user } as never);
			await modelGate;
			modelFinished = true;
		}, configurable: true });
		Object.defineProperty(sessions, "generateSessionTitle", { value: async () => undefined, configurable: true });
		const accepted = await app.inject({
			method: "POST", url: `/api/rooms/${solo.id}/new-work`, headers: { "idempotency-key": "preflight-streaming-0001" },
			payload: { content, workspaceId: solo.workspace?.id ?? null, cwdSnapshot: solo.cwdSnapshot },
		});
		assert.equal(accepted.statusCode, 200, accepted.body);
		assert.equal(modelFinished, false, "durable user entry is sufficient; assistant completion is not required");
		const file = (await sessions.list()).find((item) => item.id === accepted.json().sessionId)?.sessionFile;
		assert.ok(file && readFileSync(file, "utf8").includes(content));
	} finally {
		releaseModel?.();
		await sessions.disposeAll();
		await app.close();
	}
});

test("双 Workspace 的 Manager/Direct 归属、业务活动与操作键跨重启保持隔离", async () => {
	const first = await makeStack();
	const { app, teams, sessions, dir } = first;
	let soloId = "";
	let aId = "";
	let bId = "";
	let aSessionId = "";
	let bSessionId = "";
	let directAId = "";
	let directBId = "";
	let directASessionId = "";
	let directBSessionId = "";
	let reservedSessionId = "";
	try {
		const a = await teams.workspaces.createManaged("Project A");
		const b = await teams.workspaces.createManaged("Project B");
		aId = a.id;
		bId = b.id;
		const initial = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms;
		soloId = initial.find((room: { type: string }) => room.type === "solo").id;
		const switchSolo = async (workspaceId: string) => {
			const response = await app.inject({
				method: "POST", url: `/api/rooms/${soloId}/switch-workspace`,
				payload: { workspaceId, mode: "in_place" },
			});
			assert.equal(response.statusCode, 200, response.body);
			return response.json().room as { activeSession: string; workspace: { id: string }; cwdSnapshot: string };
		};
		const inA = await switchSolo(aId);
		aSessionId = inA.activeSession;
		assert.equal(inA.cwdSnapshot, a.canonicalPath);
		await sessions.ensureSessionFile(aSessionId);
		const reserve = await app.inject({
			method: "POST", url: `/api/rooms/${soloId}/sessions`,
			headers: { "idempotency-key": "dual-workspace-a-0001" }, payload: {},
		});
		assert.equal(reserve.statusCode, 200, reserve.body);
		reservedSessionId = reserve.json().session.id;
		await sessions.ensureSessionFile(reservedSessionId);
		const inB = await switchSolo(bId);
		bSessionId = inB.activeSession;
		assert.notEqual(bSessionId, reservedSessionId);
		assert.equal(inB.cwdSnapshot, b.canonicalPath);
		await sessions.ensureSessionFile(bSessionId);
		const backInA = await switchSolo(aId);
		assert.equal(backInA.activeSession, reservedSessionId);
		const direct = async (workspaceId: string) => {
			const response = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"], workspaceId } });
			assert.equal(response.statusCode, 200, response.body);
			return response.json().room as { id: string; activeSession: string; cwdSnapshot: string };
		};
		const directA = await direct(aId);
		const directB = await direct(bId);
		directAId = directA.id;
		directBId = directB.id;
		directASessionId = directA.activeSession;
		directBSessionId = directB.activeSession;
		assert.notEqual(directAId, directBId);
		assert.equal(directA.cwdSnapshot, a.canonicalPath);
		assert.equal(directB.cwdSnapshot, b.canonicalPath);
		await sessions.ensureSessionFile(directASessionId);
		await sessions.ensureSessionFile(directBSessionId);
		const fileById = new Map((await sessions.list()).map((session) => [session.id, session.sessionFile]));
		const writeActivity = (sessionId: string, id: string, at: string) => appendFileSync(fileById.get(sessionId)!, `${JSON.stringify({
			type: "custom_message", id, parentId: null, timestamp: at,
			customType: "pudding:task_result", content: id, display: true,
		})}\n`);
		writeActivity(directBSessionId, "B result", new Date(Date.now() + 10_000).toISOString());
		writeActivity(directASessionId, "A result", new Date(Date.now() + 20_000).toISOString());
		const ordered = (await app.inject({ method: "GET", url: "/api/rooms" })).json().rooms;
		assert.equal(ordered[0].id, directAId);
		assert.equal(ordered[1].id, directBId);
		assert.equal(ordered[0].lastMessagePreview, "A result");
		assert.equal(ordered[1].lastMessagePreview, "B result");
		const location = await app.inject({ method: "GET", url: `/api/rooms/${soloId}/sessions/${bSessionId}/location` });
		assert.deepEqual(location.json(), { roomId: soloId, sessionId: bSessionId, workspaceId: bId, active: false });
		const foreign = await app.inject({ method: "GET", url: `/api/rooms/${directAId}/sessions/${directBSessionId}/location` });
		assert.equal(foreign.statusCode, 404);
		assert.ok(existsSync(path.join(dir, "state", "room-activity.json")));
		assert.ok(existsSync(path.join(dir, "state", "session-creation-operations.json")));
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
	const restarted = await makeStack(undefined, undefined, undefined, false, dir);
	try {
		const roomsResponse = await restarted.app.inject({ method: "GET", url: "/api/rooms" });
		assert.equal(roomsResponse.statusCode, 200, roomsResponse.body);
		const ordered = roomsResponse.json().rooms;
		assert.equal(ordered[0].id, directAId);
		assert.equal(ordered[1].id, directBId);
		assert.equal(ordered.find((room: { id: string }) => room.id === soloId).activeSession, reservedSessionId);
		assert.equal((await restarted.teams.workspaceForSession(aSessionId)), (await restarted.teams.workspaces.require(aId)).canonicalPath);
		assert.equal((await restarted.teams.workspaceForSession(bSessionId)), (await restarted.teams.workspaces.require(bId)).canonicalPath);
		const replay = await restarted.app.inject({
			method: "POST", url: `/api/rooms/${soloId}/sessions`,
			headers: { "idempotency-key": "dual-workspace-a-0001" }, payload: {},
		});
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().session.id, reservedSessionId);
		const windows = JSON.parse(readFileSync(path.join(dir, "teams", "windows.json"), "utf8")) as {
			windows: Record<string, { workspaceId?: string; cwdSnapshot: string }>;
		};
		assert.equal(windows.windows[directAId]?.workspaceId, aId);
		assert.equal(windows.windows[directBId]?.workspaceId, bId);
		assert.notEqual(windows.windows[directAId]?.cwdSnapshot, windows.windows[directBId]?.cwdSnapshot);
	} finally {
		await restarted.sessions.disposeAll();
		await restarted.app.close();
	}
});
