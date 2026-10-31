import { test } from "node:test";
import assert from "node:assert";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	RoomEventConflictError,
	RoomEventStore,
	RoomSessionNotFoundError,
	RoomSessionRecoveryRequiredError,
	type RoomEventDraft,
} from "./room-event-store.js";

function freshStore(): { store: RoomEventStore; root: string } {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-events-"));
	return { store: new RoomEventStore(root), root };
}

const ROOM = "room-1111-2222";

function draft(overrides: Partial<RoomEventDraft> = {}): RoomEventDraft {
	return {
		id: overrides.id ?? "event-1",
		kind: "message",
		actor: { kind: "user" },
		content: "请检查这个方案",
		mentions: ["worker-a"],
		createdAt: "2026-10-31T00:00:00.000Z",
		...overrides,
	};
}

test("RoomEventStore: 创建、追加、seq 连续与重启回读", async () => {
	const { store, root } = freshStore();
	const created = await store.create(ROOM);
	assert.equal(created.created, true);
	assert.equal((await store.read(ROOM)).length, 0);

	const first = await store.append(ROOM, draft({ attachments: [{
		name: "方案.pdf", path: "/tmp/方案.pdf", mediaType: "application/pdf", size: 12,
		sha256: "a".repeat(64), kind: "file",
	}] }));
	assert.equal(first.seq, 1);
	const second = await store.append(ROOM, draft({
		id: "event-2", actor: { kind: "agent", agentId: "worker-a" }, content: "已完成", mentions: [],
	}));
	assert.equal(second.seq, 2);

	const restarted = new RoomEventStore(root);
	const events = await restarted.read(ROOM);
	assert.deepEqual(events.map((event) => event.seq), [1, 2]);
	assert.deepEqual(events.map((event) => event.id), ["event-1", "event-2"]);
	assert.equal(events[0]!.attachments?.[0]?.name, "方案.pdf");

	const third = await restarted.append(ROOM, draft({ id: "event-3", kind: "terminal", content: "已取消", mentions: [] }));
	assert.equal(third.seq, 3);
});

test("RoomEventStore: 同一 room 的并发追加串行且 seq 不重复", async () => {
	const { store } = freshStore();
	await store.create(ROOM);
	const events = await Promise.all(Array.from({ length: 25 }, (_, index) => store.append(ROOM, draft({
		id: `event-${index + 1}`,
		content: `消息 ${index + 1}`,
	}))));
	assert.deepEqual(events.map((event) => event.seq).sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index + 1));
	const loaded = await store.read(ROOM);
	assert.equal(loaded.length, 25);
	assert.equal(new Set(loaded.map((event) => event.id)).size, 25);
});

test("RoomEventStore: 同一 sourceParticipantTurnId 幂等投影", async () => {
	const { store } = freshStore();
	await store.create(ROOM);
	const projection = draft({
		id: "event-final", actor: { kind: "agent", agentId: "worker-a" }, content: "结论", mentions: [],
		sourceParticipantTurnId: "turn-1",
	});
	const first = await store.appendIdempotent(ROOM, projection);
	const second = await store.appendIdempotent(ROOM, { ...projection, id: "event-final-retry" });
	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal(second.event.id, "event-final");
	assert.equal((await store.read(ROOM)).length, 1);

	await assert.rejects(
		() => store.appendIdempotent(ROOM, { ...projection, content: "另一段结论" }),
		RoomEventConflictError,
	);
});

test("RoomEventStore: 显式 event id 重复且内容不同必须冲突", async () => {
	const { store } = freshStore();
	await store.create(ROOM);
	await store.append(ROOM, draft());
	await assert.rejects(
		() => store.append(ROOM, draft({ content: "不同正文" })),
		RoomEventConflictError,
	);
	await assert.rejects(
		() => store.appendIdempotent(ROOM, draft({ content: "不同正文" })),
		RoomEventConflictError,
	);
});

test("RoomEventStore: 完整坏行/重复 id/不连续 seq 进入 recovery_required", async () => {
	const { store, root } = freshStore();
	await store.create(ROOM);
	await store.append(ROOM, draft());
	const file = path.join(root, ROOM, "events.jsonl");

	appendFileSync(file, "{not-json}\n");
	await assert.rejects(() => store.read(ROOM), RoomSessionRecoveryRequiredError);
	await assert.rejects(() => store.append(ROOM, draft({ id: "event-x" })), RoomSessionRecoveryRequiredError);
});

test("RoomEventStore: 未完成的尾行不被静默跳过", async () => {
	const { store, root } = freshStore();
	await store.create(ROOM);
	await store.append(ROOM, draft());
	appendFileSync(path.join(root, ROOM, "events.jsonl"), "{\"id\":\"torn");
	await assert.rejects(() => store.read(ROOM), RoomSessionRecoveryRequiredError);
});

test("RoomEventStore: 重复 id 与 seq 断裂都 fail-closed", async () => {
	const { store, root } = freshStore();
	await store.create(ROOM);
	await store.append(ROOM, draft());
	await store.append(ROOM, draft({ id: "event-2", content: "第二条" }));
	const file = path.join(root, ROOM, "events.jsonl");
	const lines = readFileSync(file, "utf8").trimEnd().split("\n");
	const second = JSON.parse(lines[1]!) as Record<string, unknown>;
	writeFileSync(file, `${lines[0]}\n${JSON.stringify({ ...second, id: "event-1" })}\n`);
	await assert.rejects(() => store.read(ROOM), RoomSessionRecoveryRequiredError);

	writeFileSync(file, `${lines[0]}\n${JSON.stringify({ ...second, seq: 3 })}\n`);
	await assert.rejects(() => store.read(ROOM), RoomSessionRecoveryRequiredError);
});

test("RoomEventStore: snapshot 按 afterSeq/limit 增量读取", async () => {
	const { store } = freshStore();
	await store.create(ROOM);
	for (let index = 1; index <= 5; index += 1) {
		await store.append(ROOM, draft({ id: `event-${index}`, content: `消息 ${index}` }));
	}
	const page = await store.snapshot(ROOM, { afterSeq: 2, limit: 2 });
	assert.deepEqual(page.events.map((event) => event.seq), [3, 4]);
	assert.equal(page.throughSeq, 4);
	assert.equal(page.nextSeq, 4);
	const tail = await store.snapshot(ROOM, { afterSeq: 4 });
	assert.deepEqual(tail.events.map((event) => event.seq), [5]);
	assert.equal(tail.nextSeq, undefined);
	await assert.rejects(() => store.snapshot(ROOM, { afterSeq: 6 }), RoomEventConflictError);
});

test("RoomEventStore: 未创建的 RoomSession 明确 not found", async () => {
	const { store } = freshStore();
	await assert.rejects(() => store.read("room-1111-2222"), RoomSessionNotFoundError);
	await assert.rejects(() => store.append("room-1111-2222", draft()), RoomSessionNotFoundError);
});

test("RoomEventStore: fork 复制公共事件但不复用 id", async () => {
	const { store } = freshStore();
	await store.create(ROOM);
	await store.append(ROOM, draft());
	await store.append(ROOM, draft({ id: "event-2", actor: { kind: "agent", agentId: "worker-a" }, content: "结论", mentions: [] }));
	const copied = await store.fork(ROOM, "room-3333-4444");
	assert.equal(copied.length, 2);
	assert.deepEqual(copied.map((event) => event.seq), [1, 2]);
	assert.notEqual(copied[0]!.id, "event-1");
	assert.equal((await store.read("room-3333-4444")).length, 2);
	await assert.rejects(() => store.fork(ROOM, "room-3333-4444"), RoomEventConflictError);
});

test("RoomEventStore: 删除后不再可读", async () => {
	const { store } = freshStore();
	await store.create(ROOM);
	await store.append(ROOM, draft());
	await store.remove(ROOM);
	await assert.rejects(() => store.read(ROOM), RoomSessionNotFoundError);
});

test("RoomEventStore: 非法 roomSessionId 不触碰文件系统", async () => {
	const { store } = freshStore();
	await assert.rejects(() => store.create("../escape"), RoomSessionNotFoundError);
});

test("RoomEventDraft 校验失败时不产生半条事件", async () => {
	const { store } = freshStore();
	await store.create(ROOM);
	await assert.rejects(() => store.append(ROOM, draft({ mentions: ["a", "a"] })), RoomEventConflictError);
	await assert.rejects(() => store.append(ROOM, draft({ id: "" })), RoomEventConflictError);
	assert.equal((await store.read(ROOM)).length, 0);
});
