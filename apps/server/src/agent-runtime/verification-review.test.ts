import { test } from "node:test";
import assert from "node:assert";
import { ENVIRONMENT_OBSERVATION_REF, bindEnvironmentObservations, parseVerificationOutput, type VerificationReviewInput } from "./verification-review.js";

const input: VerificationReviewInput = {
	verificationId: "V1", mode: "environment_verified", goalId: "G", workPlanId: "P", workItemId: "W", submissionId: "S",
	criteria: ["tests pass", "artifact exists"], submission: { id: "S" }, allowedEvidenceRefs: ["D-verifier", "A1", ENVIRONMENT_OBSERVATION_REF],
};
const meta = {
	id: "V1", goalId: "G", workPlanId: "P", workItemId: "W", submissionId: "S", goalRevision: 1, workItemRevision: 2, goalEpoch: 3,
	mode: "environment_verified" as const, verifierAgentId: "verifier", verifierDelegationId: "D-verifier", environmentProfileId: "cli-isolated-copy-v1",
	environmentMode: "isolated_copy" as const, inputFingerprint: "sha256:input", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:01.000Z",
};

test("Verifier JSON 必须原序覆盖条件且 passed 有 clean evidence", () => {
	const record = parseVerificationOutput(JSON.stringify({
		status: "passed", integrity: "clean",
		criteria: [
			{ criterion: "tests pass", status: "satisfied", evidenceRefs: ["D-verifier"], explanation: "实际运行" },
			{ criterion: "artifact exists", status: "satisfied", evidenceRefs: ["A1"], explanation: "文件存在" },
		],
		evidenceRefs: ["D-verifier", "A1"],
	}), input, meta);
	assert.equal(record.status, "passed");
	assert.equal(record.integrity, "clean");
});

test("environment_verified 空运行不能仅靠 Delegation/Receipt 身份引用伪造 passed", () => {
	const parsed = parseVerificationOutput(JSON.stringify({
		status: "passed", integrity: "clean",
		criteria: [
			{ criterion: "tests pass", status: "satisfied", evidenceRefs: ["D-verifier"], explanation: "自述执行" },
			{ criterion: "artifact exists", status: "satisfied", evidenceRefs: ["A1"], explanation: "自述存在" },
		], evidenceRefs: ["D-verifier", "A1"],
	}), input, meta);
	const bound = bindEnvironmentObservations(parsed, []);
	assert.equal(bound.status, "failed");
	assert.match(bound.failureReason ?? "", /未观察到/);
});

test("平台观测替换逐项 placeholder，形成不可伪造 observation 引用", () => {
	const parsed = parseVerificationOutput(JSON.stringify({
		status: "passed", integrity: "clean",
		criteria: input.criteria.map((criterion) => ({ criterion, status: "satisfied", evidenceRefs: [ENVIRONMENT_OBSERVATION_REF], explanation: "实际检查" })),
		evidenceRefs: [ENVIRONMENT_OBSERVATION_REF],
	}), input, meta);
	const observation = { id: "observation:D-verifier:3", delegationId: "D-verifier", kind: "tool" as const, title: "test completed", contentHash: "sha256:test" };
	const bound = bindEnvironmentObservations(parsed, [observation]);
	assert.equal(bound.status, "passed");
	assert.deepEqual(bound.criteria.map((criterion) => criterion.evidenceRefs), [[observation.id], [observation.id]]);
	assert.deepEqual(bound.observations, [observation]);
});

test("Verifier 不能引用未知证据，也不能把 uncertain 伪装为 passed", () => {
	assert.throws(() => parseVerificationOutput(JSON.stringify({
		status: "passed", integrity: "clean",
		criteria: [
			{ criterion: "tests pass", status: "satisfied", evidenceRefs: ["invented"], explanation: "x" },
			{ criterion: "artifact exists", status: "uncertain", evidenceRefs: [], explanation: "x" },
		], evidenceRefs: [],
	}), input, meta), /未知证据|passed/);
});
