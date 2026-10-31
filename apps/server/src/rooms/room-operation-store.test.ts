import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	RoomOperationConflictError,
	RoomOperationRecoveryRequiredError,
	RoomOperationStore,
} from "./room-operation-store.js";

const ROOM = "room-1111-2222";

function fresh(): { store: RoomOperationStore; root: string } {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-ops-"));
	return { store: new RoomOperationStore(root), root };
}

test("RoomOperationStore: creation reserve/advance 幂等与冲突", async () => {
	const { store, root } = fresh();
	const reserved = await store.reserveCreation(ROOM, { key: "op-create-1", requestHash: "hash-1", managerAgentSessionId: "manager-session-1" });
	assert.equal(reserved.created, true);
	assert.equal(reserved.operation.phase, "reserved");
	const replay = await store.reserveCreation(ROOM, { key: "op-create-1", requestHash: "hash-1", managerAgentSessionId: "manager-session-1" });
	assert.equal(replay.created, false);
	await assert.rejects(
		() => store.reserveCreation(ROOM, { key: "op-create-1", requestHash: "hash-2", managerAgentSessionId: "manager-session-1" }),
		RoomOperationConflictError,
	);
	assert.equal((await store.advanceCreation(ROOM, "op-create-1", "event_file_created")).phase, "event_file_created");
	assert.equal((await store.advanceCreation(ROOM, "op-create-1", "event_file_created")).phase, "event_file_created");
	await assert.rejects(() => store.advanceCreation(ROOM, "op-create-1", "attached"), RoomOperationConflictError);
	const attached = await (async () => {
		await store.advanceCreation(ROOM, "op-create-1", "manager_created");
		await store.advanceCreation(ROOM, "op-create-1", "manager_bound");
		return store.advanceCreation(ROOM, "op-create-1", "attached");
	})();
	assert.equal(attached.phase, "attached");
	assert.equal((await new RoomOperationStore(root).getCreation(ROOM, "op-create-1"))?.phase, "attached");
});

test("RoomOperationStore: message 阶段与 accepted 补丁", async () => {
	const { store, root } = fresh();
	const reserved = await store.reserveMessage(ROOM, { key: "op-message-1", requestHash: "m-1" });
	assert.equal(reserved.operation.phase, "reserved");
	await assert.rejects(
		() => store.reserveMessage(ROOM, { key: "op-message-1", requestHash: "m-2" }),
		RoomOperationConflictError,
	);
	await assert.rejects(() => store.advanceMessage(ROOM, "op-message-1", "participant_bound"), RoomOperationConflictError);
	const appended = await store.advanceMessage(ROOM, "op-message-1", "user_event_appended", { roomEventId: "event-1" });
	assert.equal(appended.roomEventId, "event-1");
	await store.advanceMessage(ROOM, "op-message-1", "participant_bound", { participantTurnId: "turn-1", agentSessionId: "agent-1" });
	await store.advanceMessage(ROOM, "op-message-1", "participant_input_durable");
	const accepted = await store.advanceMessage(ROOM, "op-message-1", "accepted");
	assert.equal(accepted.phase, "accepted");
	assert.equal(accepted.participantTurnId, "turn-1");
	assert.equal((await new RoomOperationStore(root).getMessage(ROOM, "op-message-1"))?.phase, "accepted");
});

test("RoomOperationStore: 非法 key、损坏文件、未知阶段 fail-closed", async () => {
	const { store, root } = fresh();
	await assert.rejects(() => store.reserveMessage(ROOM, { key: "short", requestHash: "x" }), RoomOperationConflictError);
	await store.reserveMessage(ROOM, { key: "op-message-1", requestHash: "x" });
	writeFileSync(path.join(root, ROOM, "operations.json"), "{not-json}\n");
	await assert.rejects(() => store.getMessage(ROOM, "op-message-1"), RoomOperationRecoveryRequiredError);
	writeFileSync(path.join(root, ROOM, "operations.json"), JSON.stringify({ version: 1, creation: {}, messages: { "op-message-1": { key: "op-message-1", requestHash: "x", phase: "bogus", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }) + "\n");
	await assert.rejects(() => store.getMessage(ROOM, "op-message-1"), RoomOperationRecoveryRequiredError);
});

test("RoomOperationStore: 未 reserve 不能 advance", async () => {
	const { store } = fresh();
	await assert.rejects(() => store.advanceMessage(ROOM, "op-message-9", "user_event_appended"), RoomOperationConflictError);
});
