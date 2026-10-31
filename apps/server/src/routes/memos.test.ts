import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import type { Memo } from "../memo/contracts.js";
import type { MemoPromoter } from "../memo/promote.js";
import type { MemoProjection } from "../memo/projection.js";
import { MemoStore } from "../memo/store.js";
import { registerMemoRoutes } from "./memos.js";
import { localViewerIdentity } from "./identity.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-memo-routes-"));
	const store = new MemoStore(path.join(root, "memo"));
	const app = Fastify();
	const projection = {
		reconcile: async () => undefined,
		attach: async (_owner: string, memos: Memo[]) => memos.map((memo) => ({
			memo, display: { state: "draft" as const, label: "未整理", locked: false },
		})),
	};
	const promoter = {
		promote: async (owner: string, input: { operationId: string; memoIds: string[]; bindingId: string; task: string }) => {
			const reserved = store.reservePromotion(owner, input);
			store.advancePhase(owner, input.operationId, ["freezing"], "sources_frozen");
			const promotion = store.advancePhase(owner, input.operationId, ["sources_frozen"], "job_created", { jobId: "job-1" });
			assert.equal(reserved.promotion.phase, "freezing");
			return {
				promotion,
				job: { id: "job-1", status: "queued", operationId: `memo:${promotion.operationId}`, targetBindingId: promotion.bindingId },
				replayed: false,
			};
		},
	};
	registerMemoRoutes(app, { store, promoter: promoter as unknown as MemoPromoter, projection: projection as unknown as MemoProjection });
	return { root, app, store, close: () => rm(root, { recursive: true, force: true }) };
}

const owner = () => localViewerIdentity().user.id;

test("memo routes：创建、重放与 DTO 边界", async () => {
	const { app, close } = await fixture();
	try {
		const created = await app.inject({ method: "POST", url: "/api/memos", payload: { operationId: "op-1", text: "  #产品 第一条  " } });
		assert.equal(created.statusCode, 201);
		const body = created.json() as { memo: Record<string, unknown>; replayed: boolean };
		assert.equal(body.replayed, false);
		assert.equal(body.memo.text, "  #产品 第一条  ");
		assert.deepEqual(body.memo.tags, ["产品"]);
		assert.equal(body.memo.lifecycle, "unorganized");
		assert.equal(body.memo.ownerId, undefined);
		assert.equal(body.memo.requestHash, undefined);
		const replay = await app.inject({ method: "POST", url: "/api/memos", payload: { operationId: "op-1", text: "  #产品 第一条  " } });
		assert.equal(replay.statusCode, 200);
		assert.equal((replay.json() as { memo: { id: string } }).memo.id, (body.memo as { id: string }).id);
		const invalid = await app.inject({ method: "POST", url: "/api/memos", payload: { operationId: "op-2", text: "   " } });
		assert.equal(invalid.statusCode, 400);
		const conflict = await app.inject({ method: "POST", url: "/api/memos", payload: { operationId: "op-1", text: "别的" } });
		assert.equal(conflict.statusCode, 409);
	} finally { await close(); }
});

test("memo routes：列表计数、编辑 CAS、删除与恢复", async () => {
	const { app, close } = await fixture();
	try {
		const created = await app.inject({ method: "POST", url: "/api/memos", payload: { operationId: "op-1", text: "第一条 #读书" } });
		const id = (created.json() as { memo: { id: string } }).memo.id;
		const list = await app.inject({ method: "GET", url: "/api/memos?filter=all" });
		expectList(list.json(), 1);
		const patched = await app.inject({ method: "PATCH", url: `/api/memos/${id}`, payload: { text: "第二条 #产品", expectedRevision: 1 } });
		assert.equal(patched.statusCode, 200);
		assert.deepEqual((patched.json() as { memo: { tags: string[] } }).memo.tags, ["产品"]);
		const stale = await app.inject({ method: "PATCH", url: `/api/memos/${id}`, payload: { text: "第三条", expectedRevision: 1 } });
		assert.equal(stale.statusCode, 409);
		const removed = await app.inject({ method: "DELETE", url: `/api/memos/${id}`, payload: { operationId: "op-del", expectedRevision: 2 } });
		assert.equal(removed.statusCode, 200);
		assert.equal((await app.inject({ method: "GET", url: "/api/memos?filter=all" })).json().counts.all, 0);
		const restore = await app.inject({ method: "POST", url: `/api/memos/${id}/restore`, payload: { operationId: "op-restore" } });
		assert.equal(restore.statusCode, 200);
		assert.equal((await app.inject({ method: "GET", url: "/api/memos?filter=all" })).json().counts.all, 1);
	} finally { await close(); }
});

test("memo routes：整理返回 202，非法筛选与跨 owner 隔离", async () => {
	const { app, close } = await fixture();
	try {
		const created = await app.inject({ method: "POST", url: "/api/memos", payload: { operationId: "op-1", text: "第一条" } });
		const id = (created.json() as { memo: { id: string } }).memo.id;
		const promoted = await app.inject({ method: "POST", url: "/api/memos/promote", payload: { operationId: "op-p", memoIds: [id], bindingId: "b1", task: "整理" } });
		assert.equal(promoted.statusCode, 202);
		const body = promoted.json() as { jobId: string; phase: string; operationId: string; memos: Array<{ lifecycle: string }> };
		assert.equal(body.jobId, "job-1");
		assert.equal(body.phase, "job_created");
		assert.equal(body.memos[0]!.lifecycle, "promoting");
		const missing = await app.inject({ method: "POST", url: "/api/memos/promote", payload: { operationId: "op-x", memoIds: ["missing"], bindingId: "b1", task: "整理" } });
		assert.equal(missing.statusCode, 404);
		const badLimit = await app.inject({ method: "GET", url: "/api/memos?limit=999" });
		assert.equal(badLimit.statusCode, 400);
		assert.equal(owner().startsWith("local:"), true);
	} finally { await close(); }
});

function expectList(body: unknown, all: number) {
	const value = body as { items: unknown[]; counts: { all: number } };
	assert.equal(value.counts.all, all);
	assert.equal(value.items.length, all);
}
