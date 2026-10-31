import type { FastifyInstance } from "fastify";
import { localViewerIdentity } from "./identity.js";
import { MemoError, type Memo, type MemoDisplay, type MemoDto, type MemoListDto } from "../memo/contracts.js";
import type { MemoStore } from "../memo/store.js";
import type { MemoPromoter } from "../memo/promote.js";
import type { MemoProjection } from "../memo/projection.js";

export interface MemoRouteDeps {
	store: MemoStore;
	promoter: MemoPromoter;
	projection: MemoProjection;
}

function present(memo: Memo, display: MemoDisplay): MemoDto {
	return {
		id: memo.id,
		text: memo.text,
		tags: memo.tags,
		lifecycle: memo.lifecycle,
		createdAt: memo.createdAt,
		updatedAt: memo.updatedAt,
		revision: memo.revision,
		...(memo.lastError ? { lastError: memo.lastError } : {}),
		display,
	};
}

function statusFor(error: MemoError): number {
	if (error.code === "invalid_input") return 400;
	if (error.code === "not_found") return 404;
	if (error.code === "conflict") return 409;
	return 422;
}

function sendMemoError(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
	if (error instanceof MemoError) {
		return reply.code(statusFor(error)).send({ error: error.message, code: error.code });
	}
	throw error;
}

/** DTO 不暴露 ownerId/requestHash/内部指针；显示状态只来自只读投影。 */
export function registerMemoRoutes(app: FastifyInstance, deps: MemoRouteDeps): void {
	const ownerId = () => localViewerIdentity().user.id;

	app.get<{ Querystring: { filter?: string; tag?: string; q?: string; before?: string; limit?: string } }>("/api/memos", async (req, reply) => {
		try {
			const owner = ownerId();
			// 只读对账：终态回写生命周期；事实源暂不可读时不阻断列表。
			await deps.projection.reconcile(owner).catch(() => undefined);
			const result = deps.store.list(owner, {
				filter: req.query.filter,
				tag: req.query.tag,
				q: req.query.q,
				before: req.query.before,
				limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
			});
			const attached = await deps.projection.attach(owner, result.items);
			const body: MemoListDto = {
				items: attached.map(({ memo, display }) => present(memo, display)),
				counts: result.counts,
				tags: result.tags,
				nextBefore: result.nextBefore,
			};
			return body;
		} catch (error) {
			return sendMemoError(reply, error);
		}
	});

	app.post<{ Body: { operationId?: unknown; text?: unknown } }>("/api/memos", async (req, reply) => {
		try {
			const owner = ownerId();
			const { memo, replayed } = deps.store.create(owner, { operationId: req.body?.operationId, text: req.body?.text });
			const [attached] = await deps.projection.attach(owner, [memo]);
			return reply.code(replayed ? 200 : 201).send({ memo: present(attached!.memo, attached!.display), replayed });
		} catch (error) {
			return sendMemoError(reply, error);
		}
	});

	app.patch<{ Params: { id: string }; Body: { text?: unknown; expectedRevision?: unknown } }>("/api/memos/:id", async (req, reply) => {
		try {
			const owner = ownerId();
			const memo = deps.store.update(owner, req.params.id, {
				text: req.body?.text,
				expectedRevision: req.body?.expectedRevision,
			});
			const [attached] = await deps.projection.attach(owner, [memo]);
			return { memo: present(attached!.memo, attached!.display) };
		} catch (error) {
			return sendMemoError(reply, error);
		}
	});

	app.delete<{ Params: { id: string }; Body: { operationId?: unknown; expectedRevision?: unknown } }>("/api/memos/:id", async (req, reply) => {
		try {
			const { memo, replayed } = deps.store.remove(ownerId(), req.params.id, {
				operationId: req.body?.operationId,
				expectedRevision: req.body?.expectedRevision,
			});
			return { id: memo.id, revision: memo.revision, deletedAt: memo.deletedAt, deleted: Boolean(memo.deletedAt), replayed };
		} catch (error) {
			return sendMemoError(reply, error);
		}
	});

	app.post<{ Params: { id: string }; Body: { operationId?: unknown } }>("/api/memos/:id/restore", async (req, reply) => {
		try {
			const owner = ownerId();
			const { memo, replayed } = deps.store.restore(owner, req.params.id, { operationId: req.body?.operationId });
			const [attached] = await deps.projection.attach(owner, [memo]);
			return { memo: present(attached!.memo, attached!.display), deleted: Boolean(memo.deletedAt), replayed };
		} catch (error) {
			return sendMemoError(reply, error);
		}
	});

	app.post<{ Body: { operationId?: unknown; memoIds?: unknown; bindingId?: unknown; task?: unknown } }>("/api/memos/promote", async (req, reply) => {
		try {
			const owner = ownerId();
			const result = await deps.promoter.promote(owner, {
				operationId: req.body?.operationId,
				memoIds: req.body?.memoIds,
				bindingId: req.body?.bindingId,
				task: req.body?.task,
			});
			const memos = result.promotion.items.map((item) => deps.store.get(owner, item.memoId, true));
			const attached = await deps.projection.attach(owner, memos);
			return reply.code(202).send({
				operationId: result.promotion.operationId,
				phase: result.promotion.phase,
				bindingId: result.promotion.bindingId,
				jobId: result.job.id,
				jobStatus: result.job.status,
				replayed: result.replayed,
				memos: attached.map(({ memo, display }) => present(memo, display)),
			});
		} catch (error) {
			return sendMemoError(reply, error);
		}
	});
}
