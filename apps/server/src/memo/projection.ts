import {
	DISPLAY_LABELS,
	isLockedDisplay,
	type Memo,
	type MemoDisplay,
	type MemoDisplayState,
} from "./contracts.js";
import type { CuratorJob, CuratorJobStatus } from "../knowledge/curator-jobs.js";
import type { StoredReviewBatch } from "../knowledge/wiki/review-store.js";
import type { StoredPublishOperation, PublishOperationState } from "../knowledge/wiki/publish-journal.js";
import type { MemoStore } from "./store.js";

export interface MemoDisplayFacts {
	lifecycle: Memo["lifecycle"];
	outcome?: Memo["outcome"];
	bindingId?: string;
	jobId?: string;
	jobStatus?: CuratorJobStatus;
	failureCode?: string;
	batchId?: string;
	reviewStatus?: StoredReviewBatch["status"];
	publicationState?: PublishOperationState;
	/** 审核侧明确关闭冲突后才解除锁定；仅有一个 conflict 状态不足以解锁。 */
	conflictClosed?: boolean;
	detail?: string;
}

const JOB_STATES: Partial<Record<CuratorJobStatus, MemoDisplayState>> = {
	queued: "queued",
	running: "running",
	submitting: "submitting",
	pending_review: "pending_review",
	no_changes: "no_changes",
	needs_attention: "needs_attention",
	failed: "failed",
	cancelled: "cancelled",
};

const REVIEW_STATES: Partial<Record<StoredReviewBatch["status"], MemoDisplayState>> = {
	candidate: "pending_review",
	pending_review: "pending_review",
	approved: "approved",
	publishing: "publishing",
	published: "published",
	partial: "partial",
	conflict: "conflict",
	rejected: "rejected",
	returned: "returned",
};

/** 纯映射：审核/发布只读投影，未列出的组合保持锁定而不是猜测成功。 */
export function mapMemoDisplay(facts: MemoDisplayFacts): MemoDisplay {
	const base = (state: MemoDisplayState, extra: Partial<MemoDisplay> = {}): MemoDisplay => ({
		state,
		label: DISPLAY_LABELS[state],
		locked: isLockedDisplay(state),
		...(facts.detail ? { detail: facts.detail } : {}),
		...extra,
	});
	if (facts.lifecycle === "unorganized") return base("draft");
	if (facts.lifecycle === "organized") {
		return base(facts.outcome === "no_changes" ? "no_changes" : "published",
			facts.outcome === "no_changes" ? {} : facts.bindingId ? { knowledgeUrl: `/knowledge?vault=${encodeURIComponent(facts.bindingId)}` } : {});
	}
	const reviewUrl = facts.batchId && facts.bindingId
		? `/knowledge/review?vault=${encodeURIComponent(facts.bindingId)}&batch=${encodeURIComponent(facts.batchId)}`
		: undefined;
	const jobUrl = facts.jobId && facts.bindingId
		? `/knowledge?vault=${encodeURIComponent(facts.bindingId)}&job=${encodeURIComponent(facts.jobId)}`
		: undefined;
	if (facts.publicationState === "published") {
		return base("published", { knowledgeUrl: facts.bindingId ? `/knowledge?vault=${encodeURIComponent(facts.bindingId)}` : undefined });
	}
	if (facts.publicationState === "partial") return base("partial", { reviewUrl });
	if (facts.publicationState === "conflict" || facts.publicationState === "unknown") {
		return facts.conflictClosed ? { ...base("conflict", { reviewUrl }), locked: false } : base("conflict", { reviewUrl });
	}
	if (!facts.jobStatus) return base("queued", { jobId: facts.jobId, detail: facts.detail ?? "正在冻结来源" });
	if (facts.failureCode === "candidate_registration_failed") {
		return base("candidate_registration_failed", { jobId: facts.jobId, ...(jobUrl ? { reviewUrl: jobUrl } : {}) });
	}
	if (facts.jobStatus === "failed") return base("failed");
	if (facts.jobStatus === "pending_review") {
		if (!facts.reviewStatus) return base("pending_review", { batchId: facts.batchId, reviewUrl });
		const state = REVIEW_STATES[facts.reviewStatus] ?? "pending_review";
		if (state === "conflict" && facts.conflictClosed) return { ...base("conflict", { batchId: facts.batchId, reviewUrl }), locked: false };
		return base(state, { batchId: facts.batchId, reviewUrl, jobId: facts.jobId,
			...(state === "published" && facts.bindingId ? { knowledgeUrl: `/knowledge?vault=${encodeURIComponent(facts.bindingId)}` } : {}) });
	}
	const state = JOB_STATES[facts.jobStatus] ?? "queued";
	return base(state, { jobId: facts.jobId, reviewUrl, batchId: facts.batchId });
}

export interface MemoProjectionDeps {
	store: Pick<MemoStore, "promotion" | "byLifecycle" | "releaseMemos" | "completeMemos">;
	jobs: { get(id: string): Promise<CuratorJob | undefined> };
	reviews: { get(id: string): Promise<StoredReviewBatch | undefined> };
	publications: { list(): Promise<StoredPublishOperation[]> };
	revisions?: { followup(record: StoredReviewBatch): Promise<StoredReviewBatch["returnRequest"]> };
}

/**
 * 组合当前 attempt 的 Job/Review/Publication/revision 事实源。
 * 生命周期终态在这里回写，但只写 memo 自己的生命周期，不复制审核正文。
 */
export class MemoProjection {
	constructor(private readonly deps: MemoProjectionDeps) {}

	async display(ownerId: string, memo: Memo, publications?: StoredPublishOperation[]): Promise<MemoDisplay> {
		const promotion = memo.currentOperationId ? this.deps.store.promotion(ownerId, memo.currentOperationId) : undefined;
		if (memo.lifecycle !== "promoting") {
			return mapMemoDisplay({ lifecycle: memo.lifecycle, outcome: memo.outcome, bindingId: promotion?.bindingId, detail: memo.lastError });
		}
		if (!promotion) {
			return mapMemoDisplay({ lifecycle: memo.lifecycle, detail: "整理任务记录缺失，请联系支持或查看知识库任务" });
		}
		let job = promotion.jobId ? await this.deps.jobs.get(promotion.jobId) : undefined;
		// 只接受属于该 owner 与该绑定库的 Job；其它库的 Job 不能驱动本条目状态。
		if (job && (job.ownerId !== ownerId || job.targetBindingId !== promotion.bindingId)) job = undefined;
		let review = job?.candidateBatchId ? await this.trustedReview(ownerId, promotion, job.candidateBatchId) : undefined;
		// 退回不是终态：沿修订链读取最新 Job/批次，直到出现可判定的状态。
		for (let depth = 0; review?.status === "returned" && this.deps.revisions && depth < 5; depth++) {
			const request = await this.deps.revisions.followup(review);
			if (!request) break;
			const nextJob = request.jobId ? await this.deps.jobs.get(request.jobId) : undefined;
			const trustedNextJob = nextJob && nextJob.ownerId === ownerId && nextJob.targetBindingId === promotion.bindingId ? nextJob : undefined;
			if (trustedNextJob) job = trustedNextJob;
			const batchId = request.newBatchId ?? trustedNextJob?.candidateBatchId;
			// 修订 Job 尚未 attach 批次：保留 returned，不能用旧 batch 的 pending_review 冒充。
			if (!batchId) break;
			const nextReview = await this.trustedReview(ownerId, promotion, batchId);
			if (!nextReview) { review = undefined; break; }
			review = nextReview;
		}
		const ops = publications ?? await this.deps.publications.list();
		const publication = review
			? ops.find((operation) => operation.ownerId === ownerId && operation.batchId === review.batch.id &&
				operation.bindingId === review.batch.bindingId && operation.manifestHash === review.batch.manifestHash)
			: undefined;
		return mapMemoDisplay({
			lifecycle: memo.lifecycle,
			outcome: memo.outcome,
			bindingId: promotion.bindingId,
			jobId: job?.id ?? promotion.jobId,
			jobStatus: job?.status,
			failureCode: job?.failureCode,
			batchId: review?.batch.id ?? job?.candidateBatchId,
			reviewStatus: review?.status,
			publicationState: publication?.state,
			conflictClosed: Boolean(review?.conflictClosure),
			detail: memo.lastError ?? promotion.lastError,
		});
	}

	/** listed 变更行：只在事实源给出明确终态时写回生命周期。 */
	async attach(ownerId: string, memos: Memo[]): Promise<Array<{ memo: Memo; display: MemoDisplay }>> {
		const publications = memos.some((memo) => memo.lifecycle === "promoting") ? await this.deps.publications.list() : [];
		const out: Array<{ memo: Memo; display: MemoDisplay }> = [];
		for (const memo of memos) {
			const display = await this.display(ownerId, memo, publications);
			out.push({ memo: await this.settle(ownerId, memo, display), display });
		}
		return out;
	}

	async reconcile(ownerId: string): Promise<void> {
		const promoting = this.deps.store.byLifecycle(ownerId, "promoting");
		if (!promoting.length) return;
		const publications = await this.deps.publications.list();
		for (const memo of promoting) {
			const display = await this.display(ownerId, memo, publications);
			await this.settle(ownerId, memo, display);
		}
	}

	private async trustedReview(ownerId: string, promotion: { bindingId: string }, batchId: string): Promise<StoredReviewBatch | undefined> {
		const record = await this.deps.reviews.get(batchId);
		if (!record || record.ownerId !== ownerId || record.batch.bindingId !== promotion.bindingId) return undefined;
		return record;
	}

	private async settle(ownerId: string, memo: Memo, display: MemoDisplay): Promise<Memo> {
		if (memo.lifecycle !== "promoting") return memo;
		const expectedOperationId = memo.currentOperationId;
		if (!expectedOperationId) return memo;
		if (display.state === "published" || display.state === "no_changes") {
			this.deps.store.completeMemos(ownerId, [memo.id], expectedOperationId, display.state === "no_changes" ? "no_changes" : "published");
			return { ...memo, lifecycle: "organized", outcome: display.state === "no_changes" ? "no_changes" : "published", lastError: undefined };
		}
		if (display.state === "rejected" || display.state === "failed" || display.state === "cancelled" ||
			(display.state === "conflict" && !display.locked)) {
			const reason = display.state === "rejected" ? "审核已拒绝，可修改后重新整理"
				: display.state === "cancelled" ? "整理已取消"
				: display.state === "conflict" ? "冲突已解决，可重新整理" : "上次整理失败，可重新整理";
			this.deps.store.releaseMemos(ownerId, [memo.id], expectedOperationId, reason);
			return { ...memo, lifecycle: "unorganized", currentOperationId: undefined, lastError: display.detail ?? DISPLAY_LABELS[display.state] };
		}
		return memo;
	}

}
