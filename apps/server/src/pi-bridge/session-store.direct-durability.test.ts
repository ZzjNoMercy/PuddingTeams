import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PiSessionStore } from "./session-store.js";

test("direct admission card is present in its JSONL before durable send resolves", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-direct-durable-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-dir");
	const store = new PiSessionStore(root, path.join(root, "sessions"));
	try {
		const summary = await store.create();
		await store.sendCustomMessageDurable(summary.id, {
			customType: "pudding:user_message",
			content: "执行任务",
			details: { windowId: "direct-window", operationId: "operation-12345678" },
		});
		const session = await store.open(summary.id);
		const entries = readFileSync(session.sessionFile!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
			type?: string; customType?: string; content?: string; details?: { operationId?: string };
		});
		assert.equal(entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pudding:user_message" &&
			entry.content === "执行任务" && entry.details?.operationId === "operation-12345678").length, 1);
	} finally { await store.disposeAll(); }
});

test("pi message admission marker is hidden and durable only for a persisted user entry", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-pi-admission-"));
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-dir");
	const store = new PiSessionStore(root, path.join(root, "sessions"));
	try {
		const summary = await store.create();
		const session = await store.open(summary.id);
		const facts = { operationId: "operation-12345678", requestHash: "a".repeat(64), contextHash: "b".repeat(64), userEntryId: "missing" };
		await assert.rejects(store.appendMessageAdmission(summary.id, facts), /user 未落盘/);
		const index = session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() } as never);
		const user = session.sessionManager.getEntry(index);
		assert.equal(user?.type, "message");
		await store.appendMessageAdmission(summary.id, { ...facts, userEntryId: user!.id });
		const entries = readFileSync(session.sessionFile!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
			type?: string; customType?: string; display?: boolean; details?: { operationId?: string; userEntryId?: string };
		});
		const markers = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pudding:message_admission");
		assert.equal(markers.length, 1);
		assert.equal(markers[0]?.display, false);
		assert.equal(markers[0]?.details?.operationId, facts.operationId);
		assert.equal(markers[0]?.details?.userEntryId, user?.id);
	} finally { await store.disposeAll(); }
});
