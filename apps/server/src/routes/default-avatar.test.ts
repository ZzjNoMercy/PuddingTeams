import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { TeamsStore } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { ExtensionCatalog } from "../agent-runtime/extensions.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { ExtensionRegistry } from "../agent-runtime/extension-registry.js";
import { piConnectorManifest } from "../agent-runtime/pi-extension.js";
import { registerAgentsRoutes } from "./agents.js";
import type { ConnectorExtensionManifest } from "../agent-runtime/extensions.js";

/**
 * §11 头像回退：Agent 未上传头像时，GET /api/agents/:name/avatar 回退到
 * Connector manifest 声明的包内默认头像（manifest.connector.avatar）；
 * 上传优先，删除上传后回到默认。
 */

const SVG_ASSET = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#000"/></svg>';
/** 1x1 PNG（saveAvatar 嗅探需要合法签名）。 */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function avatarConnectorManifest(): ConnectorExtensionManifest {
	return {
		id: "ava-conn",
		publisher: "test",
		displayName: "带头像 Connector",
		version: "1.0.0",
		source: "builtin",
		kind: "connector",
		engines: { puddingteams: ">=1 <2" },
		permissions: ["spawn"],
		connector: {
			id: "ava-conn",
			displayName: "带头像 Connector",
			apiVersion: "1",
			defaultTransport: "spawn",
			supportedTransports: ["spawn"],
			avatar: "avatar.svg",
		},
	};
}

async function makeStack() {
	const dir = freshDir("pt-avatar-");
	const assetsDir = path.join(dir, "pkg-assets");
	mkdirSync(assetsDir, { recursive: true });
	writeFileSync(path.join(assetsDir, "avatar.svg"), SVG_ASSET);

	const credentials = new CredentialsStore(path.join(dir, "sec"));
	await credentials.init();
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
		900_000,
		credentials,
	);
	await teams.init();
	const registry = new ExtensionRegistry(path.join(dir, "teams"), new ExtensionCatalog(), new DriverRegistry());
	registry.registerBuiltin(avatarConnectorManifest(), {}, { assetsDir });
	await registry.init();
	const app = Fastify();
	registerAgentsRoutes(app, teams, { extensions: registry });
	await teams.upsertAgent({
		name: "ava-worker",
		description: "绑定带头像 connector 的 worker",
		enabled: true,
		connector: { extensionId: "ava-conn", connectorId: "ava-conn", transport: "spawn", config: {} },
	});
	return { app, teams };
}

test("§11: 列表装饰——未上传头像且 connector 有默认头像时 hasDefaultAvatar=true", async () => {
	const { app } = await makeStack();
	const res = await app.inject({ method: "GET", url: "/api/agents" });
	const agents = (res.json() as { agents: Array<{ name: string; hasDefaultAvatar?: boolean; avatar?: string }> }).agents;
	const worker = agents.find((a) => a.name === "ava-worker");
	assert.ok(worker, "agent 必须存在");
	assert.equal(worker!.hasDefaultAvatar, true);
	assert.equal(worker!.avatar, undefined, "未上传时 avatar 字段仍为空");
});

test("§11: avatar GET 回退链——包内默认 → 上传优先 → 删除后回到默认", async () => {
	const { app } = await makeStack();

	// 1. 未上传：回退到包内 SVG。
	const def = await app.inject({ method: "GET", url: "/api/agents/ava-worker/avatar" });
	assert.equal(def.statusCode, 200);
	assert.equal(def.headers["content-type"], "image/svg+xml");
	assert.equal(def.body, SVG_ASSET);

	// 2. 上传 PNG 后：上传优先。
	const up = await app.inject({
		method: "POST",
		url: "/api/agents/ava-worker/avatar",
		payload: { data: PNG_B64, mediaType: "image/png" },
	});
	assert.equal(up.statusCode, 200);
	const uploaded = await app.inject({ method: "GET", url: "/api/agents/ava-worker/avatar" });
	assert.equal(uploaded.statusCode, 200);
	assert.equal(uploaded.headers["content-type"], "image/png");

	// 3. 删除上传：回到包内默认。
	const del = await app.inject({ method: "DELETE", url: "/api/agents/ava-worker/avatar" });
	assert.equal(del.statusCode, 204);
	const back = await app.inject({ method: "GET", url: "/api/agents/ava-worker/avatar" });
	assert.equal(back.statusCode, 200);
	assert.equal(back.headers["content-type"], "image/svg+xml");
});

test("§11: 复制有上传头像的 Worker 时，副本响应立即标记 Connector 默认头像", async () => {
	const { app } = await makeStack();
	const up = await app.inject({
		method: "POST",
		url: "/api/agents/ava-worker/avatar",
		payload: { data: PNG_B64, mediaType: "image/png" },
	});
	assert.equal(up.statusCode, 200);

	const duplicate = await app.inject({ method: "POST", url: "/api/agents/ava-worker/duplicate" });
	assert.equal(duplicate.statusCode, 200);
	assert.equal(duplicate.json().agent.avatar, undefined, "上传头像属于源身份，不得复制");
	assert.equal(duplicate.json().agent.hasDefaultAvatar, true, "响应必须足以让当前前端生命周期登记默认头像");

	const avatar = await app.inject({ method: "GET", url: `/api/agents/${duplicate.json().agent.name}/avatar` });
	assert.equal(avatar.statusCode, 200);
	assert.equal(avatar.headers["content-type"], "image/svg+xml");
});

test("§11: 无 connector 默认头像的 agent 仍是 404（前端展示程序化默认）", async () => {
	const { app, teams } = await makeStack();
	await teams.upsertAgent({
		name: "plain-worker",
		description: "x",
		enabled: true,
		invoke: { type: "command", command: "plain-cli", runArgs: [] },
	});
	const res = await app.inject({ method: "GET", url: "/api/agents/plain-worker/avatar" });
	assert.equal(res.statusCode, 404);
	const list = await app.inject({ method: "GET", url: "/api/agents" });
	const plain = (list.json() as { agents: Array<{ name: string; hasDefaultAvatar?: boolean }> }).agents.find(
		(a) => a.name === "plain-worker",
	);
	assert.equal(plain!.hasDefaultAvatar, undefined);
});

test("§11: pinned manager（无 connector 绑定）回退到 pi Connector 的默认头像", async () => {
	const dir = freshDir("pt-avatar-pi-");
	const assetsDir = path.join(dir, "pi-assets");
	mkdirSync(assetsDir, { recursive: true });
	writeFileSync(path.join(assetsDir, "pi.svg"), SVG_ASSET);

	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	const registry = new ExtensionRegistry(path.join(dir, "teams"), new ExtensionCatalog(), new DriverRegistry());
	registry.registerBuiltin(piConnectorManifest, {}, { assetsDir });
	await registry.init();
	const app = Fastify();
	registerAgentsRoutes(app, teams, { extensions: registry });

	// pinned manager 没有 connector 绑定，按 invoke.type === "pi" 归 pi Connector。
	const list = await app.inject({ method: "GET", url: "/api/agents" });
	const manager = (list.json() as { agents: Array<{ name: string; hasDefaultAvatar?: boolean }> }).agents.find(
		(a) => a.name === "manager",
	);
	assert.equal(manager!.hasDefaultAvatar, true);

	const res = await app.inject({ method: "GET", url: "/api/agents/manager/avatar" });
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers["content-type"], "image/svg+xml");
	assert.equal(res.body, SVG_ASSET);
});

test("§11: 首装把发行内置 Designer 头像复制到用户数据目录", async () => {
	const dir = freshDir("pt-avatar-designer-");
	const bundledAssets = path.join(dir, "bundled-assets");
	mkdirSync(bundledAssets, { recursive: true });
	writeFileSync(path.join(bundledAssets, "pi-b.webp"), Buffer.from("RIFFxxxxWEBP", "ascii"));
	const teams = new TeamsStore(
		{
			state: path.join(dir, "state"),
			assets: path.join(dir, "assets"),
			managedWorkspaces: path.join(dir, "managed"),
			bundledAssets,
		},
		dir,
	);
	await teams.init();
	const designer = await teams.getAgent("pi-b");
	assert.equal(designer?.avatar, "pi-b.webp");
	const avatar = await teams.readAvatar("pi-b");
	assert.equal(avatar?.mime, "image/webp");
	assert.equal(avatar?.buf.toString("ascii"), "RIFFxxxxWEBP");
});
