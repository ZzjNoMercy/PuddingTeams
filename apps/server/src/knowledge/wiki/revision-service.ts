import { createHash } from "node:crypto";
import type { CuratorJob, CuratorJobStore, WikiCuratorService } from "../curator-jobs.js";
import type { KnowledgeBindingRegistry } from "../bindings.js";
import type { KnowledgeObjectStore } from "../objects.js";
import { ReviewStoreError, type ReturnRevisionInput, type ReviewStore, type StoredReviewBatch } from "./review-store.js";
import type { PublishJournal } from "./publish-journal.js";
import { assertConflictResolution } from "./conflict-resolution.js";
import { withKnowledgeMutation } from "../mutation-lock.js";

/** Durable returned batch is the outbox; creation is idempotent across both stores. */
export class WikiRevisionService {
	constructor(private readonly deps: { reviews: ReviewStore; jobs: CuratorJobStore; curator: WikiCuratorService; bindings: KnowledgeBindingRegistry; objects: KnowledgeObjectStore; publications: Pick<PublishJournal, "list"> }) {}
	private async original(record: StoredReviewBatch): Promise<CuratorJob> {
		let jobId: string | undefined;
		try { jobId = (JSON.parse(record.batch.validationReceipt) as { jobId?: string }).jobId; } catch { /* Not a curator batch. */ }
		const job = jobId ? await this.deps.jobs.get(jobId) : undefined;
		if (!job || job.ownerId !== record.ownerId || job.targetBindingId !== record.batch.bindingId || job.candidateBatchId !== record.batch.id)
			throw new ReviewStoreError("invalid_input", "该批次没有可恢复的整理来源，请新建整理任务");
		return job;
	}
	private async drive(record: StoredReviewBatch): Promise<{ job: CuratorJob; replayed: boolean }> {
		const request = record.returnRequest!;
		await this.deps.bindings.requireUsable(record.ownerId, record.batch.bindingId);
		const original = await this.original(record);
		const candidateFiles = await Promise.all(record.batch.files.filter((file) => file.candidateHash).map(async (file) => {
			const bytes = await this.deps.objects.get(file.candidateHash!);
			if (createHash("sha256").update(bytes).digest("hex") !== file.candidateHash) throw new Error("原候选快照校验失败");
			return { path: file.targetPath, contentHash: file.candidateHash! };
		}));
		const receipt = JSON.parse(record.batch.validationReceipt) as { readEvidence?: Array<{ noteRef?: string; hash?: string }> };
		const readable = new Map([...original.baseline, ...(original.revision?.acceptedSources ?? [])].map((entry) => [entry.acceptanceId, entry]));
		const input = { ownerId: record.ownerId, operationId: `revision:${record.batch.id}:${request.operationId}`,
			bindingId: record.batch.bindingId, agentId: original.agentId, task: original.task, origin: original.origin,
			revision: { parentBatchId: record.batch.id, parentManifestHash: record.batch.manifestHash, feedback: request.feedback,
				sourceIds: original.sources.map((source) => source.id), candidateFiles,
				acceptedSources: [...readable.values()].filter((entry) => {
					return record.batch.sourceSnapshots.includes(entry.contentHash) && receipt.readEvidence?.some((evidence) => evidence.noteRef === entry.acceptanceId && evidence.hash === entry.contentHash);
				}) } };
		const result = await this.deps.curator.create(input);
		await this.deps.reviews.attachRevisionJob(record.batch.id, request.operationId, result.job.id, result.job.candidateBatchId);
		return result;
	}
	/** The first return job is immutable. Display follows only its verified retry chain. */
	async followup(record: StoredReviewBatch): Promise<StoredReviewBatch["returnRequest"]> {
		const request = record.returnRequest;
		if (!request?.jobId) return request;
		const jobs = (await this.deps.jobs.list(record.ownerId)).filter((job) => job.targetBindingId === record.batch.bindingId &&
			job.revision?.parentBatchId === record.batch.id && job.revision.parentManifestHash === record.batch.manifestHash && job.revision.feedback === request.feedback);
		const linked = new Map([[request.jobId, 0]]);
		for (let pass = 0; pass < jobs.length; pass++) for (const job of jobs) if (job.retryOf && linked.has(job.retryOf)) linked.set(job.id, linked.get(job.retryOf)! + 1);
		const latest = jobs.filter((job) => linked.has(job.id)).sort((a, b) => linked.get(b.id)! - linked.get(a.id)! || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
		return latest ? { ...request, jobId: latest.id, newBatchId: latest.candidateBatchId } : request;
	}
	async request(input: ReturnRevisionInput): Promise<{ job: CuratorJob; replayed: boolean }> {
		const original = await this.deps.reviews.get(input.batchId);
		if (!original || original.ownerId !== input.actorId) throw new ReviewStoreError("not_found", "审核批次不存在");
		await this.deps.bindings.requireUsable(input.actorId, original.batch.bindingId);
		await this.original(original);
		const returned = await withKnowledgeMutation(original.batch.bindingId, async () => {
			const current = (await this.deps.reviews.get(input.batchId))!;
			if (current.status === "conflict") await assertConflictResolution(current, this.deps.publications);
			return this.deps.reviews.returnForRevision(input, current.status === "conflict");
		});
		const result = await this.drive(returned.record);
		return { job: result.job, replayed: returned.replayed };
	}
	async recover(): Promise<{ recovered: string[]; unavailable: string[] }> {
		const recovered: string[] = [], unavailable: string[] = [];
		for (const record of await this.deps.reviews.list()) {
			if (record.status !== "returned" || !record.returnRequest) continue;
			try { await this.drive(record); recovered.push(record.batch.id); } catch { unavailable.push(record.batch.id); }
		}
		return { recovered, unavailable };
	}
}
