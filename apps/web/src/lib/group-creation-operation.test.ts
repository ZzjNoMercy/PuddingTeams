import { test } from "node:test";
import assert from "node:assert/strict";
import { clearGroupCreationOperation, groupCreationFingerprint, groupWorkspaceSwitchFingerprint, reserveGroupCreationOperation } from "./group-creation-operation.js";

test("群聊响应未知时同成员重选沿用操作键，成功后才允许新意图", () => {
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); },
		removeItem: (key: string) => { data.delete(key); },
	};
	const first = groupCreationFingerprint(["beta", "alpha"], "workspace-a");
	const reordered = groupCreationFingerprint(["alpha", "beta"], "workspace-a");
	assert.equal(first, reordered);
	const key = reserveGroupCreationOperation(first, storage);
	assert.equal(reserveGroupCreationOperation(reordered, storage), key);
	assert.notEqual(reserveGroupCreationOperation(groupCreationFingerprint(["alpha", "beta"], "workspace-b"), storage), key);
	clearGroupCreationOperation(first, "wrong-key", storage);
	assert.equal(reserveGroupCreationOperation(first, storage), key);
	clearGroupCreationOperation(first, key, storage);
	assert.notEqual(reserveGroupCreationOperation(first, storage), key);
});

test("会话存储拒绝时本标签仍保持相同的群聊创建身份", () => {
	const fingerprint = groupCreationFingerprint(["alpha", "gamma"], "");
	const denied = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("denied"); } };
	assert.equal(reserveGroupCreationOperation(fingerprint, denied), reserveGroupCreationOperation(fingerprint, denied));
});

test("跨项目群聊创建的操作身份绑定源房间和目标项目", () => {
	const first = groupWorkspaceSwitchFingerprint("source-a", "workspace-b");
	assert.equal(first, groupWorkspaceSwitchFingerprint("source-a", "workspace-b"));
	assert.notEqual(first, groupWorkspaceSwitchFingerprint("source-a", null));
	assert.notEqual(first, groupWorkspaceSwitchFingerprint("source-c", "workspace-b"));
	assert.notEqual(first, groupCreationFingerprint(["alpha", "beta"], "workspace-b"));
});
