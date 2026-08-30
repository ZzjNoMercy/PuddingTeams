import assert from "node:assert/strict";
import { test } from "node:test";
import {
	executionContractHash,
	sealExecutionReceipt,
	type ReceiptContractSnapshot,
} from "./execution-receipt.js";

function contract(overrides: Partial<ReceiptContractSnapshot> = {}): ReceiptContractSnapshot {
	return {
		delegationId: "delegation-1",
		operationId: "operation-1",
		goalId: "goal-1",
		workPlanId: "plan-1",
		workItemId: "item-1",
		attempt: 1,
		goalRevision: 2,
		workItemRevision: 3,
		goalEpoch: 4,
		task: "实现功能",
		intent: "交付可运行实现",
		expectedOutcome: "测试通过",
		evidenceRequirements: ["提供测试结果"],
		completionBoundary: "功能可运行",
		workspaceId: "workspace-1",
		cwdSnapshot: "/tmp/workspace",
		agentId: "worker-1",
		agentRevision: 5,
		createdAt: "2026-08-29T00:00:00.000Z",
		...overrides,
	};
}

test("contract hash 对字段顺序稳定，冻结契约变化必然改变", () => {
	const first = executionContractHash(contract());
	const second = executionContractHash({ ...contract(), evidenceRequirements: ["提供测试结果"] });
	const changed = executionContractHash(contract({ workItemRevision: 4 }));
	assert.equal(first, second);
	assert.notEqual(first, changed);
});

test("sealed Receipt 区分上游报告与 Runtime Artifact 捕获", () => {
	const receipt = sealExecutionReceipt({
		contract: contract(),
		result: {
			agentId: "worker-1",
			status: "completed",
			sessionHandle: "session-1",
			runHandle: "run-1",
			reportedEvidence: [{ requirement: "提供测试结果", evidenceRefs: ["artifact:test-log"] }],
			artifacts: [{ name: "test.log", path: "test.log", origin: "observe" }],
		},
		artifactCapture: [{
			reportedPath: "test.log",
			artifactId: "artifact:test-log",
			contentHash: "sha256:abc",
			status: "captured",
		}],
		connectorId: "connector-codex",
		transport: "spawn",
		observedAt: "2026-08-29T00:01:00.000Z",
	});
	assert.equal(receipt.reportedOutcome, "completed");
	assert.equal(receipt.collectionStatus, "complete");
	assert.equal(receipt.integrity, "clean");
	assert.deepEqual(receipt.requirementResults, [{
		requirement: "提供测试结果",
		status: "provided",
		evidenceRefs: ["artifact:test-log"],
	}]);
	assert.equal(receipt.artifactCapture[0]?.artifactId, "artifact:test-log");
	assert.equal(receipt.observer.connectorId, "connector-codex");
});

test("缺失必需证据与越界 Artifact 形成 partial + violation，不伪造 verified", () => {
	const receipt = sealExecutionReceipt({
		contract: contract(),
		result: {
			agentId: "worker-1",
			status: "completed",
			artifacts: [{ name: "secret", path: "../secret", origin: "push" }],
		},
		artifactCapture: [{ reportedPath: "../secret", status: "rejected", issue: "artifact is outside delegation cwdSnapshot" }],
		connectorId: "connector-unsafe",
		transport: "rpc",
	});
	assert.equal(receipt.collectionStatus, "failed");
	assert.equal(receipt.integrity, "violation");
	assert.equal(receipt.requirementResults[0]?.status, "missing");
	assert.equal("verified" in receipt, false);
	assert.equal("accepted" in receipt, false);
});
