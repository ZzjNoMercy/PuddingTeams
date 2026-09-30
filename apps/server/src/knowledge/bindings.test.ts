import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeBindingRegistry } from "./bindings.js";

async function fixture() {
	const base = await mkdtemp(path.join(tmpdir(), "pt-bindings-"));
	const rootA = path.join(base, "vault-a");
	const rootB = path.join(base, "vault-b");
	await mkdir(rootA);
	await mkdir(rootB);
	await writeFile(path.join(rootA, "note.md"), "original");
	return { base, rootA, rootB, registry: new KnowledgeBindingRegistry(path.join(base, "home", "state", "knowledge")) };
}

test("registers a read-only root without writing into it and survives registry reload", async () => {
	const { base, rootA, registry } = await fixture();
	const before = await readdir(rootA);
	const record = await registry.create({ ownerId: "owner-1", name: "Personal", description: "Private notes", rootPath: rootA });
	assert.deepEqual(await readdir(rootA), before);
	assert.equal(await readFile(path.join(rootA, "note.md"), "utf8"), "original");
	assert.equal(record.bindingRevision, 1);
	assert.equal(record.readPolicy, "private");
	const reopened = new KnowledgeBindingRegistry(path.join(base, "home", "state", "knowledge"));
	assert.equal((await reopened.list("owner-1"))[0]?.id, record.id);
	assert.deepEqual(await reopened.list("another-owner"), []);
	await assert.rejects(() => reopened.requireUsable("another-owner", record.id), { code: "not_found" });
});

test("name and description input must be bounded and non-empty", async () => {
	const { rootA, registry } = await fixture();
	await assert.rejects(() => registry.create({ ownerId: "owner-1", name: " ", description: "Notes", rootPath: rootA }), { code: "invalid_input" });
	await assert.rejects(() => registry.create({ ownerId: "owner-1", name: "A", description: "x".repeat(501), rootPath: rootA }), { code: "invalid_input" });
});

test("rejects same, nested and symlink-alias roots", async () => {
	const { base, rootA, rootB, registry } = await fixture();
	await registry.create({ ownerId: "owner-1", name: "A", description: "Notes", rootPath: rootA });
	await assert.rejects(() => registry.create({ ownerId: "owner-1", name: "Again", description: "Notes", rootPath: rootA }), { code: "overlapping_root" });
	const nested = path.join(rootA, "nested");
	await mkdir(nested);
	await assert.rejects(() => registry.create({ ownerId: "owner-1", name: "Nested", description: "Notes", rootPath: nested }), { code: "overlapping_root" });
	const alias = path.join(base, "alias");
	await symlink(rootA, alias);
	await assert.rejects(() => registry.create({ ownerId: "owner-1", name: "Alias", description: "Notes", rootPath: alias }), { code: "overlapping_root" });
	assert.equal((await registry.create({ ownerId: "owner-1", name: "B", description: "Notes", rootPath: rootB })).name, "B");
});

test("optimistic metadata revision and revocation do not alter vault files", async () => {
	const { rootA, registry } = await fixture();
	const record = await registry.create({ ownerId: "owner-1", name: "A", description: "Notes", rootPath: rootA });
	const updated = await registry.updateDescription("owner-1", record.id, 1, "Updated notes");
	assert.equal(updated.bindingRevision, 2);
	await assert.rejects(() => registry.updateDescription("owner-1", record.id, 1, "Stale"), { code: "revision_conflict" });
	const revoked = await registry.revoke("owner-1", record.id, 2);
	assert.equal(revoked.trustRevision, 2);
	await assert.rejects(() => registry.requireUsable("owner-1", record.id), { code: "not_found" });
	assert.equal(await readFile(path.join(rootA, "note.md"), "utf8"), "original");
});

test("root replacement is unavailable even when the same path exists", async () => {
	const { rootA, registry } = await fixture();
	const record = await registry.create({ ownerId: "owner-1", name: "A", description: "Notes", rootPath: rootA });
	await rename(rootA, `${rootA}-old`);
	await mkdir(rootA);
	assert.equal((await registry.list("owner-1"))[0]?.availability, "offline");
	await assert.rejects(() => registry.requireUsable("owner-1", record.id), { code: "root_changed" });
});

test("revoked bindings do not block re-registering the same root", async () => {
	const { rootA, rootB, registry } = await fixture();
	const record = await registry.create({ ownerId: "owner-1", name: "A", description: "Notes", rootPath: rootA });
	await registry.create({ ownerId: "owner-1", name: "B", description: "Notes", rootPath: rootB });
	await registry.revoke("owner-1", record.id, 1);
	const again = await registry.create({ ownerId: "owner-1", name: "A2", description: "Notes", rootPath: rootA });
	assert.notEqual(again.id, record.id);
	// 活跃绑定的重叠保护不受影响。
	await assert.rejects(() => registry.create({ ownerId: "owner-1", name: "C", description: "Notes", rootPath: rootB }), { code: "overlapping_root" });
	const nested = path.join(rootA, "nested");
	await mkdir(nested);
	await assert.rejects(() => registry.create({ ownerId: "owner-1", name: "Nested", description: "Notes", rootPath: nested }), { code: "overlapping_root" });
});
