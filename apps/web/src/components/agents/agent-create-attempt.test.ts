import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireAgentCreateAttempt, agentCreateDigest, clearAgentCreateAttempt } from "./agent-create-attempt.js";

test("创建指纹是固定长度摘要，不暴露提交正文", async () => {
	const body = JSON.stringify({ displayName: "Data Analyst", config: { command: "private-input" } });
	const digest = await agentCreateDigest(body);
	assert.match(digest, /^[a-f0-9]{64}$/);
	assert.notEqual(digest, await agentCreateDigest(`${body} changed`));
	assert.ok(!digest.includes("private-input"));
});

test("刷新后同用户同请求恢复原操作键，改文产生新键；存储不含请求正文", () => {
	const entries = new Map<string, string>();
	const storage = {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => { entries.set(key, value); },
		removeItem: (key: string) => { entries.delete(key); },
	};
	let count = 0;
	const newKey = () => `operation-${++count}-0001`;
	const first = acquireAgentCreateAttempt("tenant:user", "a".repeat(64), null, storage, newKey);
	const afterReload = acquireAgentCreateAttempt("tenant:user", "a".repeat(64), null, storage, newKey);
	assert.equal(afterReload.key, first.key);
	assert.equal(count, 1);
	assert.deepEqual(Object.keys(JSON.parse([...entries.values()][0]!) as Record<string, unknown>).sort(), ["digest", "key", "scope"]);
	const changed = acquireAgentCreateAttempt("tenant:user", "b".repeat(64), null, storage, newKey);
	assert.notEqual(changed.key, first.key);
	assert.equal(entries.size, 2);
	assert.equal(acquireAgentCreateAttempt("tenant:user", "a".repeat(64), null, storage, newKey).key, first.key);
	assert.equal(count, 2);
	clearAgentCreateAttempt(first, storage);
	assert.equal(acquireAgentCreateAttempt("tenant:user", "b".repeat(64), null, storage, newKey).key, changed.key);
	clearAgentCreateAttempt(changed, storage);
	assert.equal(entries.size, 0);
});

test("浏览器存储被拒绝时当前弹窗仍可复用内存操作键", () => {
	const storage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
	const first = acquireAgentCreateAttempt("tenant:user", "a".repeat(64), null, storage, () => "operation-0001");
	const retry = acquireAgentCreateAttempt("tenant:user", "a".repeat(64), first, storage, () => "operation-0002");
	assert.equal(retry.key, first.key);
});
