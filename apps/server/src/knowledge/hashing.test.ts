import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { hashBufferSha256, hashFileSha256, MAX_HASH_BYTES } from "./hashing.js";

test("hashFileSha256 流式哈希与同步哈希一致", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-hash-"));
	const file = path.join(dir, "note.md");
	const content = "# 标题\n正文内容\n".repeat(1000);
	await writeFile(file, content);
	const { hash, size } = await hashFileSha256(file);
	assert.equal(hash, createHash("sha256").update(content).digest("hex"));
	assert.equal(size, Buffer.byteLength(content));
});

test("hashFileSha256 超限抛 too_large", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-hash-large-"));
	const file = path.join(dir, "big.md");
	await writeFile(file, Buffer.alloc(MAX_HASH_BYTES + 1, 0x61));
	await assert.rejects(() => hashFileSha256(file), { code: "too_large" });
});

test("hashFileSha256 缺失文件抛 not_found，符号链接被拒绝", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-hash-missing-"));
	await assert.rejects(() => hashFileSha256(path.join(dir, "none.md")), { code: "not_found" });
	const target = path.join(dir, "target.md");
	await writeFile(target, "x");
	const link = path.join(dir, "link.md");
	await symlink(target, link);
	await assert.rejects(() => hashFileSha256(link), { code: "not_found" });
});

test("hashBufferSha256 返回 hex 摘要", () => {
	assert.equal(hashBufferSha256("abc"), createHash("sha256").update("abc").digest("hex"));
});
