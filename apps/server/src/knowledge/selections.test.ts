import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeSelectionStore } from "./selections.js";

test("source selections stay scoped to owner and workspace context", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-selections-"));
	const a = path.join(base, "a"); const b = path.join(base, "b");
	await mkdir(a); await mkdir(b);
	const state = path.join(base, "home", "state", "knowledge");
	const bindings = new KnowledgeBindingRegistry(state);
	const first = await bindings.create({ ownerId: "local:a", name: "A", description: "First", rootPath: a });
	const second = await bindings.create({ ownerId: "local:a", name: "B", description: "Second", rootPath: b });
	const selections = new KnowledgeSelectionStore(state, bindings);
	const projectA = await selections.set("local:a", "workspace:a", 0, [first.id, second.id]);
	assert.equal(projectA.revision, 1);
	assert.deepEqual((await selections.get("local:a", "workspace:b")).selectedBindingIds, []);
	assert.deepEqual((await selections.get("local:b", "workspace:a")).selectedBindingIds, []);
	await assert.rejects(() => selections.set("local:b", "workspace:a", 0, [first.id]), { code: "not_found" });
	await assert.rejects(() => selections.set("local:a", "workspace:a", 0, [first.id]), { code: "revision_conflict" });
	await assert.rejects(() => selections.set("local:a", "workspace:a", 1, [first.id, first.id]), { code: "invalid_selection" });
	await bindings.revoke("local:a", second.id, second.bindingRevision);
	assert.deepEqual((await selections.get("local:a", "workspace:a")).selectedBindingIds, [first.id, second.id]);
	assert.deepEqual((await selections.effective("local:a", "workspace:a")).selectedBindingIds, [first.id]);
});

test("memory defaults join existing and new contexts; opt-outs survive restart, inheritance and offline roots", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-memory-defaults-"));
	try {
		const vault = path.join(base, "vault"); await mkdir(vault);
		const state = path.join(base, "state"), bindings = new KnowledgeBindingRegistry(state);
		const memory = await bindings.create({ ownerId: "owner", name: "Memory", description: "Memory", rootPath: vault });
		let configured = false;
		const defaults = async (ownerId: string) => configured && ownerId === "owner" ? [memory.id] : [];
		let selections = new KnowledgeSelectionStore(state, bindings, defaults);
		await selections.inherit("owner", "session:existing", "workbench");
		assert.deepEqual((await selections.effective("owner", "session:existing")).selectedBindingIds, []);
		configured = true;
		assert.deepEqual((await selections.effective("owner", "session:existing")).selectedBindingIds, [memory.id]);
		assert.deepEqual((await selections.effective("owner", "session:new")).selectedBindingIds, [memory.id]);
		assert.deepEqual((await selections.effective("other", "session:new")).selectedBindingIds, []);
		await selections.set("owner", "workbench", 0, []);
		await selections.inherit("owner", "session:opt-out", "workbench");
		selections = new KnowledgeSelectionStore(state, bindings, defaults);
		assert.deepEqual((await selections.effective("owner", "session:opt-out")).selectedBindingIds, []);
		await selections.set("owner", "session:opt-out", 1, [memory.id]);
		assert.deepEqual((await selections.effective("owner", "session:opt-out")).selectedBindingIds, [memory.id]);
		await rename(vault, `${vault}-offline`);
		await selections.inherit("owner", "session:offline", "fresh-workbench");
		assert.deepEqual((await selections.effective("owner", "session:offline")).selectedBindingIds, []);
		await rename(`${vault}-offline`, vault);
		assert.deepEqual((await selections.effective("owner", "session:offline")).selectedBindingIds, [memory.id]);
		await bindings.revoke("owner", memory.id, memory.bindingRevision);
		assert.deepEqual((await selections.effective("owner", "session:new")).selectedBindingIds, []);
	} finally { await rm(base, { recursive: true, force: true }); }
});
