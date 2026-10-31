import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "./teams.js";

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

async function makeStore() {
	const dir = freshDir("pt-v4-rooms-");
	const store = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await store.init();
	for (const name of ["alpha", "beta"]) {
		await store.upsertAgent({ name, description: name, invoke: { type: "command", command: name, runArgs: [] } });
	}
	return { dir, store };
}

test("v4: group 建房只创建 RoomSession + Manager Participant，不再使用 window.sessions", async () => {
	const { store } = await makeStore();
	const window = await store.createWindow({ type: "group", members: ["alpha", "beta"], sessionId: "manager-session-1" });
	assert.deepEqual(window.sessions, []);
	assert.equal(window.activeSession, "");
	assert.equal(window.roomSessionIds?.length, 1);
	assert.equal(window.activeRoomSessionId, window.roomSessionIds![0]);
	assert.equal(await store.managerSession(window.id), "manager-session-1");
	const participant = await store.participantSession("manager-session-1");
	assert.equal(participant?.role, "manager");
	const context = await store.contextForSession("manager-session-1");
	assert.equal(context?.window.id, window.id);
	const roomContext = await store.contextForRoomSession(window.activeRoomSessionId!);
	assert.equal(roomContext?.window.id, window.id);
});

test("v4: 新增/切换/删除 RoomSession 与 ParticipantSession", async () => {
	const { store } = await makeStore();
	const window = await store.createWindow({ type: "group", members: ["alpha", "beta"], sessionId: "manager-session-1" });
	const roomId = await store.addRoomSession(window.id, "manager-session-2");
	assert.equal((await store.getWindow(window.id))?.activeRoomSessionId, roomId);
	await store.setActiveRoomSession(window.id, window.roomSessionIds![0]!);
	assert.equal((await store.getWindow(window.id))?.activeRoomSessionId, window.roomSessionIds![0]);
	await store.addParticipantSession({
		windowId: window.id,
		roomSessionId: roomId,
		agentSessionId: "worker-session-1",
		agentId: "alpha",
		role: "worker",
		cwdSnapshot: window.cwdSnapshot,
	});
	const workerContext = await store.contextForSession("worker-session-1");
	assert.equal(workerContext?.window.id, window.id);
	assert.equal((await store.participantSession("worker-session-1"))?.roomSessionId, roomId);

	const removed = await store.removeRoomSession(window.id, roomId);
	assert.equal(removed.removed, true);
	assert.deepEqual(removed.agentSessionIds.sort(), ["manager-session-2", "worker-session-1"]);
	assert.equal(await store.contextForSession("worker-session-1"), undefined);
	const last = await store.removeRoomSession(window.id, window.roomSessionIds![0]!);
	assert.equal(last.removed, false);
	assert.match(last.blocked ?? "", /至少/);
});

test("v4: 重启后 RoomSession/Participant 可解析，窗口索引保持", async () => {
	const { dir, store } = await makeStore();
	const window = await store.createWindow({ type: "group", members: ["alpha", "beta"], sessionId: "manager-session-1" });
	await store.addParticipantSession({
		windowId: window.id,
		roomSessionId: window.activeRoomSessionId!,
		agentSessionId: "worker-session-1",
		agentId: "alpha",
		role: "worker",
		cwdSnapshot: window.cwdSnapshot,
	});
	const restarted = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await restarted.init();
	const reloaded = await restarted.getWindow(window.id);
	assert.deepEqual(reloaded?.roomSessionIds, window.roomSessionIds);
	assert.equal((await restarted.contextForSession("worker-session-1"))?.window.id, window.id);
	assert.equal(await restarted.managerSession(window.id), "manager-session-1");
});
