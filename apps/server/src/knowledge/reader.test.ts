import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { listKnowledgeTree, readKnowledgeNote } from "./reader.js";

test("registered Wiki reads only Markdown under wiki/, not raw or symlink targets", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-knowledge-reader-"));
	const root = path.join(base, "vault");
	await mkdir(path.join(root, "wiki", "nested"), { recursive: true });
	await mkdir(path.join(root, "raw"));
	await writeFile(path.join(root, "wiki", "nested", "中文.md"), "# 安全正文\n");
	await writeFile(path.join(root, "raw", "secret.md"), "SECRET");
	await symlink(path.join(root, "raw", "secret.md"), path.join(root, "wiki", "leak.md"));
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const binding = await registry.create({ ownerId: "owner", name: "Wiki", description: "Test", rootPath: root });
	const tree = await listKnowledgeTree(binding);
	assert.deepEqual(tree.map((item) => item.name), ["nested"]);
	assert.deepEqual(tree[0]?.children?.map((item) => item.name), ["中文.md"]);
	assert.equal((await readKnowledgeNote(binding, "nested/中文.md")).content, "# 安全正文\n");
	await assert.rejects(() => readKnowledgeNote(binding, "../raw/secret.md"), { code: "invalid_path" });
	await assert.rejects(() => readKnowledgeNote(binding, "leak.md"), { code: "not_found" });
});

test("控制文档照常出现在文件树里（用户要能直接打开看）", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-knowledge-reader-control-"));
	const root = path.join(base, "vault");
	await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
	await mkdir(path.join(root, "raw"));
	await writeFile(path.join(root, "wiki", "AGENTS.md"), "契约\n");
	await writeFile(path.join(root, "wiki", "CLAUDE.md"), "契约\n");
	await writeFile(path.join(root, "wiki", "index.md"), "# 首页\n");
	await writeFile(path.join(root, "wiki", "log.md"), "## 追加记录\n");
	await writeFile(path.join(root, "wiki", "concepts", "index.md"), "# 概念索引\n");
	await writeFile(path.join(root, "wiki", "concepts", "harness.md"), "# Harness\n");
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const binding = await registry.create({ ownerId: "owner", name: "Wiki", description: "Test", rootPath: root });
	const tree = await listKnowledgeTree(binding);
	// 目录在前、笔记按名排序在后。
	assert.deepEqual(tree.map((item) => item.name), ["concepts", "AGENTS.md", "CLAUDE.md", "index.md", "log.md"]);
	assert.deepEqual(tree[0]?.children?.map((item) => item.name), ["harness.md", "index.md"]);
	// 它们只是不计入笔记数（由 observation 的 control 标记负责），路径读取照常可用。
	assert.equal((await readKnowledgeNote(binding, "index.md")).content, "# 首页\n");
	assert.equal((await readKnowledgeNote(binding, "log.md")).content, "## 追加记录\n");
});

test("reading fails after a registered root is replaced", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-knowledge-reader-root-"));
	const root = path.join(base, "vault");
	await mkdir(root);
	await writeFile(path.join(root, "note.md"), "old");
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const binding = await registry.create({ ownerId: "owner", name: "Notes", description: "Test", rootPath: root });
	await rename(root, `${root}-old`);
	await mkdir(root);
	await writeFile(path.join(root, "note.md"), "new");
	await assert.rejects(() => listKnowledgeTree(binding), { code: "root_changed" });
	await assert.rejects(() => readKnowledgeNote(binding, "note.md"), { code: "root_changed" });
});
