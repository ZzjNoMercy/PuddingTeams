import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publicationManifestHash, type PublicationBatch } from "../contracts.js";
import { PublishJournal, PublishJournalError, toPublishOperation } from "./publish-journal.js";

function buildBatch(id: string): PublicationBatch {
	const content = createHash("sha256").update(`${id}:content`).digest("hex");
	const batch: PublicationBatch = {
		id,
		revision: 1,
		bindingId: "binding-1",
		manifestHash: "",
		rootIdentity: "root-1",
		files: [
			{ targetPath: "a.md", operation: "update", expectedHashOrAbsent: "b".repeat(64), candidateHash: content, blobRef: content },
			{ targetPath: "Daily/x.md", operation: "create", expectedHashOrAbsent: null, candidateHash: content, blobRef: content },
		],
		sourceSnapshots: ["snap-1"],
		bindingRevision: 1,
		trustRevision: 1,
		dependencyGroups: [["a.md", "Daily/x.md"]],
		validationReceipt: "{}",
		compilerVersion: "test",
		status: "approved",
	};
	batch.manifestHash = publicationManifestHash(batch);
	return batch;
}

async function journalFixture(): Promise<PublishJournal> {
	return new PublishJournal(await realpath(await mkdtemp(path.join(tmpdir(), "pt-publish-journal-"))));
}

test("publish-journal：begin 持久化逐文件粒度，operationId 幂等不双写（P07）", async () => {
	const journal = await journalFixture();
	const batch = buildBatch("batch-1");
	const began = await journal.begin({ batch, ownerId: "u1", actorId: "u1", reviewId: "review-1", idempotencyKey: "review-1" });
	assert.equal(began.replayed, false);
	assert.equal(began.record.state, "queued");
	assert.equal(began.record.journalRef, `publish-journal:${began.record.id}`);
	assert.equal(began.record.files.length, 2);
	assert.deepEqual(began.record.files[0], {
		targetPath: "a.md", operation: "update", candidateHash: batch.files[0]!.candidateHash,
		baselineHash: "b".repeat(64), beforeImageRef: null, status: "pending", receipts: [],
	});
	// 同键同批次 → 幂等回放
	const replay = await journal.begin({ batch, ownerId: "u1", actorId: "u1", reviewId: "review-1", idempotencyKey: "review-1" });
	assert.equal(replay.replayed, true);
	assert.equal(replay.record.id, began.record.id);
	assert.equal((await journal.list()).length, 1);
	// 同键不同批次内容 → conflict
	const other = buildBatch("batch-2");
	await assert.rejects(() => journal.begin({ batch: other, ownerId: "u1", actorId: "u1", reviewId: "review-1", idempotencyKey: "review-1" }),
		(error: unknown) => error instanceof PublishJournalError && error.code === "conflict");
});

test("publish-journal：回执逐步落盘、组登记幂等、状态收敛与对账扫描面", async () => {
	const journal = await journalFixture();
	const batch = buildBatch("batch-3");
	const { record } = await journal.begin({ batch, ownerId: "u1", actorId: "u1", reviewId: "r", idempotencyKey: "r" });
	// queued 也在对账扫描面内（begin 后 setRunning 前的崩溃窗）
	assert.equal((await journal.listInterrupted()).length, 1);
	const running = await journal.setRunning(record.id);
	assert.equal(running.state, "running");
	await assert.rejects(() => journal.setRunning(record.id), (error: unknown) =>
		error instanceof PublishJournalError && error.code === "conflict");
	await journal.appendReceipt(record.id, "a.md", { step: "before_image" }, { beforeImageRef: "b".repeat(64) });
	await journal.appendReceipt(record.id, "a.md", { step: "write", detail: batch.files[0]!.candidateHash! });
	const verified = await journal.appendReceipt(record.id, "a.md", { step: "verify" }, { status: "applied" });
	const file = verified.files[0]!;
	assert.deepEqual(file.receipts.map((receipt) => receipt.step), ["before_image", "write", "verify"]);
	assert.equal(file.status, "applied");
	assert.equal(file.beforeImageRef, "b".repeat(64));
	// 组登记幂等
	await journal.markGroupCommitted(record.id, ["a.md", "Daily/x.md"]);
	const again = await journal.markGroupCommitted(record.id, ["Daily/x.md", "a.md"]);
	assert.equal(again.committedGroups.length, 1);
	// 收敛 terminal：finishedAt 落盘，退出对账扫描面
	const settled = await journal.settle(record.id, "published");
	assert.ok(settled.finishedAt);
	assert.equal((await journal.listInterrupted()).length, 0);
	// wire 投影
	const view = toPublishOperation(settled);
	assert.equal(view.state, "published");
	assert.equal(view.results[0]!.status, "applied");
	assert.equal(view.results[0]!.afterHash, batch.files[0]!.candidateHash);
	assert.ok(view.results[0]!.receiptRef!.startsWith(settled.journalRef));
	// unknown 态留在扫描面（等启动对账）
	const second = await journal.begin({ batch: buildBatch("batch-4"), ownerId: "u1", actorId: "u1", reviewId: "r2", idempotencyKey: "r2" });
	await journal.setRunning(second.record.id);
	await journal.settle(second.record.id, "unknown");
	assert.deepEqual((await journal.listInterrupted()).map((operation) => operation.id), [second.record.id]);
});
