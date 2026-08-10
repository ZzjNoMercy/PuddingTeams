import { test } from "node:test";
import assert from "node:assert";
import { buildCompletionReviewPrompt, parseCompletionReview } from "./completion-review.js";

const meta = { reviewerModel: "provider/reviewer", reviewerSessionId: "review-session" };

test("P3-G: 独立 reviewer JSON 被规范化为可审计判定", () => {
	const review = parseCompletionReview(
		'```json\n{"verdict":"satisfied","criteria":[{"criterion":"测试通过","status":"satisfied","evidenceRefs":["run-1","run-1"],"explanation":"测试记录成功"}],"gaps":[]}\n```',
		{ goal: "交付", completionBoundary: "测试通过", goalRevision: 3, currentBrief: "完成", delegations: [{ id: "run-1" }], artifactIds: [], artifacts: [], humanDecisions: [], managerEvidence: [] },
		meta,
	);
	assert.equal(review.goalRevision, 3);
	assert.equal(review.verdict, "satisfied");
	assert.deepEqual(review.criteria[0]?.evidenceRefs, ["run-1"]);
	assert.equal(review.reviewerModel, "provider/reviewer");
});

test("P3-G: reviewer 不能用矛盾逐项状态宣告 satisfied", () => {
	assert.throws(
		() => parseCompletionReview(
			'{"verdict":"satisfied","criteria":[{"criterion":"用户确认","status":"uncertain","evidenceRefs":[],"explanation":"尚未确认"}],"gaps":[]}',
			{ goal: "交付", completionBoundary: "用户确认", goalRevision: 0, currentBrief: "完成", delegations: [], artifactIds: [], artifacts: [], humanDecisions: [], managerEvidence: [] },
			meta,
		),
		/矛盾/,
	);
});

test("P3-G: reviewer 不能引用不存在的证据或无证据通过", () => {
	const input = { goal: "交付", completionBoundary: "测试通过", goalRevision: 0, currentBrief: "完成", delegations: [], artifactIds: [], artifacts: [], humanDecisions: [], managerEvidence: [] };
	assert.throws(
		() => parseCompletionReview('{"verdict":"satisfied","criteria":[{"criterion":"测试通过","status":"satisfied","evidenceRefs":["fake"],"explanation":"通过"}],"gaps":[]}', input, meta),
		/不存在的证据/,
	);
	assert.throws(
		() => parseCompletionReview('{"verdict":"satisfied","criteria":[{"criterion":"测试通过","status":"satisfied","evidenceRefs":[],"explanation":"通过"}],"gaps":[]}', input, meta),
		/未给已满足条件提供证据/,
	);
});

test("P3-G: reviewer 必须逐行、原序覆盖冻结完成条件", () => {
	const input = { goal: "交付", completionBoundary: "功能完成\n测试通过", goalRevision: 0, currentBrief: "完成", delegations: [], artifactIds: [], artifacts: [], humanDecisions: [], managerEvidence: [] };
	assert.throws(
		() => parseCompletionReview('{"verdict":"not_satisfied","criteria":[{"criterion":"功能和测试完成","status":"unsatisfied","evidenceRefs":[],"explanation":"缺证据"}],"gaps":["缺证据"]}', input, meta),
		/逐行、原序/,
	);
});

test("P3-G: reviewer prompt 只包含冻结输入与结构化输出契约", () => {
	const prompt = buildCompletionReviewPrompt({
		goal: "交付页面",
		completionBoundary: "页面可打开",
		goalRevision: 1,
		currentBrief: "页面已生成",
		delegations: [{ id: "d1", status: "completed" }],
		artifactIds: ["a1"],
		artifacts: [{ id: "a1", contentHash: "sha" }],
		humanDecisions: [],
		managerEvidence: [],
	});
	assert.match(prompt, /页面可打开/);
	assert.match(prompt, /needs_human/);
	assert.doesNotMatch(prompt, /chain.of.thought/i);
});
