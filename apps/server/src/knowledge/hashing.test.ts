import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashBufferSha256 } from "./hashing.js";

test("hashBufferSha256 返回 hex 摘要", () => {
	assert.equal(hashBufferSha256("abc"), createHash("sha256").update("abc").digest("hex"));
});
