import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listCustomProvidersSnapshot, upsertCustomProvider } from "./custom-providers.js";
import { configureSharedModelRuntime, resetSharedModelRuntime } from "./model-runtime.js";
import { ProviderDeletionCoordinator } from "./provider-deletion.js";
import { PiSessionStore } from "./session-store.js";

test("真实 PiSessionStore auth.json 在 Provider 删除两侧进程退出后恢复", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-provider-sdk-crash-"));
	const agentDir = path.join(root, "pi-agent");
	const authPath = path.join(root, "secrets", "auth.json");
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const savedOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	configureSharedModelRuntime({ authPath });
	try {
		for (const phase of ["before-catalog", "after-catalog"] as const) {
			const id = phase;
			const originalKey = `secret-${phase}`;
			const journal = path.join(root, "secrets", `${phase}-journal.json`);
			const store = new PiSessionStore(root, path.join(root, "sessions"));
			await upsertCustomProvider(id, { name: id, baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] });
			await store.setProviderKey(id, originalKey);
			assert.equal((await store.snapshotProviderCredential(id) as { key?: string } | undefined)?.key, originalKey);
			const revision = (await listCustomProvidersSnapshot()).revision;
			const program = `import { PiSessionStore } from "./src/pi-bridge/session-store.ts";
import { ProviderDeletionCoordinator } from "./src/pi-bridge/provider-deletion.ts";
import { configureSharedModelRuntime } from "./src/pi-bridge/model-runtime.ts";
import path from "node:path";
configureSharedModelRuntime({ authPath: process.env.TEST_AUTH_PATH });
const root = process.env.TEST_ROOT;
const store = new PiSessionStore(root, path.join(root, "sessions"));
if (process.env.TEST_PHASE === "before-catalog") {
  const remove = store.removeProviderKey.bind(store);
  store.removeProviderKey = async (id) => { await remove(id); process.exit(17); };
}
const coordinator = new ProviderDeletionCoordinator(process.env.TEST_JOURNAL, store,
  process.env.TEST_PHASE === "after-catalog" ? async () => process.exit(17) : undefined);
await coordinator.withMutation(() => coordinator.delete(process.env.TEST_ID, process.env.TEST_REVISION));`;
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
				cwd: path.resolve(import.meta.dirname, "../.."),
				env: { ...process.env, TEST_ROOT: root, TEST_AUTH_PATH: authPath, TEST_JOURNAL: journal, TEST_ID: id, TEST_REVISION: revision, TEST_PHASE: phase },
				encoding: "utf8",
			});
			assert.equal(child.status, 17, child.stderr || child.stdout);
			assert.equal(existsSync(journal), true);
			const afterCrash = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
			assert.equal(id in afterCrash, false, "子进程必须在真实 SDK 凭证撤销后退出");
			resetSharedModelRuntime();
			const restarted = new PiSessionStore(root, path.join(root, "sessions"));
			assert.equal(await new ProviderDeletionCoordinator(journal, restarted).recover(), phase === "before-catalog" ? "restored" : "deleted");
			assert.equal(existsSync(journal), false);
			assert.equal((await listCustomProvidersSnapshot()).providers.some((provider) => provider.id === id), phase === "before-catalog");
			const afterRecovery = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
			assert.equal(afterRecovery[id]?.key, phase === "before-catalog" ? originalKey : undefined);
			assert.equal((await restarted.snapshotProviderCredential(id) as { key?: string } | undefined)?.key, phase === "before-catalog" ? originalKey : undefined);
			await store.disposeAll();
			await restarted.disposeAll();
		}
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		if (savedOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = savedOffline;
	}
});
