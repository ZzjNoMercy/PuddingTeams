import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { KnowledgeAcceptanceStore, noteIdentityKey, parseNoteFrontmatter } from "./acceptance.js";

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

test("parseNoteFrontmatter 提取 id/title 并去引号", () => {
	assert.deepEqual(parseNoteFrontmatter("---\nid: note-1\ntitle: \"标题 A\"\n---\n正文"), { id: "note-1", title: "标题 A" });
	assert.deepEqual(parseNoteFrontmatter("---\ntitle: '单引号'\n---\n"), { title: "单引号" });
	assert.deepEqual(parseNoteFrontmatter("---\r\nid: crlf\r\n---\r\nbody"), { id: "crlf" });
	assert.deepEqual(parseNoteFrontmatter("# 没有 frontmatter\n"), {});
	assert.deepEqual(parseNoteFrontmatter("---\n未闭合\nbody\n"), {});
	assert.deepEqual(parseNoteFrontmatter("---\nid:\ntitle:   \n---\n"), {});
});

test("noteIdentityKey 优先声明 id", () => {
	assert.equal(noteIdentityKey({ declaredNoteId: "x", normalizedRelativePath: "a.md" }), "id:x");
	assert.equal(noteIdentityKey({ normalizedRelativePath: "a.md" }), "path:a.md");
});

test("adopt 落盘信封并可跨实例重载；修订号乐观并发", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-acceptance-"));
	const store = new KnowledgeAcceptanceStore(dir);
	const contentHash = hashOf("content");
	const { acceptanceRevision, adopted } = await store.adopt("b1", [
		{ relativePath: "a.md", contentHash, snapshotRef: contentHash, acceptedBy: "local:tester" },
	], 0);
	assert.equal(acceptanceRevision, 1);
	assert.deepEqual(adopted, [{ path: "a.md", identityKey: "path:a.md", contentHash }]);
	const onDisk = JSON.parse(await readFile(path.join(dir, "b1.json"), "utf8")) as { version: number; bindingId: string; acceptanceRevision: number; entries: Record<string, { noteIdentity: { normalizedRelativePath?: string } }> };
	assert.equal(onDisk.version, 1);
	assert.equal(onDisk.bindingId, "b1");
	assert.equal(onDisk.acceptanceRevision, 1);
	assert.equal(onDisk.entries["path:a.md"]?.noteIdentity.normalizedRelativePath, "a.md");

	// 新实例从磁盘重载（K09 前置：账本即事实源）。
	const reloaded = new KnowledgeAcceptanceStore(dir);
	const snapshot = await reloaded.getSnapshot("b1");
	assert.equal(snapshot.acceptanceRevision, 1);
	assert.equal(Object.keys(snapshot.entries).length, 1);

	await assert.rejects(() => reloaded.adopt("b1", [
		{ relativePath: "b.md", contentHash: hashOf("b"), snapshotRef: hashOf("b"), acceptedBy: "local:tester" },
	], 0), { code: "stale_revision" });
	const again = await reloaded.adopt("b1", [
		{ relativePath: "b.md", declaredNoteId: "n-b", title: "B", contentHash: hashOf("b"), snapshotRef: hashOf("b"), acceptedBy: "local:tester" },
	], 1);
	assert.equal(again.acceptanceRevision, 2);
	assert.deepEqual(again.adopted[0], { path: "b.md", identityKey: "id:n-b", contentHash: hashOf("b") });
});

test("adopt 同路径身份键变化时替换旧键；removeEntries 移除并推进修订", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-acceptance-rekey-"));
	const store = new KnowledgeAcceptanceStore(dir);
	await store.adopt("b1", [{ relativePath: "a.md", contentHash: hashOf("v1"), snapshotRef: hashOf("v1"), acceptedBy: "me" }], 0);
	const { adopted } = await store.adopt("b1", [
		{ relativePath: "a.md", declaredNoteId: "n-a", contentHash: hashOf("v2"), snapshotRef: hashOf("v2"), acceptedBy: "me" },
	], 1);
	assert.deepEqual(adopted[0]?.identityKey, "id:n-a");
	let snapshot = await store.getSnapshot("b1");
	assert.deepEqual(Object.keys(snapshot.entries), ["id:n-a"]);
	assert.equal(snapshot.entries["id:n-a"]?.contentHash, hashOf("v2"));

	await store.removeEntries("b1", ["id:n-a", "path:ghost.md"]);
	snapshot = await store.getSnapshot("b1");
	assert.equal(Object.keys(snapshot.entries).length, 0);
	assert.equal(snapshot.acceptanceRevision, 3);
});

test("getSnapshot 返回冻结视图，账本缺失时为空账本", async () => {
	const store = new KnowledgeAcceptanceStore(await mkdtemp(path.join(tmpdir(), "pt-acceptance-empty-")));
	const snapshot = await store.getSnapshot("fresh");
	assert.equal(snapshot.acceptanceRevision, 0);
	assert.deepEqual(snapshot.entries, {});
	assert.throws(() => { (snapshot.entries as Record<string, unknown>).x = 1; }, TypeError);
});

test("契约、首页与日志留在文件树里，但不能被采纳成笔记", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-acceptance-control-"));
	const store = new KnowledgeAcceptanceStore(dir);
	const contentHash = hashOf("# 首页\n");
	// 整批拒绝：控制文档一旦混进采纳项就会污染编译来源。
	for (const relativePath of ["AGENTS.md", "claude.md", "index.md", "log.md"]) {
		await assert.rejects(
			() => store.adopt("b1", [{ relativePath, contentHash, snapshotRef: contentHash, acceptedBy: "local:tester" }], 0),
			{ code: "invalid_input" },
		);
	}
	assert.equal((await store.getSnapshot("b1")).acceptanceRevision, 0, "被拒绝的批次不推进修订号");
	// 子目录里的同名文件仍是正常笔记。
	await store.adopt("b1", [{ relativePath: "concepts/index.md", contentHash, snapshotRef: contentHash, acceptedBy: "local:tester" }], 0);
	assert.equal((await store.getSnapshot("b1")).acceptanceRevision, 1);
});


test("adoptPublished：index/log与笔记同revision提交，控制快照不混入笔记来源", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-controls-"));
	const store = new KnowledgeAcceptanceStore(dir);
	const item = (relativePath: string) => ({ relativePath, contentHash: hashOf(relativePath), snapshotRef: hashOf(relativePath), acceptedBy: "owner" });
	await store.adoptPublished("b1", [item("a.md"), item("index.md"), item("log.md")], 0);
	const ledger = await new KnowledgeAcceptanceStore(dir).getSnapshot("b1");
	assert.equal(ledger.acceptanceRevision, 1);
	assert.deepEqual(Object.keys(ledger.entries), ["path:a.md"]);
	assert.equal(ledger.controlEntries!["path:index.md"]!.controlKind, "index");
	assert.equal(ledger.controlEntries!["path:log.md"]!.controlKind, "log");
	assert.throws(() => { ledger.controlEntries!.fake = ledger.controlEntries!["path:index.md"]!; }, TypeError);
	await assert.rejects(() => store.adoptPublished("b1", [item("b.md"), item("AGENTS.md")], 1), { code: "invalid_input" });
	assert.equal((await store.getSnapshot("b1")).acceptanceRevision, 1);
	assert.equal((await store.getSnapshot("b1")).entries["path:b.md"], undefined);
});
