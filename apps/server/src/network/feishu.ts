import { randomBytes, timingSafeEqual, createDecipheriv } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { LarkConnection, type ConnectionCredential, type AuthorizationOptions } from "@puddingteams/capability-lark-cli/connection";
import type { SharedCapabilityConnection } from "../agent-runtime/extensions.js";

/** A private loopback broker, distinct from browser APIs. It exposes only short-lived
 * tokens to bound CLI invocations, never App Secret / Refresh Token / vault bytes. */
export async function startFeishuBroker(connection: LarkConnection): Promise<{ service: SharedCapabilityConnection; close(): Promise<void>; url: string; key: string }> {
	const key = randomBytes(32).toString("hex");
	const server: Server = createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		const expected = Buffer.from(`Bearer ${key}`);
		const supplied = Buffer.from(req.headers.authorization ?? "");
		if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(JSON.stringify({ error: "凭证服务访问被拒绝" })); return; }
		try {
			let raw = "";
			for await (const chunk of req) { raw += chunk; if (raw.length > 32_768) throw new Error("请求过大"); }
			const input = raw ? JSON.parse(raw) as Record<string, unknown> : {};
			const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			let result: unknown;
			if (req.method === "GET" && route === "/status") result = { ...await connection.status(), scope: (await connection.settings()).scope };
			else if (req.method === "GET" && route === "/settings") result = await connection.settings();
			else if (req.method === "POST" && route === "/settings") result = await connection.configure(validateSettings(input));
			else if (req.method === "POST" && route === "/credential") {
				if (input.identity !== "user" && input.identity !== "bot") throw new Error("身份无效");
				result = await connection.cliCredential(input.identity);
			} else if (req.method === "POST" && route === "/authorizations") result = await connection.begin(validateAuthorization(input));
			else if (req.method === "GET" && /^\/authorizations\/[a-f0-9-]+$/.test(route)) result = await connection.authorizationStatus(route.split("/")[2]!);
			else if (req.method === "POST" && route === "/refresh") {
				if (input.identity !== "user" && input.identity !== "bot") throw new Error("身份无效");
				await connection.accessToken(input.identity, true); result = { ok: true };
			} else if (req.method === "POST" && route === "/logout") { await connection.logout(); result = { ok: true }; }
			else { res.writeHead(404); res.end(JSON.stringify({ error: "凭证服务操作不存在" })); return; }
			if (!result) { res.writeHead(404); res.end(JSON.stringify({ error: "授权会话已过期" })); return; }
			res.end(JSON.stringify(result));
		} catch (error) {
			res.writeHead(400);
			res.end(JSON.stringify({ error: error instanceof SyntaxError ? "请求格式无效" : error instanceof Error ? error.message : "飞书操作失败" }));
		}
	});
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("飞书凭证服务启动失败");
	const url = `http://127.0.0.1:${address.port}`;
	return {
		url, key,
		service: { status: () => connection.status(), begin: () => connection.begin(), authorizationStatus: id => connection.authorizationStatus(id), cancel: id => connection.cancel(id), runtimeEnv: async () => ({ PUDDING_LARK_BROKER_URL: url, PUDDING_LARK_BROKER_KEY: key }) },
		close: async () => { connection.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
	};
}

function validateSettings(input: Record<string, unknown>) {
	if (typeof input.appId !== "string" || (input.appSecret !== undefined && typeof input.appSecret !== "string") || (input.confirmReplace !== undefined && typeof input.confirmReplace !== "boolean")) throw new Error("应用配置格式无效");
	return { appId: input.appId, appSecret: input.appSecret as string | undefined, confirmReplace: input.confirmReplace === true };
}
function validateAuthorization(input: Record<string, unknown>): AuthorizationOptions {
	if ((input.scope !== undefined && typeof input.scope !== "string") || (input.recommend !== undefined && typeof input.recommend !== "boolean")) throw new Error("授权参数格式无效");
	for (const key of ["domains", "exclude"]) if (input[key] !== undefined && (!Array.isArray(input[key]) || (input[key] as unknown[]).some(item => typeof item !== "string") || (input[key] as unknown[]).length > 100)) throw new Error("授权范围格式无效");
	return { scope: input.scope as string | undefined, domains: input.domains as string[] | undefined, exclude: input.exclude as string[] | undefined, recommend: input.recommend === true };
}

/** Explicit, read-only adoption. We never downgrade Keychain or copy its master key
 * to disk. OS denied access is surfaced, not treated as missing authorization. */
export async function readLocalFeishuCredential(options: { home?: string; platform?: NodeJS.Platform; readKey?: () => Promise<Buffer> } = {}): Promise<ConnectionCredential> {
	const home = options.home ?? homedir();
	if ((options.platform ?? process.platform) !== "darwin") throw new Error("本机连接导入当前支持 macOS；其他系统请在设置中配置默认应用");
	try {
		const config = JSON.parse(await readFile(path.join(home, ".lark-cli", "config.json"), "utf8")) as { currentApp?: string; apps?: Array<{ name?: string; appId: string; appSecret: string | { source?: string; id?: string }; users?: Array<{ userOpenId: string; userName?: string }>; brand?: string }> };
		const app = config.currentApp ? config.apps?.find(a => a.appId === config.currentApp || a.name === config.currentApp) : config.apps?.[0];
		if (!app || !/^cli_[a-zA-Z0-9]+$/.test(app.appId) || (app.brand && app.brand !== "feishu")) throw new Error("本机默认飞书应用不存在");
		const dir = path.join(home, "Library", "Application Support", "lark-cli");
		let key: Buffer;
		try { key = await readFile(path.join(dir, "master.key.file")); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (options.readKey) key = await options.readKey();
			else {
				// Captured in memory only; never forwarded to stdout, logs, UI or exceptions.
				const result = await promisify(execFile)("/usr/bin/security", ["find-generic-password", "-s", "lark-cli", "-a", "master.key", "-w"], { timeout: 5000, maxBuffer: 4096 });
				key = Buffer.from(result.stdout.trim(), "base64");
			}
		}
		if (key.length !== 32) throw new Error("本机加密凭证不可读");
		const decrypt = async (account: string) => {
			const blob = await readFile(path.join(dir, account.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc"));
			if (blob.length < 28) throw new Error("本机凭证损坏");
			const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
			decipher.setAuthTag(blob.subarray(-16));
			return Buffer.concat([decipher.update(blob.subarray(12, -16)), decipher.final()]).toString("utf8");
		};
		const secret = typeof app.appSecret === "string" ? app.appSecret : app.appSecret.source === "keychain" && app.appSecret.id === `appsecret:${app.appId}` ? await decrypt(app.appSecret.id) : undefined;
		if (!secret) throw new Error("本机应用密钥引用不受支持");
		const record: ConnectionCredential = { appId: app.appId, appSecret: secret };
		const user = app.users?.[0];
		if (user) {
			try {
				const raw = JSON.parse(await decrypt(`${app.appId}:${user.userOpenId}`)) as { appId: string; accessToken: string; refreshToken?: string; expiresAt: number; refreshExpiresAt?: number; scope: string; tokenType?: string; dpopKeyId?: string };
				if (raw.appId !== app.appId || !raw.accessToken || !Number.isFinite(raw.expiresAt) || typeof raw.scope !== "string") throw new Error("本机用户凭证无效");
				if (raw.tokenType === "DPoP" || raw.dpopKeyId) throw new Error("本机用户凭证绑定了独立签名密钥，无法作为 Bearer 共享；原授权未被修改");
				record.user = { accessToken: raw.accessToken, refreshToken: raw.refreshToken, expiresAt: raw.expiresAt, refreshExpiresAt: raw.refreshExpiresAt, scope: raw.scope, userName: user.userName };
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		return record;
	} catch (error) {
		if (error instanceof Error && /^本机/.test(error.message)) throw error;
		throw new Error("无法读取本机飞书加密凭证，请检查 CLI 配置和系统钥匙串权限；未发起新授权");
	}
}

export function registerFeishuRoutes(app: FastifyInstance, connection: LarkConnection, importLocal = readLocalFeishuCredential) {
	app.get("/api/settings/feishu", async (_req, reply) => { reply.header("Cache-Control", "no-store"); return connection.settings(); });
	app.put<{ Body: Record<string, unknown> }>("/api/settings/feishu", async (req, reply) => {
		reply.header("Cache-Control", "no-store");
		try { return await connection.configure(validateSettings(req.body ?? {})); }
		catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "应用配置失败" }); }
	});
	app.post("/api/settings/feishu/import-local", async (_req, reply) => {
		reply.header("Cache-Control", "no-store");
		try { return await connection.adopt(await importLocal()); }
		catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "本机连接导入失败" }); }
	});
	app.post("/api/settings/feishu/refresh", async (_req, reply) => {
		reply.header("Cache-Control", "no-store");
		try { await connection.accessToken("user"); return await connection.status(); }
		catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : "凭证刷新失败" }); }
	});
}
