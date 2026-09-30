import assert from "node:assert/strict";
import test from "node:test";
import { clearChatSendOperation, reserveChatSendOperation } from "./chat-send-operation.js";

test("an uncertain ordinary message keeps its key until explicitly cleared for a new intent", async () => {
	const records = new Map<string, string>();
	const storage = () => ({
		getItem: (key: string) => records.get(key) ?? null,
		setItem: (key: string, value: string) => { records.set(key, value); },
		removeItem: (key: string) => { records.delete(key); },
	});
	const session = `session-${crypto.randomUUID()}`;
	const first = await reserveChatSendOperation(session, "hello", [], storage);
	assert.equal(await reserveChatSendOperation(session, "hello", [], storage), first);
	await assert.rejects(() => reserveChatSendOperation(session, "hello", [{ filename: "file.txt", data: "eA==" }], storage), /旧消息的结果仍未确认/);
	await assert.rejects(() => reserveChatSendOperation(session, "different", [], storage), /旧消息的结果仍未确认/);
	assert.equal(await reserveChatSendOperation(session, "hello", [], storage), first);
	clearChatSendOperation(session, first, storage);
	const changed = await reserveChatSendOperation(session, "different", [], storage);
	assert.notEqual(changed, first);
	clearChatSendOperation(session, changed, storage);
	assert.notEqual(await reserveChatSendOperation(session, "different", [], storage), changed, "confirmed send is a new intent if repeated later");
});

test("a restored uncertain key cannot be replaced by an edited message before explicit review", async () => {
	const records = new Map<string, string>();
	const storage = () => ({
		getItem: (key: string) => records.get(key) ?? null,
		setItem: (key: string, value: string) => { records.set(key, value); },
		removeItem: (key: string) => { records.delete(key); },
	});
	const seededSession = `session-${crypto.randomUUID()}`;
	const restoredSession = `session-${crypto.randomUUID()}`;
	const key = await reserveChatSendOperation(seededSession, "original", [], storage);
	records.set(`puddingteams:message-operation:v1:${restoredSession}`, records.get(`puddingteams:message-operation:v1:${seededSession}`)!);
	await assert.rejects(() => reserveChatSendOperation(restoredSession, "edited", [], storage), /旧消息的结果仍未确认/);
	assert.equal(await reserveChatSendOperation(restoredSession, "original", [], storage), key);
	clearChatSendOperation(restoredSession, key, storage);
	assert.notEqual(await reserveChatSendOperation(restoredSession, "edited", [], storage), key);
});

test("storage denial still reuses an uncertain operation within this tab", async () => {
	const denied = () => { throw new Error("storage denied"); };
	const session = `session-${crypto.randomUUID()}`;
	const first = await reserveChatSendOperation(session, "retry me", [], denied);
	assert.equal(await reserveChatSendOperation(session, "retry me", [], denied), first);
});

test("explicitly discarded operation leaves an invalid tombstone when storage removal is denied", async () => {
	const records = new Map<string, string>();
	const storage = () => ({
		getItem: (key: string) => records.get(key) ?? null,
		setItem: (key: string, value: string) => { records.set(key, value); },
		removeItem: () => { throw new Error("remove denied"); },
	});
	const session = `session-${crypto.randomUUID()}`;
	const first = await reserveChatSendOperation(session, "same draft", [], storage);
	clearChatSendOperation(session, first, storage);
	assert.deepEqual(JSON.parse(records.get(`puddingteams:message-operation:v1:${session}`)!), { discardedKey: first });
	assert.notEqual(await reserveChatSendOperation(session, "same draft", [], storage), first);
});

test("a key restored after page reload is cleared after confirmed replay", async () => {
	const records = new Map<string, string>();
	const storage = () => ({
		getItem: (key: string) => records.get(key) ?? null,
		setItem: (key: string, value: string) => { records.set(key, value); },
		removeItem: (key: string) => { records.delete(key); },
	});
	const seededSession = `session-${crypto.randomUUID()}`;
	const restoredSession = `session-${crypto.randomUUID()}`;
	const first = await reserveChatSendOperation(seededSession, "repeat", [], storage);
	const persisted = records.get(`puddingteams:message-operation:v1:${seededSession}`)!;
	records.set(`puddingteams:message-operation:v1:${restoredSession}`, persisted);
	assert.equal(await reserveChatSendOperation(restoredSession, "repeat", [], storage), first);
	clearChatSendOperation(restoredSession, first, storage);
	assert.equal(records.has(`puddingteams:message-operation:v1:${restoredSession}`), false);
	assert.notEqual(await reserveChatSendOperation(restoredSession, "repeat", [], storage), first,
		"a later identical message is a new user intent");
});
