import type { PublishJournal } from "./publish-journal.js";
import { ReviewStoreError, type StoredReviewBatch } from "./review-store.js";

/** Must run inside the library mutation lock when accepting a resolution. */
export async function conflictResolutionBlock(record: StoredReviewBatch, journal: Pick<PublishJournal, "list">): Promise<string | null> {
	if (record.status !== "conflict") return "批次已变化，请刷新后再处理";
	if (record.conflictClosure) return "此冲突已经关闭";
	const operations = (await journal.list()).filter(op => op.batchId === record.batch.id && op.bindingId === record.batch.bindingId && op.ownerId === record.ownerId);
	if (operations.length === 0 && record.conflictReason !== "review_window_expired") return "缺少发布核对记录，暂时不能关闭或重新整理";
	if (operations.some(op => ["queued", "running", "unknown"].includes(op.state) || op.committedGroups.length > 0 || op.files.some(file =>
		["applied", "uncertain"].includes(file.status) || (file.status !== "rolled_back" && file.receipts.some(receipt => ["write", "verify"].includes(receipt.step)))))) {
		return "这批发布仍有未确认或已写入的内容，请先完成发布对账";
	}
	return null;
}

export async function assertConflictResolution(record: StoredReviewBatch, journal: Pick<PublishJournal, "list">): Promise<void> {
	const blocked = await conflictResolutionBlock(record, journal);
	if (blocked) throw new ReviewStoreError("conflict", blocked);
}
