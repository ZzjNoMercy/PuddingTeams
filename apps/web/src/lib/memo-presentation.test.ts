import assert from "node:assert/strict";
import { test } from "node:test";
import type { Memo } from "./memos";
import { canEditMemo, canSelectMemo, groupMemosByDay, memoDayLabel, memoStatusTone, parseMemoTags } from "./memo-presentation";

const memo = (patch: Partial<Memo>): Memo => ({
	id: "m1", text: "正文", tags: [], lifecycle: "unorganized",
	createdAt: "2026-10-27T10:00:00+08:00", updatedAt: "", revision: 1,
	display: { state: "draft", label: "未整理", locked: false }, ...patch,
});

test("memo 展示：标签解析与正文不改写", () => {
	assert.deepEqual(parseMemoTags("记录 #产品 #产品 与 #设计，以及 #a-b"), ["产品", "设计", "a-b"]);
	assert.deepEqual(parseMemoTags("紧贴#不是标签"), []);
	assert.equal(parseMemoTags("#标签").length, 1);
	const text = "#产品 原文  两个空格";
	assert.equal(memo({ text }).text, text);
});

test("memo 展示：今天/昨天/跨月分组", () => {
	const now = new Date("2026-10-27T12:00:00+08:00");
	assert.equal(memoDayLabel("2026-10-27T09:00:00+08:00", now), "今天");
	assert.equal(memoDayLabel("2026-10-26T23:59:00+08:00", now), "昨天");
	assert.equal(memoDayLabel("2026-09-30T10:00:00+08:00", now), "9 月 30 日");
	const groups = groupMemosByDay([
		memo({ id: "a", createdAt: "2026-10-27T09:00:00+08:00" }),
		memo({ id: "b", createdAt: "2026-10-27T08:00:00+08:00" }),
		memo({ id: "c", createdAt: "2026-10-26T09:00:00+08:00" }),
	], now);
	assert.deepEqual(groups.map((group) => group.label), ["今天", "昨天"]);
	assert.deepEqual(groups[0]!.items.map((item) => item.id), ["a", "b"]);
});

test("memo 展示：生命周期与显示状态共同决定可编辑/可提交", () => {
	assert.equal(canEditMemo(memo({})), true);
	assert.equal(canSelectMemo(memo({})), true);
	for (const state of ["queued", "running", "submitting", "pending_review", "approved", "publishing", "returned", "conflict", "partial", "candidate_registration_failed", "needs_attention"] as const) {
		assert.equal(canEditMemo(memo({ lifecycle: "promoting", display: { state, label: state, locked: true } })), false, state);
		assert.equal(canSelectMemo(memo({ lifecycle: "promoting", display: { state, label: state, locked: true } })), false, state);
	}
	assert.equal(canEditMemo(memo({ lifecycle: "organized", display: { state: "published", label: "已发布", locked: false } })), false);
	assert.equal(memoStatusTone("published"), "done");
	assert.equal(memoStatusTone("pending_review"), "review");
	assert.equal(memoStatusTone("failed"), "danger");
	assert.equal(memoStatusTone("draft"), "neutral");
});
