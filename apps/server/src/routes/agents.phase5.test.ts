import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { TeamsStore } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { ExtensionCatalog, EXTENSION_MANIFEST_FILE } from "../agent-runtime/extensions.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { ExtensionRegistry } from "../agent-runtime/extension-registry.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { puddingClawConnectorManifest, puddingClawExtensionHooks } from "../agent-runtime/puddingclaw-extension.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerAgentsRoutes } from "./agents.js";
import { registerExtensionsRoutes } from "./extensions.js";
import type { AgentDriver, AgentEvent, DriverCapabilities } from "../agent-runtime/types.js";
import { ProductSettingsStore } from "../store/product-settings.js";

/**
 * Phase 5 路由测试（§10.1）：Connector/Capability 绑定 API、revision 与
 * affectedSessions 响应、禁用/卸载保护（§9.3.6/8）、pinned manager 双层拒绝。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

interface Stack {
	app: FastifyInstance;
	teams: TeamsStore;
	credentials: CredentialsStore;
	registry: ExtensionRegistry;
	runtime: AgentRuntime;
	delegations: DelegationStore;
	drivers: DriverRegistry;
	settings: ProductSettingsStore;
	sessions: PiSessionStore;
	dir: string;
}

function makeDriver(id: string, onCancel?: () => void): AgentDriver {
	const capabilities: DriverCapabilities = { operations: ["run", "continue", "cancel"], interactionKinds: [], progress: "none", transport: "spawn" };
	return {
		id,
		async capabilities() {
			return capabilities;
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: id, status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async *continue(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: id, status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: id, status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async cancel() {
			onCancel?.();
		},
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const, enabled: true,
				compatibility: "supported" as const, capabilities, issues: [],
			};
		},
	};
}

async function makeStack(): Promise<Stack> {
	const dir = freshDir("pt-p5-routes-");
	const credentials = new CredentialsStore(path.join(dir, "sec"));
	await credentials.init();
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
		900_000,
		credentials,
	);
	await teams.init();
	const catalog = new ExtensionCatalog();
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(path.join(dir, "teams"), catalog, drivers);
	registry.registerBuiltin(puddingClawConnectorManifest, puddingClawExtensionHooks());
	const settings = new ProductSettingsStore(path.join(dir, "teams"));
	await settings.setDeveloperMode(true);
	await registry.init({ developerMode: true });
	const delegations = new DelegationStore(path.join(dir, "rt"));
	await delegations.init();
	const interactionSecrets = new InteractionSecretStore(path.join(dir, "isec"));
	await interactionSecrets.init();
	const runtime = new AgentRuntime(delegations, interactionSecrets, (agentId) => drivers.get(agentId), {
		ttlMs: 24 * 60 * 60 * 1000,
	});
	const invoker = new AgentInvoker(teams, runtime, drivers, credentials, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker, catalog);
	const app = Fastify();
	registerAgentsRoutes(app, teams, { credentials, runtime, invoker, extensions: registry, sessions });
	registerExtensionsRoutes(app, {
		registry,
		teams,
		runtime,
		sessions,
		settings,
		capabilityStateRoot: path.join(dir, "capabilities"),
	});
	return { app, teams, credentials, registry, runtime, delegations, drivers, settings, sessions, dir };
}

/** 写一个可安装的 capability 扩展包目录。 */
function writeCapabilityPackage(dir: string): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, EXTENSION_MANIFEST_FILE),
		JSON.stringify({
			id: "cap-ext",
			publisher: "test",
			displayName: "测试 Capability",
			version: "1.0.0",
			source: "external",
			kind: "capability",
			engines: { puddingteams: ">=0.1 <1" },
			entry: "index.mjs",
			capability: {
				id: "cap-ext",
				displayName: "测试 Capability",
				apiVersion: "1",
				tools: [{ name: "do_thing", activation: "always" }],
			},
		}),
	);
	writeFileSync(
		path.join(dir, "index.mjs"),
		`let installed = false;
		export const extension = {
			manifest: { id: "cap-ext", kind: "capability", name: "cap", version: "1", tools: [{ name: "do_thing", activation: "always" }] },
			register(ctx) {},
			listConnections() { return [{ id: "main", name: "测试系统", state: installed ? "connected" : "unavailable", ...(installed ? { accountName: "测试账号" } : { actions: [{ id: "install", label: "安装依赖" }] }), checkedAt: "2026-08-26T00:00:00.000Z" }]; },
			runConnectionAction(connectionId, actionId) { if (connectionId !== "main" || actionId !== "install") throw new Error("bad action"); installed = true; },
		};`,
	);
	return dir;
}

test("P3-0 API: 关闭开发者模式的持久化窗口会阻塞并发本地安装", async () => {
	const { app, settings, dir } = await makeStack();
	const extensionDir = writeCapabilityPackage(path.join(dir, "race-cap"));
	const originalSet = settings.setDeveloperMode.bind(settings);
	let enteredResolve!: () => void;
	let releaseResolve!: () => void;
	const entered = new Promise<void>((resolve) => {
		enteredResolve = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseResolve = resolve;
	});
	settings.setDeveloperMode = async (enabled: boolean) => {
		if (!enabled) {
			enteredResolve();
			await release;
		}
		return originalSet(enabled);
	};

	const disabling = app.inject({ method: "PUT", url: "/api/extensions/developer-mode", payload: { enabled: false } });
	await entered;
	const installing = app.inject({ method: "POST", url: "/api/extensions/install", payload: { path: extensionDir } });
	releaseResolve();
	const [disabled, installed] = await Promise.all([disabling, installing]);
	assert.equal(disabled.statusCode, 200, disabled.body);
	assert.equal(installed.statusCode, 400, installed.body);
	assert.match(installed.body, /开发者模式/);
	await app.close();
});

test("Phase5: DEFAULT_TEAMS 新结构——pinned manager + PuddingClaw connector binding（决策 20）", async () => {
	const { app } = await makeStack();
	const res = await app.inject({ method: "GET", url: "/api/agents" });
	const { agents } = res.json() as { agents: Array<Record<string, unknown>> };
	const manager = agents.find((a) => a.name === "manager");
	assert.ok(manager, "agents.json 必须含 pinned manager 条目");
	assert.equal(manager!.pinned, true);
	assert.deepEqual(manager!.invoke, { type: "pi" });
	const claw = agents.find((a) => a.name === "puddingclaw");
	assert.ok(claw);
	assert.deepEqual(claw!.connector, {
		extensionId: "puddingclaw",
		connectorId: "puddingclaw",
		transport: "spawn",
		config: { command: "puddingclaw" },
	});
	const httpClaw = agents.find((a) => a.name === "puddingclaw-http");
	assert.ok(httpClaw, "默认目录必须展示禁用的 PuddingClaw HTTP 测试 Worker");
	assert.equal(httpClaw!.enabled, false);
	assert.deepEqual(httpClaw!.connector, {
		extensionId: "puddingclaw",
		connectorId: "puddingclaw",
		transport: "http",
		config: { endpoint: "http://127.0.0.1:8888" },
	});
	await app.close();
});

test("Connector 动态配置选项：宿主转发 Driver 结果，不猜 provider 模型", async () => {
	const { app, drivers } = await makeStack();
	const driver = makeDriver("puddingclaw");
	driver.listConfigOptions = async (field) => field === "model"
		? [{ value: "provider-model", label: "Provider Model", isDefault: true }]
		: [];
	drivers.registerFactory("puddingclaw", () => driver, "puddingclaw");
	const response = await app.inject({
		method: "GET",
		url: "/api/agents/puddingclaw/connector/config-options/model",
	});
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(response.json(), {
		options: [{ value: "provider-model", label: "Provider Model", isDefault: true }],
	});
	await app.close();
});

test("Phase5: pinned manager 双层拒绝——不可删除、不可禁用、保留名与 pi 类型受保护", async () => {
	const { app } = await makeStack();
	// 路由层拒绝删除/禁用。
	let res = await app.inject({ method: "DELETE", url: "/api/agents/manager" });
	assert.equal(res.statusCode, 400);
	res = await app.inject({ method: "PUT", url: "/api/agents/manager/enabled", payload: { enabled: false } });
	assert.equal(res.statusCode, 400);
	// store 层兜底（绕过路由直接 upsert/remove）。
	res = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: { name: "manager", description: "x", invoke: { type: "command", command: "echo", runArgs: [] } },
	});
	assert.equal(res.statusCode, 400, "保留名 manager 不能注册为普通 worker");
	res = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: { name: "other", description: "x", invoke: { type: "pi" } },
	});
	assert.equal(res.statusCode, 400, "pi invoke 仅限保留名 manager");
	await app.close();
});

test("Phase5: manager 可编辑配置——PATCH 合并、非法值拒绝", async () => {
	const { app } = await makeStack();
	const res = await app.inject({
		method: "PATCH",
		url: "/api/agents/manager/manager",
		payload: { description: "新的描述", manager: { thinkingLevel: "high", noExtensions: true }, piResources: { systemPrompt: "你是调度助手" } },
	});
	assert.equal(res.statusCode, 200);
	const body = res.json() as { agent: { description: string; manager: Record<string, unknown>; piResources: Record<string, unknown>; pinned: boolean }; revision: number };
	assert.equal(body.agent.description, "新的描述");
	assert.equal(body.agent.manager.thinkingLevel, "high");
	assert.equal(body.agent.piResources.systemPrompt, "你是调度助手");
	assert.equal(body.agent.manager.noExtensions, true);
	assert.ok(body.revision >= 1);
	// 合并语义：第二次 patch 不清掉之前的键。
	const res2 = await app.inject({ method: "PATCH", url: "/api/agents/manager/manager", payload: { manager: { builtinTools: false } } });
	const body2 = res2.json() as { agent: { manager: Record<string, unknown> } };
	assert.equal(body2.agent.manager.thinkingLevel, "high");
	assert.equal(body2.agent.manager.builtinTools, false);
	// 非法 thinking level 拒绝。
	const bad = await app.inject({ method: "PATCH", url: "/api/agents/manager/manager", payload: { manager: { thinkingLevel: "ultra" } } });
	assert.equal(bad.statusCode, 400);
	// 非 manager 不能走该通道。
	const other = await app.inject({ method: "PATCH", url: "/api/agents/puddingclaw/manager", payload: { manager: {} } });
	assert.equal(other.statusCode, 400);
	await app.close();
});

test("Phase5: PuddingClaw Connector 不接受未声明 secret，revision 与 affectedSessions 响应", async () => {
	const { app, credentials } = await makeStack();
	const rejected = await app.inject({
		method: "PUT",
		url: "/api/agents/puddingclaw/connector",
		payload: {
			extensionId: "puddingclaw",
			connectorId: "puddingclaw",
			transport: "spawn",
			config: { command: "puddingclaw" },
			secrets: { PUDDINGCLAW_TOKEN: "sk-secret-value-123" },
		},
	});
	assert.equal(rejected.statusCode, 400);
	assert.match(rejected.body, /not declared/);

	const res = await app.inject({
		method: "PUT",
		url: "/api/agents/puddingclaw/connector",
		payload: {
			extensionId: "puddingclaw",
			connectorId: "puddingclaw",
			transport: "spawn",
			config: { command: "puddingclaw" },
		},
	});
	assert.equal(res.statusCode, 200);
	const body = res.json() as {
		agent: { connector: { secretRefs?: Record<string, string> }; extensionRevision: number };
		revision: number;
		affectedSessions: { affectedSessions: number; activeNow: number; reloadPending: number };
	};
	assert.equal(body.agent.connector.secretRefs, undefined);
	assert.ok(body.revision >= 1, "写操作必须递增 extensionRevision");
	assert.equal(typeof body.affectedSessions.activeNow, "number");
	assert.equal(typeof body.affectedSessions.reloadPending, "number");
	assert.deepEqual(await credentials.listConfigured("puddingclaw"), []);

	// GET 返回绑定 + contribution manifest。
	const get = await app.inject({ method: "GET", url: "/api/agents/puddingclaw/connector" });
	const got = get.json() as { connector: { connectorId: string }; extension: { kind: string } };
	assert.equal(got.connector.connectorId, "puddingclaw");
	assert.equal(got.extension.kind, "connector");

	// 未安装的 extension 拒绝绑定。
	const bad = await app.inject({
		method: "PUT",
		url: "/api/agents/puddingclaw/connector",
		payload: { extensionId: "nope", connectorId: "nope", config: {} },
	});
	assert.equal(bad.statusCode, 400);
	// pinned manager 不能绑定 Connector。
	const pinned = await app.inject({
		method: "PUT",
		url: "/api/agents/manager/connector",
		payload: { extensionId: "puddingclaw", connectorId: "puddingclaw", config: {} },
	});
	assert.equal(pinned.statusCode, 400);
	await app.close();
});

test("Phase5: Manager 与 Worker 均可配置 Capability；绑定 CRUD + probe + revision 递增", async () => {
	const { app, teams, registry, dir } = await makeStack();
	await teams.upsertAgent({
		name: "alpha",
		description: "alpha worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
		enabled: true,
	});
	// 未安装 extension 直接绑定 → 400。
	const early = await app.inject({
		method: "POST",
		url: "/api/agents/alpha/extensions",
		payload: { extensionId: "cap-ext", capabilityId: "cap-ext" },
	});
	assert.equal(early.statusCode, 400);

	await registry.install(writeCapabilityPackage(path.join(dir, "ext-cap")));
	const managerCreated = await app.inject({
		method: "POST",
		url: "/api/agents/manager/extensions",
		payload: { extensionId: "cap-ext", capabilityId: "cap-ext", config: { owner: "manager" } },
	});
	assert.equal(managerCreated.statusCode, 200, managerCreated.body);
	assert.equal(
		((await teams.getAgent("manager"))!.capabilityExtensions ?? [])[0]?.extensionId,
		"cap-ext",
		"pinned Manager 必须允许独立配置 Capability",
	);
	const rev0 = (await teams.getAgent("alpha"))!.extensionRevision ?? 0;

	const created = await app.inject({
		method: "POST",
		url: "/api/agents/alpha/extensions",
		payload: { extensionId: "cap-ext", capabilityId: "cap-ext", config: { k: 1 }, activation: "searchable" },
	});
	assert.equal(created.statusCode, 200);
	const createdBody = created.json() as { agent: { capabilityExtensions: Array<{ id: string; activation?: string }> }; revision: number };
	const binding = createdBody.agent.capabilityExtensions[0]!;
	assert.ok(binding.id);
	assert.equal(binding.activation, "searchable");
	assert.equal(createdBody.revision, rev0 + 1, "POST 必须递增 revision");

	// 列表。
	const list = await app.inject({ method: "GET", url: "/api/agents/alpha/extensions" });
	assert.equal((list.json() as { bindings: unknown[] }).bindings.length, 1);

	// probe：安装/启用状态 + 命名空间工具清单。
	const probe = await app.inject({ method: "POST", url: `/api/agents/alpha/extensions/${binding.id}/probe` });
	const probeBody = probe.json() as { probe: { extensionInstalled: boolean; enabled: boolean; tools: string[] } };
	assert.equal(probeBody.probe.extensionInstalled, true);
	assert.equal(probeBody.probe.enabled, true);
	assert.deepEqual(probeBody.probe.tools, ["agent_alpha__cap-ext__do_thing"]);

	// PATCH 禁用绑定 → revision 再递增，probe 反映禁用。
	const patched = await app.inject({
		method: "PATCH",
		url: `/api/agents/alpha/extensions/${binding.id}`,
		payload: { enabled: false },
	});
	assert.equal(patched.statusCode, 200);
	assert.equal((patched.json() as { revision: number }).revision, rev0 + 2);
	const probe2 = await app.inject({ method: "POST", url: `/api/agents/alpha/extensions/${binding.id}/probe` });
	assert.equal((probe2.json() as { probe: { enabled: boolean } }).probe.enabled, false);

	// DELETE 移除绑定。
	const del = await app.inject({ method: "DELETE", url: `/api/agents/alpha/extensions/${binding.id}` });
	assert.equal(del.statusCode, 200);
	assert.equal(((await teams.getAgent("alpha"))!.capabilityExtensions ?? []).length, 0);
	// 不存在的 binding → 404。
	const missing = await app.inject({ method: "DELETE", url: "/api/agents/alpha/extensions/nope" });
	assert.equal(missing.statusCode, 404);
	await app.close();
});

test("Phase5: 禁用保护——active/waiting Run 时 409，resolve keep/cancel 语义（§9.3.6）", async () => {
	const { app, teams, delegations, drivers } = await makeStack();
	await teams.upsertAgent({
		name: "alpha",
		description: "alpha worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
		enabled: true,
	});
	let cancelled = 0;
	drivers.register(makeDriver("alpha", () => cancelled++));
	// 制造一个 running delegation。
	const d = await delegations.createDelegation({
		windowId: "w1",
		workspaceId: "workspace-1",
		cwdSnapshot: process.cwd(),
		managerSessionId: "s1",
		agentId: "alpha",
		agentRevision: 0,
		operation: "run",
	});
	await delegations.updateDelegation(d.id, { runHandle: "run-1" });

	// 无 resolve → 409 + Run 清单，Agent 仍启用。
	const conflict = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false } });
	assert.equal(conflict.statusCode, 409);
	const conflictBody = conflict.json() as { runs: Array<{ delegationId: string; status: string }> };
	assert.deepEqual(conflictBody.runs.map((r) => r.delegationId), [d.id]);
	assert.equal((await teams.getAgent("alpha"))!.enabled, true, "409 不得改变启用状态");

	// resolve:"keep" → 禁用成功，Run 保留（不静默杀死）。
	const keep = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false, resolve: "keep" } });
	assert.equal(keep.statusCode, 200);
	assert.equal((await teams.getAgent("alpha"))!.enabled, false);
	assert.equal((await delegations.getDelegation(d.id))!.status, "running", "keep 必须保留 Run");
	assert.equal(cancelled, 0);

	// 重新启用后 resolve:"cancel" → Runtime 取消 Run 再禁用。
	await teams.setEnabled("alpha", true);
	const cancel = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false, resolve: "cancel" } });
	assert.equal(cancel.statusCode, 200);
	assert.equal(cancelled, 1, "cancel 必须走 Runtime 取消");
	assert.equal((await delegations.getDelegation(d.id))!.status, "cancelled");
	await app.close();
});

test("Phase5: 卸载保护——启用 Agent 或 active Run 引用时 409（§9.3.8）", async () => {
	const { app, teams, registry, delegations, dir } = await makeStack();
	await registry.install(writeCapabilityPackage(path.join(dir, "ext-cap")));
	await teams.upsertAgent({
		name: "alpha",
		description: "alpha worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
		enabled: true,
		capabilityExtensions: [{ id: "b1", extensionId: "cap-ext", capabilityId: "cap-ext", enabled: true, config: {} }],
	});

	// 启用 Agent 引用 → 409。
	const conflict = await app.inject({ method: "DELETE", url: "/api/extensions/cap-ext" });
	assert.equal(conflict.statusCode, 409);
	assert.deepEqual((conflict.json() as { agents: string[] }).agents, ["alpha"]);

	// 禁用 Agent 后仍有 running Run（capability 不因 Run 拦截；换 connector 场景验证 Run 拦截）。
	await teams.setEnabled("alpha", false);
	const ok = await app.inject({ method: "DELETE", url: "/api/extensions/cap-ext" });
	assert.equal(ok.statusCode, 204, "禁用后允许卸载，历史绑定保留");

	// connector + active Run → 409。
	const connDir = path.join(dir, "ext-conn");
	mkdirSync(connDir, { recursive: true });
	writeFileSync(
		path.join(connDir, EXTENSION_MANIFEST_FILE),
		JSON.stringify({
			id: "conn-ext", publisher: "test", displayName: "c", version: "1.0.0", source: "external",
			kind: "connector", engines: { puddingteams: ">=0.1" }, permissions: ["spawn"], entry: "index.mjs",
			connector: { id: "conn-ext", displayName: "c", apiVersion: "1", defaultTransport: "spawn", supportedTransports: ["spawn"] },
		}),
	);
	writeFileSync(
		path.join(connDir, "index.mjs"),
		`export function createDriver() { return { id: "conn-ext", async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" }; }, async *run() {}, async *continue() {}, async *respond() {}, async probe() {} }; }`,
	);
	await registry.install(connDir);
	await teams.upsertAgent({
		name: "beta",
		description: "beta worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
		enabled: false,
		connector: { extensionId: "conn-ext", connectorId: "conn-ext", transport: "spawn", config: {} },
	});
	await delegations.createDelegation({ workspaceId: "workspace-1", cwdSnapshot: dir, windowId: "w1", managerSessionId: "s1", agentId: "beta", agentRevision: 0, operation: "run" });
	const connConflict = await app.inject({ method: "DELETE", url: "/api/extensions/conn-ext" });
	assert.equal(connConflict.statusCode, 409, "active Run 引用 connector 时必须 409");
	assert.equal((connConflict.json() as { runs: Array<{ agentId: string }> }).runs[0]!.agentId, "beta");

	// builtin 不可卸载。
	const builtin = await app.inject({ method: "DELETE", url: "/api/extensions/puddingclaw" });
	assert.equal(builtin.statusCode, 400);
	await app.close();
});

test("Phase5: connector_missing 探测——不静默回退（§9.3.8）", async () => {
	const { app, teams } = await makeStack();
	await teams.upsertAgent({
		name: "ghost",
		description: "ghost worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
		enabled: true,
		connector: { extensionId: "uninstalled", connectorId: "uninstalled", transport: "spawn", config: {} },
	});
	const res = await app.inject({ method: "POST", url: "/api/agents/ghost/probe" });
	assert.equal(res.statusCode, 200);
	const { probe } = res.json() as { probe: { extensionInstalled: boolean; issues: Array<{ code: string }> } };
	assert.equal(probe.extensionInstalled, false);
	assert.equal(probe.issues[0]!.code, "connector_missing");
	// pinned manager 无 probe。
	const mp = await app.inject({ method: "POST", url: "/api/agents/manager/probe" });
	assert.equal(mp.statusCode, 400);
	await app.close();
});

test("Phase5: catalog 必须 kind 过滤且两类不混（§10.1）", async () => {
	const { app } = await makeStack();
	const bad = await app.inject({ method: "GET", url: "/api/extensions/catalog?kind=both" });
	assert.equal(bad.statusCode, 400);
	const connectors = await app.inject({ method: "GET", url: "/api/extensions/catalog?kind=connector" });
	const connBody = connectors.json() as { extensions: Array<{ manifest: { kind: string; id: string }; origin: string }> };
	assert.ok(connBody.extensions.length >= 1);
	assert.ok(connBody.extensions.every((e) => e.manifest.kind === "connector"));
	assert.equal(connBody.extensions[0]!.origin, "builtin");
	const capabilities = await app.inject({ method: "GET", url: "/api/extensions/catalog?kind=capability" });
	assert.equal((capabilities.json() as { extensions: unknown[] }).extensions.length, 0, "预装零个用户 Capability（§10.4）");
	await app.close();
});

test("Extension 连接状态 API 聚合只读投影，显式动作与探测解耦", async () => {
	const { app, registry, dir } = await makeStack();
	await registry.installOrUpdateFromDir(writeCapabilityPackage(path.join(dir, "connection-cap")));
	const response = await app.inject({ method: "GET", url: "/api/extensions/connections" });
	assert.equal(response.statusCode, 200, response.body);
	const body = response.json() as { connections: Array<{ id: string; connectionId: string; extensionId: string; state: string; actions?: Array<{ id: string }> }> };
	assert.equal(body.connections[0]?.id, "cap-ext:main");
	assert.equal(body.connections[0]?.connectionId, "main");
	assert.equal(body.connections[0]?.state, "unavailable");
	assert.equal(body.connections[0]?.actions?.[0]?.id, "install");
	const action = await app.inject({ method: "POST", url: "/api/extensions/cap-ext/connections/main/actions/install" });
	assert.equal(action.statusCode, 200, action.body);
	assert.equal((action.json() as { connection: { state: string; accountName?: string } }).connection.state, "connected");
	assert.equal((action.json() as { connection: { state: string; accountName?: string } }).connection.accountName, "测试账号");
	await app.close();
});

test("P4 API: install mode=copy 安装 user 包；三态冲突 409；bundled 不可卸载、user 可卸载", async () => {
	const { app, registry, dir } = await makeStack();
	// bundled 预置 cap-ext → 同 id user 安装 409，不静默覆盖。
	await registry.installOrUpdateFromDir(writeCapabilityPackage(path.join(dir, "bundled-cap")));
	const conflict = await app.inject({
		method: "POST",
		url: "/api/extensions/install",
		payload: { path: writeCapabilityPackage(path.join(dir, "user-cap-same")), mode: "copy" },
	});
	assert.equal(conflict.statusCode, 409, conflict.body);
	assert.match(conflict.body, /互不覆盖/);
	// local-link 与 bundled 同 id 同样 409。
	const linkConflict = await app.inject({
		method: "POST",
		url: "/api/extensions/install",
		payload: { path: writeCapabilityPackage(path.join(dir, "link-cap-same")) },
	});
	assert.equal(linkConflict.statusCode, 409, linkConflict.body);

	// 不同 id 的 user 安装成功。
	const userDir = path.join(dir, "user-cap-pkg");
	mkdirSync(userDir, { recursive: true });
	writeFileSync(
		path.join(userDir, EXTENSION_MANIFEST_FILE),
		JSON.stringify({
			id: "user-cap", publisher: "test", displayName: "用户 Capability", version: "1.0.0", source: "external",
			kind: "capability", engines: { puddingteams: ">=0.1 <1" }, entry: "index.mjs",
			capability: { id: "user-cap", displayName: "用户 Capability", apiVersion: "1", tools: [{ name: "do_thing", activation: "always" }] },
		}),
	);
	writeFileSync(
		path.join(userDir, "index.mjs"),
		`export const extension = {
			manifest: { id: "user-cap", kind: "capability", name: "user cap", version: "1", tools: [{ name: "do_thing", activation: "always" }] },
			register(ctx) {},
		};`,
	);
	const ok = await app.inject({ method: "POST", url: "/api/extensions/install", payload: { path: userDir, mode: "copy" } });
	assert.equal(ok.statusCode, 200, ok.body);
	assert.equal((ok.json() as { extension: { origin: string } }).extension.origin, "user");

	// 重复安装 → 409；mode 非法 → 400。
	const dup = await app.inject({ method: "POST", url: "/api/extensions/install", payload: { path: userDir, mode: "copy" } });
	assert.equal(dup.statusCode, 409, dup.body);
	const badMode = await app.inject({ method: "POST", url: "/api/extensions/install", payload: { path: userDir, mode: "sideload" } });
	assert.equal(badMode.statusCode, 400);

	// bundled 不可卸载（400）；user 无绑定可卸载（204）。
	const delBundled = await app.inject({ method: "DELETE", url: "/api/extensions/cap-ext" });
	assert.equal(delBundled.statusCode, 400, delBundled.body);
	const del = await app.inject({ method: "DELETE", url: "/api/extensions/user-cap" });
	assert.equal(del.statusCode, 204, del.body);
	await app.close();
});
