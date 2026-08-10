import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkStateConflictError, WorkStateStore } from "./work-state.js";

test("P3-G: Session Goal revision、业务决策与清理闭环", async () => {
	const store = new WorkStateStore(mkdtempSync(path.join(tmpdir(), "pt-work-state-")));
	await store.init();
	const created = await store.create({
		sessionId: "s1",
		goal: "交付可审核版本",
		completionBoundary: "测试全绿且 Human 审核通过",
		participantAgentIds: ["codex", "codex"],
	});
	assert.equal(created.revision, 0);
	assert.deepEqual(created.participantAgentIds, ["codex"]);
	const updated = await store.update("s1", 0, { currentBrief: "实现完成", nextAction: "请求审核" });
	assert.equal(updated.revision, 1);
	await assert.rejects(() => store.update("s1", 0, { currentBrief: "旧状态覆盖" }), WorkStateConflictError);
	await assert.rejects(() => store.update("s1", 1, { status: "resolved", currentBrief: "" }), /resolved/);

	const decision = await store.createDecision({
		sessionId: "s1",
		requestedBy: "manager",
		question: "是否发布？",
		context: "测试已通过",
		options: [{ id: "yes", label: "发布" }],
		blockedAction: "发布",
		resumeHint: "按答案继续",
	});
	assert.equal(decision.status, "pending");
	const answered = await store.answerDecision(decision.id, "yes");
	assert.equal(answered.answer, "yes");
	await store.removeSession("s1");
	assert.equal(await store.get("s1"), undefined);
	assert.deepEqual(await store.listDecisions("s1"), []);
});
