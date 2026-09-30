import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listCustomProvidersSnapshot, upsertCustomProvider } from "./custom-providers.js";
import { ProviderDeletionCoordinator, ProviderRecoveryRequiredError, type ProviderCredentialPort } from "./provider-deletion.js";

function filePort(keyFile: string): ProviderCredentialPort {
	return {
		async snapshotProviderCredential() { return JSON.parse(readFileSync(keyFile, "utf8")) as unknown; },
		async removeProviderKey() { writeFileSync(keyFile, "null"); },
		async restoreProviderCredential(_id, credential) { writeFileSync(keyFile, JSON.stringify(credential)); },
	};
}

for (const phase of ["before-catalog", "after-catalog"] as const) {
	test(`Provider 删除在 ${phase} 强制退出后由启动恢复收敛`, async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pt-provider-crash-"));
		const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
		const journal = path.join(dir, "secrets", "provider-deletion-journal.json");
		const keyFile = path.join(dir, "credential.json");
		try {
			writeFileSync(keyFile, JSON.stringify({ type: "api_key", key: "old-secret" }));
			await upsertCustomProvider("fixture", { name: "Fixture", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] });
			const revision = (await listCustomProvidersSnapshot()).revision;
			const program = `import { ProviderDeletionCoordinator } from "./src/pi-bridge/provider-deletion.ts";
import { readFileSync, writeFileSync } from "node:fs";
const keyFile = process.env.TEST_KEY_FILE;
const port = {
  async snapshotProviderCredential() { return JSON.parse(readFileSync(keyFile, "utf8")); },
  async removeProviderKey() { writeFileSync(keyFile, "null"); ${phase === "before-catalog" ? "process.exit(17);" : ""} },
  async restoreProviderCredential(_id, credential) { writeFileSync(keyFile, JSON.stringify(credential)); },
};
const coordinator = new ProviderDeletionCoordinator(process.env.TEST_JOURNAL, port, ${phase === "after-catalog" ? "async () => process.exit(17)" : "undefined"});
await coordinator.withMutation(() => coordinator.delete("fixture", process.env.TEST_REVISION));`;
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
				cwd: path.resolve(import.meta.dirname, "../.."),
				env: { ...process.env, TEST_KEY_FILE: keyFile, TEST_JOURNAL: journal, TEST_REVISION: revision },
				encoding: "utf8",
			});
			assert.equal(child.status, 17, child.stderr || child.stdout);
			assert.equal(existsSync(journal), true);
			assert.equal(statSync(journal).mode & 0o777, 0o600);
			assert.equal(JSON.parse(readFileSync(keyFile, "utf8")), null);
			const coordinator = new ProviderDeletionCoordinator(journal, filePort(keyFile));
			assert.equal(await coordinator.recover(), phase === "before-catalog" ? "restored" : "deleted");
			assert.equal(existsSync(journal), false);
			assert.equal((await listCustomProvidersSnapshot()).providers.some((provider) => provider.id === "fixture"), phase === "before-catalog");
			assert.deepEqual(JSON.parse(readFileSync(keyFile, "utf8")), phase === "before-catalog" ? { type: "api_key", key: "old-secret" } : null);
		} finally {
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		}
	});
}

test("凭证恢复失败时日志保留，写操作封锁；修复后重启恢复", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-provider-recovery-"));
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
	const journal = path.join(dir, "secrets", "provider-deletion-journal.json");
	const keyFile = path.join(dir, "credential.json");
	try {
		writeFileSync(keyFile, JSON.stringify({ type: "api_key", key: "old-secret" }));
		await upsertCustomProvider("fixture", { name: "Fixture", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] });
		const revision = (await listCustomProvidersSnapshot()).revision;
		const port = filePort(keyFile);
		const failing: ProviderCredentialPort = {
			...port,
			async removeProviderKey(id) {
				await port.removeProviderKey(id);
				writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), `${readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")} `);
			},
			async restoreProviderCredential() { throw new Error("injected restore failure"); },
		};
		const coordinator = new ProviderDeletionCoordinator(journal, failing);
		await assert.rejects(() => coordinator.withMutation(() => coordinator.delete("fixture", revision)), ProviderRecoveryRequiredError);
		assert.equal(existsSync(journal), true);
		await assert.rejects(() => coordinator.withMutation(async () => undefined), ProviderRecoveryRequiredError);
		assert.equal(await new ProviderDeletionCoordinator(journal, port).recover(), "restored");
		assert.deepEqual(JSON.parse(readFileSync(keyFile, "utf8")), { type: "api_key", key: "old-secret" });
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
});
