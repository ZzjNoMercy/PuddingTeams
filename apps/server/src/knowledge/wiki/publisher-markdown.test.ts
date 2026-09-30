import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KnowledgeAcceptanceStore } from "../acceptance.js";
import { KnowledgeBindingRegistry } from "../bindings.js";
import { publicationManifestHash, type KnowledgeBinding, type PublicationBatch } from "../contracts.js";
import { hashBufferSha256 } from "../hashing.js";
import { KnowledgeObjectStore } from "../objects.js";
import { KnowledgeObservationService } from "../observation.js";
import { KnowledgeSearchIndex } from "../search-index.js";
import { PublishJournal } from "./publish-journal.js";
import { MarkdownWikiPublisher, PublishCrashError, type PublishStepHook } from "./publisher-markdown.js";
import { ReviewStore } from "./review-store.js";
import { imageAssetPath } from "../image-publication.js";

const OWNER = "user-local";

const originalPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");

async function imageBatch(f: PublisherFixture, options: { large?: boolean; reuse?: boolean; secondPage?: boolean; update?: boolean } = {}) {
	const bytes = options.large ? Buffer.concat([originalPng, Buffer.alloc(3 * 1024 * 1024)]) : originalPng;
	const blob = await f.objects.put(bytes), assetPath = imageAssetPath(blob.hash, "image/png");
	if (options.reuse) { await mkdir(path.dirname(path.join(f.vault, assetPath)), { recursive: true }); await writeFile(path.join(f.vault, assetPath), bytes); }
	const pagePath = options.update ? "a.md" : "facts/nested/page.md";
	const content = `---\nsources: [image-source]\n---\n# Page\n![原图](${options.update ? "" : "../../"}${assetPath})\n`;
	const batch = await buildBatch(f, [{ targetPath: pagePath, content, operation: options.update ? "update" : "create" }, ...(options.secondPage ? [{ targetPath: "q.md", content: "# Q\n" }] : [])]);
	batch.files.unshift({ targetPath: assetPath, kind: "image", mediaType: "image/png", sourceIds: ["image-source"], operation: options.reuse ? "update" : "create", expectedHashOrAbsent: options.reuse ? blob.hash : null, candidateHash: blob.hash, blobRef: blob.hash });
	batch.dependencyGroups = [[assetPath, ...batch.files.filter(file => file.kind !== "image").map(file => file.targetPath)]];
	batch.sourceSnapshots = [blob.hash];
	batch.validationReceipt = JSON.stringify({ sources: [{ id: "image-source", kind: "image", originalHash: blob.hash, mediaType: "image/png" }] });
	batch.manifestHash = publicationManifestHash(batch);
	return { batch, bytes, assetPath, pagePath, content };
}

interface PublisherFixture {
	root: string;
	vault: string;
	binding: KnowledgeBinding;
	bindings: KnowledgeBindingRegistry;
	objects: KnowledgeObjectStore;
	acceptance: KnowledgeAcceptanceStore;
	observation: KnowledgeObservationService;
	searchIndex: KnowledgeSearchIndex;
	reviews: ReviewStore;
	journal: PublishJournal;
	publisher: MarkdownWikiPublisher;
	operationsDir: string;
}

async function publisherFixture(stepHook?: PublishStepHook): Promise<PublisherFixture> {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pt-publisher-")));
	const vault = path.join(root, "vault");
	await mkdir(path.join(vault, "sub"), { recursive: true });
	await writeFile(path.join(vault, "a.md"), "# Accepted\n");
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
	const binding = await bindings.create({ ownerId: OWNER, name: "Wiki", description: "T", rootPath: vault });
	const objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"));
	const blob = await objects.put(Buffer.from("# Accepted\n", "utf8"));
	await acceptance.adopt(binding.id, [{ relativePath: "a.md", contentHash: blob.hash, snapshotRef: blob.hash, acceptedBy: OWNER }], 0);
	const observation = new KnowledgeObservationService(acceptance, { objects });
	const searchIndex = new KnowledgeSearchIndex(path.join(root, "index-cache"), objects);
	const reviews = new ReviewStore(path.join(root, "reviews"));
	const operationsDir = path.join(root, "operations");
	const journal = new PublishJournal(operationsDir);
	const publisher = new MarkdownWikiPublisher({
		bindings, reviews, journal, acceptance, observation, objects, searchIndex, operationsDir,
		...(stepHook ? { stepHook } : {}),
	});
	return { root, vault, binding, bindings, objects, acceptance, observation, searchIndex, reviews, journal, publisher, operationsDir };
}

let batchSeq = 0;

/** 构造合法批次：候选字节入对象库；update/delete 的基线取当前磁盘内容哈希。 */
async function buildBatch(fixture: PublisherFixture,
	files: Array<{ targetPath: string; content?: string; operation?: "create" | "update" | "delete" }>,
	dependencyGroups?: string[][]): Promise<PublicationBatch> {
	batchSeq += 1;
	const built = [];
	for (const file of files) {
		const operation = file.operation ?? "create";
		const blob = operation === "delete" ? null : await fixture.objects.put(Buffer.from(file.content ?? "", "utf8"));
		const baseline = operation === "create" ? null :
			hashBufferSha256(await readFile(path.join(fixture.vault, file.targetPath)));
		built.push({
			targetPath: file.targetPath,
			operation,
			expectedHashOrAbsent: baseline,
			candidateHash: blob?.hash ?? null,
			blobRef: blob?.hash ?? null,
		});
	}
	const batch: PublicationBatch = {
		id: `pub-batch-${batchSeq}`,
		revision: 1,
		bindingId: fixture.binding.id,
		manifestHash: "",
		rootIdentity: fixture.binding.rootIdentity,
		files: built,
		sourceSnapshots: ["snap-1"],
		bindingRevision: 1,
		trustRevision: 1,
		dependencyGroups: dependencyGroups ?? [files.map((file) => file.targetPath)],
		validationReceipt: "{}",
		compilerVersion: "test",
		status: "candidate",
	};
	batch.manifestHash = publicationManifestHash(batch);
	return batch;
}

async function approveAndPublish(fixture: PublisherFixture, batch: PublicationBatch) {
	await fixture.reviews.registerCandidate(batch, OWNER);
	const { decision } = await fixture.reviews.decide({
		batchId: batch.id, operationId: `op-${batch.id}`, actorId: OWNER, decision: "approve",
		manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: batch.files.map((file) => file.targetPath),
	});
	const outcome = await fixture.publisher.onApproved(batch, decision);
	return { decision, outcome };
}

const readVault = (fixture: PublisherFixture, relative: string) =>
	readFile(path.join(fixture.vault, relative), "utf8").catch(() => null);

test("publisher：发布成功——原子写入、before-image 留存、账本回写与索引/观察重建", async () => {
	const fixture = await publisherFixture();
	const batch = await buildBatch(fixture, [
		{ targetPath: "a.md", content: "# Updated\n", operation: "update" },
		{ targetPath: "Daily/x.md", content: "---\ntitle: 日报\n---\n# Daily\n" },
	]);
	const { outcome } = await approveAndPublish(fixture, batch);
	assert.equal(outcome.accepted, true);
	assert.match(outcome.note ?? "", /已发布/);
	// 磁盘：update 替换、create 新建
	assert.equal(await readVault(fixture, "a.md"), "# Updated\n");
	assert.equal(await readVault(fixture, "Daily/x.md"), "---\ntitle: 日报\n---\n# Daily\n");
	// 批次与操作收敛
	const stored = (await fixture.reviews.get(batch.id))!;
	assert.equal(stored.status, "published");
	const operation = (await fixture.journal.list())[0]!;
	assert.equal(operation.state, "published");
	assert.equal(operation.committedGroups.length, 1);
	const update = operation.files.find((file) => file.targetPath === "a.md")!;
	assert.deepEqual(update.receipts.map((receipt) => receipt.step), ["preflight", "before_image", "write", "verify"]);
	const create = operation.files.find((file) => file.targetPath === "Daily/x.md")!;
	assert.deepEqual(create.receipts.map((receipt) => receipt.step), ["preflight", "write", "verify"]);
	// before-image 留存且与基线一致
	const beforeImage = await readFile(path.join(fixture.operationsDir, operation.id, "before", "a.md"), "utf8");
	assert.equal(beforeImage, "# Accepted\n");
	assert.equal(update.beforeImageRef, hashBufferSha256(Buffer.from("# Accepted\n", "utf8")));
	// 账本回写：revision 推进、a.md 更新、Daily/x.md 新建（identity 来自候选 frontmatter）
	const ledger = await fixture.acceptance.getSnapshot(fixture.binding.id);
	assert.equal(ledger.acceptanceRevision, 2);
	const updated = Object.values(ledger.entries).find((entry) => entry.relativePath === "a.md")!;
	assert.equal(updated.contentHash, hashBufferSha256(Buffer.from("# Updated\n", "utf8")));
	assert.equal(updated.acceptedBy, OWNER);
	const created = Object.values(ledger.entries).find((entry) => entry.relativePath === "Daily/x.md")!;
	assert.equal(created.title, "日报");
	// 索引重建与观察重扫已触发
	const index = await fixture.searchIndex.load(fixture.binding.id, ledger);
	assert.equal(index.acceptanceRevision, 2);
	assert.ok(index.notesByPath.has("Daily/x.md"));
	const record = await fixture.observation.scan(fixture.binding);
	assert.equal(record.files.get("a.md")!.state, "current");
	assert.equal(record.files.get("Daily/x.md")!.state, "current");
});

test("publisher：写前基线冲突整批中止且零落盘（P05）", async () => {
	const fixture = await publisherFixture();
	const batch = await buildBatch(fixture, [
		{ targetPath: "a.md", content: "# Updated\n", operation: "update" },
		{ targetPath: "Daily/y.md", content: "# Y\n" },
	]);
	await writeFile(path.join(fixture.vault, "a.md"), "# Tampered\n"); // 审核后外部改动
	const { outcome } = await approveAndPublish(fixture, batch);
	assert.equal(outcome.accepted, true);
	assert.match(outcome.note ?? "", /未写入任何字节/);
	assert.equal(await readVault(fixture, "a.md"), "# Tampered\n", "外部改动原样保留");
	assert.equal(await readVault(fixture, "Daily/y.md"), null, "零落盘：create 目标未写入");
	const stored = (await fixture.reviews.get(batch.id))!;
	assert.equal(stored.status, "conflict");
	assert.equal(stored.conflictReason, "publish_preflight");
	const operation = (await fixture.journal.list())[0]!;
	assert.equal(operation.state, "conflict");
	assert.equal(operation.files.find((file) => file.targetPath === "a.md")!.status, "conflict");
	assert.equal(operation.committedGroups.length, 0);
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2, "真实外部变更自动同步，不是采纳冲突候选");
	assert.equal(Object.values((await fixture.acceptance.getSnapshot(fixture.binding.id)).entries)[0]!.contentHash, hashBufferSha256(Buffer.from("# Tampered\n")));
});

test("publisher：create 不覆盖——预读后目标被外部创建则冲突拒写（wx 语义）", async () => {
	let vaultPath = "";
	const fixture = await publisherFixture(async (step) => {
		if (step === "preflight") await writeFile(path.join(vaultPath, "c.md"), "# External\n");
	});
	vaultPath = fixture.vault;
	const batch = await buildBatch(fixture, [{ targetPath: "c.md", content: "# Candidate\n" }]);
	const { outcome } = await approveAndPublish(fixture, batch);
	assert.equal(outcome.accepted, true);
	assert.equal(await readVault(fixture, "c.md"), "# External\n", "既有文件未被覆盖");
	const operation = (await fixture.journal.list())[0]!;
	assert.equal(operation.state, "conflict");
	assert.equal(operation.files[0]!.status, "conflict");
	assert.match(operation.files[0]!.error ?? "", /不覆盖/);
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2, "外部抢建实际内容同步");
});

test("publisher：依赖组全成才提交——partial 不进账本（P08）", async () => {
	let vaultPath = "";
	const fixture = await publisherFixture(async (step, targetPath) => {
		// 第一组提交完成后，外部抢建第二组的 create 目标
		if (step === "group_commit" && targetPath === "a.md") await writeFile(path.join(vaultPath, "d.md"), "# External\n");
	});
	vaultPath = fixture.vault;
	const batch = await buildBatch(fixture, [
		{ targetPath: "a.md", content: "# Updated\n", operation: "update" },
		{ targetPath: "d.md", content: "# D\n" },
	], [["a.md"], ["d.md"]]);
	const { outcome } = await approveAndPublish(fixture, batch);
	assert.equal(outcome.accepted, true);
	assert.match(outcome.note ?? "", /部分发布/);
	assert.equal(await readVault(fixture, "a.md"), "# Updated\n", "第一组已落盘");
	assert.equal(await readVault(fixture, "d.md"), "# External\n", "第二组冲突目标未被覆盖");
	const stored = (await fixture.reviews.get(batch.id))!;
	assert.equal(stored.status, "partial");
	const operation = (await fixture.journal.list())[0]!;
	assert.equal(operation.state, "partial");
	assert.deepEqual(operation.committedGroups, [["a.md"]]);
	const ledger = await fixture.acceptance.getSnapshot(fixture.binding.id);
	assert.equal(ledger.acceptanceRevision, 3, "第一组发布加真实外部抢建同步");
	assert.equal(Object.values(ledger.entries).find((entry) => entry.relativePath === "d.md")!.contentHash, hashBufferSha256(Buffer.from("# External\n")), "同步的是外部内容，不是未提交候选");
});

test("publisher：写后校验失败标 uncertain 并停止后续写入", async () => {
	let vaultPath = "";
	const fixture = await publisherFixture(async (step, targetPath) => {
		if (step === "write" && targetPath === "a.md") await writeFile(path.join(vaultPath, "a.md"), "# Third\n");
	});
	vaultPath = fixture.vault;
	const batch = await buildBatch(fixture, [
		{ targetPath: "a.md", content: "# Updated\n", operation: "update" },
		{ targetPath: "e.md", content: "# E\n" },
	]);
	const { outcome } = await approveAndPublish(fixture, batch);
	assert.equal(outcome.accepted, true);
	assert.match(outcome.note ?? "", /结果未知/);
	assert.equal(await readVault(fixture, "a.md"), "# Third\n", "第三方内容不被覆盖");
	assert.equal(await readVault(fixture, "e.md"), null, "后续写入已停止");
	const operation = (await fixture.journal.list())[0]!;
	assert.equal(operation.state, "unknown");
	assert.equal(operation.files.find((file) => file.targetPath === "a.md")!.status, "uncertain");
	assert.equal(operation.files.find((file) => file.targetPath === "e.md")!.status, "failed");
	const stored = (await fixture.reviews.get(batch.id))!;
	assert.equal(stored.status, "conflict");
	assert.equal(stored.conflictReason, "publish_uncertain");
});

test("publisher：delete 请求整批拒止（fail-closed）", async () => {
	const fixture = await publisherFixture();
	const batch = await buildBatch(fixture, [{ targetPath: "a.md", operation: "delete" }]);
	const { outcome } = await approveAndPublish(fixture, batch);
	assert.equal(outcome.accepted, true);
	assert.match(outcome.note ?? "", /拒止/);
	assert.equal(await readVault(fixture, "a.md"), "# Accepted\n", "delete 未执行");
	const operation = (await fixture.journal.list())[0]!;
	assert.equal(operation.state, "conflict");
	assert.equal(operation.files[0]!.status, "rejected");
	const stored = (await fixture.reviews.get(batch.id))!;
	assert.equal(stored.status, "conflict");
	assert.equal(stored.conflictReason, "publish_rejected");
});

test("reconcile：崩溃在组登记前——磁盘与账本证据齐全，补登记完成发布（不重复 adopt）", async () => {
	const fixture = await publisherFixture((step) => {
		if (step === "group_commit") throw new PublishCrashError("boom");
	});
	const batch = await buildBatch(fixture, [{ targetPath: "a.md", content: "# Updated\n", operation: "update" }]);
	await fixture.reviews.registerCandidate(batch, OWNER);
	const { decision } = await fixture.reviews.decide({
		batchId: batch.id, operationId: `op-${batch.id}`, actorId: OWNER, decision: "approve",
		manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: ["a.md"],
	});
	await assert.rejects(() => fixture.publisher.onApproved(batch, decision), PublishCrashError);
	assert.equal((await fixture.reviews.get(batch.id))!.status, "publishing");
	assert.equal((await fixture.journal.list())[0]!.state, "running");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2, "崩溃前 adopt 已完成");
	// 模拟重启后的启动对账（同存储目录、无崩溃钩子）
	const settled = await fixture.publisher.reconcileInterrupted();
	assert.equal(settled.length, 1);
	assert.equal(settled[0]!.state, "published");
	assert.equal(settled[0]!.committedGroups.length, 1);
	assert.equal((await fixture.reviews.get(batch.id))!.status, "published");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2, "账本证据齐全时只补登记，不重复 adopt");
	assert.equal(await readVault(fixture, "a.md"), "# Updated\n");
});

test("reconcile：崩溃在写入后——未提交组回滚 before-image，账本不动（P09/P11）", async () => {
	const fixture = await publisherFixture((step, targetPath) => {
		if (step === "write" && targetPath === "a.md") throw new PublishCrashError("boom");
	});
	const batch = await buildBatch(fixture, [
		{ targetPath: "a.md", content: "# Updated\n", operation: "update" },
		{ targetPath: "f.md", content: "# F\n" },
	]);
	await fixture.reviews.registerCandidate(batch, OWNER);
	const { decision } = await fixture.reviews.decide({
		batchId: batch.id, operationId: `op-${batch.id}`, actorId: OWNER, decision: "approve",
		manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: batch.files.map((file) => file.targetPath),
	});
	await assert.rejects(() => fixture.publisher.onApproved(batch, decision), PublishCrashError);
	assert.equal(await readVault(fixture, "a.md"), "# Updated\n", "崩溃时 rename 已生效");
	assert.equal(await readVault(fixture, "f.md"), null);
	const settled = await fixture.publisher.reconcileInterrupted();
	assert.equal(settled.length, 1);
	assert.equal(settled[0]!.state, "conflict");
	const operation = settled[0]!;
	const update = operation.files.find((file) => file.targetPath === "a.md")!;
	assert.equal(update.status, "rolled_back");
	assert.deepEqual(update.receipts.map((receipt) => receipt.step), ["preflight", "before_image", "reconcile", "rollback"]);
	assert.equal(operation.files.find((file) => file.targetPath === "f.md")!.status, "failed");
	assert.equal(await readVault(fixture, "a.md"), "# Accepted\n", "before-image 已恢复");
	const stored = (await fixture.reviews.get(batch.id))!;
	assert.equal(stored.status, "conflict");
	assert.equal(stored.conflictReason, "publish_interrupted");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 1, "未提交组不进账本");
});

test("reconcile：外部新编辑不被回滚覆盖，只报告转人工（P11）", async () => {
	let vaultPath = "";
	const fixture = await publisherFixture((step, targetPath) => {
		if (step === "write" && targetPath === "a.md") throw new PublishCrashError("boom");
	});
	vaultPath = fixture.vault;
	const batch = await buildBatch(fixture, [{ targetPath: "a.md", content: "# Updated\n", operation: "update" }]);
	await fixture.reviews.registerCandidate(batch, OWNER);
	const { decision } = await fixture.reviews.decide({
		batchId: batch.id, operationId: `op-${batch.id}`, actorId: OWNER, decision: "approve",
		manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: ["a.md"],
	});
	await assert.rejects(() => fixture.publisher.onApproved(batch, decision), PublishCrashError);
	// 崩溃后、对账前：用户在外部又编辑了该文件
	await writeFile(path.join(vaultPath, "a.md"), "# External edit\n");
	const settled = await fixture.publisher.reconcileInterrupted();
	assert.equal(settled.length, 1);
	assert.equal(settled[0]!.state, "conflict");
	const file = settled[0]!.files[0]!;
	assert.equal(file.status, "conflict");
	assert.match(file.error ?? "", /转人工/);
	assert.equal(await readVault(fixture, "a.md"), "# External edit\n", "外部编辑原样保留，before-image 不覆盖");
	const stored = (await fixture.reviews.get(batch.id))!;
	assert.equal(stored.status, "conflict");
	assert.equal(stored.conflictReason, "publish_external");
});

test("reconcile：磁盘已是候选但账本未写——补做组提交收敛 published", async () => {
	const fixture = await publisherFixture((step, targetPath) => {
		if (step === "verify" && targetPath === "a.md") throw new PublishCrashError("boom");
	});
	const batch = await buildBatch(fixture, [{ targetPath: "a.md", content: "# Updated\n", operation: "update" }]);
	await fixture.reviews.registerCandidate(batch, OWNER);
	const { decision } = await fixture.reviews.decide({
		batchId: batch.id, operationId: `op-${batch.id}`, actorId: OWNER, decision: "approve",
		manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: ["a.md"],
	});
	await assert.rejects(() => fixture.publisher.onApproved(batch, decision), PublishCrashError);
	const settled = await fixture.publisher.reconcileInterrupted();
	assert.equal(settled[0]!.state, "published");
	assert.equal((await fixture.reviews.get(batch.id))!.status, "published");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2, "补做组提交");
	assert.equal(await readVault(fixture, "a.md"), "# Updated\n", "前向完成，不回滚");
});

async function approveOnly(fixture: PublisherFixture, batch: PublicationBatch) {
	await fixture.reviews.registerCandidate(batch, OWNER);
	return (await fixture.reviews.decide({ batchId: batch.id, operationId: `op-${batch.id}`, actorId: OWNER,
		decision: "approve", manifestHash: batch.manifestHash, expectedBatchRevision: 1,
		reviewedFiles: batch.files.map((file) => file.targetPath) })).decision;
}

function restartedPublisher(fixture: PublisherFixture) {
	return new MarkdownWikiPublisher({ ...fixture, reviews: new ReviewStore(path.join(fixture.root, "reviews")),
		journal: new PublishJournal(fixture.operationsDir) });
}

test("自动同步与真实多文件发布共用串行锁，中途扫描等待且不洗白未提交组", async () => {
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>(resolve => release = resolve), writing = new Promise<void>(resolve => entered = resolve);
	const f = await publisherFixture(async (step, target) => { if (step === "write" && target === "a.md") { entered(); await gate; } });
	const batch = await buildBatch(f, [{ targetPath: "a.md", operation: "update", content: "# reviewed first\n" }, { targetPath: "b.md", content: "# reviewed second\n" }]);
	const publish = f.publisher.onApproved(batch, await approveOnly(f, batch)); await writing;
	let scanned = false; const scan = f.observation.scan(f.binding).then(record => { scanned = true; return record; });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(scanned, false); assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, 1);
	release(); await publish; const observed = await scan;
	assert.equal(observed.files.get("a.md")!.state, "current"); assert.equal(observed.files.get("b.md")!.state, "current");
	const ledger = await f.acceptance.getSnapshot(f.binding.id); assert.equal(ledger.acceptanceRevision, 2);
	assert(Object.values(ledger.entries).every(entry => entry.acceptedBy === OWNER), "组提交后的扫描保留人审发布来源，不伪记外部编辑");
});

test("图片发布：3MiB原件先于嵌套页面，同hash复用不覆写且不进入Markdown账本或索引", async () => {
	const written: string[] = [];
	const f = await publisherFixture((step, target) => { if (step === "write") written.push(target); });
	const first = await imageBatch(f, { large: true });
	await approveAndPublish(f, first.batch);
	assert.deepEqual(written, [first.assetPath, first.pagePath]);
	assert.deepEqual(await readFile(path.join(f.vault, first.assetPath)), first.bytes);
	const ledger = await f.acceptance.getSnapshot(f.binding.id);
	assert.deepEqual(Object.values(ledger.entries).map(entry => entry.relativePath).sort(), ["a.md", first.pagePath].sort());
	assert.equal((await f.searchIndex.load(f.binding.id, ledger)).notesByPath.has(first.assetPath), false);
	const before = await stat(path.join(f.vault, first.assetPath));
	const second = await imageBatch(f, { large: true, update: true });
	second.batch.files[0]!.operation = "update"; second.batch.files[0]!.expectedHashOrAbsent = second.batch.files[0]!.candidateHash;
	second.batch.manifestHash = publicationManifestHash(second.batch);
	await approveAndPublish(f, second.batch);
	const after = await stat(path.join(f.vault, first.assetPath));
	assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
	assert.equal(written.filter(target => target === first.assetPath).length, 1);
});

test("图片审核/冲突：图和页全部已阅才能批准，拒绝零写，同名非原bytes不覆写", async () => {
	const f = await publisherFixture(), image = await imageBatch(f);
	await f.reviews.registerCandidate(image.batch, OWNER);
	await assert.rejects(f.reviews.decide({ batchId: image.batch.id, operationId: "omit-image", actorId: OWNER, decision: "approve", manifestHash: image.batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: [image.pagePath] }));
	await f.reviews.decide({ batchId: image.batch.id, operationId: "reject-image", actorId: OWNER, decision: "reject", manifestHash: image.batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: [] });
	assert.equal(await readVault(f, image.assetPath), null); assert.equal(await readVault(f, image.pagePath), null);
	const conflict = await imageBatch(f);
	await mkdir(path.dirname(path.join(f.vault, conflict.assetPath)), { recursive: true });
	await writeFile(path.join(f.vault, conflict.assetPath), "external");
	await approveAndPublish(f, conflict.batch);
	assert.equal((await f.reviews.get(conflict.batch.id))!.status, "conflict");
	assert.equal(await readVault(f, conflict.assetPath), "external"); assert.equal(await readVault(f, conflict.pagePath), null);
});

test("图片恢复：3MiB资产与页面字节齐全才补提交，重复重启不重复采纳", async () => {
	const f = await publisherFixture((step, target) => { if (step === "write" && target.endsWith("page.md")) throw new PublishCrashError("page persisted"); });
	const image = await imageBatch(f, { large: true });
	const review = await approveOnly(f, image.batch);
	await assert.rejects(f.publisher.onApproved(image.batch, review), PublishCrashError);
	await restartedPublisher(f).reconcileInterrupted();
	assert.equal((await f.reviews.get(image.batch.id))!.status, "published");
	assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, 2);
	await restartedPublisher(f).reconcileInterrupted();
	assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, 2);
	assert.deepEqual(await readFile(path.join(f.vault, image.assetPath)), image.bytes);
});

test("图片恢复：新图写完而页面未写可安全删除，复用的原图回滚仍保留", async () => {
	for (const reuse of [false, true]) {
		const f = await publisherFixture((step, target) => { if ((!reuse && step === "write" && target.startsWith("assets/")) || (reuse && step === "write" && target.endsWith("page.md"))) throw new PublishCrashError("partial group"); });
		const image = await imageBatch(f, { reuse, secondPage: true });
		await assert.rejects(f.publisher.onApproved(image.batch, await approveOnly(f, image.batch)), PublishCrashError);
		await restartedPublisher(f).reconcileInterrupted();
		assert.equal(await readVault(f, image.pagePath), null);
		if (reuse) assert.deepEqual(await readFile(path.join(f.vault, image.assetPath)), image.bytes);
		else assert.equal(await readVault(f, image.assetPath), null);
		assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, 1);
	}
});

test("图片恢复：外部编辑引用页或before-image损坏时保留原图，转人工不采纳", async () => {
	for (const mode of ["external", "missing-before"]) {
		const f = await publisherFixture((step, target) => { if (step === "write" && target === "a.md") throw new PublishCrashError("partial image group"); });
		const image = await imageBatch(f, { update: true, secondPage: true });
		await assert.rejects(f.publisher.onApproved(image.batch, await approveOnly(f, image.batch)), PublishCrashError);
		if (mode === "external") await writeFile(path.join(f.vault, "a.md"), image.content + "用户新编辑\n");
		else { const operation = (await f.journal.list())[0]!; await unlink(path.join(f.operationsDir, operation.id, "before", "a.md")); }
		const [operation] = await restartedPublisher(f).reconcileInterrupted();
		assert.equal(operation!.state, "unknown");
		assert.match(operation!.files.find(file => file.kind === "image")!.error!, /保留原图/);
		assert.deepEqual(await readFile(path.join(f.vault, image.assetPath)), image.bytes);
		assert.match((await readVault(f, "a.md"))!, /assets\/images/);
		assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, mode === "external" ? 2 : 1, "真正外部编辑同步，候选残留仍隔离");
	}
});

test("图片恢复：原图被外部变异不能补提交；未变页面先回滚不形成假成功", async () => {
	const f = await publisherFixture((step, target) => { if (step === "write" && target.endsWith("page.md")) throw new PublishCrashError("page persisted"); });
	const image = await imageBatch(f);
	await assert.rejects(f.publisher.onApproved(image.batch, await approveOnly(f, image.batch)), PublishCrashError);
	await writeFile(path.join(f.vault, image.assetPath), "external image");
	await restartedPublisher(f).reconcileInterrupted();
	assert.equal(await readVault(f, image.pagePath), null);
	assert.equal(await readVault(f, image.assetPath), "external image");
	assert.equal((await f.reviews.get(image.batch.id))!.status, "conflict");
	assert.equal((await f.acceptance.getSnapshot(f.binding.id)).acceptanceRevision, 1);
});

test("reconcile：approve 落账但无 journal 的任务重启续发，重启两次不重复采纳", async () => {
	const fixture = await publisherFixture();
	const batch = await buildBatch(fixture, [{ targetPath: "orphan.md", content: "# Orphan\n" }]);
	await approveOnly(fixture, batch);
	assert.equal((await fixture.journal.list()).length, 0);
	const publisher = restartedPublisher(fixture);
	assert.equal((await publisher.reconcileInterrupted()).length, 1);
	assert.equal((await fixture.reviews.get(batch.id))!.status, "published");
	assert.equal(await readVault(fixture, "orphan.md"), "# Orphan\n");
	assert.equal((await restartedPublisher(fixture).reconcileInterrupted()).length, 0);
	assert.equal((await fixture.journal.list()).length, 1);
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2);
});

test("reconcile：journal 创建后、publishing 落账前崩溃明确收敛，不重放未知操作", async () => {
	const fixture = await publisherFixture();
	const batch = await buildBatch(fixture, [{ targetPath: "queued.md", content: "# Queued\n" }]);
	const review = await approveOnly(fixture, batch);
	await fixture.journal.begin({ batch, ownerId: OWNER, actorId: OWNER, reviewId: review.id, idempotencyKey: review.id });
	await restartedPublisher(fixture).reconcileInterrupted();
	assert.equal((await fixture.reviews.get(batch.id))!.status, "conflict");
	assert.equal((await fixture.journal.list())[0]!.state, "conflict");
	assert.equal(await readVault(fixture, "queued.md"), null);
});

test("reconcile：journal published 后 review 结算前崩溃补收敛且不重复采纳", async () => {
	const fixture = await publisherFixture();
	const batch = await buildBatch(fixture, [{ targetPath: "settle.md", content: "# Settled\n" }]);
	const review = await approveOnly(fixture, batch);
	fixture.reviews.settlePublish = async () => { throw new PublishCrashError("review settlement crash"); };
	await assert.rejects(() => fixture.publisher.onApproved(batch, review), PublishCrashError);
	assert.equal((await fixture.journal.list())[0]!.state, "published");
	assert.equal((await fixture.reviews.get(batch.id))!.status, "publishing");
	await restartedPublisher(fixture).reconcileInterrupted();
	assert.equal((await fixture.reviews.get(batch.id))!.status, "published");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2);
});

test("publisher：调用方替换候选或审核决定被拒绝，正式区零变化", async () => {
	const fixture = await publisherFixture();
	const batch = await buildBatch(fixture, [{ targetPath: "forged.md", content: "# Reviewed\n" }]);
	const review = await approveOnly(fixture, batch);
	const blob = await fixture.objects.put(Buffer.from("# Unreviewed\n"));
	const forged = { ...batch, files: batch.files.map((file) => ({ ...file, blobRef: blob.hash, candidateHash: blob.hash })) };
	forged.manifestHash = publicationManifestHash(forged);
	assert.equal((await fixture.publisher.onApproved(forged, review)).accepted, false);
	assert.equal((await fixture.publisher.onApproved(batch, { ...review, actorId: "forged" })).accepted, false);
	assert.equal(await readVault(fixture, "forged.md"), null);
	assert.equal((await fixture.journal.list()).length, 0);
});

test("publisher：审核后的 binding/schema/trust/root 代际变化均拒绝零写入", async () => {
	for (const revision of ["binding", "schema", "trust", "root"] as const) {
		const fixture = await publisherFixture();
		const batch = await buildBatch(fixture, [{ targetPath: "stale.md", content: "# Stale\n" }]);
		const review = await approveOnly(fixture, batch);
		const current = { ...fixture.binding,
			...(revision === "binding" ? { bindingRevision: 2 } : {}),
			...(revision === "trust" ? { trustRevision: 2 } : {}),
			...(revision === "root" ? { rootIdentity: "different" } : {}),
			...(revision === "schema" ? { schemaRef: { format: "teams-schema", id: "new-schema", revision: 1, hash: "a".repeat(64) } } : {}),
		};
		const publisher = new MarkdownWikiPublisher({ ...fixture, bindings: { requireUsable: async () => current } });
		await publisher.onApproved(batch, review);
		assert.equal((await fixture.reviews.get(batch.id))!.status, "conflict", revision);
		assert.equal(await readVault(fixture, "stale.md"), null, revision);
		const operation = (await fixture.journal.list())[0]!;
		const expectedReason = { binding: "连接配置已更新", schema: "结构已更新", trust: "授权已变化", root: "文件夹已变化" }[revision];
		assert.match(operation.stopReason ?? "", new RegExp(expectedReason), revision);
		assert.match(operation.stopReason ?? "", /未写入任何文件/);
		assert.equal(operation.files[0]!.receipts.length, 0);
	}
});

test("publisher：预检后父目录被替换为 symlink 时拒绝写入库外", async () => {
	let fixture: PublisherFixture;
	fixture = await publisherFixture(async (step) => {
		if (step !== "preflight") return;
		await mkdir(path.join(fixture.root, "outside"));
		await rename(path.join(fixture.vault, "sub"), path.join(fixture.vault, "saved-sub"));
		await symlink(path.join(fixture.root, "outside"), path.join(fixture.vault, "sub"));
	});
	const batch = await buildBatch(fixture, [{ targetPath: "sub/x.md", content: "# Unsafe\n" }]);
	await approveAndPublish(fixture, batch);
	assert.equal(await readFile(path.join(fixture.root, "outside", "x.md"), "utf8").catch(() => null), null);
	assert.equal((await fixture.reviews.get(batch.id))!.status, "conflict");
});


test("publisher：四文件含index/log发布，控制快照与笔记分开且重启不重复采纳", async () => {
	const fixture = await publisherFixture((step) => { if (step === "group_commit") throw new PublishCrashError("after ledger commit"); });
	const batch = await buildBatch(fixture, [
		{ targetPath: "a.md", content: "# Updated\n", operation: "update" },
		{ targetPath: "b.md", content: "# New\n" },
		{ targetPath: "index.md", content: "# Index\n[[a]] [[b]]\n" },
		{ targetPath: "log.md", content: "# Log\n已审核生成 a/b\n" },
	]);
	const review = await approveOnly(fixture, batch);
	await assert.rejects(() => fixture.publisher.onApproved(batch, review), PublishCrashError);
	await restartedPublisher(fixture).reconcileInterrupted();
	const ledger = await fixture.acceptance.getSnapshot(fixture.binding.id);
	assert.equal(ledger.acceptanceRevision, 2, "已提交的混合组恢复不重复adopt");
	assert.equal(Object.keys(ledger.entries).length, 2);
	assert.equal(Object.keys(ledger.controlEntries!).length, 2);
	assert.equal(ledger.entries["path:index.md"], undefined);
	assert.equal((await fixture.objects.get(ledger.controlEntries!["path:index.md"]!.snapshotRef)).toString(), "# Index\n[[a]] [[b]]\n");
	assert.equal((await fixture.reviews.get(batch.id))!.status, "published");
	const index = await fixture.searchIndex.load(fixture.binding.id, ledger);
	assert.equal(index.notesByPath.has("index.md"), false, "普通笔记检索索引不混入控制文档");
});

test("reconcile：unknown异常可凭磁盘证据完成，并补收敛之前的publish_uncertain", async () => {
	const fixture = await publisherFixture((step) => { if (step === "group_commit") throw new Error("receipt database unavailable"); });
	const batch = await buildBatch(fixture, [{ targetPath: "unknown.md", content: "# Written\n" }]);
	await approveAndPublish(fixture, batch);
	assert.equal((await fixture.reviews.get(batch.id))!.conflictReason, "publish_uncertain");
	assert.equal((await fixture.journal.list())[0]!.state, "unknown");
	await restartedPublisher(fixture).reconcileInterrupted();
	assert.equal((await fixture.reviews.get(batch.id))!.status, "published");
	assert.equal((await fixture.journal.list())[0]!.state, "published");
});
