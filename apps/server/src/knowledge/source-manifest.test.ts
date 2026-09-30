import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectSourceManifest } from "./source-manifest.js";

test("source manifest checks exact safe paths and content hashes without writing", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-source-manifest-"));
	const raw = path.join(root, "raw");
	await mkdir(path.join(raw, "source"), { recursive: true });
	await writeFile(path.join(raw, "source", "snapshot.txt"), "evidence\n");
	const hash = createHash("sha256").update("evidence\n").digest("hex");
	const rows = [
		{ source_id: "one", snapshot_path: "source/snapshot.txt", sha256: hash },
		{ source_id: "one", snapshot_path: "../outside.txt", sha256: hash },
		{ source_id: "two", snapshot_path: "source/snapshot.txt", sha256: hash },
		{ source_id: "three", snapshot_path: "source/missing.txt", sha256: hash },
	].map((row) => JSON.stringify(row));
	await writeFile(path.join(raw, "manifest.jsonl"), `${rows.join("\n")}\n`);
	const inspection = await inspectSourceManifest(root, true);
	assert.equal(inspection.entries, 4);
	assert.equal(inspection.verifiedHashes, 1);
	assert.deepEqual(inspection.diagnostics.map((item) => item.code), ["unsafe_path", "duplicate_path", "missing_snapshot"]);
	await writeFile(path.join(raw, "source", "snapshot.txt"), "tampered\n");
	const changed = await inspectSourceManifest(root, true);
	assert.equal(changed.diagnostics[0]?.code, "hash_mismatch");
});

test("symlink source snapshot is not followed", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-source-link-"));
	const raw = path.join(root, "raw");
	await mkdir(raw);
	const outside = path.join(root, "outside.txt");
	await writeFile(outside, "outside");
	await symlink(outside, path.join(raw, "alias.txt"));
	await writeFile(path.join(raw, "manifest.jsonl"), JSON.stringify({ source_id: "one", snapshot_path: "alias.txt", sha256: "a".repeat(64) }) + "\n");
	const result = await inspectSourceManifest(root, true);
	assert.deepEqual(result.diagnostics.map((item) => item.code), ["unsafe_path"]);
});
