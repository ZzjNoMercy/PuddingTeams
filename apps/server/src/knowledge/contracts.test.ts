import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicationBatchShape, assertReviewMatchesBatch, publicationManifestHash, type PublicationBatch, type ReviewDecision } from "./contracts.js";

function fixture(): { batch: PublicationBatch; review: ReviewDecision } {
	const batch: PublicationBatch = {
		id: "batch-1", revision: 1, bindingId: "binding-1", manifestHash: "", rootIdentity: "device:inode",
		files: [
			{ operation: "create", targetPath: "wiki/a.md", expectedHashOrAbsent: null, candidateHash: "a".repeat(64), blobRef: "blob-a" },
			{ operation: "update", targetPath: "wiki/b.md", expectedHashOrAbsent: "b".repeat(64), candidateHash: "c".repeat(64), blobRef: "blob-b" },
		],
		sourceSnapshots: ["source-1"], schemaHash: "schema-1", bindingRevision: 2, trustRevision: 3,
		dependencyGroups: [["wiki/a.md", "wiki/b.md"]], validationReceipt: "receipt-1", compilerVersion: "1", status: "pending_review",
	};
	batch.manifestHash = publicationManifestHash(batch);
	const review: ReviewDecision = {
		id: "review-1", batchId: batch.id, revision: batch.revision, manifestHash: batch.manifestHash,
		actorId: "human-1", decidedAt: "2026-09-23T00:00:00Z", decision: "approve",
		reviewedFiles: batch.files.map((file) => file.targetPath), expectedTargets: batch.files.map((file) => file.targetPath), policyRevision: 1,
	};
	return { batch, review };
}

test("approval covers the exact frozen batch and all targets", () => {
	const { batch, review } = fixture();
	assert.doesNotThrow(() => assertReviewMatchesBatch(batch, review));
	for (const changed of [
		{ ...batch, files: [{ ...batch.files[0]!, candidateHash: "d".repeat(64) }, batch.files[1]!] },
		{ ...batch, rootIdentity: "replaced-root" },
		{ ...batch, trustRevision: 4 },
		{ ...batch, sourceSnapshots: ["new-source"] },
	]) {
		assert.throws(() => assertReviewMatchesBatch(changed, review), /frozen publication batch/);
	}
	assert.throws(() => assertReviewMatchesBatch(batch, { ...review, reviewedFiles: ["wiki/a.md"] }), /every distinct target/);
	assert.throws(() => assertReviewMatchesBatch(batch, { ...review, expectedTargets: ["wiki/a.md", "wiki/a.md"] }), /every distinct target/);
	assert.throws(() => assertReviewMatchesBatch(batch, { ...review, batchId: "other-batch" }), /frozen publication batch/);
	assert.throws(() => assertReviewMatchesBatch(batch, { ...review, decision: "reject" }), /frozen publication batch/);
});

test("publication plan rejects path escape, missing bytes, stale create and incomplete groups", () => {
	const { batch } = fixture();
	assert.doesNotThrow(() => assertPublicationBatchShape(batch));
	for (const targetPath of ["../outside.md", "/absolute.md", "C:/absolute.md", "wiki//a.md", "wiki/./a.md", "wiki\\a.md"]) {
		assert.throws(() => assertPublicationBatchShape({ ...batch, files: [{ ...batch.files[0]!, targetPath }, batch.files[1]!] }), /publication target/);
	}
	assert.throws(() => assertPublicationBatchShape({ ...batch, files: [{ ...batch.files[0]!, expectedHashOrAbsent: "a".repeat(64) }, batch.files[1]!] }), /must be absent/);
	assert.throws(() => assertPublicationBatchShape({ ...batch, files: [{ ...batch.files[0]!, candidateHash: null }, batch.files[1]!] }), /candidate bytes/);
	assert.throws(() => assertPublicationBatchShape({ ...batch, dependencyGroups: [["wiki/a.md"]] }), /every target exactly once/);
});
