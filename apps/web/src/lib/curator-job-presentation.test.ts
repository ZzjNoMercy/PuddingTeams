import assert from "node:assert/strict";
import { test } from "node:test";
import { canCancelCuratorJob, curatorFailureReason, curatorJobHref, curatorJobLabels, curatorJobRetryLabel, curatorSourceChatHref, curatorJobStatusLabel, isCuratorJobActive } from "./curator-job-presentation.js";

test("submitting is active and continues polling but cannot be cancelled", () => {
	assert.equal(isCuratorJobActive("submitting"), true);
	assert.equal(canCancelCuratorJob("submitting"), false);
	assert.equal(curatorJobLabels.submitting, "正在提交候选");
	assert.equal(isCuratorJobActive("pending_review"), false);
	assert.equal(isCuratorJobActive("failed"), false);
});

test("chat task links encode exact job and binding without changing query scope", () => {
	const href = curatorJobHref("job/a?x=1", "vault&b");
	const query = new URL(href, "https://local.test").searchParams;
	assert.equal(query.get("job"), "job/a?x=1");
	assert.equal(query.get("vault"), "vault&b");
	assert.deepEqual([...query.keys()].sort(), ["job", "vault"]);
	assert.equal(new URL(curatorJobHref("job/a"), "https://local.test").searchParams.get("job"), "job/a");
});

test("timeout and missing submission remain distinct; unknown server errors are retained", () => {
	assert.equal(curatorJobStatusLabel("failed", "model_timeout"), "整理超时");
	assert.equal(curatorJobStatusLabel("failed", "worker_no_submission"), "整理失败");
	assert.match(curatorFailureReason("model_timeout"), /超时/);
	assert.match(curatorFailureReason("worker_no_submission"), /没有提交候选/);
	assert.equal(curatorFailureReason("provider-http-503 trace=123"), "provider-http-503 trace=123");
	for (const code of ["model_timeout", "model_error", "server_restart"]) {
		assert.match(curatorFailureReason(code, "worker"), /返回来源聊天继续/);
		assert.doesNotMatch(curatorFailureReason(code, "worker"), /重试/);
		assert.match(curatorFailureReason(code, "background"), /重试/);
	}
	assert.match(curatorFailureReason("candidate_registration_failed", "worker"), /重试登记/);
});

test("candidate generation is complete without claiming its batch remains unreviewed", () => {
	assert.equal(curatorJobLabels.pending_review, "完成 · 已生成候选");
	assert.equal(curatorJobLabels.pending_review.includes("待审核"), false);
});

test("worker execution cannot start a background retry; frozen registration can retry", () => {
	assert.equal(curatorJobRetryLabel({ status: "failed", executionMode: "worker" }), null);
	assert.equal(curatorJobRetryLabel({ status: "needs_attention", executionMode: "worker" }), null);
	assert.equal(curatorJobRetryLabel({ status: "failed", executionMode: "background" }), "重试解析与整理");
	assert.equal(curatorJobRetryLabel({ status: "failed", executionMode: "worker", canRetryRegistration: true }), "重试登记候选");
	assert.equal(curatorJobRetryLabel({ status: "submitting", executionMode: "worker", canRetryRegistration: true }), null);
});

test("source chat links use the actual solo or room route and only existing sessions", () => {
	const origin = { windowId: "r&1", sessionId: "s/a?b" };
	const rooms = [{ id: origin.windowId, type: "direct", sessions: [{ id: origin.sessionId }] }];
	const direct = new URL(curatorSourceChatHref(origin, rooms)!, "https://local.test");
	assert.equal(direct.pathname, "/chats");
	assert.equal(direct.searchParams.get("room"), origin.windowId);
	assert.equal(direct.searchParams.get("session"), origin.sessionId);
	assert.equal(direct.searchParams.has("window"), false);
	const solo = new URL(curatorSourceChatHref(origin, [{ ...rooms[0], type: "solo" }])!, "https://local.test");
	assert.equal(solo.pathname, "/");
	assert.equal(solo.searchParams.get("session"), origin.sessionId);
	assert.equal(solo.searchParams.has("room"), false);
	assert.equal(curatorSourceChatHref(origin, []), null);
	assert.equal(curatorSourceChatHref(origin, [{ ...rooms[0], sessions: [] }]), null);
	assert.equal(curatorSourceChatHref(origin, null), null);
});
