import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeSourceStore } from "../knowledge/sources.js";
import type { CuratorJob } from "../knowledge/curator-jobs.js";
import type { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import type { WikiCuratorService } from "../knowledge/curator-jobs.js";
import { MemoError } from "./contracts.js";
import { MemoPromoter, memoSourceId } from "./promote.js";
import { MemoStore } from "./store.js";

function fakeCurator() {
	const jobs = new Map<string, CuratorJob>();
	const calls: Array<{ operationId: string; sourceIds?: string[]; task: string; bindingId: string }> = [];
	let sequence = 0;
	const create = async (input: Parameters<WikiCuratorService["create"]>[0]) => {
		calls.push({ operationId: input.operationId, sourceIds: input.sourceIds, task: input.task, bindingId: input.bindingId });
		const existing = [...jobs.values()].find((job) => job.operationId === input.operationId);
		if (existing) return { job: existing, replayed: true };
		const job = {
			id: `job-${++sequence}`, operationId: input.operationId, ownerId: input.ownerId,
			requestHash: "hash", executionMode: input.executionMode ?? "background",
			targetBindingId: input.bindingId, agentId: "wiki", agentRevision: 0, task: input.task,
			sources: [], baseline: [], bindingRevision: 1, trustRevision: 1, rootIdentity: "root",
			contentPrefix: "", contractHash: null, status: "queued",
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		} as unknown as CuratorJob;
		jobs.set(job.id, job);
		return { job, replayed: false };
	};
	return { jobs, calls, create, get: async (id: string) => jobs.get(id), list: async () => [...jobs.values()] };
}

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-memo-promote-"));
	const objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const sources = new KnowledgeSourceStore({ stateDir: path.join(root, "knowledge-state"), objects });
	const directory = path.join(root, "memo");
	const store = new MemoStore(directory);
	const curator = fakeCurator();
	const bindings = { requireUsable: async () => { throw new Error("unused"); } };
	const promoter = new MemoPromoter({
		store, sources, curator, jobs: curator,
		bindings: { requireUsable: async (ownerId: string, bindingId: string) => {
			if (bindingId !== "b1") throw new Error("目标知识库不可用");
			return { id: bindingId } as never;
		} } as unknown as Pick<KnowledgeBindingRegistry, "requireUsable">,
	});
	return { root, directory, store, sources, promoter, curator, bindings, close: () => rm(root, { recursive: true, force: true }) };
}

const code = (expected: string) => (error: unknown) => error instanceof MemoError && error.code === expected;

test("promote：确定性来源 id、有序快照与来源身份", async () => {
	const { store, sources, promoter, curator, close } = await fixture();
	try {
		const owner = "local:a";
		const a = store.create(owner, { operationId: "op-a", text: "第一条 #产品 #x" }).memo;
		const b = store.create(owner, { operationId: "op-b", text: "第二条" }).memo;
		const result = await promoter.promote(owner, { operationId: "op-p", memoIds: [b.id, a.id], bindingId: "b1", task: "整理" });
		assert.equal(result.promotion.phase, "job_created");
		assert.equal(result.job.operationId, "memo:op-p");
		assert.equal(result.promotion.jobId, result.job.id);
		assert.equal(curator.calls.length, 1);
		const sourceIds = result.promotion.items.map((item) => item.sourceId!);
		assert.deepEqual(sourceIds, [memoSourceId(owner, "op-p", b.id), memoSourceId(owner, "op-p", a.id)]);
		const source = await sources.get(owner, sourceIds[1]!);
		assert.deepEqual(source?.origin?.memo, { id: a.id, createdAt: a.createdAt, tags: ["产品", "x"].sort((x, y) => x.localeCompare(y, "zh-CN")), revision: 1 });
		assert.equal((await sources.readText(owner, sourceIds[1]!)).text, a.text);
		assert.equal(store.get(owner, a.id).lifecycle, "promoting");
		assert.equal(store.get(owner, a.id).currentOperationId, "op-p");

		const replay = await promoter.promote(owner, { operationId: "op-p", memoIds: [b.id, a.id], bindingId: "b1", task: "整理" });
		assert.equal(replay.replayed, true);
		assert.equal(replay.job.id, result.job.id);
		assert.equal(curator.calls.length, 1);
		assert.equal((await sources.manifest(owner, sourceIds)).sources.length, 2);
	} finally { await close(); }
});

test("promote：同键异载荷冲突，失效知识库在任何冻结前拒绝", async () => {
	const { store, sources, promoter, curator, close } = await fixture();
	try {
		const owner = "local:a";
		const a = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		const b = store.create(owner, { operationId: "op-b", text: "第二条" }).memo;
		await assert.rejects(() => promoter.promote(owner, { operationId: "op-bad", memoIds: [a.id], bindingId: "gone", task: "整理" }), /目标知识库不可用/);
		assert.equal(store.get(owner, a.id).lifecycle, "unorganized");
		await promoter.promote(owner, { operationId: "op-p", memoIds: [a.id], bindingId: "b1", task: "整理" });
		await assert.rejects(() => promoter.promote(owner, { operationId: "op-p", memoIds: [a.id], bindingId: "b1", task: "换了要求" }), code("conflict"));
		await assert.rejects(() => promoter.promote(owner, { operationId: "op-p", memoIds: [a.id, b.id], bindingId: "b1", task: "整理" }), code("conflict"));
		await assert.rejects(() => promoter.promote(owner, { operationId: "op-other", memoIds: [a.id], bindingId: "b1", task: "第二次" }), code("conflict"));
		const calls = curator.calls.length;
		assert.equal(calls, 1);
	} finally { await close(); }
});

test("promote：冻结后崩溃可从原 attempt 续跑，不重复来源或 Job", async () => {
	const { store, sources, promoter, curator, close } = await fixture();
	try {
		const owner = "local:a";
		const a = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		store.reservePromotion(owner, { operationId: "op-crash", memoIds: [a.id], bindingId: "b1", task: "整理" });
		await promoter.recover();
		const promotion = store.promotion(owner, "op-crash")!;
		assert.equal(promotion.phase, "job_created");
		assert.ok(promotion.jobId);
		assert.equal(curator.calls.length, 1);
		assert.equal((await sources.manifest(owner, promotion.items.map((item) => item.sourceId!))).sources.length, 1);
	} finally { await close(); }
});

test("promote：Job 已创建但 checkpoint 丢失时重放找回原 Job", async () => {
	const { store, directory, sources, promoter, curator, close } = await fixture();
	try {
		const owner = "local:a";
		const a = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		const first = await promoter.promote(owner, { operationId: "op-p", memoIds: [a.id], bindingId: "b1", task: "整理" });
		const db = new DatabaseSync(path.join(directory, "memo.sqlite"));
		try {
			db.prepare("UPDATE memo_promotions SET phase='sources_frozen', job_id=NULL WHERE operation_id=?").run("op-p");
		} finally { db.close(); }
		const replay = await promoter.promote(owner, { operationId: "op-p", memoIds: [a.id], bindingId: "b1", task: "整理" });
		assert.equal(replay.job.id, first.job.id);
		const promotion = store.promotion(owner, "op-p")!;
		assert.equal(promotion.phase, "job_created");
		assert.equal(promotion.jobId, first.job.id);
		assert.equal(curator.calls.length, 2);
		assert.equal((await sources.manifest(owner, promotion.items.map((item) => item.sourceId!))).sources.length, 1);
	} finally { await close(); }
});

test("promote：发布后删除速记不影响已固定来源与历史", async () => {
	const { store, sources, promoter, close } = await fixture();
	try {
		const owner = "local:a";
		const a = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		const result = await promoter.promote(owner, { operationId: "op-p", memoIds: [a.id], bindingId: "b1", task: "整理" });
		store.completeMemos(owner, [a.id], "op-p", "published");
		assert.equal(store.get(owner, a.id).lifecycle, "organized");
		const removed = store.remove(owner, a.id, { operationId: "op-del", expectedRevision: 1 });
		assert.ok(removed.memo.deletedAt);
		const sourceId = result.promotion.items[0]!.sourceId!;
		assert.equal((await sources.readText(owner, sourceId)).text, "第一条");
		assert.equal(store.promotion(owner, "op-p")?.phase, "job_created");
	} finally { await close(); }
});

test("promote：Job 创建失败时结束 attempt 并释放速记，可用新 operationId 重试", async () => {
	const { root } = await fixture();
	const objects = new KnowledgeObjectStore(path.join(root, "objects-2"));
	const sources = new KnowledgeSourceStore({ stateDir: path.join(root, "knowledge-state-2"), objects });
	const directory = path.join(root, "memo-2");
	const store = new MemoStore(directory);
	const jobs = new Map<string, CuratorJob>();
	let failures = 1;
	const curator = {
		create: async (input: Parameters<WikiCuratorService["create"]>[0]) => {
			if (failures-- > 0) throw new Error("同一 operationId 已用于不同整理请求");
			const job = { id: "job-ok", operationId: input.operationId, ownerId: input.ownerId, requestHash: "h", executionMode: "background",
				targetBindingId: input.bindingId, agentId: "wiki", agentRevision: 0, task: input.task, sources: [], baseline: [],
				bindingRevision: 1, trustRevision: 1, rootIdentity: "root", contentPrefix: "", contractHash: null,
				status: "queued", createdAt: "", updatedAt: "" } as unknown as CuratorJob;
			jobs.set(job.id, job);
			return { job, replayed: false };
		},
	};
	const promoter = new MemoPromoter({
		store, sources, curator, jobs: { get: async (id: string) => jobs.get(id) },
		bindings: { requireUsable: async () => ({ id: "b1" }) as never } as unknown as Pick<KnowledgeBindingRegistry, "requireUsable">,
	});
	const owner = "local:a";
	const first = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
	await assert.rejects(
		() => promoter.promote(owner, { operationId: "op-p", memoIds: [first.id], bindingId: "b1", task: "整理" }),
		(error: unknown) => error instanceof MemoError && error.code === "unavailable",
	);
	const failedAttempt = store.promotion(owner, "op-p")!;
	assert.equal(failedAttempt.phase, "failed");
	assert.equal(store.get(owner, first.id).lifecycle, "unorganized");
	assert.match(store.get(owner, first.id).lastError ?? "", /operationId/);
	assert.deepEqual(store.recoverable(), [], "失败 attempt 不应在启动时被反复重试");

	const retried = await promoter.promote(owner, { operationId: "op-p2", memoIds: [first.id], bindingId: "b1", task: "整理" });
	assert.equal(retried.job.id, "job-ok");
	assert.equal(store.get(owner, first.id).lifecycle, "promoting");
});

test("promote：失败后同 operationId 重放，若 Job 已存在则认领而不是重建", async () => {
	const { store, promoter, curator, close } = await fixture();
	try {
		const owner = "local:a";
		const memo = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		store.reservePromotion(owner, { operationId: "op-p", memoIds: [memo.id], bindingId: "b1", task: "整理" });
		store.advancePhase(owner, "op-p", ["freezing"], "sources_frozen");
		store.failPromotion(owner, "op-p", "创建 Job 时崩溃");
		assert.equal(store.get(owner, memo.id).lifecycle, "unorganized");
		// 模拟 Job 已在崩溃前创建，但 checkpoint 未写回。
		const job = { id: "job-crash", operationId: "memo:op-p", ownerId: owner, requestHash: "h", executionMode: "background",
			targetBindingId: "b1", agentId: "wiki", agentRevision: 0, task: "整理", sources: [], baseline: [],
			bindingRevision: 1, trustRevision: 1, rootIdentity: "root", contentPrefix: "", contractHash: null,
			status: "queued", createdAt: "", updatedAt: "" } as unknown as CuratorJob;
		curator.jobs.set(job.id, job);
		const replay = await promoter.promote(owner, { operationId: "op-p", memoIds: [memo.id], bindingId: "b1", task: "整理" });
		assert.equal(replay.job.id, "job-crash");
		assert.equal(replay.replayed, true);
		const promotion = store.promotion(owner, "op-p")!;
		assert.equal(promotion.phase, "job_created");
		assert.equal(promotion.jobId, "job-crash");
		assert.equal(store.get(owner, memo.id).lifecycle, "promoting");
		assert.equal(store.get(owner, memo.id).currentOperationId, "op-p");
		assert.equal(curator.calls.length, 0, "认领既有 Job 不应重新调用 curator");
	} finally { await close(); }
});

test("promote：失败的 attempt 在没有既有 Job 时拒绝同 operationId 重放", async () => {
	const { store, promoter, close } = await fixture();
	try {
		const owner = "local:a";
		const memo = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		store.reservePromotion(owner, { operationId: "op-p", memoIds: [memo.id], bindingId: "b1", task: "整理" });
		store.failPromotion(owner, "op-p", "失败");
		await assert.rejects(
			() => promoter.promote(owner, { operationId: "op-p", memoIds: [memo.id], bindingId: "b1", task: "整理" }),
			(error: unknown) => error instanceof MemoError && error.code === "conflict",
		);
		assert.equal(store.get(owner, memo.id).lifecycle, "unorganized");
	} finally { await close(); }
});

test("promote：不认领其它知识库或不同任务的同名 operationId Job", async () => {
	const { store, promoter, curator, close } = await fixture();
	try {
		const owner = "local:a";
		const memo = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		store.reservePromotion(owner, { operationId: "op-p", memoIds: [memo.id], bindingId: "b1", task: "整理" });
		store.failPromotion(owner, "op-p", "失败");
		const foreign = { id: "foreign-job", operationId: "memo:op-p", ownerId: owner, requestHash: "h", executionMode: "background",
			targetBindingId: "other-vault", agentId: "wiki", agentRevision: 0, task: "别人的任务", sources: [], baseline: [],
			bindingRevision: 1, trustRevision: 1, rootIdentity: "root", contentPrefix: "", contractHash: null,
			status: "queued", createdAt: "", updatedAt: "" } as unknown as CuratorJob;
		curator.jobs.set(foreign.id, foreign);
		await assert.rejects(
			() => promoter.promote(owner, { operationId: "op-p", memoIds: [memo.id], bindingId: "b1", task: "整理" }),
			(error: unknown) => error instanceof MemoError && error.code === "conflict",
		);
		assert.equal(store.get(owner, memo.id).lifecycle, "unorganized");
	} finally { await close(); }
});

test("promote：两个 operationId 并发整理同一条速记只有一个成功", async () => {
	const { store, promoter, close } = await fixture();
	try {
		const owner = "local:a";
		const memo = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		const results = await Promise.allSettled([
			promoter.promote(owner, { operationId: "op-x", memoIds: [memo.id], bindingId: "b1", task: "甲" }),
			promoter.promote(owner, { operationId: "op-y", memoIds: [memo.id], bindingId: "b1", task: "乙" }),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
		assert.ok(rejected.reason instanceof MemoError && rejected.reason.code === "conflict");
	} finally { await close(); }
});

test("promote：部分来源冻结后恢复不会重复冻结", async () => {
	const { store, sources, promoter, close } = await fixture();
	try {
		const owner = "local:a";
		const a = store.create(owner, { operationId: "op-a", text: "第一条" }).memo;
		const b = store.create(owner, { operationId: "op-b", text: "第二条" }).memo;
		const reserved = store.reservePromotion(owner, { operationId: "op-partial", memoIds: [a.id, b.id], bindingId: "b1", task: "整理" });
		await sources.createMemoText(owner, {
			id: memoSourceId(owner, "op-partial", a.id), text: a.text, title: `速记：${a.text}`,
			origin: { channel: "user_input", memo: { id: a.id, createdAt: a.createdAt, tags: a.tags, revision: a.revision } },
		});
		store.recordSource(owner, "op-partial", a.id, memoSourceId(owner, "op-partial", a.id));
		await promoter.recover();
		const promotion = store.promotion(owner, "op-partial")!;
		assert.equal(promotion.phase, "job_created");
		assert.equal(promotion.items.filter((item) => item.sourceId).length, 2);
		assert.equal((await sources.manifest(owner, promotion.items.map((item) => item.sourceId!))).sources.length, 2);
		assert.equal(reserved.promotion.phase, "freezing");
	} finally { await close(); }
});
