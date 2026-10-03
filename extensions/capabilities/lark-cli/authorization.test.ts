import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LarkConnection, type ConnectionCredential, type ConnectionVault } from "./connection.js";
import { authorization, listConnections } from "./index.js";

const existing: ConnectionCredential = { appId: "cli_test", appSecret: "private-secret", user: { accessToken: "old-access", refreshToken: "refresh-one", expiresAt: 1000, refreshExpiresAt: 9999999, scope: "calendar:calendar:readonly offline_access", userName: "测试用户" } };
function fixture(options: { mode?: string; record?: ConnectionCredential; failWrite?: number } = {}) {
	let raw = options.record === undefined ? JSON.stringify(existing) : JSON.stringify(options.record);
	let writes = 0;
	let now = 100000;
	const requests: Array<{ url: string; body: string }> = [];
	const vault: ConnectionVault = { read: async () => raw || undefined, write: async value => { if (++writes === options.failWrite) throw new Error("disk failed"); raw = value; } };
	const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
		const target = String(url);
		const body = String(init?.body ?? "");
		requests.push({ url: target, body });
		if (options.mode === "offline") throw new Error("private-secret refresh-one access-token");
		if (target.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "bot-token", expire: 7200 });
		if (target.includes("device_authorization")) return Response.json({ device_code: "real-private-device-code", verification_uri_complete: options.mode === "malicious" ? "https://example.com/auth" : "https://accounts.feishu.cn/auth?user_code=test", expires_in: 120, interval: 1 });
		if (target.includes("user_info")) return Response.json({ code: 0, data: { name: "新用户" } });
		if (target.includes("scopes.json")) return Response.json({ scopes: { calendar: { user_scopes: ["calendar:calendar:read", "calendar:calendar.event:create"] }, im: { user_scopes: ["im:message.send_as_user"] } } });
		if (body.includes("grant_type=refresh_token")) {
			await delay(15);
			if (options.mode === "invalid") return Response.json({ error: "invalid_grant", code: 20073 }, { status: 400 });
			return Response.json({ access_token: "fresh-access", refresh_token: "refresh-two", expires_in: 7200, refresh_token_expires_in: 604800, scope: existing.user!.scope, token_type: "Bearer" });
		}
		if (options.mode === "pending") return Response.json({ error: "authorization_pending" }, { status: 400 });
		if (options.mode === "slow_down") return Response.json({ error: "slow_down" }, { status: 400 });
		if (options.mode === "reject") return Response.json({ error: "access_denied", error_description: "private-secret" }, { status: 400 });
		if (options.mode === "delayed") await delay(80);
		return Response.json({ access_token: "login-access", refresh_token: "login-refresh", expires_in: 7200, refresh_token_expires_in: 604800, scope: "calendar:calendar:readonly offline_access", token_type: "Bearer" });
	}) as typeof fetch;
	const connection = new LarkConnection(vault, { fetch: fetchMock, now: () => now, qr: async () => "data:image/png;base64,test" });
	return { connection, requests, vault, raw: () => raw, setNow: (value: number) => { now = value; }, clear: () => { raw = ""; } };
}
async function completed(connection: LarkConnection, id: string) {
	for (let i = 0; i < 100; i++) { const result = await connection.authorizationStatus(id); if (result?.state !== "pending") return result; await delay(10); }
	throw new Error("test timeout");
}

test("平台与多个 CLI 并发取凭证只刷新一次，轮换在返回前保存", async () => {
	const { connection, requests, raw } = fixture();
	const tokens = await Promise.all([connection.accessToken("user"), connection.cliCredential("user"), connection.cliCredential("user")]);
	assert.equal(tokens[0], "fresh-access");
	assert.equal((tokens[1] as { accessToken: string }).accessToken, "fresh-access");
	assert.equal(requests.filter(r => r.body.includes("refresh_token=")).length, 1);
	assert.match(raw(), /refresh-two/);
	assert.doesNotMatch(raw(), /refresh-one/);
	assert.doesNotMatch(JSON.stringify(await connection.settings()), /private-secret|fresh-access|refresh-two/);
	connection.close();
});
test("CLI 与平台续期共享，失效不静默退回机器人身份", async () => {
	const { connection, requests } = fixture({ mode: "invalid" });
	await assert.rejects(connection.cliCredential("user"));
	await assert.rejects(connection.accessToken("user"), /授权已失效/);
	assert.equal(requests.filter(r => r.url.includes("tenant_access_token")).length, 0);
	assert.equal(requests.filter(r => r.body.includes("refresh_token=")).length, 1);
});
test("消耗刷新令牌后落盘失败或网络结果不确定，重启也不重放旧刷新令牌", async () => {
	for (const options of [{ failWrite: 2 }, { mode: "offline" }]) {
		const { connection, vault, raw } = fixture(options);
		await assert.rejects(connection.accessToken("user"));
		assert.match(raw(), /refreshState/);
		const restarted = new LarkConnection(vault, { now: () => 100000, fetch: (() => { throw new Error("must not request"); }) as unknown as typeof fetch });
		await assert.rejects(restarted.accessToken("user"), /结果不确定/);
	}
});
test("平台授权入口不依赖 CLI，保留既有范围且不公开设备码或凭证", async () => {
	const { connection, requests } = fixture();
	const service = { ...connection, status: () => connection.status(), begin: () => connection.begin(), authorizationStatus: (id: string) => connection.authorizationStatus(id), cancel: (id: string) => connection.cancel(id), runtimeEnv: async () => ({}) };
	const ctx = { env: { PATH: "" }, stateDir: "/nonexistent", connection: service };
	const session = await authorization.begin("default", "authorize-user", ctx);
	assert.equal(session.verificationUrl, "https://accounts.feishu.cn/auth?user_code=test");
	assert.doesNotMatch(JSON.stringify(session), /real-private-device-code|private-secret|refresh-one/);
	assert.match(requests.find(r => r.url.includes("device_authorization"))!.body, /calendar/);
	assert.ok(!requests.some(r => r.body.includes("device_code=")), "显示入口前不启动轮询");
	assert.equal((await completed(connection, session.id))?.state, "completed");
	const [status] = await listConnections(ctx);
	assert.equal(status?.userAuthorization, "authorized");
	assert.ok(status?.actions?.some(a => a.id === "install-cli"));
	assert.equal((await connection.cliCredential()).accessToken, "login-access");
	connection.close();
});
test("两边发起重新授权会替换未完成入口，取消/过期不改已有凭证", async () => {
	const { connection, raw, setNow } = fixture({ mode: "pending" });
	const before = raw();
	const first = await connection.begin();
	const second = await connection.begin();
	assert.equal((await connection.authorizationStatus(first.id))?.state, "cancelled");
	await connection.cancel(second.id);
	assert.equal((await connection.authorizationStatus(second.id))?.state, "cancelled");
	const third = await connection.begin();
	setNow(9999999);
	assert.equal((await connection.authorizationStatus(third.id))?.state, "expired");
	assert.equal(raw(), before);
	connection.close();
});
test("拒绝、不可信入口、网络错误不会泄露原始认证信息", async () => {
	const rejected = fixture({ mode: "reject" });
	const session = await rejected.connection.begin();
	const view = await completed(rejected.connection, session.id);
	assert.equal(view?.state, "failed");
	assert.doesNotMatch(JSON.stringify(view), /private-secret|real-private-device-code/);
	const malicious = fixture({ mode: "malicious" });
	await assert.rejects(malicious.connection.begin(), /非官方/);
	const offline = fixture({ mode: "offline" });
	await assert.rejects(offline.connection.begin(), e => e instanceof Error && !e.message.includes("private-secret"));
});
test("取消正在等待的 HTTP 授权不覆写凭证", async () => {
	const { connection, raw } = fixture({ mode: "delayed" });
	const before = raw();
	const session = await connection.begin();
	await connection.authorizationStatus(session.id);
	await delay(10);
	await connection.cancel(session.id);
	await delay(100);
	assert.equal(raw(), before);
	assert.equal((await connection.authorizationStatus(session.id))?.state, "cancelled");
});
test("配置同一应用保留用户授权，切换应用必须确认并清除不匹配凭证", async () => {
	const { connection, raw } = fixture();
	await connection.configure({ appId: "cli_test", appSecret: "new-secret" });
	assert.match(raw(), /refresh-one/);
	await assert.rejects(connection.configure({ appId: "cli_other", appSecret: "secret" }), /确认/);
	await connection.configure({ appId: "cli_other", appSecret: "secret", confirmReplace: true });
	assert.doesNotMatch(raw(), /refresh-one|old-access/);
});
test("显式导入已有凭证不发起授权；按官方域申请增量权限", async () => {
	const { connection, clear, requests } = fixture();
	clear();
	await connection.adopt(structuredClone(existing));
	assert.ok(!requests.some(r => r.url.includes("device_authorization")));
	const session = await connection.begin({ domains: ["calendar"], scope: "im:message.send_as_user" });
	const request = new URLSearchParams(requests.find(r => r.url.includes("device_authorization"))!.body);
	assert.match(request.get("scope")!, /calendar:calendar:readonly/);
	assert.match(request.get("scope")!, /calendar:calendar.event:create/);
	assert.match(request.get("scope")!, /im:message.send_as_user/);
	await connection.cancel(session.id);
});
test("未配置时明确引导设置，首次仅申请基础身份与续期", async () => {
	const { connection, clear, requests } = fixture(); clear();
	assert.equal((await connection.status()).state, "disconnected");
	await assert.rejects(connection.begin(), /默认应用/);
	await connection.configure({ appId: "cli_test", appSecret: "secret" });
	const session = await connection.begin();
	const body = new URLSearchParams(requests.find(r => r.url.includes("device_authorization"))!.body);
	assert.equal(body.get("scope"), "auth:user.id:read offline_access");
	await connection.cancel(session.id);
});
