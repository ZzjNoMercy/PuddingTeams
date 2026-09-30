import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeObjectStore } from "./objects.js";

test("objects.put 按 sha256 分桶落盘，get 原样取回", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-objects-"));
	const store = new KnowledgeObjectStore(dir);
	const content = Buffer.from("# 采纳快照\n内容\n");
	const { hash, path: objectPath } = await store.put(content);
	assert.match(hash, /^[a-f0-9]{64}$/);
	assert.equal(objectPath, path.join(dir, hash.slice(0, 2), `${hash}.md`));
	assert.deepEqual(await readFile(objectPath), content);
	assert.equal((await stat(objectPath)).mode & 0o777, 0o600);
	assert.deepEqual(await store.get(hash), content);
	assert.equal(await store.has(hash), true);
	assert.equal(await store.has("0".repeat(64)), false);
});

test("objects.put 重复内容去重复用，不重复写入", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-objects-dedupe-"));
	const store = new KnowledgeObjectStore(dir);
	const content = Buffer.from("same bytes");
	const first = await store.put(content);
	const firstMtime = (await stat(first.path)).mtimeMs;
	const second = await store.put(content);
	assert.equal(first.hash, second.hash);
	assert.equal(first.path, second.path);
	assert.equal((await stat(second.path)).mtimeMs, firstMtime);
});

test("objects.put 同路径异内容视为冲突抛 integrity_error", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-objects-collision-"));
	const store = new KnowledgeObjectStore(dir);
	const { hash, path: objectPath } = await store.put(Buffer.from("original"));
	await writeFile(objectPath, "tampered");
	// 同内容再 put 命中同一哈希路径，但磁盘字节已被篡改 → 冲突。
	await assert.rejects(() => store.put(Buffer.from("original")), { code: "integrity_error" });
	await assert.rejects(() => store.get(hash), { code: "integrity_error" });
});

test("objects.get 非法哈希与缺失对象分别抛 invalid_input / not_found", async () => {
	const store = new KnowledgeObjectStore(await mkdtemp(path.join(tmpdir(), "pt-objects-invalid-")));
	await assert.rejects(() => store.get("not-a-hash"), { code: "invalid_input" });
	await assert.rejects(() => store.get("a".repeat(64)), { code: "not_found" });
});
