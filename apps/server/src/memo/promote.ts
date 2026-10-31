import { createHash } from "node:crypto";
import type { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import type { KnowledgeSourceStore } from "../knowledge/sources.js";
import type { CuratorJob, WikiCuratorService } from "../knowledge/curator-jobs.js";
import { MEMO_PROMOTE_LIMIT, MemoError, promoteRequestHash, requireOperationId } from "./contracts.js";
import type { MemoPromotion, MemoPromotionItem } from "./contracts.js";
import type { MemoStore } from "./store.js";

export interface PromoteMemoInput {
	operationId: unknown;
	memoIds: unknown;
	bindingId: unknown;
	task: unknown;
}

export interface PromoteMemoResult {
	promotion: MemoPromotion;
	job: CuratorJob;
	replayed: boolean;
}

export function memoSourceId(ownerId: string, operationId: string, memoId: string): string {
	return `memo:${createHash("sha256").update(`${ownerId}:${operationId}:${memoId}`).digest("hex")}`;
}

/** Curator operation ids are capped at 200 chars; keep the memo prefix deterministic. */
export function memoCuratorOperationId(operationId: string): string {
	const value = `memo:${operationId}`;
	if (value.length > 200) throw new MemoError("invalid_input", "operationId 过长");
	return value;
}

function firstLine(text: string): string {
	return text.split(/\r\n|\r|\n/)[0]!.trim().slice(0, 120) || "速记";
}

function validateMemoIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MEMO_PROMOTE_LIMIT) {
		throw new MemoError("invalid_input", `请选择 1–${MEMO_PROMOTE_LIMIT} 条速记`);
	}
	const ids: string[] = [];
	for (const id of value) {
		if (typeof id !== "string" || !id) throw new MemoError("invalid_input", "速记 ID 无效");
		if (ids.includes(id)) throw new MemoError("invalid_input", "速记 ID 重复");
		ids.push(id);
	}
	return ids;
}

/**
 * 速记整理的唯一入口：先整批锁定并保存快照，再逐条冻结来源，最后复用 curator。
 * 每个阶段都可从持久化状态续跑；任何失败都不会留下半冻结的可用状态。
 */
export class MemoPromoter {
	private readonly locks = new Map<string, Promise<unknown>>();

	constructor(private readonly deps: {
		store: Pick<MemoStore, "get" | "promotion" | "reservePromotion" | "recordSource" | "advancePhase" | "setPromotionError" | "recoverable" | "releaseMemos" | "failPromotion" | "adoptJob">;
		bindings: Pick<KnowledgeBindingRegistry, "requireUsable">;
		sources: Pick<KnowledgeSourceStore, "createMemoText">;
		curator: Pick<WikiCuratorService, "create">;
		jobs?: { get(id: string): Promise<CuratorJob | undefined>; list?(ownerId?: string): Promise<CuratorJob[]> };
	}) {}

	async promote(ownerId: string, input: PromoteMemoInput): Promise<PromoteMemoResult> {
		const operationId = requireOperationId(input.operationId);
		memoCuratorOperationId(operationId);
		const memoIds = validateMemoIds(input.memoIds);
		const bindingId = typeof input.bindingId === "string" ? input.bindingId.trim() : "";
		const task = typeof input.task === "string" ? input.task.trim() : "";
		if (!bindingId || bindingId.length > 200) throw new MemoError("invalid_input", "请选择目标知识库");
		if (!task || task.length > 20_000) throw new MemoError("invalid_input", "请填写整理要求");
		return this.serialize(`${ownerId}:${operationId}`, async () => {
			const existing = this.deps.store.promotion(ownerId, operationId);
			if (existing) {
				// 先确认持久化 attempt 自身一致，再核对本次载荷；不重新读取可变正文。
				const recomputed = promoteRequestHash({
					memoIds: existing.items.map((item) => item.memoId), bindingId: existing.bindingId, task: existing.task,
					items: existing.items.map((item) => ({ memoId: item.memoId, revision: item.memoRevision, text: item.textSnapshot, tags: item.tags })),
				});
				if (recomputed !== existing.requestHash) throw new MemoError("conflict", "整理批次记录不一致，请重新提交");
				if (existing.bindingId !== bindingId || existing.task !== task ||
					existing.items.map((item) => item.memoId).join("\u0000") !== memoIds.join("\u0000")) {
					throw new MemoError("conflict", "operationId 已用于其他整理请求");
				}
				return this.continueAttempt(ownerId, existing, true);
			}
			try {
				await this.deps.bindings.requireUsable(ownerId, bindingId);
			} catch (error) {
				throw new MemoError("unavailable", error instanceof Error ? error.message : "目标知识库不可用");
			}
			const { promotion } = this.deps.store.reservePromotion(ownerId, { operationId, memoIds, bindingId, task });
			return this.continueAttempt(ownerId, promotion, false);
		});
	}

	/** 启动恢复：卡在冻结/来源就绪/Job 写回前的 attempt 按原 operationId 续跑。 */
	async recover(): Promise<Array<{ operationId: string; ok: boolean }>> {
		const results: Array<{ operationId: string; ok: boolean }> = [];
		for (const { ownerId, promotion } of this.deps.store.recoverable()) {
			try {
				await this.serialize(`${ownerId}:${promotion.operationId}`, async () => {
					const current = this.deps.store.promotion(ownerId, promotion.operationId);
					if (current) await this.continueAttempt(ownerId, current, true);
				});
				results.push({ operationId: promotion.operationId, ok: true });
			} catch (error) {
				results.push({ operationId: promotion.operationId, ok: false });
				// 保留可见错误并继续锁定：无法安全判定的分支不自动解锁。
				this.deps.store.setPromotionError(ownerId, promotion.operationId, error instanceof Error ? error.message : "整理恢复失败");
			}
		}
		return results;
	}

	private async serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key);
		if (previous) await previous.catch(() => undefined);
		const promise = action();
		this.locks.set(key, promise);
		try {
			return await promise;
		} finally {
			if (this.locks.get(key) === promise) this.locks.delete(key);
		}
	}

	private async continueAttempt(ownerId: string, promotion: MemoPromotion, replayed: boolean): Promise<PromoteMemoResult> {
		let current = promotion;
		if (current.phase === "failed") {
			// 失败是终态；但 Job 可能已创建而 checkpoint 未写回（崩溃窗口），此时认领它而不是重建。
			const existing = await this.findJob(current);
			if (!existing) throw new MemoError("conflict", "本次整理已结束，请重新提交整理");
			const adopted = this.deps.store.adoptJob(ownerId, current.operationId, existing.id);
			return { promotion: adopted, job: existing, replayed: true };
		}
		try {
			if (current.phase === "freezing") {
				for (const item of current.items) {
					if (item.sourceId) continue;
					await this.freezeItem(ownerId, current, item);
				}
				current = this.deps.store.advancePhase(ownerId, current.operationId, ["freezing"], "sources_frozen");
			}
			if (current.phase !== "job_created" || !current.jobId) {
				const sourceIds = current.items.map((item) => {
					if (!item.sourceId) throw new MemoError("unavailable", "来源冻结未完成");
					return item.sourceId;
				});
				const result = await this.deps.curator.create({
					ownerId,
					operationId: memoCuratorOperationId(current.operationId),
					bindingId: current.bindingId,
					agentId: "wiki",
					task: current.task,
					sourceIds,
					executionMode: "background",
				});
				const saved = this.deps.store.advancePhase(ownerId, current.operationId, ["sources_frozen", "job_created"], "job_created", { jobId: result.job.id });
				return { promotion: saved, job: result.job, replayed: replayed || result.replayed };
			}
			const existingJob = this.deps.jobs ? await this.deps.jobs.get(current.jobId) : undefined;
			const job = existingJob ?? await this.readJob(current);
			// Job 记录缺失但 curator 仍能找回时，把 jobId 补回 attempt，避免永久卡在 queued。
			const promotion = existingJob ? current : this.deps.store.adoptJob(ownerId, current.operationId, job.id);
			return { promotion, job, replayed };
		} catch (error) {
			const message = error instanceof Error ? error.message : "整理失败";
			this.deps.store.setPromotionError(ownerId, current.operationId, message);
			const phase = this.deps.store.promotion(ownerId, current.operationId)?.phase;
			// Job 尚未创建时的确定性失败没有可续接的副作用：结束 attempt 并释放速记，
			// 否则状态会永久锁死（用户既不能改、也不能重新整理）。
			if (phase && phase !== "job_created" && phase !== "failed") {
				this.deps.store.failPromotion(ownerId, current.operationId, message);
			}
			throw new MemoError("unavailable", message);
		}
	}

	private async findJob(promotion: MemoPromotion): Promise<CuratorJob | undefined> {
		if (!this.deps.jobs?.list) return undefined;
		const jobs = await this.deps.jobs.list(promotion.ownerId);
		return jobs.find((job) => job.operationId === memoCuratorOperationId(promotion.operationId) &&
			job.targetBindingId === promotion.bindingId && job.task === promotion.task);
	}

	private async freezeItem(ownerId: string, promotion: MemoPromotion, item: MemoPromotionItem): Promise<void> {
		const memo = this.deps.store.get(ownerId, item.memoId, true);
		if (memo.ownerId !== ownerId) throw new MemoError("not_found", "速记不存在");
		const sourceId = memoSourceId(ownerId, promotion.operationId, item.memoId);
		await this.deps.sources.createMemoText(ownerId, {
			id: sourceId,
			text: item.textSnapshot,
			title: `速记：${firstLine(item.textSnapshot)}`,
			origin: {
				channel: "user_input",
				memo: { id: item.memoId, createdAt: memo.createdAt, tags: item.tags, revision: item.memoRevision },
			},
		});
		this.deps.store.recordSource(ownerId, promotion.operationId, item.memoId, sourceId);
	}

	private async readJob(promotion: MemoPromotion): Promise<CuratorJob> {
		const job = await this.deps.curator.create({
			ownerId: promotion.ownerId,
			operationId: memoCuratorOperationId(promotion.operationId),
			bindingId: promotion.bindingId,
			agentId: "wiki",
			task: promotion.task,
			sourceIds: promotion.items.map((item) => item.sourceId!),
			executionMode: "background",
		});
		return job.job;
	}
}
