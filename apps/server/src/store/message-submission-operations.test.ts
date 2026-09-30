import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageSubmissionConflictError, MessageSubmissionOperations, MessageSubmissionUnconfirmedError } from "./message-submission-operations.js";

test("ordinary message reservation survives restart and never replays a reserved operation", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "pt-message-operations-"));
	const key = randomUUID();
	const hash = createHash("sha256").update("payload").digest("hex");
	const context = createHash("sha256").update("workspace-a").digest("hex");
	const first = new MessageSubmissionOperations(directory);
	assert.equal(await first.reserve(key, "session-a", hash, context), "new");
	const restarted = new MessageSubmissionOperations(directory);
	assert.equal(await restarted.reserve(key, "session-a", hash, context), "unconfirmed");
	await assert.rejects(() => restarted.reserve(key, "session-b", hash, context), MessageSubmissionConflictError);
	await assert.rejects(() => restarted.reserve(key, "session-a", createHash("sha256").update("other").digest("hex"), context), MessageSubmissionConflictError);
	await assert.rejects(() => restarted.reserve(key, "session-a", hash, createHash("sha256").update("workspace-b").digest("hex")), MessageSubmissionConflictError);
	await restarted.markAccepted(key, "session-a", hash);
	assert.equal(await new MessageSubmissionOperations(directory).reserve(key, "session-a", hash, context), "accepted");
});

test("partial or corrupt reservation fails closed", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "pt-message-operations-"));
	const key = randomUUID();
	const hash = createHash("sha256").update("payload").digest("hex");
	const context = createHash("sha256").update("workspace-a").digest("hex");
	writeFileSync(path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`), "{partial");
	await assert.rejects(() => new MessageSubmissionOperations(directory).reserve(key, "session-a", hash, context), MessageSubmissionUnconfirmedError);
});

test("pre-effect rejection is durable and keeps its reason across restart", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "pt-message-rejected-"));
	const key = randomUUID();
	const hash = createHash("sha256").update("payload").digest("hex");
	const context = createHash("sha256").update("workspace-a").digest("hex");
	const operations = new MessageSubmissionOperations(directory);
	assert.equal(await operations.reserve(key, "session-a", hash, context), "new");
	await operations.markRejected(key, "session-a", hash, "file not found");
	const restarted = new MessageSubmissionOperations(directory);
	assert.deepEqual(await restarted.reserve(key, "session-a", hash, context), { rejected: "file not found" });
	await assert.rejects(() => restarted.markAccepted(key, "session-a", hash), MessageSubmissionUnconfirmedError);
	await assert.rejects(() => restarted.reserve(key, "session-a", createHash("sha256").update("changed").digest("hex"), context), MessageSubmissionConflictError);
});
