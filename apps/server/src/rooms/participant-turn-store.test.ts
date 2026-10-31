import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ParticipantTurnStore,
	RoomTurnConflictError,
	RoomTurnNotFoundError,
	RoomTurnStoreRecoveryRequiredError,
	type NewParticipantTurn,
	type ParticipantInput,
} from "./participant-turn-store.js";

const ROOM = "room-1111-2222";

function freshStore(): { store: ParticipantTurnStore; root: string } {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-turns-"));
	return { store: new ParticipantTurnStore(root), root };
}

function newTurn(overrides: Partial<NewParticipantTurn> = {}): NewParticipantTurn {
	return {
		id: "turn-1",
		agentSessionId: "agent-session-1",
		sourceRoomEventId: "event-1",
		contextThroughRoomEventId: "event-1",
		inputHash: "a".repeat(64),
		operationId: "op-1",
		bindingRevision: 1,
		...overrides,
	};
}

function input(overrides: Partial<ParticipantInput> = {}): ParticipantInput {
	return {
		operationId: "op-1",
		sourceRoomEventId: "event-1",
		contextThroughRoomEventId: "event-1",
		inputHash: "a".repeat(64),
		delivery: "normal",
		persistence: "durable",
		...overrides,
	};
}

test("ParticipantTurnStore: admit 幂等、按 operation 查找、重启回读", async () => {
	const { store, root } = freshStore();
	const admitted = await store.admit(ROOM, newTurn());
	assert.equal(admitted.created, true);
	assert.equal(admitted.turn.status, "admitted");
	const replay = await store.admit(ROOM, newTurn());
	assert.equal(replay.created, false);
	assert.equal((await store.list(ROOM)).length, 1);
	assert.equal((await store.findByOperation(ROOM, "op-1"))?.id, "turn-1");

	const restarted = new ParticipantTurnStore(root);
	assert.equal((await restarted.get(ROOM, "turn-1"))?.operationId, "op-1");
	await assert.rejects(
		() => store.admit(ROOM, newTurn({ id: "turn-2" })),
		RoomTurnConflictError,
	);
});

test("ParticipantTurnStore: 状态机与终态投影校验", async () => {
	const { store } = freshStore();
	await store.admit(ROOM, newTurn());
	const running = await store.update(ROOM, "turn-1", { status: "running", execution: { kind: "native_pi" } });
	assert.equal(running.status, "running");
	await assert.rejects(
		() => store.update(ROOM, "turn-1", { status: "completed" }),
		"completed 必须有 finalContent",
	);
	const completed = await store.update(ROOM, "turn-1", { status: "completed", finalContent: "最终结论" });
	assert.equal(completed.status, "completed");
	assert.equal(completed.publicProjectionState, "pending");
	const projected = await store.update(ROOM, "turn-1", { publicProjectionState: "projected" });
	assert.equal(projected.publicProjectionState, "projected");
	await assert.rejects(
		() => store.update(ROOM, "turn-1", { status: "running" }),
		RoomTurnConflictError,
	);
});

test("ParticipantTurnStore: 首输入 normal，followUp 追加且同键回放", async () => {
	const { store } = freshStore();
	await store.admit(ROOM, newTurn());
	const first = await store.appendInput(ROOM, "turn-1", input());
	assert.equal(first.created, true);
	const replay = await store.appendInput(ROOM, "turn-1", input());
	assert.equal(replay.created, false);
	const follow = await store.appendInput(ROOM, "turn-1", input({ operationId: "op-2", delivery: "followUp", sourceRoomEventId: "event-2", contextThroughRoomEventId: "event-2" }));
	assert.equal(follow.created, true);
	assert.deepEqual(follow.turn.inputs.map((item) => item.operationId), ["op-1", "op-2"]);
});

test("ParticipantTurnStore: 同一 Turn 不能有两个 normal 输入，终态后不能再追加", async () => {
	const { store } = freshStore();
	await store.admit(ROOM, newTurn());
	await store.appendInput(ROOM, "turn-1", input());
	await assert.rejects(
		() => store.appendInput(ROOM, "turn-1", input({ operationId: "op-2" })),
		RoomTurnConflictError,
	);
	await store.update(ROOM, "turn-1", { status: "cancelled", terminalReason: "用户停止" });
	await assert.rejects(
		() => store.appendInput(ROOM, "turn-1", input({ operationId: "op-3", delivery: "followUp" })),
		RoomTurnConflictError,
	);
});

test("ParticipantTurnStore: 损坏的 turns.json fail-closed", async () => {
	const { store, root } = freshStore();
	await store.admit(ROOM, newTurn());
	writeFileSync(path.join(root, ROOM, "turns.json"), "{not-json}\n");
	await assert.rejects(() => store.list(ROOM), RoomTurnStoreRecoveryRequiredError);
	writeFileSync(path.join(root, ROOM, "turns.json"), JSON.stringify({ "turn-1": { id: "turn-2" } }) + "\n");
	await assert.rejects(() => store.list(ROOM), RoomTurnStoreRecoveryRequiredError);
});

test("ParticipantTurnStore: 未找到 Turn 明确失败", async () => {
	const { store } = freshStore();
	await assert.rejects(() => store.update(ROOM, "turn-x", { status: "running" }), RoomTurnNotFoundError);
	await assert.rejects(() => store.appendInput(ROOM, "turn-x", input()), RoomTurnNotFoundError);
});

test("ParticipantTurnStore: 原子写后文件可被重新读取", async () => {
	const { store, root } = freshStore();
	await store.admit(ROOM, newTurn());
	const text = readFileSync(path.join(root, ROOM, "turns.json"), "utf8");
	assert.match(text, /"turn-1"/);
	assert.equal(JSON.parse(text)["turn-1"].status, "admitted");
});
