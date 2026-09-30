import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessSettings } from "./api";
import { clearHarnessSettingsDraft, harnessDraftMatchesServer, harnessSettingsDraftKey, loadHarnessSettingsDraft, mergeHarnessSettingsDraft, saveHarnessSettingsDraft } from "./harness-settings-draft";

const settings = (provider: string) => ({ codeSearch: { defaultProvider: provider }, workerResults: { offloadThresholdTokens: 10 } }) as HarnessSettings;

function storage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => { values.set(key, value); },
		removeItem: (key: string) => { values.delete(key); },
	};
}

test("Harness draft is scoped to tenant and viewer", () => {
	const identity = (tenant: string, user: string) => ({ tenant: { id: tenant }, user: { id: user } }) as Parameters<typeof harnessSettingsDraftKey>[0];
	assert.notEqual(harnessSettingsDraftKey(identity("a", "u")), harnessSettingsDraftKey(identity("b", "u")));
	assert.notEqual(harnessSettingsDraftKey(identity("a", "u")), harnessSettingsDraftKey(identity("a", "v")));
});

test("Harness draft restores only against the same saved baseline", () => {
	const key = `harness-draft-test-${crypto.randomUUID()}`;
	const store = storage();
	const draft = { baseline: settings("builtin"), value: settings("fff") };
	saveHarnessSettingsDraft(key, draft, () => store);
	assert.deepEqual(loadHarnessSettingsDraft(key, () => store), draft);
	assert.equal(harnessDraftMatchesServer(draft, settings("builtin")), true);
	assert.equal(harnessDraftMatchesServer(draft, settings("fff")), false);
	clearHarnessSettingsDraft(key, () => store);
	assert.equal(loadHarnessSettingsDraft(key, () => store), null);
});

test("malformed draft cannot populate controlled settings fields", () => {
	const key = `harness-draft-test-${crypto.randomUUID()}`;
	const store = storage();
	store.setItem(key, JSON.stringify({ baseline: settings("builtin"), value: { codeSearch: null } }));
	assert.equal(loadHarnessSettingsDraft(key, () => store), null);
});

test("server shape changes keep the old draft readable but prevent automatic restore", () => {
	const key = `harness-draft-test-${crypto.randomUUID()}`;
	const store = storage();
	const draft = { baseline: settings("builtin"), value: settings("fff") };
	saveHarnessSettingsDraft(key, draft, () => store);
	assert.deepEqual(loadHarnessSettingsDraft(key, () => store), draft);
	assert.equal(harnessDraftMatchesServer(draft, { ...settings("builtin"), newPolicy: true } as HarnessSettings), false);
});

test("storage removal failure does not resurrect a saved draft", () => {
	const key = `harness-draft-test-${crypto.randomUUID()}`;
	const store = storage();
	saveHarnessSettingsDraft(key, { baseline: settings("builtin"), value: settings("fff") }, () => store);
	clearHarnessSettingsDraft(key, () => ({ ...store, removeItem: () => { throw new Error("storage denied"); } }));
	assert.equal(loadHarnessSettingsDraft(key, () => store), null);
});

test("storage write failure still keeps the draft for same-tab navigation", () => {
	const key = `harness-draft-test-${crypto.randomUUID()}`;
	const draft = { baseline: settings("builtin"), value: settings("fff") };
	saveHarnessSettingsDraft(key, draft, () => ({ ...storage(), setItem: () => { throw new Error("storage denied"); } }));
	assert.deepEqual(loadHarnessSettingsDraft(key, () => storage()), draft);
});

test("Harness 草稿仅自动合并互不冲突的字段", () => {
	const baseline = settings("builtin");
	const draft = { baseline, value: { ...baseline, codeSearch: { defaultProvider: "fff" } } as HarnessSettings };
	const remote = { ...baseline, workerResults: { offloadThresholdTokens: 20 } } as HarnessSettings;
	assert.deepEqual(mergeHarnessSettingsDraft(draft, remote), {
		value: { codeSearch: { defaultProvider: "fff" }, workerResults: { offloadThresholdTokens: 20 } },
		conflicts: [],
	});
	assert.deepEqual(mergeHarnessSettingsDraft(draft, { ...remote, codeSearch: { defaultProvider: "fff" } } as HarnessSettings)?.conflicts, [], "双方同值不冲突");
});

test("Harness 草稿同字段分歧和结构变化不被静默覆盖", () => {
	const baseline = settings("builtin");
	const draft = { baseline, value: { ...baseline, workerResults: { offloadThresholdTokens: 15 } } as HarnessSettings };
	const remote = { ...baseline, workerResults: { offloadThresholdTokens: 20 } } as HarnessSettings;
	assert.deepEqual(mergeHarnessSettingsDraft(draft, remote), { value: remote, conflicts: ["workerResults.offloadThresholdTokens"] });
	assert.equal(mergeHarnessSettingsDraft(draft, { ...remote, newPolicy: true } as HarnessSettings), null);
});
