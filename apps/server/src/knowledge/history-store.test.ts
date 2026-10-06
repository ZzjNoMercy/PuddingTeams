import assert from "node:assert/strict";
import { localViewerIdentity } from "../routes/identity.js";
const OWNER = localViewerIdentity().user.id;
import { test } from "node:test";
import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeHistoryStore } from "./history-store.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeObservationService } from "./observation.js";
import { KnowledgeSearchIndex } from "./search-index.js";
import { registerKnowledgeRoutes } from "../routes/knowledge.js";
import { publicationManifestHash, type PublicationBatch } from "./contracts.js";
import { ReviewStore } from "./wiki/review-store.js";
import { PublishJournal } from "./wiki/publish-journal.js";
import { MarkdownWikiPublisher } from "./wiki/publisher-markdown.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-history-")), vault = path.join(root, "vault"); await mkdir(vault);
	const history = new KnowledgeHistoryStore(path.join(root, "state")), objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"), history), bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
	const binding = await bindings.create({ ownerId: OWNER, rootPath: vault, name: "Wiki", description: "history" });
	const observation = new KnowledgeObservationService(acceptance, { objects }), searchIndex = new KnowledgeSearchIndex(path.join(root, "cache"), objects);
	const adopt = async (text: string, relativePath: string, revision: number) => {
		const blob = await objects.put(Buffer.from(text));
		await acceptance.adopt(binding.id, [{ relativePath, declaredNoteId: "stable-declared-id", contentHash: blob.hash, acceptedBy: OWNER, sourceIds: ["source-one"] }], revision);
		return blob;
	};
	return { root, vault, history, objects, acceptance, bindings, binding, observation, searchIndex, adopt };
}

test("history：原子采纳outbox在SQLite投影失败后恢复，重启不重复；重命名保持稳定noteId", async () => {
	const f = await fixture();
	try {
		const append = f.history.append.bind(f.history); f.history.append = async () => { throw new Error("projection unavailable"); };
		const a = await f.adopt("# v1", "first.md", 0);
		assert.equal((await f.history.list(f.binding.id, "first.md")).versions.length, 0);
		const onDisk = JSON.parse(await readFile(path.join(f.root, "acceptance", `${f.binding.id}.json`), "utf8"));
		assert.equal(onDisk.historyOutbox.length, 1, "采纳与历史待投影事件同一原子落盘");
		f.history.append = append;
		const restarted = new KnowledgeAcceptanceStore(path.join(f.root, "acceptance"), new KnowledgeHistoryStore(path.join(f.root, "state")));
		await restarted.recoverHistory(); await restarted.recoverHistory();
		const first = (await f.history.list(f.binding.id, "first.md")).versions[0]!;
		assert.equal(first.channel, "initial"); assert.equal(first.contentHash, a.hash);
		await restarted.adopt(f.binding.id, [{ relativePath: "renamed.md", declaredNoteId: "stable-declared-id", contentHash: a.hash, acceptedBy: OWNER }], 1);
		const renamed = await f.history.list(f.binding.id, "renamed.md");
		assert.equal(renamed.noteId, first.noteId); assert.equal(renamed.versions.length, 2);
		assert.equal(renamed.versions[0]?.previousPath, "first.md");
		assert.equal(renamed.versions[0]?.channel, "initial");
		const before = Object.values((await restarted.getSnapshot(f.binding.id)).entries)[0]!;
		await restarted.adopt(f.binding.id, [{ relativePath: "renamed.md", declaredNoteId: "stable-declared-id", contentHash: a.hash, acceptedBy: OWNER }], 2);
		assert.equal((await f.history.list(f.binding.id, "renamed.md")).versions.length, 2, "无变化不记版本");
		const after = Object.values((await restarted.getSnapshot(f.binding.id)).entries)[0]!;
		assert.notEqual(after.acceptanceId, before.acceptanceId, "显式重复采纳仍刷新授权身份，使旧compile来源失效");
		assert.equal(after.noteId, before.noteId); assert.equal((await restarted.getSnapshot(f.binding.id)).acceptanceRevision, 3);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("history：SQLite写完但outbox清理前崩溃，重放仍只有一次事件且同op不同字节拒绝", async () => {
	const f = await fixture();
	try {
		const append = f.history.append.bind(f.history);
		f.history.append = async (events) => { await append(events); throw new Error("crash before outbox ack"); };
		await f.adopt("# committed", "note.md", 0);
		const before = (await f.history.list(f.binding.id, "note.md")).versions;
		assert.equal(before.length, 1);
		const freshHistory = new KnowledgeHistoryStore(path.join(f.root, "state"));
		const restarted = new KnowledgeAcceptanceStore(path.join(f.root, "acceptance"), freshHistory);
		await restarted.recoverHistory(); await restarted.recoverHistory();
		assert.equal((await freshHistory.list(f.binding.id, "note.md")).versions.length, 1);
		assert.deepEqual((await restarted.getSnapshot(f.binding.id)).historyOutbox, []);
		await assert.rejects(freshHistory.append([{ ...before[0]!, contentHash: "a".repeat(64)}]), /conflicts/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("history routes：固定快照/diff与当前盘内容无关，撤销授权和跨库版本不泄漏", async () => {
	const f = await fixture(), app = Fastify();
	try {
		await f.adopt("# old\n", "note.md", 0); await f.adopt("# new\n", "note.md", 1);
		await writeFile(path.join(f.vault, "note.md"), "# unaccepted live edit\n");
		registerKnowledgeRoutes(app, f.bindings, { ...f, history: f.history });
		const list = await app.inject({ url: `/api/knowledge/${f.binding.id}/history?path=note.md` }); assert.equal(list.statusCode, 200);
		const versions = list.json().versions; assert.equal(versions.length, 2); assert.deepEqual(versions.map((v: { revision: number }) => v.revision), [2, 1]);
		const detail = await app.inject({ url: `/api/knowledge/${f.binding.id}/history/${versions[0].id}` }); assert.equal(detail.statusCode, 200);
		assert.equal(detail.json().content, "# new\n"); assert.equal(detail.json().previousContent, "# old\n"); assert.ok(detail.json().diff.hunks.length);
		assert.equal((await app.inject({ url: `/api/knowledge/${f.binding.id}/history?path=..%2Fsecret.md` })).statusCode, 400);
		assert.equal((await app.inject({ url: `/api/knowledge/other/history/${versions[0].id}` })).statusCode, 404);
		await f.bindings.revoke(OWNER, f.binding.id, 1);
		assert.equal((await app.inject({ url: `/api/knowledge/${f.binding.id}/history?path=note.md` })).statusCode, 404);
	} finally { await app.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("history publisher：待审/拒绝不记历史；partial只记已提交组，发布恢复不重复事件", async () => {
	const f = await fixture();
	try {
		const reviews = new ReviewStore(path.join(f.root, "reviews")), journal = new PublishJournal(path.join(f.root, "operations"));
		const files = await Promise.all(["a.md", "b.md"].map(async (targetPath) => { const blob = await f.objects.put(Buffer.from(`# ${targetPath}\n`));
			return { operation: "create" as const, targetPath, expectedHashOrAbsent: null, candidateHash: blob.hash}; }));
		const batch: PublicationBatch = { id: "partial-history", revision: 1, bindingId: f.binding.id, rootIdentity: f.binding.rootIdentity, manifestHash: "", files,
			sourceSnapshots: [], bindingRevision: 1, trustRevision: 1, dependencyGroups: [["a.md"], ["b.md"]], validationReceipt: JSON.stringify({ reasons: { "a.md": "修改理由" } }), compilerVersion: "fixture", status: "candidate" };
		batch.manifestHash = publicationManifestHash(batch); await reviews.registerCandidate(batch, OWNER);
		assert.deepEqual((await f.history.list(f.binding.id, "a.md")).versions, []);
		const approved = await reviews.decide({ batchId: batch.id, operationId: "approve", actorId: OWNER, decision: "approve", manifestHash: batch.manifestHash, reviewedFiles: ["a.md", "b.md"] });
		const publisher = new MarkdownWikiPublisher({ ...f, reviews, journal, operationsDir: path.join(f.root, "operations"), stepHook: async (step, target) => {
			if (step === "group_commit" && target === "a.md") await writeFile(path.join(f.vault, "b.md"), "# external\n");
		} });
		await publisher.onApproved(batch, approved.decision); assert.equal((await reviews.get(batch.id))?.status, "partial");
		const versions = (await f.history.list(f.binding.id, "a.md")).versions; assert.equal(versions.length, 1);
		assert.equal(versions[0]?.channel, "agent_publish"); assert.equal(versions[0]?.batchId, batch.id); assert.equal(versions[0]?.decisionId, approved.decision.id); assert.equal(versions[0]?.summary, "修改理由");
		const external = (await f.history.list(f.binding.id, "b.md")).versions; assert.equal(external.length, 1); assert.equal(external[0]!.channel, "external_sync"); assert.equal(external[0]!.decisionId, undefined); assert.equal((await f.objects.get(external[0]!.contentHash)).toString(), "# external\n");
		await publisher.reconcileInterrupted(); await f.acceptance.recoverHistory();
		assert.equal((await f.history.list(f.binding.id, "a.md")).versions.length, 1);
		const rejectedBatch = { ...batch, id: "reject-history", manifestHash: "" }; rejectedBatch.manifestHash = publicationManifestHash(rejectedBatch);
		await reviews.registerCandidate(rejectedBatch, OWNER); await reviews.decide({ batchId: rejectedBatch.id, operationId: "reject", actorId: OWNER, decision: "reject", manifestHash: rejectedBatch.manifestHash, reviewedFiles: [] });
		assert.equal((await f.history.list(f.binding.id, "a.md")).versions.length, 1);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});
