import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomFanoutStore } from "./room-fanout-store.js";

test("RoomFanoutStore: 计划持久化、前进与删除", async () => {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "pt-fanout-")), "plans.json");
	const store = new RoomFanoutStore(file);
	const plan = {
		operationId: "op-fanout-1", roomSessionId: "room-1111-2222", sourceEventId: "event-1",
		targetAgentIds: ["worker-a", "worker-b"], nextIndex: 1, createdAt: "2026-10-31T00:00:00.000Z",
	};
	await store.put(plan);
	const restarted = new RoomFanoutStore(file);
	assert.deepEqual(await restarted.list(), [plan]);
	await restarted.advance(plan.roomSessionId, "op-fanout-1", 2);
	assert.equal((await restarted.list())[0]!.nextIndex, 2);
	await restarted.advance(plan.roomSessionId, "op-fanout-1", 1);
	assert.equal((await restarted.list())[0]!.nextIndex, 2, "nextIndex 只前进");
	await restarted.remove(plan.roomSessionId, "op-fanout-1");
	assert.deepEqual(await restarted.list(), []);
});
