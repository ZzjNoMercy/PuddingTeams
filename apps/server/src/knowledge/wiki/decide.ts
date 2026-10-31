import type { WikiPublisher } from "../contracts.js";
import type { KnowledgeAuditChannel, KnowledgeAuditStore } from "../audit-store.js";
import type { PublishJournal } from "./publish-journal.js";
import type { ReviewStore, StoredReviewBatch } from "./review-store.js";
import type { ReviewDecision } from "../contracts.js";
import type { CuratorJob } from "../curator-jobs.js";
import { ReviewStoreError } from "./review-store.js";

export interface KnowledgeDecisionActor {
	id: string;
	/** user = 人工确认；agent = 模型代批（同一审核账本，不同权限来源）。 */
	kind: "user" | "agent";
}

export interface DecideAndPublishInput {
	batchId: string;
	manifestHash: string;
	decision: "approve" | "reject";
	reviewedFiles: string[];
	operationId: string;
	actor: KnowledgeDecisionActor;
	channel: KnowledgeAuditChannel;
	sessionId?: string;
	windowId?: string;
	jobId?: string;
	/** 模型给出的补充说明；不进入审计幂等负载（审计只认决定事实）。 */
	reason?: string;
}

export interface DecideAndPublishDeps {
	reviews: ReviewStore;
	publisher: WikiPublisher;
	publications: Pick<PublishJournal, "list">;
	audit?: Pick<KnowledgeAuditStore, "append">;
}

export interface DecideAndPublishResult {
	record: StoredReviewBatch;
	decision: ReviewDecision;
	replayed: boolean;
	publish?: { accepted: boolean; note?: string };
	auditWarning?: string;
}

/**
 * 审核决定 + 审计 + 发布 的唯一入口。审核页（user）与模型工具（agent）共用，
 * 保证两条通道走同一份 ReviewStore 门禁与 Publisher 校验，只在审计 actor 上区分。
 */
export async function decideAndPublish(deps: DecideAndPublishDeps, input: DecideAndPublishInput): Promise<DecideAndPublishResult> {
	const outcome = await deps.reviews.decide({
		batchId: input.batchId,
		operationId: input.operationId,
		actorId: input.actor.id,
		decision: input.decision,
		manifestHash: input.manifestHash,
		reviewedFiles: input.reviewedFiles,
	});
	// 决定已落账后审计失败可原样重试（同 operationId 重放）；不允许无通道证据的成功。
	if (deps.audit) {
		await deps.audit.append({
			dedupeKey: `knowledge:review:${outcome.decision.id}`,
			kind: input.decision === "approve" ? "review.approved" : "review.rejected",
			ownerId: outcome.record.ownerId, actorId: input.actor.id, actorKind: input.actor.kind, channel: input.channel,
			bindingId: outcome.record.batch.bindingId, batchId: outcome.record.batch.id,
			...(input.jobId ? { jobId: input.jobId } : {}),
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			...(input.windowId ? { windowId: input.windowId } : {}),
			manifestHash: outcome.decision.manifestHash, decision: input.decision,
			reviewedFiles: outcome.decision.reviewedFiles,
			files: outcome.record.batch.files.map((file) => ({ path: file.targetPath, operation: file.operation,
				candidateHash: file.candidateHash ?? null, baselineHash: file.expectedHashOrAbsent ?? null })),
			summary: `${input.decision === "approve" ? "批准" : "拒绝"}候选：${outcome.record.batch.files.length} 项文件`,
		});
	}
	let publish: { accepted: boolean; note?: string } | undefined;
	let record = outcome.record;
	if (input.decision === "approve" && record.status === "approved" && record.decisionId === outcome.decision.id) {
		publish = await deps.publisher.onApproved(record.batch, outcome.decision)
			.catch(() => ({ accepted: false, note: "发布挂载点调用失败，批次保持 approved 待发布" }));
		if (publish.accepted) {
			const current = await deps.reviews.get(record.batch.id);
			if (current && current.status === "approved") record = await deps.reviews.markPublishRequested(record.batch.id);
			else if (current) record = current;
		}
	}
	let auditWarning: string | undefined;
	if (publish?.accepted && deps.audit) {
		const publication = (await deps.publications.list())
			.filter((item) => item.batchId === record.batch.id && item.ownerId === record.ownerId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
		if (publication) {
			try {
				await deps.audit.append({
					dedupeKey: `knowledge:publication:${publication.id}:${publication.state}`,
					kind: "publication.settled", ownerId: record.ownerId, actorId: "knowledge-publisher", actorKind: "host", channel: input.channel,
					bindingId: record.batch.bindingId, batchId: record.batch.id, publicationId: publication.id, manifestHash: publication.manifestHash,
					...(input.jobId ? { jobId: input.jobId } : {}),
					...(input.sessionId ? { sessionId: input.sessionId } : {}),
					...(input.windowId ? { windowId: input.windowId } : {}),
					files: publication.files.map((file) => ({ path: file.targetPath, operation: file.operation,
						candidateHash: file.candidateHash, baselineHash: file.baselineHash })),
					publication: { state: publication.state, fileCount: publication.files.length, committedGroups: publication.committedGroups.length },
					summary: `发布${publication.state === "published" ? "完成" : publication.state}：${publication.files.length} 项文件`,
					details: { stopReason: publication.stopReason ?? null, triggeredBy: input.actor.id },
				});
			} catch { auditWarning = "发布已完成，但发布审计写入失败"; }
		}
	}
	return { record, decision: outcome.decision, replayed: outcome.replayed, ...(publish ? { publish } : {}), ...(auditWarning ? { auditWarning } : {}) };
}

/**
 * 模型代批入口：只允许批准当前整理任务自己的待审核候选。
 * 审计记录 actorKind=agent、channel=chat 与来源会话；用户通道仍可事后复核。
 */
export function createAgentPublisher(deps: DecideAndPublishDeps): (job: CuratorJob, reason?: string) => Promise<DecideAndPublishResult> {
	return async (job, reason) => {
		const record = job.candidateBatchId ? await deps.reviews.get(job.candidateBatchId) : undefined;
		if (!record || record.ownerId !== job.ownerId || record.batch.bindingId !== job.targetBindingId) throw new Error("候选批次不属于当前整理任务");
		// 不在 pending_review 时不在这里快速失败：同 operationId 的重放要能重新驱动
		// 已 approved 的批次（发布挂载点失败后的重试）；其余状态由 ReviewStore 拒绝。
		try {
			return await decideAndPublish(deps, {
				batchId: record.batch.id, manifestHash: record.batch.manifestHash, decision: "approve",
				reviewedFiles: record.batch.files.map((file) => file.targetPath),
				operationId: `agent-publish:${record.batch.id}:${record.batch.manifestHash}`,
				actor: { id: job.agentId, kind: "agent" }, channel: "chat",
				...(job.origin?.sessionId ? { sessionId: job.origin.sessionId } : {}),
				...(job.origin?.windowId ? { windowId: job.origin.windowId } : {}),
				jobId: job.id,
				...(reason ? { reason } : {}),
			});
		} catch (error) {
			if (error instanceof ReviewStoreError && error.code === "expired") throw new Error("候选已超过审核窗口，请重新整理");
			if (error instanceof ReviewStoreError && error.code === "conflict") throw new Error("候选状态已变化（可能已被人工处理或发布），请重新查询");
			throw error;
		}
	};
}
