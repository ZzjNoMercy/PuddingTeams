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
	await assert.rejects(() => store.setHarness({
		goalActivation: { direct: "manager_explicit" as "user_explicit" },
	}), /direct 无效/);
	await assert.rejects(() => store.setHarness({
		codeSearch: { defaultProvider: "invalid" as "fff" },
	}), /codeSearch.defaultProvider 无效/);
});
