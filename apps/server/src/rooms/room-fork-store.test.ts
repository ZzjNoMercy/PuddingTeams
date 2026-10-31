import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomForkStore } from "./room-fork-store.js";

test("RoomForkStore: 阶段只前进，支持列表与重启读取", async () => {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "pt-fork-store-")), "forks.json");
	const store = new RoomForkStore(file);
	const key = "fork-operation-1";
	const reserved = await store.reserve({
		key, sourceRoomSessionId: "source-room-1", throughEventSeq: 2,
		targetRoomSessionId: "target-room-1", managerAgentSessionId: "manager-session-1",
	});
	assert.equal(reserved.created, true);
	assert.equal(reserved.operation.phase, "reserved");
	await store.advance(key, "snapshot_saved");
	await store.advance(key, "session_saved");
	const attached = await store.markAttached(key);
	assert.equal(attached.phase, "attached");
	// 不允许倒退。
	assert.equal((await store.advance(key, "snapshot_saved")).phase, "attached");
	const restarted = new RoomForkStore(file);
	assert.equal((await restarted.get(key))?.phase, "attached");
	assert.equal((await restarted.list()).length, 1);
	const replay = await restarted.reserve({ key, sourceRoomSessionId: "source-room-1", throughEventSeq: 2, targetRoomSessionId: "other-room-1", managerAgentSessionId: "other-manager-1" });
	assert.equal(replay.created, false);
	assert.equal(replay.operation.targetRoomSessionId, "target-room-1");
});
