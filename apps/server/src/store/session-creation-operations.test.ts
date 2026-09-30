import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionCreationOperations } from "./session-creation-operations.js";

test("new-work reservation survives restart and rejects key reuse in another context", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pt-session-operation-"));
	try {
		const file = path.join(dir, "state", "operations.json");
		const firstStore = new SessionCreationOperations(file);
		const first = await firstStore.reserve("work-key-1234", "solo", "workspace-a", "initial-session");
		assert.equal(first.sessionId, "initial-session");
		await firstStore.markAttached(first.key, first.sessionId);
		const restarted = new SessionCreationOperations(file);
		assert.deepEqual(await restarted.reserve("work-key-1234", "solo", "workspace-a"), { ...first, phase: "attached" });
		await assert.rejects(() => restarted.reserve("work-key-1234", "solo", "workspace-b"), /不同房间、Workspace 或内容/);
		await assert.rejects(() => restarted.reserve("bad", "solo", "workspace-a"), /Idempotency-Key/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("two operation keys cannot reserve the same idle container", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pt-session-operation-"));
	try {
		const store = new SessionCreationOperations(path.join(dir, "operations.json"));
		const [first, second] = await Promise.all([
			store.reserve("operation-aaa", "solo", "context", "idle-session"),
			store.reserve("operation-bbb", "solo", "context", "idle-session"),
		]);
		assert.equal(first.sessionId, "idle-session");
		assert.notEqual(second.sessionId, first.sessionId);
		assert.match(second.sessionId, /^work-[a-f0-9]{32}$/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("malformed ledger cannot reserve a Session; inherited property names remain valid operation keys", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pt-session-ledger-invalid-"));
	try {
		const file = path.join(dir, "operations.json");
		const store = new SessionCreationOperations(file);
		await writeFile(file, "[]");
		await assert.rejects(store.reserve("constructor", "solo", "context", "idle-session"), /账本无效/);
		assert.equal(await readFile(file, "utf8"), "[]");
		await writeFile(file, "{}");
		const created = await store.reserve("constructor", "solo", "context", "idle-session");
		assert.equal(created.sessionId, "idle-session");
		assert.equal((await new SessionCreationOperations(file).reserve("constructor", "solo", "context")).sessionId, "idle-session");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("reservation rename failure cleans its temporary file and can be retried", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pt-session-ledger-rename-"));
	try {
		const file = path.join(dir, "operations.json");
		await mkdir(file);
		const store = new SessionCreationOperations(file);
		await assert.rejects(store.reserve("rename-fail-0001", "solo", "context"));
		assert.deepEqual(await readdir(dir), ["operations.json"], "failed rename must not leave a credential-like ledger temp file");
		await rm(file, { recursive: true });
		const reserved = await store.reserve("rename-fail-0001", "solo", "context");
		assert.match(reserved.sessionId, /^work-[a-f0-9]{32}$/);
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("directory sync failure after ledger rename freezes this process until restart", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pt-session-ledger-sync-"));
	try {
		const file = path.join(dir, "operations.json");
		const store = new SessionCreationOperations(file);
		await store.reserve("synced-work-0001", "solo", "context");
		const internals = store as unknown as { syncDirectory: () => Promise<void> };
		internals.syncDirectory = async () => { throw new Error("injected directory sync failure"); };
		await assert.rejects(store.reserve("uncertain-work-0001", "solo", "context"), /injected directory sync failure/);
		const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		assert.ok(Object.hasOwn(onDisk, "uncertain-work-0001"), "rename occurred before the simulated sync failure");
		await assert.rejects(store.reserve("third-work-0001", "solo", "context"), /持久化结果不确定/);
		const restarted = new SessionCreationOperations(file);
		assert.deepEqual(await restarted.reserve("uncertain-work-0001", "solo", "context"), onDisk["uncertain-work-0001"]);
		assert.ok((await restarted.reserve("third-work-0001", "solo", "context")).sessionId);
		assert.deepEqual(await readdir(dir), ["operations.json"]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
