import assert from "node:assert/strict";
import { test } from "node:test";
import type { WikiPublicationDetail } from "../../lib/api";
import { publicationFeedback } from "./publication-feedback";

const stopped: WikiPublicationDetail = {
	id: "op", batchId: "batch", bindingId: "people", state: "conflict", journalRef: "journal", fileCount: 1,
	createdAt: "2026-09-30", updatedAt: "2026-09-30", reviewId: "review", idempotencyKey: "key", committedGroups: [], results: [],
	conflictReason: "publish_preflight", currentContextChanges: ["知识库结构已更新，候选仍按旧结构生成"],
	files: [{targetPath: "People/p.md", operation: "create", candidateHash: "a", baselineHash: null, beforeImageRef: null, status: "pending", receipts: []}],
};

test("发布前整批停止显示无写入与重新生成建议，当前差异不冒充历史原因", () => {
	const feedback = publicationFeedback(stopped)!;
	assert.match(feedback.reason, /发布前检查未通过/);
	assert.doesNotMatch(feedback.reason, /结构已更新/);
	assert.match(feedback.impact, /未写入任何文件/);
	assert.match(feedback.action, /重新生成候选/);
});

test("记录的具体停止理由优先呈现", () => {
	assert.equal(publicationFeedback({...stopped, stopReason: "知识库整理规则已更新"})!.reason, "知识库整理规则已更新");
});

test("结果未知或已发生写入不能声称零写入，也不引导重复发布", () => {
	const uncertain = {...stopped, state: "unknown" as const, files: stopped.files.map(file => ({...file, status: "uncertain" as const}))};
	const feedback = publicationFeedback(uncertain)!;
	assert.doesNotMatch(feedback.impact, /未写入任何文件/);
	assert.match(feedback.action, /请勿重复发布/);
	const partial = publicationFeedback({...stopped, state: "partial", committedGroups: [["People/p.md"]]})!;
	assert.match(partial.impact, /已提交 1 组/);
});
