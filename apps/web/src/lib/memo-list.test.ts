import assert from "node:assert/strict";
import { test } from "node:test";
import type { Memo, MemoList } from "./memos";
import { hasActiveAttempt, mergeMemoPage, mergeMemoStatus, pruneMemoSelection, selectedMemos } from "./memo-list";

const memo = (id: string, patch: Partial<Memo> = {}): Memo => ({
	id, text: id, tags: [], lifecycle: "unorganized",
	createdAt: `2026-10-27T0${id.length}:00:00+08:00`, updatedAt: "", revision: 1,
	display: { state: "draft", label: "未整理", locked: false }, ...patch,
});

const page = (items: Memo[], nextBefore: string | null = null): MemoList => ({
	items, counts: { unorganized: items.length, promoting: 0, organized: 0, all: items.length },
	tags: [], nextBefore,
});

test("memo 列表：首屏替换，游标追加去重，筛选变化丢弃旧页", () => {
	const first = mergeMemoPage(null, page([memo("a"), memo("b")], "cursor-1"));
	assert.deepEqual(first.items.map((item) => item.id), ["a", "b"]);
	const second = mergeMemoPage(first, page([memo("b"), memo("c")]), "cursor-1");
	assert.deepEqual(second.items.map((item) => item.id), ["a", "b", "c"]);
	assert.equal(second.nextBefore, null);
	const replaced = mergeMemoPage(first, page([memo("z")]));
	assert.deepEqual(replaced.items.map((item) => item.id), ["z"]);
});

test("memo 列表：刷新后剔除已不可选的选择", () => {
	const selectable = (item: Memo) => item.lifecycle === "unorganized" && !item.display.locked;
	const items = [memo("a"), memo("b", { lifecycle: "promoting", display: { state: "pending_review", label: "待审核", locked: true } })];
	const pruned = pruneMemoSelection(new Set(["a", "b", "gone"]), items, selectable);
	assert.deepEqual([...pruned], ["a"]);
	assert.deepEqual(selectedMemos(items, pruned).map((item) => item.id), ["a"]);
});

test("memo 列表：存在活动 attempt 时轮询", () => {
	assert.equal(hasActiveAttempt([memo("a")]), false);
	assert.equal(hasActiveAttempt([memo("a", { lifecycle: "promoting", display: { state: "queued", label: "整理中", locked: true } })]), true);
});

test("memo 列表：状态刷新保留已加载页并插入新条目", () => {
	const page1 = [memo("a", { createdAt: "2026-10-27T09:00:00+08:00" }), memo("b", { createdAt: "2026-10-27T08:00:00+08:00" })];
	const page2 = [memo("c", { createdAt: "2026-10-26T09:00:00+08:00" })];
	const previous = mergeMemoPage(mergeMemoPage(null, page([...page1], "cursor")), page(page2), "cursor");
	const refreshed = mergeMemoStatus(previous.items, [
		memo("b", { createdAt: "2026-10-27T08:00:00+08:00", lifecycle: "promoting", display: { state: "pending_review", label: "待审核", locked: true } }),
		memo("d", { createdAt: "2026-10-27T10:00:00+08:00" }),
	]);
	assert.deepEqual(refreshed.map((item) => item.id), ["d", "a", "b", "c"]);
	assert.equal(refreshed.find((item) => item.id === "b")!.display.state, "pending_review");
	assert.equal(refreshed.find((item) => item.id === "c")!.display.state, "draft");
});
