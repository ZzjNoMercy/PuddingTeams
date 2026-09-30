import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownReferenceDefinitions, resolveKnowledgeAssetRef } from "./markdown.js";
import { hasFrozenBatchImage, managedImageHash } from "./snapshot-images.js";

const hash = "a".repeat(64);
const path = `assets/images/${hash}.png`;
const image = { kind: "image", targetPath: path, candidateHash: hash, operation: "create" };

test("nested Markdown resolves relative image against its frozen page path", () => {
	assert.deepEqual(resolveKnowledgeAssetRef("projects/reports/page.md", `../../${path}`), { kind: "asset", path });
	assert.deepEqual(resolveKnowledgeAssetRef("projects/page.md", `../${path}`), { kind: "asset", path });
	assert.equal(hasFrozenBatchImage(path, [image]), true);
});

test("candidate image must match frozen manifest kind, path and content hash", () => {
	assert.equal(hasFrozenBatchImage(path, []), false);
	assert.equal(hasFrozenBatchImage(path, [{ ...image, kind: "markdown" }]), false);
	assert.equal(hasFrozenBatchImage(path, [{ ...image, candidateHash: "b".repeat(64) }]), false);
	assert.equal(hasFrozenBatchImage(path, [{ ...image, targetPath: `projects/${path}` }]), false);
	assert.equal(hasFrozenBatchImage(path, [{ ...image, operation: "delete" }]), false);
});

test("snapshot policy rejects arbitrary local filenames, unsafe SVG and base64 URLs", () => {
	for (const value of ["photo.png", "assets/images/photo.png", path.replace(".png", ".svg"), `/${path}`, `data:image/png;base64,${hash}`, `https://example.com/${path}`]) assert.equal(managedImageHash(value), null);
	assert.equal(managedImageHash(path), hash);
});

test("relative resource resolver blocks escape, absolute and hidden paths", () => {
	for (const value of [`../../${path}`, `/${path}`, `//host/${path}`, ".private/photo.png", "file:///tmp/photo.png"]) {
		const ref = resolveKnowledgeAssetRef("folder/page.md", value);
		assert.equal(ref.kind === "asset" && managedImageHash(ref.path) !== null, false);
	}
	assert.equal(resolveKnowledgeAssetRef("folder/page.md", "https://example.com/image.png").kind, "remote");
});

test("visual revision blocks retain their own snapshot reference definitions, excluding fenced examples", () => {
	const previous = `![diagram][figure]\n\n[figure]: ../${path} "original"\n\n\`\`\`md\n[example]: https://example.com/fake.png\n\`\`\``;
	assert.equal(markdownReferenceDefinitions(previous), `[figure]: ../${path} "original"`);
	assert.equal(markdownReferenceDefinitions(`[figure]:\n  ../${path}`), `[figure]:\n  ../${path}`);
	assert.equal(markdownReferenceDefinitions(`[figure]: ../assets/images/${"b".repeat(64)}.png`), `[figure]: ../assets/images/${"b".repeat(64)}.png`);
});
