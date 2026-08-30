import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProductSettingsStore } from "./product-settings.js";

test("Harness 设置原子更新并施加安全边界", async () => {
	const store = new ProductSettingsStore(mkdtempSync(path.join(tmpdir(), "pt-product-settings-")));
	const updated = await store.setHarness({
		codeSearch: { defaultProvider: "fff" },
		workerResults: { readChunkTokens: 1_234 },
		goalActivation: { solo: "user_explicit", confirmWhenAmbiguous: false },
		goalRecovery: { mode: "manual", resumeLeaseMs: 1, operationRetentionDays: 999, maxOperationsPerSession: 1 },
	});
	assert.equal(updated.harness.workerResults.readChunkTokens, 1_234);
	assert.equal(updated.harness.codeSearch.defaultProvider, "fff");
	assert.equal(updated.harness.workerResults.offloadThresholdTokens, 20_000, "局部更新保留当前值");
	assert.equal(updated.harness.goalActivation.solo, "user_explicit");
	assert.equal(updated.harness.goalActivation.confirmWhenAmbiguous, false);
	assert.equal(updated.harness.goalRecovery.resumeLeaseMs, 5_000);
	assert.equal(updated.harness.goalRecovery.operationRetentionDays, 365);
	assert.equal(updated.harness.goalRecovery.maxOperationsPerSession, 128);
	assert.equal(updated.harness.goalRecovery.directMode, "manual");
	assert.equal(updated.harness.verification.defaultWorkItemMode, "manager_review");
	assert.equal(updated.harness.verification.defaultFinalGoalMode, "independent_evidence_review");
	assert.equal(updated.harness.verification.firstReleaseScope, "cli_code_first");
	assert.equal(updated.harness.verification.unavailableAction, "block");
	assert.equal(updated.harness.workspaceExecution.gitWriteDefault, "isolated_worktree");
	assert.equal(updated.harness.workspaceExecution.nonGitWriteDefault, "exclusive_write");
	assert.equal(updated.harness.workspaceExecution.managerWritePolicy, "delegation_required");
	const reloaded = await store.get();
	assert.deepEqual(reloaded.harness.verification, updated.harness.verification, "verification 设置必须持久化");
	assert.deepEqual(reloaded.harness.workspaceExecution, updated.harness.workspaceExecution, "workspace 设置必须持久化");
	await assert.rejects(() => store.setHarness({
		goalActivation: { direct: "manager_explicit" as "user_explicit" },
	}), /direct 无效/);
	await assert.rejects(() => store.setHarness({
		codeSearch: { defaultProvider: "invalid" as "fff" },
	}), /codeSearch.defaultProvider 无效/);
	await assert.rejects(() => store.setHarness({
		verification: { unavailableAction: "allow" as "block" },
	}), /unavailableAction 必须为 block/);
	await assert.rejects(() => store.setHarness({
		workspaceExecution: { promotion: { conflictAction: "auto_merge" as "block_preserve_changes" } },
	}), /conflictAction 必须为 block_preserve_changes/);
	await assert.rejects(() => store.setHarness({ verification: { enabled: false } }), /enabled 必须为 true/);
	await assert.rejects(() => store.setHarness({ verification: { firstReleaseScope: "cli_and_gui" as "cli_code_first" } }), /首期必须为 cli_code_first/);
	await assert.rejects(() => store.setHarness({
		workspaceExecution: { nonGitWriteDefault: "isolated_copy_manual_apply" as "exclusive_write" },
	}), /首期必须为 exclusive_write/);
	await assert.rejects(() => store.setHarness({
		workspaceExecution: { promotion: { autoCommit: true } },
	}), /autoCommit 必须为 false/);
});
