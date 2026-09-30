import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiSessionStore } from "../src/pi-bridge/session-store.ts";
import { ProviderDeletionCoordinator } from "../src/pi-bridge/provider-deletion.ts";
import { listCustomProvidersSnapshot, upsertCustomProvider } from "../src/pi-bridge/custom-providers.ts";
import { configureSharedModelRuntime } from "../src/pi-bridge/model-runtime.ts";

const script = fileURLToPath(import.meta.url);
const serverPackageDir = path.resolve(path.dirname(script), "..");
const projectRoot = path.resolve(path.dirname(script), "../../..");
const runtimeServer = process.env.PUDDINGTEAMS_RUNTIME_SERVER ?? path.join(projectRoot, "packages/puddingteams-cli/runtime/apps/server/src/server.bundle.mjs");
assert.ok(path.isAbsolute(runtimeServer), "PUDDINGTEAMS_RUNTIME_SERVER must be absolute");

async function createThenExit(home, phase) {
	const id = `fixture-${phase}`;
	const authPath = path.join(home, "secrets", "auth.json");
	const journal = path.join(home, "secrets", "provider-deletion-journal.json");
	configureSharedModelRuntime({ authPath });
	const store = new PiSessionStore(home, path.join(home, "sessions"));
	await upsertCustomProvider(id, { name: id, baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] });
	await store.setProviderKey(id, `fixture-secret-${phase}`);
	const revision = (await listCustomProvidersSnapshot()).revision;
	if (phase === "before-catalog") {
		const remove = store.removeProviderKey.bind(store);
		store.removeProviderKey = async (providerId) => { await remove(providerId); process.exit(75); };
	}
	const coordinator = new ProviderDeletionCoordinator(journal, store, phase === "after-catalog" ? async () => process.exit(76) : undefined);
	await coordinator.withMutation(() => coordinator.delete(id, revision));
	throw new Error("crash hook was not reached");
}

async function freePort() {
	const socket = createServer();
	await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
	const address = socket.address();
	assert.ok(address && typeof address !== "string");
	await new Promise((resolve) => socket.close(resolve));
	return address.port;
}

async function waitForHealth(port, child, output) {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited before health: ${child.exitCode}\n${output()}`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch { /* listener not ready */ }
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server health timeout\n${output()}`);
}

async function rehearse(phase) {
	const home = await mkdtemp(path.join(tmpdir(), `pt-runtime-provider-${phase}-`));
	let server;
	let serverClosed;
	let output = "";
	try {
		const env = { ...process.env, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent-dir"), PI_OFFLINE: "1" };
		const created = spawnSync(process.execPath, ["--import", "tsx", script, "create", home, phase], {
			cwd: serverPackageDir, env, encoding: "utf8", timeout: 30_000,
		});
		assert.equal(created.status, phase === "before-catalog" ? 75 : 76, created.stderr || created.error?.message);
		const journal = path.join(home, "secrets", "provider-deletion-journal.json");
		assert.equal(existsSync(journal), true);
		const authPath = path.join(home, "secrets", "auth.json");
		const id = `fixture-${phase}`;
		assert.equal(id in JSON.parse(await readFile(authPath, "utf8")), false);
		const port = await freePort();
		server = spawn(process.execPath, [runtimeServer], {
			cwd: projectRoot,
			env: { ...env, HOST: "127.0.0.1", PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		serverClosed = new Promise((resolve) => server.once("exit", resolve));
		server.stdout.on("data", (chunk) => { output += String(chunk); });
		server.stderr.on("data", (chunk) => { output += String(chunk); });
		await waitForHealth(port, server, () => output);
		const response = await fetch(`http://127.0.0.1:${port}/api/providers/custom`);
		assert.equal(response.status, 200);
		const snapshot = await response.json();
		const present = snapshot.providers.some((provider) => provider.id === id);
		const shouldKeep = phase === "before-catalog";
		assert.equal(present, shouldKeep);
		const auth = JSON.parse(await readFile(authPath, "utf8"));
		assert.equal(auth[id]?.key, shouldKeep ? `fixture-secret-${phase}` : undefined);
		assert.equal(existsSync(journal), false);
		const keyProbe = await fetch(`http://127.0.0.1:${port}/api/providers/${id}/models`);
		assert.equal(keyProbe.status, shouldKeep ? 200 : 404);
		const digest = createHash("sha256").update(await readFile(runtimeServer)).digest("hex");
		return { phase, health: 200, providerPresent: present, credentialPresent: id in auth, journalCleared: true, bundleSha256: digest };
	} finally {
		if (server && server.exitCode === null) {
			server.kill("SIGTERM");
			await Promise.race([serverClosed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
			if (server.exitCode === null) server.kill("SIGKILL");
		}
		await rm(home, { recursive: true, force: true });
	}
}

if (process.argv[2] === "create") await createThenExit(process.argv[3], process.argv[4]);
else console.log(JSON.stringify({ runtimeServer, results: await Promise.all([rehearse("before-catalog"), rehearse("after-catalog")]) }, null, 2));
