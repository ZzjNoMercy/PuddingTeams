import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DelegationStore } from "./delegation-store.js";

test("DelegationStore 保持 v2，并为新增的加法字段补语义默认值", async () => {
	const state = mkdtempSync(path.join(tmpdir(), "pt-delegation-v2-"));
	const timestamp = new Date().toISOString();
	writeFileSync(path.join(state, "delegations.json"), JSON.stringify({
		version: 2,
		delegations: {
			legacy: {
				id: "legacy",
				windowId: "window",
				cwdSnapshot: state,
				managerSessionId: "manager-session",
				purpose: "execution",
				agentId: "worker",
				agentRevision: 1,
				operation: "run",
				executionState: "reported_completed",
				revision: 1,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		},
	}));
	writeFileSync(path.join(state, "interactions.json"), JSON.stringify({
		version: 2,
		interactions: {
			legacyInteraction: {
				id: "legacyInteraction",
				delegationId: "legacy",
				kind: "question",
				requests: [],
				status: "pending",
				revision: 0,
				providerStateRef: "secret-ref",
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		},
	}));

	const store = new DelegationStore(state);
	await store.init();
	const [delegation] = await store.listDelegations();
	const [interaction] = await store.listInteractions();
	assert.equal(delegation?.id, "legacy");
	assert.equal(delegation?.workerStarted, false);
	assert.equal(interaction?.source, "worker");

	await store.createInteraction({
		delegationId: "legacy",
		kind: "confirmation",
		requests: [],
	});
	const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(state, "interactions.json"), "utf8"))) as { version: number };
	assert.equal(persisted.version, 2);
});
