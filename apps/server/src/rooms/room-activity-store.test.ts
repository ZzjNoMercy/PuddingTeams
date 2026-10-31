import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomActivityStore } from "./room-activity-store.js";

test("RoomActivityStore: 活动/未读/已读持久化，坏文件拒绝", async () => {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "pt-room-activity-")), "activity.json");
	const store = new RoomActivityStore(file);
	const room = "room-1111-2222";
	assert.deepEqual(await store.status(room), { readRevision: 0, hasUnreadActivity: false });
	await store.record(room, { eventId: "event-1", at: "2026-10-31T00:00:00.000Z", preview: "你好" });
	let status = await store.status(room);
	assert.equal(status.entry?.revision, 1);
	assert.equal(status.hasUnreadActivity, true);
	await store.markRead(room);
	status = await store.status(room);
	assert.equal(status.hasUnreadActivity, false);
	assert.equal(status.readRevision, 1);
	await store.record(room, { eventId: "event-2", at: "2026-10-31T00:01:00.000Z", preview: "完成" });
	assert.equal((await store.status(room)).hasUnreadActivity, true);
	await assert.rejects(() => store.markRead(room, 0), /activity revision changed/);
	await store.record(room, { eventId: "event-3", at: "2026-10-31T00:02:00.000Z", preview: "自己发送", unread: false });
	status = await store.status(room);
	assert.equal(status.entry?.revision, 2, "自己的消息不推进 revision");
	assert.equal(status.entry?.lastMessagePreview, "自己发送");
	assert.equal(status.hasUnreadActivity, true, "上一轮 Agent final 仍未读");
	const restarted = new RoomActivityStore(file);
	assert.equal((await restarted.status(room)).entry?.lastMessagePreview, "自己发送");
	const raw = JSON.parse(readFileSync(file, "utf8")) as { revisions: Record<string, { revision: number }> };
	assert.equal(raw.revisions[room]!.revision, 2);
});

test("RoomActivityStore: 坏 JSON 拒绝读取", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-room-activity-bad-"));
	const file = path.join(dir, "activity.json");
	await import("node:fs/promises").then((fs) => fs.writeFile(file, "{not-json"));
	await assert.rejects(() => new RoomActivityStore(file).status("room-1111-2222"));
});
