import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { materializeCompileSource } from "./compile-source.js";
import { fingerprintCompileSnapshot } from "./compile-snapshot.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeObservationService } from "./observation.js";

test("compiler source contains only selected accepted object bytes", async () => {
	const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "pt-compile-source-")));
	const objects = new KnowledgeObjectStore(path.join(home, "objects"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(home, "acceptance"));
	const vault = path.join(home, "vault");
	await mkdir(path.join(vault, "notes"), { recursive: true });
	await writeFile(path.join(vault, "notes/first.md"), "# Accepted\n");
	await writeFile(path.join(vault, "notes/second.md"), "# Unselected\n");
	const binding = await new KnowledgeBindingRegistry(path.join(home, "state")).create({ ownerId: "owner", name: "Vault", description: "Test", rootPath: vault });
	const observation = new KnowledgeObservationService(acceptance, { objects });
	const first = await objects.put(Buffer.from("# Accepted\n"));
	const second = await objects.put(Buffer.from("# Unselected\n"));
	await acceptance.adopt(binding.id, [
		{ relativePath: "notes/first.md", contentHash: first.hash, acceptedBy: "owner" },
		{ relativePath: "notes/second.md", contentHash: second.hash, acceptedBy: "owner" },
	], 0);
	const ledger = await acceptance.getSnapshot(binding.id);
	const id = Object.values(ledger.entries).find((entry) => entry.relativePath === "notes/first.md")!.acceptanceId;
	const result = await materializeCompileSource(path.join(home, "compile"), ledger, [id], objects, binding, observation, acceptance);
	assert.equal(await readFile(path.join(result.root, "notes/first.md"), "utf8"), "# Accepted\n");
	await assert.rejects(readFile(path.join(result.root, "notes/second.md")), { code: "ENOENT" });
	assert.deepEqual(result.sourceSnapshotRefs, [first.hash]);
	assert.deepEqual(result.sourceAcceptanceIds, [id]);
	assert.equal(result.sourceSnapshotHash, await fingerprintCompileSnapshot(result.root));
	assert.equal((await stat(result.root)).mode & 0o777, 0o500);
	assert.equal((await stat(path.join(result.root, "notes/first.md"))).mode & 0o777, 0o400);
});

test("compiler source rejects forged acceptance, unsafe paths, and object corruption", async () => {
	const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "pt-compile-source-")));
	const objects = new KnowledgeObjectStore(path.join(home, "objects"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(home, "acceptance"));
	const vault = path.join(home, "vault");
	await mkdir(vault);
	await writeFile(path.join(vault, "safe.md"), "# Accepted\n");
	const binding = await new KnowledgeBindingRegistry(path.join(home, "state")).create({ ownerId: "owner", name: "Vault", description: "Test", rootPath: vault });
	const observation = new KnowledgeObservationService(acceptance, { objects });
	const object = await objects.put(Buffer.from("# Accepted\n"));
	await acceptance.adopt(binding.id, [
		{ relativePath: "safe.md", contentHash: object.hash, acceptedBy: "owner" },
	], 0);
	const ledger = await acceptance.getSnapshot(binding.id);
	const entry = Object.values(ledger.entries)[0]!;
	const parent = path.join(home, "compile");
	await mkdir(parent, { mode: 0o700 });
	await chmod(parent, 0o755);
	await assert.rejects(materializeCompileSource(parent, ledger, [entry.acceptanceId], objects, binding, observation, acceptance), /server-owned and mode 0700/);
	await chmod(parent, 0o700);
	await assert.rejects(materializeCompileSource(parent, ledger, ["forged"], objects, binding, observation, acceptance), /not an accepted object/);
	await assert.rejects(materializeCompileSource(parent, ledger, [entry.acceptanceId, entry.acceptanceId], objects, binding, observation, acceptance), /invalid CompileJob accepted source selection/);
	for (const availability of ["changed", "missing", "revoked"] as const) {
		const unavailable = { ...ledger, entries: { ...ledger.entries, "path:safe.md": { ...entry, availability } } };
		await assert.rejects(materializeCompileSource(parent, unavailable, [entry.acceptanceId], objects, binding, observation, acceptance), /not an accepted object/);
	}
	const unsafe = { ...ledger, entries: { ...ledger.entries, "path:safe.md": { ...entry, relativePath: "../escape.md" } } };
	await assert.rejects(materializeCompileSource(parent, unsafe, [entry.acceptanceId], objects, binding, observation, acceptance), /invalid relative path/);
	await writeFile(path.join(vault, "safe.md"), "# Changed\n");
	assert.equal(Object.values((await acceptance.getSnapshot(binding.id)).entries)[0]?.availability, "current", "stale ledger alone must not authorize compile");
	await assert.rejects(materializeCompileSource(parent, ledger, [entry.acceptanceId], objects, binding, observation, acceptance), /no longer current/);
	await writeFile(path.join(vault, "safe.md"), "---\nid: new-identity\n---\n# Accepted\n");
	await assert.rejects(materializeCompileSource(parent, ledger, [entry.acceptanceId], objects, binding, observation, acceptance), /no longer current|identity changed/);
	await writeFile(path.join(vault, "safe.md"), "# Accepted\n");
	await writeFile(object.path, "# Changed\n");
	await assert.rejects(materializeCompileSource(parent, ledger, [entry.acceptanceId], objects, binding, observation, acceptance), /内容校验失败|同哈希不同内容/);
	await writeFile(object.path, "# Accepted\n");
	await acceptance.adopt(binding.id, [
		{ relativePath: "safe.md", contentHash: object.hash, acceptedBy: "owner" },
	], (await acceptance.getSnapshot(binding.id)).acceptanceRevision);
	await assert.rejects(materializeCompileSource(parent, ledger, [entry.acceptanceId], objects, binding, observation, acceptance), /accepted source authority changed/);
});
