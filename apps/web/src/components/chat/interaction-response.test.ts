import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInteractionResponses, canApproveRequests } from "./interaction-response.js";

test("每个 permission request 使用自己的合法 scope", () => {
	const requests = [
		{ requestId: "file", prompt: "写入文件", options: ["once", "run", "reject"] },
		{ requestId: "network", prompt: "访问网络", options: ["session", "reject"] },
	];
	assert.deepEqual(buildInteractionResponses(requests, "permission", "approve", { file: "run", network: "once" }, {}), [
		{ requestId: "file", action: "approve", scope: "run", value: undefined },
		{ requestId: "network", action: "approve", scope: "session", value: undefined },
	]);
	assert.equal(canApproveRequests([{ requestId: "deny", prompt: "仅允许拒绝", options: ["reject"] }]), false);
	assert.deepEqual(buildInteractionResponses([{ requestId: "plain", prompt: "无 scope", options: [] }], "permission", "approve", {}, {}), [
		{ requestId: "plain", action: "approve", scope: undefined, value: undefined },
	]);
});

test("多轮更新后只提交当前问题集，多个问题各用自己的回答", () => {
	const current = [
		{ requestId: "second-round-a", prompt: "选 A", options: ["甲", "乙"] },
		{ requestId: "second-round-b", prompt: "输入 B" },
	];
	assert.deepEqual(buildInteractionResponses(current, "question", "answer", {}, {
		"first-round": "旧回答",
		"second-round-a": "乙",
		"second-round-b": " 新回答 ",
	}), [
		{ requestId: "second-round-a", action: "answer", scope: "乙", value: "乙" },
		{ requestId: "second-round-b", action: "answer", scope: undefined, value: "新回答" },
	]);
	assert.equal(buildInteractionResponses(current, "question", "answer", {}, { "second-round-a": "旧选项" })[0]?.scope, undefined);
});
