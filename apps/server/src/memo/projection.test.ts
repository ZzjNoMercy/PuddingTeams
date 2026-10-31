import assert from "node:assert/strict";
import { test } from "node:test";
import type { CuratorJob } from "../knowledge/curator-jobs.js";
import type { StoredReviewBatch } from "../knowledge/wiki/review-store.js";
import type { StoredPublishOperation } from "../knowledge/wiki/publish-journal.js";
import type { Memo } from "./contracts.js";
import { MemoProjection, mapMemoDisplay } from "./projection.js";

const job = (patch: Partial<CuratorJob> = {}) => ({
	id: "job-1", operationId: "memo:op", ownerId: "local:a", requestHash: "h", executionMode: "background",
	targetBindingId: "b1", agentId: "wiki", agentRevision: 0, task: "整理", sources: [], baseline: [],
	bindingRevision: 1, trustRevision: 1, rootIdentity: "root", contentPrefix: "", contractHash: null,
	status: "pending_review", candidateBatchId: "batch-1",
	createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z", ...patch,
} as unknown as CuratorJob);

const review = (status: StoredReviewBatch["status"], extra: Partial<StoredReviewBatch> = {}) => ({
	ownerId: "local:a", status, revision: 1, enteredReviewAt: "", createdAt: "", updatedAt: "",
	batch: { id: "batch-1", bindingId: "b1", files: [], manifestHash: "m" },
	...extra,
} as unknown as StoredReviewBatch);

const memo = (patch: Partial<Memo> = {}) => ({
	id: "m1", ownerId: "local:a", text: "正文", tags: [], lifecycle: "promoting" as const,
	createdAt: "", updatedAt: "", revision: 1, currentOperationId: "op", ...patch,
});

test("projection：事实源到显示状态的完整映射", () => {
	assert.equal(mapMemoDisplay({ lifecycle: "unorganized" }).state, "draft");
	assert.equal(mapMemoDisplay({ lifecycle: "unorganized" }).locked, false);
	assert.equal(mapMemoDisplay({ lifecycle: "organized", outcome: "published", bindingId: "b1" }).knowledgeUrl, "/knowledge?vault=b1");
	assert.equal(mapMemoDisplay({ lifecycle: "organized", outcome: "no_changes" }).state, "no_changes");
	assert.equal(mapMemoDisplay({ lifecycle: "organized", outcome: "no_changes" }).knowledgeUrl, undefined);
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "queued", jobId: "job-1" }).locked, true);
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "pending_review", batchId: "batch-1", bindingId: "b1" }).reviewUrl, "/knowledge/review?vault=b1&batch=batch-1");
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "pending_review", batchId: "batch-1", bindingId: "b1", reviewStatus: "returned" }).state, "returned");
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "pending_review", reviewStatus: "conflict" }).state, "conflict");
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "pending_review", reviewStatus: "conflict" }).locked, true);
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "pending_review", reviewStatus: "conflict", conflictClosed: true }).locked, false);
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "failed", failureCode: "candidate_registration_failed" }).state, "candidate_registration_failed");
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "failed" }).state, "failed");
	assert.equal(mapMemoDisplay({ lifecycle: "promoting", jobStatus: "pending_review", reviewStatus: "published", bindingId: "b1" }).knowledgeUrl, "/knowledge?vault=b1");
});

test("projection：published 回写已整理，rejected 释放到未整理，异常保持锁定", async () => {
	const settled: string[] = [];
	const resetSettled = () => { settled.length = 0; };
	const base = {
		promotion: () => ({ operationId: "op", requestHash: "h", ownerId: "local:a", bindingId: "b1", task: "整理", phase: "job_created" as const, jobId: "job-1", items: [], createdAt: "", updatedAt: "" }),
		byLifecycle: () => [],
		releaseMemos: (_owner: string, _ids: string[], _op: string, error?: string) => { settled.push(`release:${error}`); },
		completeMemos: (_owner: string, _ids: string[], _op: string, outcome: string) => { settled.push(`complete:${outcome}`); },
	};
	const build = (status: StoredReviewBatch["status"], publication: StoredPublishOperation["state"] | undefined = undefined) => {
		const deps = {
			store: base,
			jobs: { get: async () => job() },
			reviews: { get: async () => review(status) },
			publications: { list: async () => publication ? [{ ownerId: "local:a", batchId: "batch-1", state: publication } as StoredPublishOperation] : [] },
			revisions: { followup: async () => ({ newBatchId: "batch-2" }) },
		};
		return new MemoProjection(deps as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	};

	const published = build("published", "published");
	const attached = await published.attach("local:a", [memo()]);
	assert.equal(attached[0]!.display.state, "published");
	assert.deepEqual(settled, ["complete:published"]);

	resetSettled();
	const rejected = build("rejected");
	const released = await rejected.attach("local:a", [memo()]);
	assert.equal(released[0]!.memo.lifecycle, "unorganized");
	assert.match(settled[0]!, /^release:/);

	resetSettled();
	const registration = build("pending_review");
	const failedJob = new MemoProjection({
		store: base,
		jobs: { get: async () => job({ status: "failed", failureCode: "candidate_registration_failed", candidateBatchId: undefined }) },
		reviews: { get: async () => undefined },
		publications: { list: async () => [] },
	} as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	const locked = await failedJob.attach("local:a", [memo()]);
	assert.equal(locked[0]!.display.state, "candidate_registration_failed");
	assert.deepEqual(settled, []);

	resetSettled();
	const conflict = build("publishing", "unknown");
	await conflict.attach("local:a", [memo()]);
	assert.deepEqual(settled, []);

	resetSettled();
	const closedReleases: string[] = [];
	const closedStore: typeof base = { ...base, releaseMemos: (_o: string, _i: string[], _op: string, error?: string) => { closedReleases.push(error ?? ""); } };
	const closed = new MemoProjection({
		store: closedStore,
		jobs: { get: async () => job() },
		reviews: { get: async () => ({ ...review("conflict"), conflictClosure: { operationId: "c", actorId: "a", closedAt: "" } }) },
		publications: { list: async () => [] },
	} as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	await closed.attach("local:a", [memo()]);
	assert.deepEqual(closedReleases, ["冲突已解决，可重新整理"]);
});

test("projection：跨 owner 的素材不会被借用", async () => {
	const deps = {
		store: {
			promotion: () => undefined, byLifecycle: () => [],
			releaseMemos: () => undefined, completeMemos: () => undefined,
		},
		jobs: { get: async () => job() },
		reviews: { get: async () => review("pending_review") },
		publications: { list: async () => [] },
	};
	const projection = new MemoProjection(deps as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	const display = await projection.display("local:b", memo({ currentOperationId: undefined }));
	assert.equal(display.state, "queued");
	assert.equal(display.locked, true);
	assert.equal(display.reviewUrl, undefined);
});

test("projection：退回后跟随修订 Job/批次，直到发布或新的审核状态", async () => {
	const settled: string[] = [];
	const promotion = { operationId: "op", requestHash: "h", ownerId: "local:a", bindingId: "b1", task: "整理", phase: "job_created" as const, jobId: "job-1", items: [], createdAt: "", updatedAt: "" };
	const jobs = new Map<string, CuratorJob>([
		["job-1", job({ id: "job-1", candidateBatchId: "batch-1" })],
		["job-2", job({ id: "job-2", candidateBatchId: "batch-2" })],
	]);
	const batches = new Map<string, StoredReviewBatch>([
		["batch-1", review("returned")],
		["batch-2", { ...review("published"), batch: { ...review("published").batch, id: "batch-2", manifestHash: "m2" } } as StoredReviewBatch],
	]);
	const projection = new MemoProjection({
		store: {
			promotion: () => promotion, byLifecycle: () => [],
			releaseMemos: () => undefined,
			completeMemos: (_o: string, _i: string[], _op: string, outcome: string) => { settled.push(outcome); },
		},
		jobs: { get: async (id: string) => jobs.get(id) },
		reviews: { get: async (id: string) => batches.get(id) },
		publications: { list: async () => [{ ownerId: "local:a", batchId: "batch-2", bindingId: "b1", manifestHash: "m2", state: "published" } as StoredPublishOperation] },
		revisions: { followup: async (record: StoredReviewBatch) => record.batch.id === "batch-1" ? { operationId: "r", feedback: "改", actorId: "a", reviewedFiles: [], createdAt: "", jobId: "job-2", newBatchId: "batch-2" } : undefined },
	} as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	const [attached] = await projection.attach("local:a", [memo()]);
	assert.equal(attached!.display.state, "published");
	assert.equal(attached!.display.knowledgeUrl, "/knowledge?vault=b1");
	assert.deepEqual(settled, ["published"]);
});

test("projection：发布日志必须匹配 owner/binding/manifest，否则不当作已发布", async () => {
	const projection = new MemoProjection({
		store: {
			promotion: () => ({ operationId: "op", requestHash: "h", ownerId: "local:a", bindingId: "b1", task: "整理", phase: "job_created" as const, jobId: "job-1", items: [], createdAt: "", updatedAt: "" }),
			byLifecycle: () => [], releaseMemos: () => undefined, completeMemos: () => undefined,
		},
		jobs: { get: async () => job({ status: "pending_review", candidateBatchId: "batch-1" }) },
		reviews: { get: async () => review("publishing") },
		publications: { list: async () => [{ ownerId: "local:a", batchId: "batch-1", bindingId: "other-binding", manifestHash: "m", state: "published" } as StoredPublishOperation] },
	} as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	const display = await projection.display("local:a", memo());
	assert.notEqual(display.state, "published");
	assert.equal(display.state, "publishing");
});

test("projection：修订 Job 尚未 attach 批次时保留 returned；其它库的 Job 不参与投影", async () => {
	const promotion = { operationId: "op", requestHash: "h", ownerId: "local:a", bindingId: "b1", task: "整理", phase: "job_created" as const, jobId: "job-1", items: [], createdAt: "", updatedAt: "" };
	const returned = new MemoProjection({
		store: { promotion: () => promotion, byLifecycle: () => [], releaseMemos: () => undefined, completeMemos: () => undefined },
		jobs: { get: async () => job({ id: "job-1", candidateBatchId: "batch-1" }) },
		reviews: { get: async () => review("returned") },
		publications: { list: async () => [] },
		revisions: { followup: async () => ({ operationId: "r", feedback: "改", actorId: "a", reviewedFiles: [], createdAt: "" }) },
	} as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	const display = await returned.display("local:a", memo());
	assert.equal(display.state, "returned");
	assert.equal(display.locked, true);

	const foreign = new MemoProjection({
		store: { promotion: () => promotion, byLifecycle: () => [], releaseMemos: () => undefined, completeMemos: () => undefined },
		jobs: { get: async () => job({ targetBindingId: "other-vault", candidateBatchId: "batch-9", status: "pending_review" }) },
		reviews: { get: async () => review("published") },
		publications: { list: async () => [] },
	} as unknown as ConstructorParameters<typeof MemoProjection>[0]);
	const cross = await foreign.display("local:a", memo());
	assert.equal(cross.state, "queued");
	assert.equal(cross.reviewUrl, undefined);
	assert.equal(cross.knowledgeUrl, undefined);
});
