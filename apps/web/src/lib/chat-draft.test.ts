import { test } from "node:test";
import assert from "node:assert/strict";
import { clearSubmittedChatDraft, loadChatAttachmentDraft, loadChatDraft, removeSubmittedChatAttachments, saveChatAttachmentDraft, saveChatDraft } from "./chat-draft";

test("存储拒绝时同标签 A→B→A 草稿保持隔离，清空后不复现", () => {
	const denied = () => { throw new Error("storage denied"); };
	const a = `chat-draft-test-a-${crypto.randomUUID()}`;
	const b = `chat-draft-test-b-${crypto.randomUUID()}`;
	saveChatDraft(a, "A 的未发送正文", denied);
	saveChatDraft(b, "B 的未发送正文", denied);
	assert.equal(loadChatDraft(a, denied), "A 的未发送正文");
	assert.equal(loadChatDraft(b, denied), "B 的未发送正文");
	saveChatDraft(a, "", denied);
	assert.equal(loadChatDraft(a, denied), "");
	assert.equal(loadChatDraft(b, denied), "B 的未发送正文");
});

test("首次读取存储后在同标签内保持最新编辑", () => {
	const key = `chat-draft-test-${crypto.randomUUID()}`;
	const values = new Map([[key, "old"]]);
	const storage = () => ({ getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); } });
	assert.equal(loadChatDraft(key, storage), "old");
	saveChatDraft(key, "new", storage);
	assert.equal(loadChatDraft(key, storage), "new");
	assert.equal(values.get(key), "new");
});

test("发送确认只清除本次正文，保留等待期间的新编辑", () => {
	const key = `chat-draft-test-${crypto.randomUUID()}`;
	const values = new Map<string, string>();
	const storage = () => ({ getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); } });
	saveChatDraft(key, "first", storage);
	clearSubmittedChatDraft(key, "first", "next", storage);
	assert.equal(loadChatDraft(key, storage), "first");
	saveChatDraft(key, "next", storage);
	assert.equal(loadChatDraft(key, storage), "next");
	clearSubmittedChatDraft(key, "next", "next", storage);
	assert.equal(loadChatDraft(key, storage), "");
	assert.equal(values.get(key), "");
});

test("同标签附件按会话隔离，发送确认移除已提交文件并保留新添加文件", () => {
	const a = `chat-attachment-a-${crypto.randomUUID()}`;
	const b = `chat-attachment-b-${crypto.randomUUID()}`;
	const first = new File(["first"], "first.txt", { type: "text/plain" });
	const next = new File(["next"], "next.txt", { type: "text/plain" });
	const other = new File(["other"], "other.txt", { type: "text/plain" });
	saveChatAttachmentDraft(a, [{ id: "1", file: first }]);
	saveChatAttachmentDraft(b, [{ id: "2", file: other }]);
	assert.deepEqual(loadChatAttachmentDraft(a), [first]);
	assert.deepEqual(loadChatAttachmentDraft(b), [other]);
	removeSubmittedChatAttachments(a, [first], [{ id: "1", file: first }, { id: "3", file: next }]);
	assert.deepEqual(loadChatAttachmentDraft(a), [next]);
	assert.deepEqual(loadChatAttachmentDraft(b), [other]);
});
