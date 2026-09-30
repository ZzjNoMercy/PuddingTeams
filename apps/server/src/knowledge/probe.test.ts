import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeKnowledgeRoot } from "./probe.js";

test("ordinary Markdown directory is readable without a managed Wiki layout", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-md-probe-"));
	await writeFile(path.join(root, "note.md"), "test");
	const result = await probeKnowledgeRoot(root);
	assert.equal(result.profile, "markdown");
	assert.equal(result.capabilities.read, true);
	assert.equal(result.capabilities.structuredPrepare, false);
	assert.equal(result.capabilities.publish, false);
	assert.equal(result.diagnostics.length, 0);
});

test("managed Wiki markers enable preparation but do not grant publish", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-wiki-probe-"));
	for (const directory of ["wiki", "raw"]) await mkdir(path.join(root, directory), { recursive: true });
	await writeFile(path.join(root, "wiki.schema.json"), "");
	const result = await probeKnowledgeRoot(root);
	assert.equal(result.profile, "managed-wiki");
	assert.equal(result.contentRoot, path.join(await realpath(root), "wiki"));
	assert.equal(result.capabilities.layoutReady, false);
	assert.equal(result.capabilities.structuredPrepare, false);
	assert.equal(result.capabilities.publish, false);
	assert.deepEqual(result.diagnostics, ["missing_log"]);
	await writeFile(path.join(root, "wiki/log.md"), "");
	const ready = await probeKnowledgeRoot(root);
	assert.equal(ready.capabilities.layoutReady, true);
	assert.equal(ready.markers.staging, false);
	assert.equal(ready.markers.sourceManifest, false);
});

test("relative and non-directory roots are rejected", async () => {
	await assert.rejects(() => probeKnowledgeRoot("relative"), /absolute server path/);
	const root = await mkdtemp(path.join(tmpdir(), "pt-file-probe-"));
	await writeFile(path.join(root, "file.md"), "test");
	await assert.rejects(() => probeKnowledgeRoot(path.join(root, "file.md")), /not a directory/);
});

test("managed Wiki marker symlinks do not confer layout capability", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-link-probe-"));
	const outside = await mkdtemp(path.join(tmpdir(), "pt-link-outside-"));
	await mkdir(path.join(root, "wiki"));
	await symlink(outside, path.join(root, "raw"));
	const result = await probeKnowledgeRoot(root);
	assert.equal(result.markers.raw, false);
	assert.equal(result.profile, "markdown");
	assert.equal(result.capabilities.publish, false);
});
