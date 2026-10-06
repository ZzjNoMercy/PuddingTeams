import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { publicationManifestHash, type PublicationBatch } from "../contracts.js";
import { REVIEW_WINDOW_MS, ReviewStore, ReviewStoreError } from "./review-store.js";

const OWNER = "user-local";
const BINDING = "binding-1";
const ROOT_IDENTITY = "root-identity-1";

let batchSeq = 0;

/** 构造合法候选批次：hash 由内容推出，manifestHash 先置空再回填。 */
function buildBatch(files: Array<{ targetPath: string; content: string; operation?: "create" | "update" }>, id?: string): PublicationBatch {
	batchSeq += 1;
	const batch: PublicationBatch = {
		id: id ?? `batch-${batchSeq}`,
		revision: 1,
		bindingId: BINDING,
		manifestHash: "",
		rootIdentity: ROOT_IDENTITY,
		files: files.map((file) => ({
			targetPath: file.targetPath,
			operation: file.operation ?? "create",
			expectedHashOrAbsent: (file.operation ?? "create") === "create" ? null : "b".repeat(64),
			candidateHash: createHash("sha256").update(file.content).digest("hex"),
		})),
		sourceSnapshots: ["snapshot-1"],
		bindingRevision: 1,
		trustRevision: 1,
		dependencyGroups: [files.map((file) => file.targetPath)],
		validationReceipt: "{}",
		compilerVersion: "test-compiler",
		status: "candidate",
	};
	batch.manifestHash = publicationManifestHash(batch);
	return batch;
}

async function storeFixture(now?: () => number): Promise<{ store: ReviewStore; dir: string }> {
	const dir = await realpath(await mkdtemp(path.join(tmpdir(), "pt-review-store-")));
	return { store: new ReviewStore(dir, now), dir };
}

function decideInput(batch: PublicationBatch, overrides: Record<string, unknown> = {}) {
	return {
		batchId: batch.id,
		operationId: `op-${batch.id}`,
		actorId: OWNER,
		decision: "approve" as const,
		manifestHash: batch.manifestHash,
		reviewedFiles: batch.files.map((file) => file.targetPath),
		...overrides,
	};
}

test("review-store：候选转正、幂等重放与内容代际失效", async () => {
	const { store } = await storeFixture();
	const batch = buildBatch([{ targetPath: "a.md", content: "v1" }]);
	const first = await store.registerCandidate(batch, OWNER);
	assert.equal(first.replayed, false);
	assert.equal(first.record.status, "pending_review");
	assert.equal(first.record.batch.status, "pending_review");
	assert.equal(first.record.revision, 1);
	assert.ok(first.record.enteredReviewAt);
	// 幂等：同 id 同 manifestHash 重放不重置状态
	const replay = await store.registerCandidate(batch, OWNER);
	assert.equal(replay.replayed, true);
	assert.equal(replay.record.revision, 1);
	assert.equal(replay.record.enteredReviewAt, first.record.enteredReviewAt);
	// 内容变化：revision+1、审核窗与决定字段重置
	const v2 = buildBatch([{ targetPath: "a.md", content: "v2" }], batch.id);
	const bumped = await store.registerCandidate(v2, OWNER);
	assert.equal(bumped.replayed, false);
	assert.equal(bumped.record.revision, 2);
	assert.equal(bumped.record.status, "pending_review");
	assert.equal(bumped.record.decidedAt, undefined);
	assert.equal(bumped.record.decisionId, undefined);
	// 旧代际被拒：过期 manifestHash 即拒（批次号已在 manifest 载荷内）
	await assert.rejects(() => store.decide(decideInput(batch)), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
	await assert.rejects(() => store.decide(decideInput(v2, { manifestHash: batch.manifestHash })), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
	// 新代际可审
	const decided = await store.decide(decideInput(v2));
	assert.equal(decided.record.status, "approved");
	assert.equal(decided.record.batch.status, "approved");
});

test("review-store：approve 全流程、operationId 幂等与冲突", async () => {
	const { store } = await storeFixture();
	const batch = buildBatch([{ targetPath: "a.md", content: "x" }, { targetPath: "b.md", content: "y" }]);
	await store.registerCandidate(batch, OWNER);
	const decided = await store.decide(decideInput(batch));
	assert.equal(decided.replayed, false);
	assert.equal(decided.record.status, "approved");
	assert.ok(decided.record.decidedAt);
	assert.equal(decided.record.decisionId, decided.decision.id);
	assert.equal(decided.decision.batchId, batch.id);
	assert.equal(decided.decision.revision, batch.revision, "决定的 revision 绑定批次号（contracts 语义）");
	assert.equal(decided.decision.manifestHash, batch.manifestHash);
	assert.deepEqual([...decided.decision.expectedTargets].sort(), ["a.md", "b.md"]);
	// 同 operationId 同负载重放：返回既有决定，不重复落账
	const replay = await store.decide(decideInput(batch));
	assert.equal(replay.replayed, true);
	assert.equal(replay.decision.id, decided.decision.id);
	assert.equal((await store.decisionsFor(batch.id)).length, 1);
	// 同 operationId 不同负载 → conflict
	await assert.rejects(() => store.decide(decideInput(batch, { decision: "reject" })), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
	// 已有决定后再审（新 operationId）→ conflict
	await assert.rejects(() => store.decide(decideInput(batch, { operationId: "op-second" })), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
});

test("review-store：reject、发布登记与覆盖校验", async () => {
	const { store } = await storeFixture();
	const batch = buildBatch([{ targetPath: "a.md", content: "x" }]);
	await store.registerCandidate(batch, OWNER);
	// 部分覆盖（漏掉批次内文件以外的路径也算伪造）→ conflict
	await assert.rejects(() => store.decide(decideInput(batch, { reviewedFiles: ["a.md", "extra.md"] })),
		(error: unknown) => error instanceof ReviewStoreError && error.code === "conflict");
	// 伪造 manifestHash → conflict
	await assert.rejects(() => store.decide(decideInput(batch, { manifestHash: "c".repeat(64) })),
		(error: unknown) => error instanceof ReviewStoreError && error.code === "conflict");
	// 跨批借用 manifestHash → conflict
	const other = buildBatch([{ targetPath: "a.md", content: "x" }]);
	await assert.rejects(() => store.decide(decideInput(batch, { manifestHash: other.manifestHash })),
		(error: unknown) => error instanceof ReviewStoreError && error.code === "conflict");
	// 未决批次不能登记发布
	await assert.rejects(() => store.markPublishRequested(batch.id),
		(error: unknown) => error instanceof ReviewStoreError && error.code === "conflict");
	const rejected = await store.decide(decideInput(batch, { decision: "reject" }));
	assert.equal(rejected.record.status, "rejected");
	assert.equal(rejected.record.batch.status, "rejected");
	// rejected 也不能登记发布
	await assert.rejects(() => store.markPublishRequested(batch.id),
		(error: unknown) => error instanceof ReviewStoreError && error.code === "conflict");
	// approved 批次：登记幂等
	const batch2 = buildBatch([{ targetPath: "c.md", content: "z" }]);
	await store.registerCandidate(batch2, OWNER);
	await store.decide(decideInput(batch2));
	const marked = await store.markPublishRequested(batch2.id);
	assert.ok(marked.publishRequestedAt);
	const again = await store.markPublishRequested(batch2.id);
	assert.equal(again.publishRequestedAt, marked.publishRequestedAt);
});

test("review-store：24 小时审核窗，超期转入 conflict 且决定被拒", async () => {
	let now = Date.parse("2026-09-28T00:00:00Z");
	const { store } = await storeFixture(() => now);
	const batch = buildBatch([{ targetPath: "a.md", content: "x" }]);
	await store.registerCandidate(batch, OWNER);
	// 23 小时内：仍可审
	now += 23 * 60 * 60 * 1000;
	assert.equal((await store.get(batch.id))!.status, "pending_review");
	const decided = await store.decide(decideInput(batch));
	assert.equal(decided.record.status, "approved");
	// 另起一批：25 小时后 get/list 懒过期落盘为 conflict
	const stale = buildBatch([{ targetPath: "b.md", content: "y" }]);
	await store.registerCandidate(stale, OWNER);
	now += 25 * 60 * 60 * 1000;
	assert.ok(25 * 60 * 60 * 1000 > REVIEW_WINDOW_MS - 23 * 60 * 60 * 1000);
	assert.equal((await store.get(stale.id))!.status, "conflict");
	assert.equal((await store.get(stale.id))!.batch.status, "conflict");
	const listed = await store.list();
	assert.equal(listed.find((record) => record.batch.id === stale.id)!.status, "conflict");
	assert.equal(listed.find((record) => record.batch.id === batch.id)!.status, "approved", "已决批次不受超期影响");
	await assert.rejects(() => store.decide(decideInput(stale)),
		(error: unknown) => error instanceof ReviewStoreError && error.code === "expired",
		"懒过期落盘后的 decide 仍应还原为 expired 语义");
	// 超窗瞬间（恰好在 pending_review 时跨过窗口）decide 抛 expired
	const expiring = buildBatch([{ targetPath: "c.md", content: "z" }]);
	await store.registerCandidate(expiring, OWNER);
	now += 25 * 60 * 60 * 1000;
	await assert.rejects(() => store.decide(decideInput(expiring)),
		(error: unknown) => error instanceof ReviewStoreError && error.code === "expired");
	assert.equal((await store.get(expiring.id))!.status, "conflict", "expired 决定已把批次落盘为 conflict");
});

test("review-store：输入校验与缺失批次", async () => {
	const { store } = await storeFixture();
	const batch = buildBatch([{ targetPath: "a.md", content: "x" }]);
	assert.equal(await store.get("missing"), undefined);
	await assert.rejects(() => store.decide(decideInput(batch)), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "not_found");
	await assert.rejects(() => store.registerCandidate({ ...batch, manifestHash: "0".repeat(64) }, OWNER));
	await store.registerCandidate(batch, OWNER);
	await assert.rejects(() => store.decide(decideInput(batch, { manifestHash: "not-a-hash" })), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "invalid_input");
});

test("review-store：发布态转移 approved→publishing→published/partial/conflict", async () => {
	const { store } = await storeFixture();
	const batch = buildBatch([{ targetPath: "a.md", content: "x" }]);
	await store.registerCandidate(batch, OWNER);
	// 非 approved 不能进入发布
	await assert.rejects(() => store.markPublishing(batch.id), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
	await store.decide(decideInput(batch));
	// approved → publishing → published，批次快照 status 同步
	const publishing = await store.markPublishing(batch.id);
	assert.equal(publishing.status, "publishing");
	assert.equal(publishing.batch.status, "publishing");
	// publishing 中不可重复进入、不可登记发布受理
	await assert.rejects(() => store.markPublishing(batch.id), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
	await assert.rejects(() => store.markPublishRequested(batch.id), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
	const published = await store.settlePublish(batch.id, "published");
	assert.equal(published.status, "published");
	assert.equal(published.batch.status, "published");
	// 终态不可再收敛
	await assert.rejects(() => store.settlePublish(batch.id, "partial"), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "conflict");
	// conflict 收敛必须带原因
	const batch2 = buildBatch([{ targetPath: "b.md", content: "y" }]);
	await store.registerCandidate(batch2, OWNER);
	await store.decide(decideInput(batch2));
	await store.markPublishing(batch2.id);
	await assert.rejects(() => store.settlePublish(batch2.id, "conflict"), (error: unknown) =>
		error instanceof ReviewStoreError && error.code === "invalid_input");
	const conflicted = await store.settlePublish(batch2.id, "conflict", "publish_external");
	assert.equal(conflicted.status, "conflict");
	assert.equal(conflicted.conflictReason, "publish_external");
	assert.equal(conflicted.batch.status, "conflict");
	// partial 收敛
	const batch3 = buildBatch([{ targetPath: "c.md", content: "z" }]);
	await store.registerCandidate(batch3, OWNER);
	await store.decide(decideInput(batch3));
	await store.markPublishing(batch3.id);
	assert.equal((await store.settlePublish(batch3.id, "partial")).status, "partial");
});


test("review-store：批准后的候选不可改写，跨 owner/库 identity 不可重用", async () => {
	const { store } = await storeFixture();
	const batch = buildBatch([{ targetPath: "immutable.md", content: "reviewed" }]);
	await store.registerCandidate(batch, OWNER);
	await store.decide(decideInput(batch));
	const replacement = buildBatch([{ targetPath: "immutable.md", content: "unreviewed" }], batch.id);
	await assert.rejects(() => store.registerCandidate(replacement, OWNER), ReviewStoreError);
	await assert.rejects(() => store.registerCandidate(batch, "other-owner"), ReviewStoreError);
	assert.equal((await store.get(batch.id))!.batch.manifestHash, batch.manifestHash);
	await assert.rejects(() => store.decide(decideInput(batch, { actorId: "other-owner" })), ReviewStoreError);
});


test("review-store：直接提交超期审核也持久化 conflict，不因事务异常回滚超期状态", async () => {
	let now = Date.now();
	const { store, dir } = await storeFixture(() => now);
	const batch = buildBatch([{ targetPath: "expired.md", content: "expired" }]);
	await store.registerCandidate(batch, OWNER);
	now += REVIEW_WINDOW_MS + 1;
	await assert.rejects(() => store.decide(decideInput(batch)), (error: unknown) => error instanceof ReviewStoreError && error.code === "expired");
	const db = new DatabaseSync(path.join(dir, "reviews.sqlite"));
	try {
		const row = db.prepare("SELECT status FROM review_batches WHERE batch_id = ?").get(batch.id) as { status: string };
		assert.equal(row.status, "conflict", "不经 get/list 懒过期也必须持久化");
	} finally { db.close(); }
});


test("review-store：reject保留真实已阅子集可空，仍拒绝重复/跨批次文件", async () => {
	for (const viewed of [[], ["a.md"]]) {
		const { store } = await storeFixture();
		const batch = buildBatch([{ targetPath: "a.md", content: "A" }, { targetPath: "b.md", content: "B" }]);
		await store.registerCandidate(batch, OWNER);
		for (const forged of [["other.md"], ["a.md", "a.md"]]) {
			await assert.rejects(() => store.decide(decideInput(batch, { decision: "reject", reviewedFiles: forged })), ReviewStoreError);
		}
		const rejected = await store.decide(decideInput(batch, { decision: "reject", reviewedFiles: viewed }));
		assert.deepEqual(rejected.decision.reviewedFiles, viewed);
		assert.deepEqual(rejected.decision.expectedTargets, ["a.md", "b.md"]);
	}
});
