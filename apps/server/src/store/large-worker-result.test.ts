import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LargeWorkerResultStore, validateWorkerResultContext } from "./large-worker-result.js";

test("超长 Worker 结果无损外置、head/tail 预览与分页读取", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-large-result-"));
	const store = new LargeWorkerResultStore(root);
	const settings = validateWorkerResultContext({
		offloadThresholdTokens: 4_000,
		previewHeadTokens: 500,
		previewTailTokens: 200,
		readChunkTokens: 500,
	});
	const content = "HEAD-" + "x".repeat(20_000) + "-TAIL";
	const projected = await store.project("D-safe", content, settings);
	assert.equal(projected.offloaded, true);
	assert.match(projected.text, /^HEAD-/);
	assert.match(projected.text, /-TAIL/);
	assert.match(projected.text, /read_delegation_result/);
	const first = await store.read("D-safe", 0, 7_000);
	const second = await store.read("D-safe", first.nextOffset!, 160_000);
	assert.equal(first.content + second.content, content);
	assert.equal(statSync(path.join(root, "large-worker-results", "D-safe.txt")).mode & 0o777, 0o600);
});

test("Worker 结果上下文预算拒绝不安全组合", () => {
	assert.throws(() => validateWorkerResultContext({
		offloadThresholdTokens: 4_000,
		previewHeadTokens: 3_000,
		previewTailTokens: 1_000,
	}), /必须小于/);
});
