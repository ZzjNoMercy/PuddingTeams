import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { MAX_ASSET_BYTES, readKnowledgeAsset } from "./assets.js";

async function fixture(suffix: string) {
	const base = await mkdtemp(path.join(tmpdir(), `pt-asset-${suffix}-`));
	const root = path.join(base, "vault");
	await mkdir(path.join(root, "img"), { recursive: true });
	await writeFile(path.join(root, "img", "ok.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const binding = await registry.create({ ownerId: "owner", name: "Vault", description: "Test", rootPath: root });
	return { base, root, binding };
}

test("读取白名单图片并给出 Content-Type", async () => {
	const { binding } = await fixture("ok");
	const asset = await readKnowledgeAsset(binding, "img/ok.png");
	assert.equal(asset.contentType, "image/png");
	assert.equal(asset.size, 4);
});

test("非图片扩展名 400；路径穿越 400；符号链接拒绝", async () => {
	const { root, binding } = await fixture("reject");
	await writeFile(path.join(root, "note.md"), "# x\n");
	await assert.rejects(() => readKnowledgeAsset(binding, "note.md"), { code: "invalid_input" });
	await assert.rejects(() => readKnowledgeAsset(binding, "../outside.png"), { code: "invalid_path" });
	await writeFile(path.join(root, "real.png"), "PNG");
	await symlink(path.join(root, "real.png"), path.join(root, "link.png"));
	await assert.rejects(() => readKnowledgeAsset(binding, "link.png"), { code: "not_found" });
});

test("超过 10 MiB 抛 too_large", async () => {
	const { root, binding } = await fixture("large");
	await writeFile(path.join(root, "big.png"), Buffer.alloc(MAX_ASSET_BYTES + 1, 0x89));
	await assert.rejects(() => readKnowledgeAsset(binding, "big.png"), { code: "too_large" });
});
