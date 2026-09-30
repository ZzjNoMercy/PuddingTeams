import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { CustomProviderDurabilityError, deleteCustomProvider, listCustomProvidersSnapshot, setModelsDirectorySyncForTests, upsertCustomProvider } from "./custom-providers.js";
import { ProviderDeletionCoordinator, ProviderRecoveryRequiredError, type ProviderCredentialPort } from "./provider-deletion.js";
import { registerProvidersRoutes } from "../routes/providers.js";
import { registerChatRoutes } from "../routes/chat.js";
import type { PiSessionStore } from "./session-store.js";

test("models.json rename 后目录同步失败：PUT 返回 503 并封锁同进程后续写入", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-models-sync-put-"));
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	let keyWrites = 0;
	const store = {
		markAllDirty() {},
		hasProvider: async () => true,
		setProviderKey: async () => { keyWrites += 1; return { availableCount: 1 }; },
		removeProviderKey: async () => { keyWrites += 1; },
	} as unknown as PiSessionStore;
	const app = Fastify();
	try {
		const coordinator = new ProviderDeletionCoordinator(path.join(root, "secrets", "journal.json"), store);
		await registerChatRoutes(app, store, undefined, undefined, undefined, undefined, undefined, coordinator);
		await registerProvidersRoutes(app, store, coordinator);
		const revision = (await listCustomProvidersSnapshot()).revision;
		setModelsDirectorySyncForTests(async () => { throw new Error("injected models directory sync failure"); });
		const payload = { expectedRevision: revision, name: "Fixture", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] };
		const failed = await app.inject({ method: "PUT", url: "/api/providers/custom/fixture", payload });
		assert.equal(failed.statusCode, 503, failed.body);
		assert.equal(failed.json().code, "provider_write_uncertain");
		assert.equal((await listCustomProvidersSnapshot()).providers.some((provider) => provider.id === "fixture"), true, "rename 已在当前文件系统生效，不可回复普通失败");
		const retry = await app.inject({ method: "PUT", url: "/api/providers/custom/fixture", payload: { ...payload, expectedRevision: (await listCustomProvidersSnapshot()).revision, name: "Retry" } });
		assert.equal(retry.statusCode, 503, retry.body);
		assert.equal(retry.json().code, "provider_write_uncertain");
		for (const request of [
			{ method: "POST", url: "/api/providers/fixture/key", payload: { apiKey: "new-key" } },
			{ method: "DELETE", url: "/api/providers/fixture/key" },
		] as const) {
			const blocked = await app.inject(request);
			assert.equal(blocked.statusCode, 503, blocked.body);
			assert.equal(blocked.json().code, "provider_write_uncertain");
		}
		assert.equal(keyWrites, 0);
	} finally {
		setModelsDirectorySyncForTests();
		await app.close();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
});

test("models.json 删除提交后目录同步失败：保留日志并由新进程完成删除", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-models-sync-delete-"));
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	const journal = path.join(root, "secrets", "journal.json");
	const keyFile = path.join(root, "credential.json");
	const port: ProviderCredentialPort = {
		async snapshotProviderCredential() { return JSON.parse(readFileSync(keyFile, "utf8")) as unknown; },
		async removeProviderKey() { writeFileSync(keyFile, "null"); },
		async restoreProviderCredential(_id, credential) { writeFileSync(keyFile, JSON.stringify(credential)); },
	};
	try {
		writeFileSync(keyFile, JSON.stringify({ type: "api_key", key: "old" }));
		await upsertCustomProvider("fixture", { name: "Fixture", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] });
		const revision = (await listCustomProvidersSnapshot()).revision;
		const coordinator = new ProviderDeletionCoordinator(journal, port);
		setModelsDirectorySyncForTests(async () => { throw new Error("injected models directory sync failure"); });
		await assert.rejects(() => coordinator.withMutation(() => coordinator.delete("fixture", revision)), ProviderRecoveryRequiredError);
		assert.equal(existsSync(journal), true);
		assert.equal((await listCustomProvidersSnapshot()).providers.some((provider) => provider.id === "fixture"), false);
		assert.equal(JSON.parse(readFileSync(keyFile, "utf8")), null);
		await assert.rejects(() => coordinator.withMutation(async () => undefined), ProviderRecoveryRequiredError);
		setModelsDirectorySyncForTests();
		const program = `import { ProviderDeletionCoordinator } from "./src/pi-bridge/provider-deletion.ts";
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.TEST_KEY_FILE;
const port = {
  async snapshotProviderCredential() { return JSON.parse(readFileSync(file, "utf8")); },
  async removeProviderKey() { writeFileSync(file, "null"); },
  async restoreProviderCredential(_id, credential) { writeFileSync(file, JSON.stringify(credential)); },
};
const coordinator = new ProviderDeletionCoordinator(process.env.TEST_JOURNAL, port);
if (await coordinator.recover() !== "deleted") process.exit(2);`;
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
			cwd: path.resolve(import.meta.dirname, "../.."),
			env: { ...process.env, TEST_JOURNAL: journal, TEST_KEY_FILE: keyFile },
			encoding: "utf8",
		});
		assert.equal(child.status, 0, child.stderr || child.stdout);
		assert.equal(existsSync(journal), false);
	} finally {
		setModelsDirectorySyncForTests();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
});

test("目录提交不确定时不得执行旧式删除回退回调", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-models-sync-rollback-"));
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	try {
		await upsertCustomProvider("fixture", { name: "Fixture", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] });
		const revision = (await listCustomProvidersSnapshot()).revision;
		let rollbackCalls = 0;
		setModelsDirectorySyncForTests(async () => { throw new Error("injected models directory sync failure"); });
		await assert.rejects(() => deleteCustomProvider("fixture", revision, async () => undefined, async () => { rollbackCalls += 1; }), CustomProviderDurabilityError);
		assert.equal(rollbackCalls, 0);
	} finally {
		setModelsDirectorySyncForTests();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
});
