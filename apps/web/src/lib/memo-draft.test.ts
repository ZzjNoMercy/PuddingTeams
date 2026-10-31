import assert from "node:assert/strict";
import { test } from "node:test";
import { clearMemoDraftIfMatches, memoDraftKey, operationIdFor, parseMemoDraft, readMemoDraft, safeSessionStorage, writeMemoDraft, type DraftStorage } from "./memo-draft";

function storage(seed: Record<string, string> = {}, deny = false): DraftStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(seed));
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => { if (deny) throw new Error("denied"); data.set(key, value); },
		removeItem: (key) => { data.delete(key); },
	};
}

test("memo 草稿：非法 JSON 与存储拒绝都不抛错", () => {
	assert.equal(parseMemoDraft("{bad"), null);
	assert.equal(parseMemoDraft(JSON.stringify({ text: 1, operationId: "x" })), null);
	assert.equal(readMemoDraft(storage({ k: "not json" }), "k"), null);
	assert.doesNotThrow(() => writeMemoDraft(storage({}, true), "k", { text: "a", operationId: "o" }));
	assert.equal(readMemoDraft(storage(), "k"), null);
});

test("memo 草稿：key 绑定身份，写入后可读", () => {
	const store = storage();
	const key = memoDraftKey("t1", "u1");
	assert.notEqual(key, memoDraftKey("t2", "u1"));
	writeMemoDraft(store, key, { text: "半句", operationId: "op-1" });
	assert.deepEqual(readMemoDraft(store, key), { text: "半句", operationId: "op-1" });
});

test("memo 草稿：删除只在当前草稿仍等于已提交正文时发生", () => {
	const store = storage();
	const key = memoDraftKey("t", "u");
	writeMemoDraft(store, key, { text: "已提交", operationId: "op-1" });
	assert.equal(clearMemoDraftIfMatches(store, key, { text: "别的正文", operationId: "op-1" }), false);
	assert.deepEqual(readMemoDraft(store, key), { text: "已提交", operationId: "op-1" });
	assert.equal(clearMemoDraftIfMatches(store, key, { text: "已提交", operationId: "op-2" }), false, "同正文不同 operationId 不得清理");
	assert.equal(clearMemoDraftIfMatches(store, key, { text: "已提交", operationId: "op-1" }), true);
	assert.equal(readMemoDraft(store, key), null);
	// 迟到响应：用户已经改了正文，就不能清掉新草稿。
	writeMemoDraft(store, key, { text: "后来输入", operationId: "op-2" });
	assert.equal(clearMemoDraftIfMatches(store, key, { text: "旧正文", operationId: "op-3" }), false);
	assert.deepEqual(readMemoDraft(store, key), { text: "后来输入", operationId: "op-2" });
});

test("memo 草稿：正文不变复用 operationId，正文变化换新身份", () => {
	const previous = { text: "相同", operationId: "op-same" };
	assert.equal(operationIdFor("相同", previous), "op-same");
	const next = operationIdFor("改了", previous);
	assert.notEqual(next, "op-same");
	assert.equal(operationIdFor("相同", null).length > 0, true);
});

test("memo 草稿：storage 访问器被拒绝时返回 null 而不是抛错", () => {
	// node 测试里没有 window；helper 必须安全降级而不是抛 ReferenceError。
	assert.equal(safeSessionStorage(), null);
});
