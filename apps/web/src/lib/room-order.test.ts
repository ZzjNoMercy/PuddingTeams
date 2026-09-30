import { test } from "node:test";
import assert from "node:assert/strict";
import { preferCurrentRoomSummary, reconcileRoomList, sortRoomsByActivity } from "./room-order.js";

test("本地房间更新沿用服务端的活动时间与同时间 ID 顺序", () => {
	const rooms = [
		{ id: "older", modifiedAt: "2026-09-22T10:00:00.000Z" },
		{ id: "b", modifiedAt: "2026-09-23T10:00:00.000Z" },
		{ id: "invalid", modifiedAt: "invalid" },
		{ id: "a", modifiedAt: "2026-09-23T10:00:00.000Z" },
	];
	assert.deepEqual(sortRoomsByActivity(rooms).map((room) => room.id), ["a", "b", "older", "invalid"]);
	assert.equal(rooms[0]?.id, "older", "本地重排不得修改调用方持有的列表");
});

test("乱序房间响应不能让活动或已读水位倒退", () => {
	const old = { id: "room", activityRevision: 1, readRevision: 0, hasUnreadActivity: false };
	const active = { id: "room", activityRevision: 2, readRevision: 1, hasUnreadActivity: true };
	const read = { id: "room", activityRevision: 2, readRevision: 2, hasUnreadActivity: false };
	assert.equal(preferCurrentRoomSummary(active, old), active);
	assert.equal(preferCurrentRoomSummary(read, active), read);
	assert.equal(preferCurrentRoomSummary(active, read), read);
	assert.equal(preferCurrentRoomSummary(old, active), active);
});

test("两个 Session 的已读最大值不变时，迟到响应不能恢复已清除的未读", () => {
	const oneUnread = { id: "room", activityRevision: 3, readRevision: 3, hasUnreadActivity: true, activitySessionId: "old" };
	const allRead = { id: "room", activityRevision: 3, readRevision: 3, hasUnreadActivity: false, activitySessionId: "new" };
	assert.equal(preferCurrentRoomSummary(oneUnread, allRead), allRead);
	assert.equal(preferCurrentRoomSummary(allRead, oneUnread), allRead);
	const newActivity = { ...oneUnread, activityRevision: 4 };
	assert.equal(preferCurrentRoomSummary(allRead, newActivity), newActivity);
});

test("全量房间回读保持较新摘要，同时以服务端清单决定增删", () => {
	const current = [
		{ id: "active", modifiedAt: "2026-09-26T10:00:00.000Z", activityRevision: 4, readRevision: 4, hasUnreadActivity: false },
		{ id: "deleted", modifiedAt: "2026-09-25T10:00:00.000Z", activityRevision: 1, readRevision: 0, hasUnreadActivity: false },
	];
	const stale = { id: "active", modifiedAt: "2026-09-24T10:00:00.000Z", activityRevision: 3, readRevision: 3, hasUnreadActivity: true };
	const added = { id: "added", modifiedAt: "2026-09-26T09:00:00.000Z", activityRevision: 1, readRevision: 0, hasUnreadActivity: true };
	const reconciled = reconcileRoomList(current, [added, stale]);
	assert.deepEqual(reconciled.map((room) => room.id), ["active", "added"]);
	assert.equal(reconciled[0], current[0]);
	assert.equal(current.length, 2, "回读不得改写调用方列表");
	const newActivity = { ...stale, activityRevision: 5, modifiedAt: "2026-09-26T11:00:00.000Z" };
	assert.equal(reconcileRoomList(current, [newActivity])[0], newActivity);
});
