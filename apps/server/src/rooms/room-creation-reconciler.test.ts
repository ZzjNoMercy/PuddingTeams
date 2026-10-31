import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomEventStore, type RoomEventDraft } from "./room-event-store.js";
import { RoomOperationStore } from "./room-operation-store.js";
import { RoomCreationReconciler } from "./room-creation-reconciler.js";
import type { ParticipantSessionRefV4, RoomSessionRefV4 } from "../store/windows-v4.js";

const ROOM = "room-1111-2222";
const MANAGER = "manager-session-1";
const created = "2026-10-31T00:00:00.000Z";

function roomRef(id = ROOM): RoomSessionRefV4 {
	return { roomSessionId: id, roomId: "room-id-1", cwdSnapshot: "/workspace", createdAt: created };
}

function participant(roomSessionId = ROOM): ParticipantSessionRefV4 {
	return {
		agentSessionId: MANAGER, roomId: "room-id-1", roomSessionId, agentId: "manager", role: "manager",
		state: "active", cwdSnapshot: "/workspace", revision: 1, createdAt: created, updatedAt: created,
	};
}

function make(root: string, opts: { rooms?: string[]; existingSessions?: string[]; events?: boolean } = {}) {
	const rooms = opts.rooms ?? [ROOM];
	return new RoomCreationReconciler({
		root,
		events: new RoomEventStore(root),
		operations: new RoomOperationStore(root),
		teams: {
			listWindows: async () => [{ type: "group", roomSessionIds: rooms } as never],
			roomSession: async (id) => rooms.includes(id) ? roomRef(id) : undefined,
			participantSession: async (id) => id === MANAGER ? participant() : undefined,
			managerSessionForRoom: async (id) => rooms.includes(id) ? MANAGER : undefined,
		},
		sessionExists: async (id) => (opts.existingSessions ?? []).includes(id),
		removeSession: async () => undefined,
	});
}

test("Reconciler: 已提交房间无账本时补 events + attached 账本", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-reconcile-"));
	const result = await make(root).reconcile();
	assert.equal(result.kept, 1);
	assert.equal(result.removed, 0);
	const operations = await new RoomOperationStore(root).listCreation(ROOM);
	assert.equal(operations.length, 1);
	assert.equal(operations[0]!.phase, "attached");
	assert.equal(await new RoomEventStore(root).exists(ROOM), true);
});

test("Reconciler: 无房间归属的空账本/空事件目录被精确清理", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-reconcile-"));
	const events = new RoomEventStore(root);
	const operations = new RoomOperationStore(root);
	await events.create(ROOM);
	await operations.reserveCreation(ROOM, { key: "op-create-1", requestHash: "hash", managerAgentSessionId: MANAGER });
	await operations.advanceCreation(ROOM, "op-create-1", "event_file_created");
	const result = await make(root, { rooms: [] }).reconcile();
	assert.equal(result.removed, 1);
	assert.equal(result.recoveryRequired.length, 0);
	assert.equal(await events.exists(ROOM), false);
});

test("Reconciler: 预留 Manager JSONL 已存在或已有公共事件时保留现场并报 recovery", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-reconcile-"));
	const events = new RoomEventStore(root);
	const operations = new RoomOperationStore(root);
	await events.create(ROOM);
	await operations.reserveCreation(ROOM, { key: "op-create-1", requestHash: "hash", managerAgentSessionId: MANAGER });
	await operations.advanceCreation(ROOM, "op-create-1", "event_file_created");
	const withSession = await make(root, { rooms: [], existingSessions: [MANAGER] }).reconcile();
	assert.equal(withSession.removed, 0);
	assert.match(withSession.recoveryRequired[0]!.reason, /预留 Manager/);

	const draft: RoomEventDraft = {
		id: "event-1", kind: "message", actor: { kind: "user" }, content: "x", mentions: [], createdAt: created,
	};
	await events.append(ROOM, draft);
	const withEvents = await make(root, { rooms: [], existingSessions: [] }).reconcile();
	assert.equal(withEvents.removed, 0);
	assert.match(withEvents.recoveryRequired[0]!.reason, /公共事件/);
});

test("Reconciler: 窗口引用但缺 Manager binding 时不删、报 recovery", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-reconcile-"));
	const reconciler = new RoomCreationReconciler({
		root,
		events: new RoomEventStore(root),
		operations: new RoomOperationStore(root),
		teams: {
			listWindows: async () => [{ type: "group", roomSessionIds: [ROOM] } as never],
			roomSession: async () => roomRef(),
			participantSession: async () => undefined,
			managerSessionForRoom: async () => MANAGER,
		},
		sessionExists: async () => false,
		removeSession: async () => undefined,
	});
	const result = await reconciler.reconcile();
	assert.equal(result.kept, 0);
	assert.equal(result.recoveryRequired[0]!.roomSessionId, ROOM);
	assert.match(result.recoveryRequired[0]!.reason, /Manager binding/);
});
