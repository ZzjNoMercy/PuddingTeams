import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KnowledgeAuditError, KnowledgeAuditStore } from "./audit-store.js";

const store = async () => new KnowledgeAuditStore(await mkdtemp(path.join(tmpdir(), "pt-audit-")));
const event = (overrides: Record<string, unknown> = {}) => ({
	kind: "review.approved" as const, ownerId: "owner", actorId: "owner", actorKind: "user" as const, channel: "chat" as const,
	bindingId: "vault", batchId: "batch-1", jobId: "job-1", sessionId: "session-1",
	manifestHash: "a".repeat(64), decision: "approve" as const, reviewedFiles: ["a.md"],
	summary: "批准 1 项候选入库", dedupeKey: "review:decision-1", ...overrides,
});

test("审计账本按业务事实追加，并按库/批次/类型可查", async () => {
	const audits = await store();
	const first = await audits.append(event());
	const rejected = await audits.append(event({ kind: "review.rejected", decision: "reject", dedupeKey: "review:decision-2", summary: "拒绝候选", batchId: "batch-2" }));
	assert.ok(first.seq > 0 && rejected.seq > first.seq);
	const all = await audits.list({ ownerId: "owner", limit: 20, offset: 0 });
	assert.deepEqual(all.events.map((item) => item.dedupeKey), ["review:decision-2", "review:decision-1"]);
	assert.equal(all.total, 2);
	const byBatch = await audits.list({ ownerId: "owner", batchId: "batch-1", limit: 20, offset: 0 });
	assert.deepEqual(byBatch.events.map((item) => item.id), [first.id]);
	const byKind = await audits.list({ ownerId: "owner", kind: "review.rejected", limit: 20, offset: 0 });
	assert.deepEqual(byKind.events.map((item) => item.batchId), ["batch-2"]);
	assert.equal((await audits.get("owner", first.id))?.summary, "批准 1 项候选入库");
	assert.equal(await audits.get("other", first.id), undefined);
});

test("同一幂等键重放不重复记账；同键不同负载拒绝且不改写历史", async () => {
	const audits = await store();
	const first = await audits.append(event({ at: "2026-10-20T00:00:00.000Z" }));
	const replay = await audits.append(event({ at: "2026-10-20T01:00:00.000Z" }));
	assert.equal(replay.id, first.id);
	assert.equal(replay.seq, first.seq);
	assert.equal((await audits.list({ ownerId: "owner", limit: 20, offset: 0 })).total, 1);
	await assert.rejects(audits.append(event({ summary: "不同结论" })), (error: unknown) =>
		error instanceof KnowledgeAuditError && error.code === "dedupe_conflict");
	assert.equal((await audits.get("owner", first.id))?.summary, "批准 1 项候选入库");
});

test("审计输入有界：非法哈希、超长文件清单与未知类型一律拒绝", async () => {
	const audits = await store();
	await assert.rejects(audits.append(event({ manifestHash: "not-a-hash" })), /manifestHash/);
	await assert.rejects(audits.append(event({ kind: "review.archived" })), /类型无效/);
	await assert.rejects(audits.append(event({ channel: "imessage" })), /通道无效/);
	await assert.rejects(audits.append(event({ reviewedFiles: Array.from({ length: 501 }, (_, index) => `f-${index}.md`) })), /reviewedFiles/);
	await assert.rejects(audits.list({ ownerId: "owner", limit: 0, offset: 0 }), /limit/);
	await assert.rejects(audits.list({ ownerId: "owner", kind: "review.archived" as never, limit: 20, offset: 0 }), /类型无效/);
});

test("重新打开目录仍只读既有事件，没有改写入口", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-audit-"));
	const audits = new KnowledgeAuditStore(dir, () => Date.parse("2026-10-20T00:00:00.000Z"));
	await audits.append(event());
	const reopened = new KnowledgeAuditStore(dir);
	const listed = await reopened.list({ ownerId: "owner", limit: 20, offset: 0 });
	assert.equal(listed.total, 1);
	assert.equal(listed.events[0]?.at, "2026-10-20T00:00:00.000Z");
	assert.equal(typeof (reopened as unknown as { update?: unknown }).update, "undefined");
	assert.equal(typeof (reopened as unknown as { delete?: unknown }).delete, "undefined");
});
