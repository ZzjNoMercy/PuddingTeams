import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPendingManagerWorkAttachments, clearSubmittedManagerWorkAttachments, fingerprintManagerWorkAttachments, loadManagerWorkAttachments, loadPendingManagerWorkAttachments, sameManagerWorkAttachments, saveManagerWorkAttachments, savePendingManagerWorkAttachments, validateManagerWorkAttachments } from "./manager-work-attachments.js";

test("刷新后重选同字节附件可沿原键重试，异内容与元数据不可复用", async () => {
	const original = await fingerprintManagerWorkAttachments([new File(["one"], "same.txt", { type: "text/plain" })]);
	const reselected = await fingerprintManagerWorkAttachments([new File(["one"], "same.txt", { type: "text/plain" })]);
	const changedBytes = await fingerprintManagerWorkAttachments([new File(["two"], "same.txt", { type: "text/plain" })]);
	const changedName = await fingerprintManagerWorkAttachments([new File(["one"], "other.txt", { type: "text/plain" })]);
	const changedType = await fingerprintManagerWorkAttachments([new File(["one"], "same.txt", { type: "application/octet-stream" })]);
	assert.equal(sameManagerWorkAttachments(reselected, original), true);
	assert.equal(sameManagerWorkAttachments(changedBytes, original), false);
	assert.equal(sameManagerWorkAttachments(changedName, original), false);
	assert.equal(sameManagerWorkAttachments(changedType, original), false);
	assert.equal(sameManagerWorkAttachments([], original), false);
	assert.equal(sameManagerWorkAttachments(original, undefined), false);
});

test("非安全上下文没有 SubtleCrypto 时仍能比较同附件，服务器保留最终校验", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
	try {
		const original = await fingerprintManagerWorkAttachments([new File(["one"], "same.txt")]);
		const reselected = await fingerprintManagerWorkAttachments([new File(["one"], "same.txt")]);
		const changed = await fingerprintManagerWorkAttachments([new File(["two"], "same.txt")]);
		assert.match(original[0]!, /^fnv64-[a-f0-9]{16}$/);
		assert.equal(sameManagerWorkAttachments(reselected, original), true);
		assert.equal(sameManagerWorkAttachments(changed, original), false);
	} finally {
		if (previous) Object.defineProperty(globalThis, "crypto", previous);
		else Reflect.deleteProperty(globalThis, "crypto");
	}
});

test("同标签返回项目时只按原操作键恢复待确认附件身份", () => {
	const key = `manager-work-pending-${crypto.randomUUID()}`;
	const original = new File(["one"], "same.txt");
	const replacement = new File(["two"], "same.txt");
	saveManagerWorkAttachments(key, [original]);
	savePendingManagerWorkAttachments(key, "original-op", [original]);
	saveManagerWorkAttachments(key, [replacement]);
	assert.deepEqual(loadManagerWorkAttachments(key), [replacement]);
	assert.deepEqual(loadPendingManagerWorkAttachments(key, "original-op"), [original]);
	assert.equal(loadPendingManagerWorkAttachments(key, "other-op"), null);
	savePendingManagerWorkAttachments(key, "new-op", [replacement]);
	clearPendingManagerWorkAttachments(key, "original-op");
	assert.deepEqual(loadPendingManagerWorkAttachments(key, "new-op"), [replacement]);
	clearPendingManagerWorkAttachments(key, "new-op");
	assert.equal(loadPendingManagerWorkAttachments(key, "new-op"), null);
});

test("首发附件按草稿身份保存，迟到确认只清已提交文件", () => {
	const key = `manager-work-attachments-${crypto.randomUUID()}`;
	const first = new File(["one"], "first.txt");
	const later = new File(["two"], "later.txt");
	saveManagerWorkAttachments(key, [first]);
	assert.deepEqual(loadManagerWorkAttachments(key), [first]);
	saveManagerWorkAttachments(key, [first, later]);
	clearSubmittedManagerWorkAttachments(key, [first]);
	assert.deepEqual(loadManagerWorkAttachments(key), [later]);
	clearSubmittedManagerWorkAttachments(key, [later]);
	assert.deepEqual(loadManagerWorkAttachments(key), []);
});

test("首发附件大小和数量在读取前受限", () => {
	assert.equal(validateManagerWorkAttachments([new File(["x"], "x.txt")]), null);
	assert.match(validateManagerWorkAttachments([new File([], "empty.txt")]) ?? "", /空文件/);
	assert.match(validateManagerWorkAttachments(Array.from({ length: 6 }, (_, index) => new File(["x"], `${index}.txt`))) ?? "", /最多/);
});
