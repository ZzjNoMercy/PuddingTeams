import type { StoredPublishOperation } from "./wiki/publish-journal.js";
import type { CuratorJob } from "./curator-jobs.js";
import type { StoredReviewBatch } from "./wiki/review-store.js";

export type TaskDisplayStatus = "queued" | "running" | "submitting" | "pending" | "approved" | "publishing" | "published" | "rejected" | "returned" | "conflict" | "partial" | "closed" | "nochanges" | "failed" | "cancelled" | "unavailable";
export const taskGroups = ["all", "active", "pending", "ended", "failed"] as const;
export function inTaskGroup(status: TaskDisplayStatus, group: string): boolean {
	return group === "all" || ({ active: ["queued", "running", "submitting", "approved", "publishing"], pending: ["pending"], ended: ["published", "rejected", "closed", "nochanges", "cancelled"], failed: ["failed", "returned", "conflict", "partial", "unavailable"] } as Record<string, string[]>)[group]?.includes(status) === true;
}

/** Presentation only. ReviewStore is settled by Publisher, never by this view. */
export function curatorTaskView(job: CuratorJob, review?: StoredReviewBatch, bindingName = "知识库", publication?: StoredPublishOperation) {
	// A batch association is meaningful only inside the same owner and binding.
	const record = review && review.ownerId === job.ownerId && review.batch.bindingId === job.targetBindingId && review.batch.id === job.candidateBatchId && (!job.frozenCandidate || job.frozenCandidate.manifestHash === review.batch.manifestHash) ? review : undefined;
	let displayStatus: TaskDisplayStatus = job.status === "pending_review" ? "unavailable" : job.status === "no_changes" ? "nochanges" : job.status === "needs_attention" ? "failed" : job.status;
	if (record) displayStatus = ({ candidate: "unavailable", pending_review: "pending", approved: "approved", publishing: "publishing", published: "published", rejected: "rejected", returned: "returned", conflict: record.conflictClosure ? "closed" : "conflict", partial: "partial" } as const)[record.status];
	const published = record && publication && publication.ownerId === job.ownerId && publication.bindingId === job.targetBindingId && publication.batchId === record.batch.id && publication.manifestHash === record.batch.manifestHash ? publication : undefined;
	if (published && ["approved","publishing","published","partial","conflict"].includes(record!.status) && !record!.conflictClosure) displayStatus = ({queued:"approved",running:"publishing",published:"published",partial:"partial",conflict:"conflict",unknown:"unavailable"} as const)[published.state];
	const sources = job.sources ?? [];
	const source = sources.find(s => s.kind === "text" && s.origin?.channel !== "agent_task") ?? sources.find(s => s.kind !== "text");
	const title = (source?.title || `${bindingName}资料整理`).replace(/^#+\s*/, "").replace(/\s+/g, " ").slice(0, 48);
	const files = record?.batch.files.map(file => ({ path: file.targetPath, operation: file.operation, publicationStatus: published?.files.find(p => p.targetPath === file.targetPath && p.candidateHash === file.candidateHash && p.operation === file.operation)?.status, kind: file.kind === "image" ? "image" as const : "markdown" as const,
		title: /(^|\/)index\.md$/i.test(file.targetPath) ? "知识库首页" : /(^|\/)log\.md$/i.test(file.targetPath) ? "整理记录" : file.targetPath.split("/").at(-1)!.replace(/\.md$/i, ""),
		category: file.kind === "image" ? "attachment" : /(^|\/)(index|log)\.md$/i.test(file.targetPath) ? "directory" : "note" })) ?? [];
	const count = (operation: string) => files.filter(f => f.category === "note" && f.operation === operation).length;
	return { title, bindingName, displayStatus, activityAt: [job.updatedAt,record?.updatedAt,published?.updatedAt].filter((v): v is string => Boolean(v)).sort().at(-1) ?? job.createdAt,
		publication: published ? {id:published.id,state:published.state,finishedAt:published.finishedAt,applied:published.files.filter(file=>file.status === "applied").length,total:published.files.length} : undefined,
		result: record ? { added: count("create"), updated: count("update"), deleted: count("delete"), directories: files.filter(f => f.category === "directory").length, attachments: files.filter(f => f.category === "attachment").length } : undefined,
		review: record ? { status: record.status, updatedAt: record.updatedAt, enteredReviewAt: record.enteredReviewAt, decidedAt: record.decidedAt, conflictReason: record.conflictReason, files,
			feedback: record.returnRequest?.feedback, revisionJobId: record.returnRequest?.jobId, newBatchId: record.returnRequest?.newBatchId } : undefined,
		parentBatchId: job.revision?.parentBatchId, retryOf: job.retryOf };
}
