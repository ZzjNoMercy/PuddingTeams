import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSearchIndex, searchBuiltIndex } from "./search-index.js";

async function fixture(suffix: string) {
	const base = await mkdtemp(path.join(tmpdir(), `pt-search-${suffix}-`));
	const objects = new KnowledgeObjectStore(path.join(base, "objects"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(base, "acceptance"));
	const index = new KnowledgeSearchIndex(path.join(base, "cache"), objects);
	return { base, objects, acceptance, index };
}

async function acceptNotes(acceptance: KnowledgeAcceptanceStore, objects: KnowledgeObjectStore, bindingId: string, notes: Record<string, string>, expectedRevision: number) {
	const items = [];
	for (const [relativePath, content] of Object.entries(notes)) {
		const { hash } = await objects.put(Buffer.from(content));
		const idMatch = /---\nid:\s*(\S+)/.exec(content);
		items.push({
			relativePath, contentHash: hash, snapshotRef: hash, acceptedBy: "owner",
			...(idMatch ? { declaredNoteId: idMatch[1] } : {}),
		});
	}
	await acceptance.adopt(bindingId, items, expectedRevision);
	return acceptance.getSnapshot(bindingId);
}

test("索引仅从账本+快照构建；title/heading/body 排序；pending_new 不可见", async () => {
	const { acceptance, objects, index } = await fixture("basic");
	const ledger = await acceptNotes(acceptance, objects, "b1", {
		"alpha.md": "---\ntitle: 部署手册\n---\n正文提到流水线\n",
		"beta.md": "# 流水线指南\nbody\n",
		"gamma.md": "正文里有流水线三个字\n",
		"draft.md": "流水线 草稿\n",
	}, 0);
	// 移除 draft：模拟它从未被采纳（pending_new 根本不在账本）。
	await acceptance.removeEntries("b1", ["path:draft.md"]);
	const snapshot = await acceptance.getSnapshot("b1");
	const built = await index.load("b1", snapshot);
	assert.equal(built.fromCache, false);
	assert.equal(built.notes.size, 3);
	assert.equal(built.notes.get("path:alpha.md")?.title, "部署手册");
	assert.equal(built.notes.get("path:beta.md")?.title, "流水线指南");
	assert.equal(built.notes.get("path:gamma.md")?.title, "gamma");

	const { results, truncated } = searchBuiltIndex(built, "流水线", 20);
	assert.equal(truncated, false);
	assert.deepEqual(results.map((hit) => hit.path), ["beta.md", "alpha.md", "gamma.md"]);
	assert.ok(!results.some((hit) => hit.path === "draft.md"));
	void ledger;
});

test("缓存复用与失效：acceptanceRevision 变化后重建", async () => {
	const { acceptance, objects, index } = await fixture("cache");
	let ledger = await acceptNotes(acceptance, objects, "b1", { "a.md": "# A\n" }, 0);
	const first = await index.load("b1", ledger);
	assert.equal(first.fromCache, false);
	const second = await index.load("b1", ledger);
	assert.equal(second.fromCache, true);
	const { acceptanceRevision } = await acceptance.adopt("b1", [
		{ relativePath: "b.md", contentHash: (await objects.put(Buffer.from("# B\n"))).hash, snapshotRef: (await objects.put(Buffer.from("# B\n"))).hash, acceptedBy: "owner" },
	], 1);
	ledger = await acceptance.getSnapshot("b1");
	assert.equal(acceptanceRevision, 2);
	const rebuilt = await index.load("b1", ledger);
	assert.equal(rebuilt.fromCache, false);
	assert.equal(rebuilt.notes.size, 2);
});

test("K09：缓存文件删除后从账本+快照无损重建", async () => {
	const { base, acceptance, objects, index } = await fixture("rebuild");
	const ledger = await acceptNotes(acceptance, objects, "b1", { "a.md": "# 标题\n正文\n" }, 0);
	await index.load("b1", ledger);
	await rm(path.join(base, "cache", "b1-index.json"));
	const rebuilt = await index.load("b1", ledger);
	assert.equal(rebuilt.fromCache, false);
	assert.equal(rebuilt.notes.get("path:a.md")?.text.includes("正文"), true);
});

test("快照缺失的条目跳过并记录 diagnostics", async () => {
	const { base, acceptance, objects, index } = await fixture("missing");
	const ledger = await acceptNotes(acceptance, objects, "b1", { "a.md": "# A\n" }, 0);
	// 伪造一个快照缺失的账本条目：先保存快照后删对象。
	const { hash } = await objects.put(Buffer.from("# Ghost\n"));
	await acceptance.adopt("b1", [{ relativePath: "ghost.md", contentHash: hash, snapshotRef: hash, acceptedBy: "owner" }], 1);
	await rm(path.join(base, "objects", hash.slice(0, 2), `${hash}.md`));
	const built = await index.load("b1", await acceptance.getSnapshot("b1"));
	assert.equal(built.notes.size, 1);
	assert.deepEqual(built.diagnostics, ["missing_snapshot:path:ghost.md"]);
	assert.equal(ledger.acceptanceRevision, 1);
});

test("反链表：wiki 与 md 链接双向解析", async () => {
	const { acceptance, objects, index } = await fixture("backlinks");
	const ledger = await acceptNotes(acceptance, objects, "b1", {
		"target.md": "---\ntitle: 目标页\n---\n正文\n",
		"src1.md": "参见 [[target]] 一页\n",
		"sub/src2.md": "参见 [目标](../target.md) 与 [[ghost]]\n",
	}, 0);
	const built = await index.load("b1", ledger);
	const backlinks = built.backlinks.get("target.md") ?? [];
	assert.equal(backlinks.length, 2);
	const wiki = backlinks.find((link) => link.kind === "wiki");
	const md = backlinks.find((link) => link.kind === "md");
	assert.equal(wiki?.sourcePath, "src1.md");
	assert.equal(wiki?.sourceTitle, "src1");
	assert.equal(md?.sourcePath, "sub/src2.md");
	assert.match(md?.snippet ?? "", /目标/);
	assert.deepEqual(built.backlinks.get("ghost"), undefined);
});
