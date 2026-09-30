import assert from "node:assert";
import { access, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CredentialsStore } from "./credentials.js";
import { McpServerStore, normalizeMcpServerDefinition } from "./mcp-servers.js";

async function makeStore() {
	const root = mkdtempSync(path.join(tmpdir(), "pt-mcp-store-"));
	const credentials = new CredentialsStore(path.join(root, "secrets"));
	await credentials.init();
	return { root, store: new McpServerStore(path.join(root, "config"), credentials) };
}

test("MCP Server Catalog 分离明文定义与加密密钥，并只解析被选择的 Server", async () => {
	const { root, store } = await makeStore();
	const created = await store.create({
		id: "remote_docs",
		displayName: "Remote Docs",
		definition: {
			url: "https://mcp.example.test/${TENANT}",
			headers: { Authorization: "Bearer ${API_TOKEN}" },
			env: { API_TOKEN: "${API_TOKEN}" },
			requestHeadersCommand: {
				command: "${NODE_BIN}",
				args: ["/opt/mcp/request-signer.mjs", "${TENANT}"],
				env: { SIGNING_SECRET: "${SIGNING_SECRET}", PLATFORM_ID: "aisightteams" },
				timeoutMs: 5_000,
			},
		},
		secrets: {
			API_TOKEN: "top-secret-token",
			NODE_BIN: "/usr/local/bin/node",
			SIGNING_SECRET: "hmac-secret",
			TENANT: "acme",
		},
	});
	assert.deepEqual(created.secretKeys, ["API_TOKEN", "NODE_BIN", "SIGNING_SECRET", "TENANT"]);
	const configText = await readFile(path.join(root, "config", "mcp-servers.json"), "utf-8");
	assert.doesNotMatch(configText, /top-secret-token|hmac-secret|\/usr\/local\/bin\/node|acme/);
	const credentialsText = await readFile(path.join(root, "secrets", "credentials.json"), "utf-8");
	assert.doesNotMatch(credentialsText, /top-secret-token|hmac-secret|\/usr\/local\/bin\/node|acme/);

	const definitions = await store.definitionsFor(["remote_docs"]);
	assert.equal(definitions.remote_docs?.url, "https://mcp.example.test/acme");
	assert.equal(definitions.remote_docs?.headers?.Authorization, "Bearer top-secret-token");
	assert.equal(definitions.remote_docs?.env?.API_TOKEN, "top-secret-token");
	assert.deepEqual(definitions.remote_docs?.requestHeadersCommand, {
		command: "/usr/local/bin/node",
		args: ["/opt/mcp/request-signer.mjs", "acme"],
		env: { SIGNING_SECRET: "hmac-secret", PLATFORM_ID: "aisightteams" },
		timeoutMs: 5_000,
	});
	assert.deepEqual(await store.definitionsFor([]), {});
});

test("MCP Server definition 拒绝明文认证信息和不安全 transport", () => {
	assert.throws(() => normalizeMcpServerDefinition({ url: "https://example.test", bearerToken: "secret" }), /不得明文保存/);
	assert.throws(() => normalizeMcpServerDefinition({ url: "https://example.test", headers: { Authorization: "Bearer secret" } }), /疑似包含凭据/);
	assert.throws(() => normalizeMcpServerDefinition({ command: "server", env: { API_TOKEN: "secret" } }), /疑似包含凭据/);
	assert.throws(() => normalizeMcpServerDefinition({
		url: "https://example.test",
		requestHeadersCommand: { command: "node", env: { SIGNING_SECRET: "secret" } },
	}), /疑似包含凭据/);
	assert.throws(() => normalizeMcpServerDefinition({
		url: "https://example.test",
		requestHeadersCommand: { command: "node", timeoutMs: 0 },
	}), /1 到 60000/);
	assert.throws(() => normalizeMcpServerDefinition({ url: "file:///tmp/server" }), /只支持 http\/https/);
	assert.throws(() => normalizeMcpServerDefinition({ command: "server", url: "https://example.test" }), /只能配置 command 或 url/);
});

test("手工写入 Catalog 的明文凭据在列表边界 fail closed", async () => {
	const { root, store } = await makeStore();
	await store.create({ id: "safe", displayName: "Safe", definition: { command: "server" } });
	const file = path.join(root, "config", "mcp-servers.json");
	const parsed = JSON.parse(await readFile(file, "utf-8")) as { servers: Array<{ definition: Record<string, unknown> }> };
	parsed.servers[0]!.definition = { url: "https://example.test", bearerToken: "plaintext" };
	await writeFile(file, JSON.stringify(parsed), "utf-8");
	await assert.rejects(() => store.list(), /不得明文保存/);
});

test("删除 MCP Server 同时清除其密钥", async () => {
	const { store } = await makeStore();
	await store.create({ id: "local", displayName: "Local", definition: { command: "server" }, secrets: { API_TOKEN: "secret" } });
	assert.equal(await store.remove("local"), true);
	assert.equal(await store.get("local"), undefined);
	assert.equal(await store.remove("local"), false);
});

test("MCP Catalog 重命名后目录同步失败时保留待对账并拒绝继续", async () => {
	const { root, store } = await makeStore();
	await store.create({ id: "docs", displayName: "Old", definition: { command: "server" }, secrets: { API_TOKEN: "old-token" } });
	const faulted = store as unknown as { syncCatalogDirectory: (directory: string) => Promise<void> };
	faulted.syncCatalogDirectory = async () => { throw new Error("injected directory sync failure"); };
	await assert.rejects(() => store.update("docs", {
		displayName: "New", definition: { command: "server" }, secrets: { API_TOKEN: "new-token" },
	}), (error: unknown) => (error as { statusCode?: number }).statusCode === 503);
	await assert.rejects(() => store.list(), (error: unknown) => (error as { statusCode?: number }).statusCode === 503);
	await access(path.join(root, "secrets", "binding-transaction.json"));
	const credentials = new CredentialsStore(path.join(root, "secrets"));
	await credentials.init();
	const restarted = new McpServerStore(path.join(root, "config"), credentials);
	await restarted.recoverSecretTransaction();
	assert.equal((await restarted.get("docs"))?.displayName, "New");
	assert.equal((await credentials.getSecrets("docs")).API_TOKEN, "new-token");
});

for (const operation of ["create", "update", "delete"] as const) {
for (const phase of ["before-catalog", "after-catalog"] as const) {
	test(`MCP 密钥与目录事务：${operation} 真实 SIGKILL ${phase} 后按目录提交标记恢复`, async () => {
		const root = mkdtempSync(path.join(tmpdir(), "pt-mcp-sigkill-"));
		const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../scripts/mcp-secret-sigkill-child.ts", import.meta.url)), root, operation, phase], {
			cwd: path.join(process.cwd()), encoding: "utf8", timeout: 30_000,
		});
		assert.equal(child.signal, "SIGKILL", `${child.status}: ${child.stderr}`);
		const credentials = new CredentialsStore(path.join(root, "secrets", "mcp"));
		await credentials.init();
		const store = new McpServerStore(path.join(root, "config"), credentials);
		await assert.rejects(() => store.list(), /requires startup recovery/);
		await store.recoverSecretTransaction();
		const expected = operation === "create"
			? phase === "before-catalog" ? { name: undefined, token: undefined } : { name: "New", token: "new-token" }
			: operation === "delete"
				? phase === "before-catalog" ? { name: "Old", token: "old-token" } : { name: undefined, token: undefined }
				: phase === "before-catalog" ? { name: "Old", token: "old-token" } : { name: "New", token: "new-token" };
		assert.equal((await store.get("docs"))?.displayName, expected.name);
		assert.equal((await credentials.getSecrets("docs")).API_TOKEN, expected.token);
		await store.recoverSecretTransaction();
		assert.equal((await credentials.getSecrets("docs")).API_TOKEN, expected.token);
	});
}
}
