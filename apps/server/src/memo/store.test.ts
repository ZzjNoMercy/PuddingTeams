import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoError, parseMemoTags } from "./contracts.js";
import { MemoStore } from "./store.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-memo-"));
	const directory = path.join(root, "memo");
	return { root, directory, store: new MemoStore(directory), close: () => rm(root, { recursive: true, force: true }) };
}

const code = (expected: string) => (error: unknown) => error instanceof MemoError && error.code === expected;

test("memo store：正文原样保存，标签规范化去重，operationId 重放与异载荷冲突", async () => {
	const { store, close } = await fixture();
	try {
		const text = "  记一条 #产品 #产品 #设计，后 #审核  ";
		const created = store.create("local:a", { operationId: "op-1", text });
		assert.equal(created.memo.text, text);
		assert.deepEqual(created.memo.tags, ["产品", "设计", "审核"]);
		assert.equal(created.memo.lifecycle, "unorganized");
		assert.equal(created.memo.revision, 1);
		const replay = store.create("local:a", { operationId: "op-1", text });
		assert.equal(replay.replayed, true);
		assert.equal(replay.memo.id, created.memo.id);
		assert.throws(() => store.create("local:a", { operationId: "op-1", text: "不同正文" }), code("conflict"));
		assert.throws(() => store.create("local:a", { operationId: "op-1", text: "   " }), code("invalid_input"));
	} finally { await close(); }
});

test("memo store：标签边界、数量与长度上限", () => {
	assert.deepEqual(parseMemoTags("中文 #标签、括号（#括号）与 #a-b_c"), ["标签", "括号", "a-b_c"]);
	assert.deepEqual(parseMemoTags("紧贴#不是标签"), []);
	assert.deepEqual(parseMemoTags("abc#不是标签"), []);
	assert.deepEqual(parseMemoTags("# 空"), []);
	const many = Array.from({ length: 20 }, (_, index) => `#t${index}`).join(" ");
	assert.equal(parseMemoTags(many).length, 16);
	assert.deepEqual(parseMemoTags(`#${"长".repeat(33)} #ok`), ["ok"]);
	assert.deepEqual(parseMemoTags("#ＡＢＣ"), ["ABC"]);
});

test("memo store：revision CAS、编辑重算标签、整理中禁止修改", async () => {
	const { store, close } = await fixture();
	try {
		const { memo } = store.create("local:a", { operationId: "op-1", text: "#旧 内容" });
		const updated = store.update("local:a", memo.id, { text: "#新 内容", expectedRevision: 1 });
		assert.deepEqual(updated.tags, ["新"]);
		assert.equal(updated.revision, 2);
		assert.throws(() => store.update("local:a", memo.id, { text: "再改", expectedRevision: 1 }), code("conflict"));
		store.reservePromotion("local:a", { operationId: "op-promote", memoIds: [memo.id], bindingId: "b1", task: "整理" });
		assert.throws(() => store.update("local:a", memo.id, { text: "锁定后修改", expectedRevision: 2 }), code("conflict"));
		assert.throws(() => store.remove("local:a", memo.id, { operationId: "op-delete", expectedRevision: 2 }), code("conflict"));
	} finally { await close(); }
});

test("memo store：筛选、标签计数与不受筛选影响的权威 counts", async () => {
	const { store, close } = await fixture();
	try {
		const first = store.create("local:a", { operationId: "op-1", text: "阅读笔记 #读书" }).memo;
		const second = store.create("local:a", { operationId: "op-2", text: "产品判断 #产品 #读书" }).memo;
		store.create("local:a", { operationId: "op-3", text: "第三条 #产品" });
		store.reservePromotion("local:a", { operationId: "op-move", memoIds: [second.id], bindingId: "b1", task: "整理" });

		const unorganized = store.list("local:a", {});
		assert.equal(unorganized.counts.unorganized, 2);
		assert.equal(unorganized.counts.promoting, 1);
		assert.equal(unorganized.counts.organized, 0);
		assert.equal(unorganized.counts.all, 3);
		assert.ok(unorganized.items.every((memo) => memo.lifecycle === "unorganized"));
		assert.deepEqual(unorganized.tags, [{ tag: "产品", count: 2 }, { tag: "读书", count: 2 }]);

		const byTag = store.list("local:a", { filter: "all", tag: "产品" });
		assert.equal(byTag.items.length, 2);
		assert.equal(byTag.counts.all, 3);

		const promoting = store.list("local:a", { filter: "promoting" });
		assert.deepEqual(promoting.items.map((memo) => memo.id), [second.id]);

		const found = store.list("local:a", { filter: "all", q: "阅读" });
		assert.deepEqual(found.items.map((memo) => memo.id), [first.id]);
		assert.equal(store.list("local:a", { filter: "all", q: "%" }).items.length, 0);
	} finally { await close(); }
});

test("memo store：同秒按 id 稳定排序，游标分页不重不漏", async () => {
	const { store, directory, close } = await fixture();
	try {
		const ids = ["op-1", "op-2", "op-3"].map((operationId) => store.create("local:a", { operationId, text: operationId }).memo.id);
		const db = new DatabaseSync(path.join(directory, "memo.sqlite"));
		try {
			const stamp = "2026-10-27T00:00:00.000Z";
			for (const id of ids) db.prepare("UPDATE memos SET created_at=? WHERE id=?").run(stamp, id);
		} finally { db.close(); }
		const page1 = store.list("local:a", { limit: 2 });
		assert.equal(page1.items.length, 2);
		assert.ok(page1.nextBefore);
		const page2 = store.list("local:a", { limit: 2, before: page1.nextBefore! });
		assert.equal(page2.items.length, 1);
		assert.equal(page2.nextBefore, null);
		assert.deepEqual([...page1.items, ...page2.items].map((memo) => memo.id), [...ids].sort().reverse());
		assert.throws(() => store.list("local:a", { before: "not-a-cursor" }), code("invalid_input"));
	} finally { await close(); }
});

test("memo store：软删除与恢复都保留历史，跨 owner 不可见", async () => {
	const { store, close } = await fixture();
	try {
		const { memo } = store.create("local:a", { operationId: "op-1", text: "待删除 #测试" });
		const removed = store.remove("local:a", memo.id, { operationId: "op-del", expectedRevision: 1 });
		assert.ok(removed.memo.deletedAt);
		assert.equal(removed.memo.revision, 2);
		assert.equal(store.list("local:a", {}).counts.all, 0);
		assert.equal(store.remove("local:a", memo.id, { operationId: "op-del", expectedRevision: 1 }).replayed, true);
		assert.throws(() => store.remove("local:a", memo.id, { operationId: "op-del-2", expectedRevision: 2 }), code("conflict"));
		const restored = store.restore("local:a", memo.id, { operationId: "op-restore" });
		assert.equal(restored.memo.revision, 3);
		assert.equal(store.list("local:a", {}).counts.all, 1);
		assert.throws(() => store.restore("local:a", memo.id, { operationId: "op-restore-2" }), code("conflict"));
		assert.throws(() => store.get("local:b", memo.id), code("not_found"));
		assert.equal(store.list("local:b", {}).counts.all, 0);
	} finally { await close(); }
});

test("memo store：整批锁定保存快照，重复 reserve 返回同一 attempt", async () => {
	const { store, close } = await fixture();
	try {
		const a = store.create("local:a", { operationId: "op-1", text: "第一条 #x" }).memo;
		const b = store.create("local:a", { operationId: "op-2", text: "第二条" }).memo;
		const reserved = store.reservePromotion("local:a", { operationId: "op-p", memoIds: [a.id, b.id], bindingId: "b1", task: " 整理这些 " });
		assert.equal(reserved.replayed, false);
		assert.equal(reserved.promotion.phase, "freezing");
		assert.equal(reserved.promotion.task, "整理这些");
		assert.deepEqual(reserved.promotion.items.map((item) => item.memoId), [a.id, b.id]);
		assert.deepEqual(reserved.promotion.items[0]!.tags, ["x"]);
		const again = store.reservePromotion("local:a", { operationId: "op-p", memoIds: [a.id, b.id], bindingId: "b1", task: "整理这些" });
		assert.equal(again.replayed, true);
		assert.equal(again.promotion.requestHash, reserved.promotion.requestHash);
		assert.throws(() => store.reservePromotion("local:a", { operationId: "op-q", memoIds: [a.id], bindingId: "b1", task: "另一个" }), code("conflict"));
		assert.throws(() => store.reservePromotion("local:a", { operationId: "op-r", memoIds: [a.id, a.id], bindingId: "b1", task: "重复" }), code("invalid_input"));
	} finally { await close(); }
});

test("memo store：创建重放在软删除后仍返回同一条记录", async () => {
	const { store, close } = await fixture();
	try {
		const { memo } = store.create("local:a", { operationId: "op-1", text: "重放" });
		store.remove("local:a", memo.id, { operationId: "op-del", expectedRevision: 1 });
		const replay = store.create("local:a", { operationId: "op-1", text: "重放" });
		assert.equal(replay.replayed, true);
		assert.equal(replay.memo.id, memo.id);
		assert.ok(replay.memo.deletedAt);
	} finally { await close(); }
});

test("memo store：不同写操作不能复用同一个 operationId", async () => {
	const { store, close } = await fixture();
	try {
		const { memo } = store.create("local:a", { operationId: "shared-op", text: "第一条" });
		assert.throws(
			() => store.reservePromotion("local:a", { operationId: "shared-op", memoIds: [memo.id], bindingId: "b1", task: "整理" }),
			code("conflict"),
		);
		const second = store.create("local:a", { operationId: "op-create", text: "第二条" }).memo;
		assert.throws(() => store.remove("local:a", second.id, { operationId: "op-create", expectedRevision: 1 }), code("conflict"));
		store.remove("local:a", second.id, { operationId: "op-del", expectedRevision: 1 });
		store.restore("local:a", second.id, { operationId: "op-restore" });
		store.remove("local:a", second.id, { operationId: "op-del-2", expectedRevision: 3 });
		const replay = store.restore("local:a", second.id, { operationId: "op-restore" });
		assert.equal(replay.replayed, true);
		assert.ok(replay.memo.deletedAt, "重放恢复不能把后来删除的记录再次复活");
	} finally { await close(); }
});

test("memo store：过期的终态回写不能释放属于新 attempt 的速记", async () => {
	const { store, close } = await fixture();
	try {
		const memo = store.create("local:a", { operationId: "op-a", text: "第一条" }).memo;
		store.reservePromotion("local:a", { operationId: "op-A", memoIds: [memo.id], bindingId: "b1", task: "旧" });
		store.releaseMemos("local:a", [memo.id], "op-A", "旧任务失败");
		assert.equal(store.get("local:a", memo.id).lifecycle, "unorganized");
		store.reservePromotion("local:a", { operationId: "op-B", memoIds: [memo.id], bindingId: "b1", task: "新" });
		// 旧投影晚到：必须跳过，不能把 op-B 的锁定释放掉。
		store.releaseMemos("local:a", [memo.id], "op-A", "迟到的旧失败");
		store.completeMemos("local:a", [memo.id], "op-A", "published");
		const current = store.get("local:a", memo.id);
		assert.equal(current.lifecycle, "promoting");
		assert.equal(current.currentOperationId, "op-B");
		assert.equal(current.lastError, undefined);
	} finally { await close(); }
});

test("memo store：adoptJob 不能抢走新 attempt、已整理或已被编辑的速记", async () => {
	const { store, close } = await fixture();
	try {
		const memo = store.create("local:a", { operationId: "op-a", text: "第一条" }).memo;
		store.reservePromotion("local:a", { operationId: "op-A", memoIds: [memo.id], bindingId: "b1", task: "旧" });
		store.failPromotion("local:a", "op-A", "失败");
		// 用户已经用新 operationId 重新整理。
		store.reservePromotion("local:a", { operationId: "op-B", memoIds: [memo.id], bindingId: "b1", task: "新" });
		assert.throws(() => store.adoptJob("local:a", "op-A", "job-foreign"), code("conflict"));
		assert.equal(store.get("local:a", memo.id).currentOperationId, "op-B");

		// 释放后被编辑：旧快照不能重新锁定。
		store.releaseMemos("local:a", [memo.id], "op-B", "新任务失败");
		store.update("local:a", memo.id, { text: "用户改过", expectedRevision: 1 });
		assert.throws(() => store.adoptJob("local:a", "op-A", "job-foreign"), code("conflict"));
		assert.equal(store.get("local:a", memo.id).lifecycle, "unorganized");

		// 已整理条目不能被旧 attempt 拉回 promoting。
		const done = store.create("local:a", { operationId: "op-c", text: "第二条" }).memo;
		store.reservePromotion("local:a", { operationId: "op-C", memoIds: [done.id], bindingId: "b1", task: "整理" });
		store.failPromotion("local:a", "op-C", "失败");
		store.reservePromotion("local:a", { operationId: "op-D", memoIds: [done.id], bindingId: "b1", task: "整理" });
		store.completeMemos("local:a", [done.id], "op-D", "published");
		assert.throws(() => store.adoptJob("local:a", "op-C", "job-old"), code("conflict"));
		assert.equal(store.get("local:a", done.id).lifecycle, "organized");
	} finally { await close(); }
});
