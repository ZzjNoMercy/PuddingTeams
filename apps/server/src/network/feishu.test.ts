import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";
import Fastify from "fastify";
import QRCode from "qrcode";
import { CredentialsStore } from "../store/credentials.js";
import { LarkConnection } from "@puddingteams/capability-lark-cli/connection";
import { CLI_BRIDGE_SOURCE } from "@puddingteams/capability-lark-cli/cli-bridge";
import { readLocalFeishuCredential, registerFeishuRoutes, startFeishuBroker } from "./feishu.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-feishu-shared-test-"));
	const vault = new CredentialsStore(root); await vault.init();
	let now = 100000;
	let refreshes = 0;
	const record = { appId: "cli_test", appSecret: "secret-only-vault", user: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1000, refreshExpiresAt: 99999999, scope: "calendar:calendar:readonly offline_access", userName: "测试用户" } };
	await vault.setSecrets("default", { connection: JSON.stringify(record) });
	const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url).includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "bot-access", expire: 7200 });
		if (String(url).includes("device_authorization")) return Response.json({ device_code: "upstream-device-secret", verification_uri_complete: "https://accounts.feishu.cn/authorize?code=test", expires_in: 120, interval: 1 });
		if (String(url).includes("user_info")) return Response.json({ code: 0, data: { name: "测试用户" } });
		if (String(init?.body).includes("grant_type=refresh_token")) refreshes++;
		return Response.json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 7200, refresh_token_expires_in: 604800, scope: record.user.scope, token_type: "Bearer" });
	}) as typeof fetch;
	const connection = new LarkConnection({ read: async () => (await vault.getSecrets("default")).connection, write: async value => { await vault.setSecrets("default", { connection: value }); } }, { fetch: fetchMock, now: () => now, qr: url => QRCode.toDataURL(url) });
	return { root, connection, vault, refreshes: () => refreshes, advance: () => { now += 7_300_000; } };
}

test("API 设置与授权状态不公开密钥，AES-GCM 落盘与 0600 权限", async () => {
	const { root, connection } = await fixture();
	const app = Fastify(); registerFeishuRoutes(app, connection);
	try {
		const view = await app.inject({ method: "GET", url: "/api/settings/feishu" });
		assert.equal(view.headers["cache-control"], "no-store");
		assert.doesNotMatch(view.body, /secret-only-vault|old-access|old-refresh/);
		const update = await app.inject({ method: "PUT", url: "/api/settings/feishu", payload: { appId: "cli_test" } });
		assert.equal(update.statusCode, 200);
		assert.doesNotMatch(update.body, /secret-only-vault|old-refresh/);
		const file = await readFile(path.join(root, "credentials.json"), "utf8");
		assert.doesNotMatch(file, /secret-only-vault|old-refresh/);
		assert.match(file, /v1\./);
		assert.equal((await stat(path.join(root, "credentials.json"))).mode & 0o777, 0o600);
		assert.equal((await app.inject({ method: "GET", url: "/api/settings/feishu/credential" })).statusCode, 404);
		assert.equal((await app.inject({ method: "PUT", url: "/api/settings/feishu", payload: { appId: "cli_test", appSecret: 123 } })).statusCode, 400);
	} finally { connection.close(); await app.close(); }
});

test("私有 broker 拒绝无凭证和浏览器访问；CLI/平台共用一轮续期", async () => {
	const { connection, refreshes } = await fixture();
	const broker = await startFeishuBroker(connection);
	try {
		assert.equal((await fetch(`${broker.url}/credential`, { method: "POST", body: "{}" })).status, 403);
		assert.equal((await fetch(`${broker.url}/credential`, { method: "POST", headers: { Authorization: `Bearer ${broker.key}`, Origin: "http://evil.test" }, body: "{}" })).status, 403);
		const headers = { Authorization: `Bearer ${broker.key}`, "Content-Type": "application/json" };
		const [cli, token] = await Promise.all([fetch(`${broker.url}/credential`, { method: "POST", headers, body: JSON.stringify({ identity: "user" }) }).then(r => r.json()), connection.accessToken("user")]);
		assert.equal(cli.accessToken, token);
		assert.equal(refreshes(), 1);
		assert.doesNotMatch(JSON.stringify(cli), /secret-only-vault|old-refresh/);
		const auth = await fetch(`${broker.url}/authorizations`, { method: "POST", headers, body: "{}" }).then(r => r.json());
		assert.doesNotMatch(JSON.stringify(auth), /upstream-device-secret|secret-only-vault|old-refresh/);
		assert.match(auth.qrCodeDataUrl, /^data:image\/png;base64/);
	} finally { await broker.close(); }
});

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", part => { stdout += part; }); child.stderr.on("data", part => { stderr += part; });
		child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
	});
}
test("Agent Bash 每次调用取得新 token；长会话无静态 token、无机器人隐式降级", async () => {
	const { root, connection, advance, refreshes } = await fixture();
	const broker = await startFeishuBroker(connection);
	const bridge = path.join(root, "lark-cli.cjs");
	const fakeCli = path.join(root, "official-cli");
	await writeFile(bridge, CLI_BRIDGE_SOURCE);
	await writeFile(fakeCli, `#!${process.execPath}\nconst e=process.env; console.log(JSON.stringify({identity:e.LARKSUITE_CLI_DEFAULT_AS,fresh:/^access-\\d+$/.test(e.LARKSUITE_CLI_USER_ACCESS_TOKEN||''),noSecret:!e.LARKSUITE_CLI_APP_SECRET&&!e.PUDDING_LARK_BROKER_KEY,noRefresh:!e.LARKSUITE_CLI_REFRESH_TOKEN}));`, { mode: 0o700 });
	const env = { ...process.env, PUDDING_LARK_BROKER_URL: broker.url, PUDDING_LARK_BROKER_KEY: broker.key, PUDDING_LARK_REAL_CLI: fakeCli };
	try {
		const first = await runScript(bridge, ["calendar", "+agenda"], env);
		assert.equal(first.code, 0, first.stderr); assert.equal(JSON.parse(first.stdout).fresh, true);
		advance();
		const second = await runScript(bridge, ["calendar", "+agenda"], env);
		assert.equal(second.code, 0, second.stderr); assert.equal(JSON.parse(second.stdout).fresh, true);
		assert.equal(JSON.parse(second.stdout).noSecret, true); assert.equal(refreshes(), 2);
		const status = await runScript(bridge, ["auth", "status", "--json"], env);
		assert.equal(status.code, 0); assert.doesNotMatch(status.stdout, /secret-only-vault|refresh-2|access-2/);
		const login = await runScript(bridge, ["auth", "login", "--scope", "calendar:calendar:readonly", "--no-wait", "--json"], env);
		assert.equal(login.code, 0, login.stderr); assert.doesNotMatch(login.stdout, /upstream-device-secret/);
		const session = JSON.parse(login.stdout); assert.equal((await connection.authorizationStatus(session.device_code))?.state, "pending");
		await connection.logout();
		const denied = await runScript(bridge, ["calendar", "+agenda"], env);
		assert.equal(denied.code, 1); assert.match(denied.stderr, /用户授权/);
		const bot = await runScript(bridge, ["calendar", "+agenda", "--as", "bot"], env);
		assert.equal(bot.code, 0); assert.equal(JSON.parse(bot.stdout).identity, "bot");
	} finally { await broker.close(); }
});

test("导入本机已有 AES 凭证只读取，不再授权、不降级系统钥匙串", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-feishu-import-"));
	const dir = path.join(root, "Library", "Application Support", "lark-cli");
	await mkdir(dir, { recursive: true }); await mkdir(path.join(root, ".lark-cli"));
	const key = randomBytes(32);
	await writeFile(path.join(dir, "master.key.file"), key);
	const encrypt = async (account: string, value: string) => {
		const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
		const ct = Buffer.concat([cipher.update(value), cipher.final()]);
		await writeFile(path.join(dir, account.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc"), Buffer.concat([iv, ct, cipher.getAuthTag()]));
	};
	await encrypt("appsecret:cli_test", "secret");
	const user = { appId: "cli_test", accessToken: "access", refreshToken: "refresh", expiresAt: 12345, refreshExpiresAt: 99999999, scope: "offline_access", tokenType: "Bearer" };
	await encrypt("cli_test:ou_test", JSON.stringify(user));
	await writeFile(path.join(root, ".lark-cli", "config.json"), JSON.stringify({ currentApp: "cli_test", apps: [{ appId: "cli_test", brand: "feishu", appSecret: { source: "keychain", id: "appsecret:cli_test" }, users: [{ userOpenId: "ou_test", userName: "测试用户" }] }] }));
	const imported = await readLocalFeishuCredential({ home: root, platform: "darwin" });
	assert.equal(imported.user?.refreshToken, "refresh"); assert.equal(imported.appSecret, "secret");
	await encrypt("cli_test:ou_test", JSON.stringify({ ...user, tokenType: "DPoP", dpopKeyId: "key" }));
	await assert.rejects(readLocalFeishuCredential({ home: root, platform: "darwin" }), /独立签名密钥/);
	await assert.rejects(readLocalFeishuCredential({ home: root, platform: "win32" }), /支持 macOS/);
});
