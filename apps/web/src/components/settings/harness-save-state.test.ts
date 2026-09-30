import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessAfterSave } from "./harness-save-state.js";
import type { HarnessSettings } from "../../lib/api.js";

test("Harness 保存响应保留请求期间继续修改的策略", () => {
	const submitted = { codeSearch: { defaultProvider: "builtin" } } as HarnessSettings;
	const saved = { codeSearch: { defaultProvider: "builtin" }, workerResults: { offloadThresholdTokens: 20_000 } } as HarnessSettings;
	assert.equal(harnessAfterSave(submitted, submitted, saved), saved);
	const edited = { codeSearch: { defaultProvider: "fff" } } as HarnessSettings;
	assert.equal(harnessAfterSave(edited, submitted, saved), edited);
	assert.notEqual(JSON.stringify(harnessAfterSave(edited, submitted, saved)), JSON.stringify(saved));
});
