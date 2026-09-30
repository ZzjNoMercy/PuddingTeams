import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeHistoryStore } from "./history-store.js";
import { KnowledgeSearchIndex, searchBuiltIndex } from "./search-index.js";
import { KnowledgeObservationService } from "./observation.js";
import { PublishJournal } from "./wiki/publish-journal.js";
import { publicationManifestHash, type PublicationBatch } from "./contracts.js";

async function fixture(notes: Record<string, string>) {
 const base = await mkdtemp(path.join(tmpdir(), "pt-observe-auto-")), root = path.join(base, "vault"); await mkdir(root);
 for (const [relative, content] of Object.entries(notes)) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), content); }
 const registry = new KnowledgeBindingRegistry(path.join(base, "state")), binding = await registry.create({ ownerId: "owner", name: "Vault", description: "Test", rootPath: root });
 const history = new KnowledgeHistoryStore(path.join(base, "history")), acceptance = new KnowledgeAcceptanceStore(path.join(base, "acceptance"), history), objects = new KnowledgeObjectStore(path.join(base, "objects"));
 const journal = new PublishJournal(path.join(base, "operations")), searchIndex = new KnowledgeSearchIndex(path.join(base, "cache"), objects);
 const observation = new KnowledgeObservationService(acceptance, { objects, journal, searchIndex });
 return { base, root, binding, registry, acceptance, objects, history, journal, searchIndex, observation };
}

test("外部文件自动同步当前快照与检索，无schema或采纳门；重复扫描不改身份/版本", async () => {
 const f = await fixture({ "note.md": "---\nid: note\ntitle: 用户笔记\n---\n原始事实\n", "wiki.schema.json": '{"strict":"model contract only"}' });
 try {
  assert.equal((await f.observation.scan(f.binding)).files.get("note.md")!.state, "current");
  const a = await f.acceptance.getSnapshot(f.binding.id), first = Object.values(a.entries)[0]!;
  const unchanged = await f.observation.scan(f.binding); assert.equal(unchanged.files.get("note.md")!.acceptanceId, first.acceptanceId);
  assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, a.acceptanceRevision);
  await writeFile(path.join(f.root, "note.md"), "---\nid: note\n---\n新的外部事实\n"); await f.observation.scan(f.binding);
  const b = await f.acceptance.getSnapshot(f.binding.id), next = Object.values(b.entries)[0]!;
  assert.notEqual(next.acceptanceId, first.acceptanceId); assert.equal(next.noteId, first.noteId);
  assert.match((await f.objects.get(next.snapshotRef)).toString(), /新的外部事实/);
  assert.equal(searchBuiltIndex(await f.searchIndex.load(f.binding.id, b), "新的外部事实", 10).results.length, 1);
  assert.equal(searchBuiltIndex(await f.searchIndex.load(f.binding.id, b), "原始事实", 10).results.length, 0);
  const events = (await f.history.list(f.binding.id, "note.md")).versions; assert.equal(events.length, 2); assert(events.every(e => e.channel === "external_sync" && e.actorId === "platform-observer" && e.actorName === "平台观察"));
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("id和无id重命名保持稳定noteId，删除立即停止索引/当前引用且只记观察删除一次", async () => {
 const f = await fixture({ "old.md": "无id事实\n", "id.md": "---\nid: stable\n---\n有id事实\n" });
 try {
  await f.observation.scan(f.binding); const a = await f.acceptance.getSnapshot(f.binding.id);
  const first = Object.values(a.entries).find(e => e.relativePath === "old.md")!;
  await rename(path.join(f.root, "old.md"), path.join(f.root, "renamed.md")); await rename(path.join(f.root, "id.md"), path.join(f.root, "id-renamed.md"));
  await f.observation.scan(f.binding); const b = await f.acceptance.getSnapshot(f.binding.id);
  assert.equal(Object.values(b.entries).find(e => e.relativePath === "renamed.md")!.noteId, first.noteId);
  assert.equal(Object.values(b.entries).filter(e => e.availability === "current").length, 2);
  assert.equal((await f.history.list(f.binding.id, "renamed.md")).versions[0]!.changeKind, "rename");
  await rm(path.join(f.root, "renamed.md")); const record = await f.observation.scan(f.binding);
  assert.equal(record.files.get("renamed.md")!.state, "missing");
  const deleted = await f.acceptance.getSnapshot(f.binding.id);
  assert.equal(Object.values(deleted.entries).find(e => e.noteId === first.noteId)!.availability, "missing");
  assert.equal(searchBuiltIndex(await f.searchIndex.load(f.binding.id, deleted), "无id事实", 10).results.length, 0);
  const events = (await f.history.list(f.binding.id, "renamed.md")).versions; assert.equal(events[0]!.deleted, true); assert.equal(events[0]!.current, false);
  await f.observation.scan(f.binding); assert.equal((await f.history.list(f.binding.id, "renamed.md")).versions.length, events.length);
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("重复id回退独立路径，不可读旧id不覆盖新可读同id页；不可读不虚构删除", async () => {
 const f = await fixture({ "a.md": "---\nid: same\n---\nA\n" });
 try {
  await f.observation.scan(f.binding);
  await writeFile(path.join(f.root, "a.md"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await writeFile(path.join(f.root, "b.md"), "---\nid: same\n---\nB\n");
  const record = await f.observation.scan(f.binding), ledger = await f.acceptance.getSnapshot(f.binding.id);
  assert.equal(record.files.get("a.md")!.state, "unreadable"); assert.equal(record.files.get("b.md")!.state, "current");
  assert.equal(ledger.entries["path:b.md"]!.availability, "current");
  assert.equal(Object.values(ledger.entries).find(e => e.relativePath === "a.md")!.availability, "changed");
  assert.equal((await f.history.list(f.binding.id, "a.md")).versions.length, 1);
  await rm(path.join(f.root, "a.md")); await f.observation.scan(f.binding);
  const deleted = await f.history.list(f.binding.id, "a.md");
  assert.equal(deleted.currentVersionId, null); assert.equal(deleted.versions[0]!.deleted, true);
  const afterDelete = await f.acceptance.getSnapshot(f.binding.id);
  assert.equal(Object.values(afterDelete.entries).find(e => e.relativePath === "b.md")!.availability, "current");
  assert.equal(Object.values(afterDelete.entries).find(e => e.relativePath === "a.md")!.availability, "missing");
  assert.equal(searchBuiltIndex(await f.searchIndex.load(f.binding.id, afterDelete), "B", 10).results.length, 1);
  await f.observation.scan(f.binding);
  assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, afterDelete.acceptanceRevision);
  assert.equal((await f.history.list(f.binding.id, "a.md")).versions.length, deleted.versions.length);
  await writeFile(path.join(f.root, "a.md"), "---\nid: same\n---\nA restored\n");
  const duplicate = await f.observation.scan(f.binding); assert.deepEqual(duplicate.duplicates, [{ declaredId: "same", paths: ["a.md", "b.md"] }]);
  const all = await f.acceptance.getSnapshot(f.binding.id); assert(all.entries["path:a.md"]); assert(all.entries["path:b.md"]);
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("AGENTS/CLAUDE契约不假推进revision，index/log自动同步但不作普通笔记", async () => {
 const f = await fixture({ "AGENTS.md": "模型操作契约", "CLAUDE.md": "模型契约", "index.md": "[[note]]", "log.md": "外部日志", "note.md": "事实" });
 try {
  await f.observation.scan(f.binding); const a = await f.acceptance.getSnapshot(f.binding.id);
  await f.observation.scan(f.binding); const b = await f.acceptance.getSnapshot(f.binding.id);
  assert.equal(b.acceptanceRevision, a.acceptanceRevision); assert.equal(Object.keys(b.entries).length, 1); assert.equal(Object.keys(b.controlEntries!).length, 2);
  assert.equal((await f.history.list(f.binding.id, "AGENTS.md")).versions.length, 0);
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

async function publication(f: Awaited<ReturnType<typeof fixture>>, targetPath: string, content: string) {
 const blob = await f.objects.put(Buffer.from(content)), current = Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries).find(e => e.relativePath === targetPath);
 const batch: PublicationBatch = { id: `batch-${targetPath}`, revision: 1, bindingId: f.binding.id, manifestHash: "", rootIdentity: f.binding.rootIdentity, bindingRevision: 1, trustRevision: 1, files: [{ targetPath, operation: current ? "update" : "create", expectedHashOrAbsent: current?.contentHash ?? null, candidateHash: blob.hash, blobRef: blob.hash }], sourceSnapshots: [], dependencyGroups: [[targetPath]], validationReceipt: "{}", compilerVersion: "test", status: "approved" };
 batch.manifestHash = publicationManifestHash(batch); return batch;
}

test("持久未提交平台写入不能洗成外部生效，重启仍保护；第三hash真实外部编辑自由同步", async () => {
 const f = await fixture({ "a.md": "原版本" });
 try {
  await f.observation.scan(f.binding); const old = Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries)[0]!;
  const batch = await publication(f, "a.md", "平台未完成候选"), { record } = await f.journal.begin({ batch, ownerId: "owner", actorId: "owner", reviewId: "review", idempotencyKey: "review" });
  await f.journal.setRunning(record.id); await writeFile(path.join(f.root, "a.md"), "平台未完成候选");
  await f.journal.appendReceipt(record.id, "a.md", { step: "write" }, { status: "applied" }); await f.journal.settle(record.id, "conflict");
  const restarted = new KnowledgeObservationService(f.acceptance, { objects: f.objects, journal: new PublishJournal(path.join(f.base, "operations")) });
  assert.equal((await restarted.scan(f.binding)).files.get("a.md")!.state, "publishing");
  assert.equal(Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries)[0]!.acceptanceId, old.acceptanceId);
  assert.equal((await f.history.list(f.binding.id, "a.md")).versions.length, 1);
  await writeFile(path.join(f.root, "a.md"), "外部真正编辑"); assert.equal((await restarted.scan(f.binding)).files.get("a.md")!.state, "current");
  assert.match((await f.objects.get(Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries)[0]!.snapshotRef)).toString(), /真正编辑/);
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("从未写入的失败候选不挡人新建同bytes；running崩溃缺write回执仍隔离", async () => {
 const f = await fixture({});
 try {
  const failed = await publication(f, "failed.md", "人主动写的相同内容"), begin = await f.journal.begin({ batch: failed, ownerId: "owner", actorId: "owner", reviewId: "failed-review", idempotencyKey: "failed-review" });
  await f.journal.updateFile(begin.record.id, "failed.md", { status: "failed" }); await f.journal.settle(begin.record.id, "conflict");
  await writeFile(path.join(f.root, "failed.md"), "人主动写的相同内容"); assert.equal((await f.observation.scan(f.binding)).files.get("failed.md")!.state, "current");
  const crashed = await publication(f, "crash.md", "候选缺失回执"), other = await f.journal.begin({ batch: crashed, ownerId: "owner", actorId: "owner", reviewId: "crash-review", idempotencyKey: "crash-review" });
  await f.journal.setRunning(other.record.id); await writeFile(path.join(f.root, "crash.md"), "候选缺失回执");
  assert.equal((await f.observation.scan(f.binding)).files.get("crash.md")!.state, "publishing");
  assert(!Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries).some(e => e.relativePath === "crash.md"));
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("未提交候选改id时，受保护旧id预留：独立外部同id页不被覆盖", async () => {
	const f = await fixture({ "a.md": "---\nid: X\n---\n原页" });
	try {
		await f.observation.scan(f.binding);
		const batch = await publication(f, "a.md", "---\nid: Y\n---\n未提交候选"), { record } = await f.journal.begin({ batch, ownerId: "owner", actorId: "owner", reviewId: "id-change", idempotencyKey: "id-change" });
		await f.journal.setRunning(record.id); await writeFile(path.join(f.root, "a.md"), "---\nid: Y\n---\n未提交候选");
		await f.journal.appendReceipt(record.id, "a.md", { step: "write" }, { status: "applied" });
		await writeFile(path.join(f.root, "b.md"), "---\nid: X\n---\n外部新页");
		const recordAfter = await f.observation.scan(f.binding), ledger = await f.acceptance.getSnapshot(f.binding.id);
		assert.equal(recordAfter.files.get("a.md")!.state, "publishing"); assert.equal(recordAfter.files.get("b.md")!.state, "current");
		assert.equal(ledger.entries["id:X"]!.relativePath, "a.md"); assert.equal(ledger.entries["path:b.md"]!.relativePath, "b.md");
	} finally { await rm(f.base, { recursive: true, force: true }); }
});
