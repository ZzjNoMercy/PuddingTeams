import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
import { McpServerStore } from "../store/mcp-servers.js";
import { ExtensionMutationJournal } from "../store/extension-mutation-journal.js";

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
	mcpServers: McpServerStore;
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

async function makeStack(clawFixture = true): Promise<Stack> {
	const dir = freshDir("pt-p5-routes-");
	const credentials = new CredentialsStore(path.join(dir, "sec"));
	await credentials.init();
	const mcpCredentials = new CredentialsStore(path.join(dir, "mcp-sec"));
	await mcpCredentials.init();
	const mcpServers = new McpServerStore(path.join(dir, "config"), mcpCredentials);
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
		900_000,
		credentials,
	);
	await teams.init();
	if (clawFixture) await teams.upsertAgent({ name: "puddingclaw", description: "", connector: { extensionId: "puddingclaw", connectorId: "puddingclaw", transport: "spawn", config: { command: "puddingclaw" } }, enabled: true, extensionRevision: 1 });
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
	registerAgentsRoutes(app, teams, { credentials, runtime, invoker, extensions: registry, sessions, mcpServers });
	registerExtensionsRoutes(app, {
		registry,
		teams,
		runtime,
		sessions,
		settings,
		mcpServers,
		mutationJournal: new ExtensionMutationJournal(path.join(dir, "teams", "extension-mutation-pending.json")),
		mcpMutationJournal: new ExtensionMutationJournal(path.join(dir, "teams", "mcp-mutation-pending.json"), "MCP"),
		capabilityStateRoot: path.join(dir, "capabilities"),
	});
	return { app, teams, credentials, mcpServers, registry, runtime, delegations, drivers, settings, sessions, dir };
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
			engines: { puddingteams: ">=1 <2" },
			entry: "index.mjs",
			capability: {
				id: "cap-ext",
				displayName: "测试 Capability",
				apiVersion: "1",
				secretSchema: [{ key: "CAP_TOKEN", label: "Capability Token", required: false }],
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
	const { app, settings, teams, dir } = await makeStack();
	const beforeRevision = (await teams.getAgent("manager"))?.extensionRevision;
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
	assert.equal((await teams.getAgent("manager"))?.extensionRevision, beforeRevision, "拒绝的安装不得改写无关 Agent 修订号");
	await app.close();
});

test("Phase5: DEFAULT_TEAMS 新结构——pinned manager + Wiki + 三个发行内置 Worker", async () => {
	const { app } = await makeStack(false);
	const res = await app.inject({ method: "GET", url: "/api/agents" });
	const { agents } = res.json() as { agents: Array<Record<string, unknown>> };
	const manager = agents.find((a) => a.name === "manager");
	assert.ok(manager, "agents.json 必须含 pinned manager 条目");
	assert.equal(manager!.pinned, true);
	assert.deepEqual(manager!.invoke, { type: "pi" });
	const designer = agents.find((a) => a.name === "pi-b");
	assert.deepEqual(designer, {
		name: "pi-b",
		displayName: "Designer",
		description: "负责UI/UX设计和PPT制作",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		enabled: true,
		extensionRevision: 1,
	});
	const claude = agents.find((a) => a.name === "claude-code");
	assert.deepEqual(claude, {
		name: "claude-code",
		description: "Anthropic Claude Code CLI worker（spawn + stream-json 流式）",
		connector: { extensionId: "claude-code", connectorId: "claude-code", transport: "spawn", config: {} },
		enabled: true,
		extensionRevision: 1,
	});
	const codex = agents.find((a) => a.name === "codex");
	assert.deepEqual(codex, {
		name: "codex",
		description: "OpenAI Codex CLI worker（spawn + JSONL 流式）",
		connector: { extensionId: "codex", connectorId: "codex", transport: "spawn", config: {} },
		enabled: true,
		extensionRevision: 1,
	});
	assert.ok(!agents.some((a) => a.name === "puddingclaw" || a.name === "puddingclaw-http"));
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

test("Connector 配置在读取密钥途中变更时不把旧绑定与新密钥交给 Driver", async () => {
	const { app, credentials, drivers, teams } = await makeStack();
	try {
		let driverCalled = false;
		const driver = makeDriver("puddingclaw");
		driver.listConfigOptions = async () => { driverCalled = true; return []; };
		drivers.registerFactory("puddingclaw", () => driver, "puddingclaw");
		const original = credentials.getSecrets.bind(credentials);
		let changed = false;
		credentials.getSecrets = async (name) => {
			const secrets = await original(name);
			if (!changed) {
				changed = true;
				const agent = (await teams.getAgent(name))!;
				await teams.setConnectorBinding(name, { ...agent.connector!, config: { changed: true } });
			}
			return secrets;
		};
		const response = await app.inject({ method: "GET", url: "/api/agents/puddingclaw/connector/config-options/model" });
		assert.equal(response.statusCode, 502, response.body);
		assert.match(response.body, /configuration changed during credential read/);
		assert.equal(driverCalled, false);
	} finally { await app.close(); }
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
	const { app, teams } = await makeStack();
	const res = await app.inject({
		method: "PATCH",
		url: "/api/agents/manager/manager",
		payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision, description: "新的描述", manager: { thinkingLevel: "high", noExtensions: true }, piResources: { systemPrompt: "你是调度助手" } },
	});
	assert.equal(res.statusCode, 200);
	const body = res.json() as { agent: { description: string; manager: Record<string, unknown>; piResources: Record<string, unknown>; pinned: boolean }; revision: number };
	assert.equal(body.agent.description, "新的描述");
	assert.equal(body.agent.manager.thinkingLevel, "high");
	assert.equal(body.agent.piResources.systemPrompt, "你是调度助手");
	assert.equal(body.agent.manager.noExtensions, true);
	assert.ok(body.revision >= 1);
	// 合并语义：第二次 patch 不清掉之前的键。
	const res2 = await app.inject({ method: "PATCH", url: "/api/agents/manager/manager", payload: { expectedRevision: body.revision, manager: { builtinTools: false } } });
	const body2 = res2.json() as { agent: { manager: Record<string, unknown> } };
	assert.equal(body2.agent.manager.thinkingLevel, "high");
	assert.equal(body2.agent.manager.builtinTools, false);
	// 非法 thinking level 拒绝。
	const bad = await app.inject({ method: "PATCH", url: "/api/agents/manager/manager", payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision, manager: { thinkingLevel: "ultra" } } });
	assert.equal(bad.statusCode, 400);
	// 非 manager 不能走该通道。
	const other = await app.inject({ method: "PATCH", url: "/api/agents/puddingclaw/manager", payload: { manager: {} } });
	assert.equal(other.statusCode, 400);
	await app.close();
});

test("Connector 旧版提交不得覆盖新绑定或凭据引用", async () => {
	const { app, teams, credentials, registry } = await makeStack();
	registry.registerBuiltin({
		...puddingClawConnectorManifest,
		id: "revision-fixture",
		connector: { ...puddingClawConnectorManifest.connector, id: "revision-fixture", secretSchema: [{ key: "TEST_TOKEN", label: "Token", required: false }] },
	});
	const original = await teams.getAgent("puddingclaw");
	assert.ok(original);
	const input = {
		extensionId: "revision-fixture", connectorId: "revision-fixture", transport: "spawn",
		config: { command: "new" }, secrets: { TEST_TOKEN: "new-secret" },
	};
	const current = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...input, expectedRevision: original.extensionRevision } });
	assert.equal(current.statusCode, 200, current.body);
	const stale = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...input, expectedRevision: original.extensionRevision, config: { command: "old" }, secrets: { TEST_TOKEN: "old-secret" } } });
	assert.equal(stale.statusCode, 409, stale.body);
	assert.deepEqual((await teams.getAgent("puddingclaw"))?.connector?.config, { command: "new" });
	assert.deepEqual((await teams.getAgent("puddingclaw"))?.connector?.secretRefs, { TEST_TOKEN: "TEST_TOKEN" });
	assert.deepEqual(await credentials.getSecrets("puddingclaw"), { TEST_TOKEN: "new-secret" });
	const missing = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: input });
	assert.equal(missing.statusCode, 400, missing.body);
	await app.close();
});

test("Phase5: PuddingClaw Connector 不接受未声明 secret，revision 与 affectedSessions 响应", async () => {
	const { app, credentials, teams } = await makeStack();
	const rejected = await app.inject({
		method: "PUT",
		url: "/api/agents/puddingclaw/connector",
		payload: {
			expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision,
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
			expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision,
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
		payload: { expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision, extensionId: "nope", connectorId: "nope", config: {} },
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

test("创建停用 Worker 后写入 Connector 凭证、启用并跨重启回读", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	registry.registerBuiltin({
		...puddingClawConnectorManifest,
		id: "secret-fixture",
		connector: {
			...puddingClawConnectorManifest.connector,
			id: "secret-fixture",
			secretSchema: [{ key: "TEST_TOKEN", label: "Test Token", required: true }],
		},
	});
	const secret = "secret-only-in-credential-store-123";
	const prematureCreate = await app.inject({
		method: "POST", url: "/api/agents",
		payload: {
			name: "secret-worker", displayName: "Secret Worker", enabled: true,
			connector: { extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {} },
		},
	});
	assert.equal(prematureCreate.statusCode, 400, prematureCreate.body);
	assert.equal(await teams.getAgent("secret-worker"), undefined);
	const created = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: {
			name: "secret-worker",
			displayName: "Secret Worker",
			enabled: false,
			connector: { extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {} },
		},
	});
	assert.equal(created.statusCode, 200, created.body);
	assert.equal(created.json().agent.enabled, false);
	assert.equal(created.json().agent.connector.secretRefs, undefined);
	const prematureEnable = await app.inject({ method: "PUT", url: "/api/agents/secret-worker/enabled", payload: { enabled: true, expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision } });
	assert.equal(prematureEnable.statusCode, 400, prematureEnable.body);
	const rejected = await app.inject({
		method: "PUT",
		url: "/api/agents/secret-worker/connector",
		payload: {
			expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision,
			extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {},
			secrets: { UNDECLARED_TOKEN: secret },
		},
	});
	assert.equal(rejected.statusCode, 400, rejected.body);
	assert.equal((await credentials.listConfigured("secret-worker")).length, 0);
	assert.equal((await teams.getAgent("secret-worker"))?.enabled, false);

	const configured = await app.inject({
		method: "PUT",
		url: "/api/agents/secret-worker/connector",
		payload: {
			expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision,
			extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {},
			secrets: { TEST_TOKEN: secret },
		},
	});
	assert.equal(configured.statusCode, 200, configured.body);
	assert.equal(configured.json().agent.enabled, false);
	assert.deepEqual(configured.json().agent.connector.secretRefs, { TEST_TOKEN: "TEST_TOKEN" });
	assert.equal(configured.body.includes(secret), false);
	assert.deepEqual(await credentials.getSecrets("secret-worker"), { TEST_TOKEN: secret });
	const cleared = await app.inject({
		method: "PUT", url: "/api/agents/secret-worker/connector",
		payload: {
			expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision,
			extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {},
			secrets: { TEST_TOKEN: "" },
		},
	});
	assert.equal(cleared.statusCode, 200, cleared.body);
	assert.equal(cleared.json().agent.connector.secretRefs, undefined);
	assert.deepEqual(await credentials.getSecrets("secret-worker"), {});
	const enableWithoutSecret = await app.inject({ method: "PUT", url: "/api/agents/secret-worker/enabled", payload: { enabled: true, expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision } });
	assert.equal(enableWithoutSecret.statusCode, 400, enableWithoutSecret.body);
	const restoredSecret = await app.inject({
		method: "PUT", url: "/api/agents/secret-worker/connector",
		payload: {
			expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision,
			extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {},
			secrets: { TEST_TOKEN: secret },
		},
	});
	assert.equal(restoredSecret.statusCode, 200, restoredSecret.body);

	const enabled = await app.inject({ method: "PUT", url: "/api/agents/secret-worker/enabled", payload: { enabled: true, expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision } });
	assert.equal(enabled.statusCode, 200, enabled.body);
	assert.equal(enabled.json().agent.enabled, true);
	const removeWhileEnabled = await app.inject({
		method: "PUT", url: "/api/agents/secret-worker/connector",
		payload: { expectedRevision: (await teams.getAgent("secret-worker"))?.extensionRevision, extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {}, secrets: { TEST_TOKEN: "" } },
	});
	assert.equal(removeWhileEnabled.statusCode, 400, removeWhileEnabled.body);
	assert.deepEqual(await credentials.getSecrets("secret-worker"), { TEST_TOKEN: secret });
	const replaceWithoutRefs = await app.inject({
		method: "PUT", url: "/api/agents/secret-worker",
		payload: {
			name: "secret-worker", displayName: "Secret Worker", description: "secret worker", enabled: true,
			connector: { extensionId: "secret-fixture", connectorId: "secret-fixture", transport: "spawn", config: {} },
		},
	});
	assert.equal(replaceWithoutRefs.statusCode, 400, replaceWithoutRefs.body);
	assert.deepEqual((await teams.getAgent("secret-worker"))?.connector?.secretRefs, { TEST_TOKEN: "TEST_TOKEN" });
	assert.equal(readFileSync(path.join(dir, "teams", "agents.json"), "utf8").includes(secret), false);
	assert.equal(readFileSync(path.join(dir, "sec", "credentials.json"), "utf8").includes(secret), false);
	await app.close();

	const restartedCredentials = new CredentialsStore(path.join(dir, "sec"));
	await restartedCredentials.init();
	const restartedTeams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
		900_000,
		restartedCredentials,
	);
	await restartedTeams.init();
	const restored = await restartedTeams.getAgent("secret-worker");
	assert.equal(restored?.enabled, true);
	assert.deepEqual(restored?.connector?.secretRefs, { TEST_TOKEN: "TEST_TOKEN" });
	assert.deepEqual(await restartedCredentials.getSecrets("secret-worker"), { TEST_TOKEN: secret });
});

test("更换 Connector 密钥 schema 时写入失败不先删旧密钥", async () => {
	const { app, registry, credentials, teams } = await makeStack();
	try {
		for (const [id, keys] of [["secret-old", ["OLD_ONE", "OLD_TWO"]], ["secret-new", ["NEW_TOKEN"]]] as const) {
			registry.registerBuiltin({
				...puddingClawConnectorManifest,
				id,
				connector: { ...puddingClawConnectorManifest.connector, id, secretSchema: keys.map((key) => ({ key, label: key, required: false })) },
			});
		}
		const oldBinding = { extensionId: "secret-old", connectorId: "secret-old", transport: "spawn", config: {} };
		const newBinding = { extensionId: "secret-new", connectorId: "secret-new", transport: "spawn", config: {} };
		const configured = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...oldBinding, expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision, secrets: { OLD_ONE: "first", OLD_TWO: "second" } } });
		assert.equal(configured.statusCode, 200, configured.body);
		const storage = credentials as unknown as { writeFile: (data: unknown) => Promise<void> };
		const originalWriteFile = storage.writeFile.bind(credentials);
		let failOnce = true;
		storage.writeFile = async (data) => {
			if (failOnce) { failOnce = false; throw new Error("injected credentials write failure"); }
			await originalWriteFile(data);
		};
		try {
			const failed = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...newBinding, expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision, secrets: { NEW_TOKEN: "third" } } });
			assert.equal(failed.statusCode, 400, failed.body);
		} finally {
			storage.writeFile = originalWriteFile;
		}
		assert.deepEqual(await credentials.getSecrets("puddingclaw"), { OLD_ONE: "first", OLD_TWO: "second" });
		assert.equal((await teams.getAgent("puddingclaw"))?.connector?.connectorId, "secret-old");
		const switched = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...newBinding, expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision, secrets: { NEW_TOKEN: "third" } } });
		assert.equal(switched.statusCode, 200, switched.body);
		assert.deepEqual(await credentials.getSecrets("puddingclaw"), { NEW_TOKEN: "third" });
		assert.deepEqual((await teams.getAgent("puddingclaw"))?.connector?.secretRefs, { NEW_TOKEN: "NEW_TOKEN" });
	} finally {
		await app.close();
	}
});

test("更换同名 key 的 Connector 不继承旧凭据，只接受本次显式提供的新值", async () => {
	const { app, registry, credentials, teams } = await makeStack();
	try {
		for (const id of ["same-key-old", "same-key-new"]) {
			registry.registerBuiltin({
				...puddingClawConnectorManifest,
				id,
				connector: { ...puddingClawConnectorManifest.connector, id, secretSchema: [{ key: "SHARED_NAME", label: "Token", required: false }] },
			});
		}
		const binding = (id: string) => ({ extensionId: id, connectorId: id, transport: "spawn", config: {} });
		const old = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...binding("same-key-old"), expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision, secrets: { SHARED_NAME: "old-secret" } } });
		assert.equal(old.statusCode, 200, old.body);
		const switched = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...binding("same-key-new"), expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision } });
		assert.equal(switched.statusCode, 200, switched.body);
		assert.deepEqual((await teams.getAgent("puddingclaw"))?.connector?.secretRefs ?? {}, {});
		assert.deepEqual(await credentials.getSecrets("puddingclaw"), {});
		const explicit = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...binding("same-key-old"), expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision, secrets: { SHARED_NAME: "new-secret" } } });
		assert.equal(explicit.statusCode, 200, explicit.body);
		assert.deepEqual((await teams.getAgent("puddingclaw"))?.connector?.secretRefs, { SHARED_NAME: "SHARED_NAME" });
		assert.deepEqual(await credentials.getSecrets("puddingclaw"), { SHARED_NAME: "new-secret" });
	} finally { await app.close(); }
});

test("Registry 写入失败时恢复原密文，不留下待恢复事务", async () => {
	const { app, credentials, teams, dir } = await makeStack();
	try {
		await credentials.setSecrets("puddingclaw", { PUDDINGCLAW_TOKEN: "old-value" });
		const before = await teams.getAgent("puddingclaw");
		const original = teams.setConnectorBinding.bind(teams);
		teams.setConnectorBinding = async () => { throw new Error("injected registry write failure"); };
		try {
			const response = await app.inject({
				method: "PUT", url: "/api/agents/puddingclaw/connector",
				payload: {
					expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision,
					extensionId: "puddingclaw", connectorId: "puddingclaw", transport: "spawn", config: {},
					secrets: { PUDDINGCLAW_TOKEN: "new-value" },
				},
			});
			assert.equal(response.statusCode, 400, response.body);
		} finally { teams.setConnectorBinding = original; }
		assert.deepEqual(await credentials.getSecrets("puddingclaw"), { PUDDINGCLAW_TOKEN: "old-value" });
		assert.deepEqual((await teams.getAgent("puddingclaw"))?.connector, before?.connector);
		assert.equal(readFileSync(path.join(dir, "sec", "credentials.json"), "utf8").includes("new-value"), false);
		assert.equal(existsSync(path.join(dir, "sec", "binding-transaction.json")), false);
	} finally { await app.close(); }
});

test("凭据与事务记录 rename 失败时清理已 fsync 的临时文件", async () => {
	for (const target of ["credentials.json", "binding-transaction.json"]) {
		const dir = freshDir("puddingteams-secret-temp-");
		const secretDir = path.join(dir, "sec");
		const credentials = new CredentialsStore(secretDir);
		await credentials.init();
		mkdirSync(path.join(secretDir, target));
		const storage = credentials as unknown as {
			writeFile: (data: unknown) => Promise<void>;
			writeBindingTransaction: (record: unknown) => Promise<void>;
		};
		if (target === "credentials.json") {
			await assert.rejects(storage.writeFile({ version: 1, agents: {} }));
		} else {
			await assert.rejects(storage.writeBindingTransaction({
				version: 1, id: "rename-failure", agentName: "manager",
				before: { version: 1, agents: {} }, after: { version: 1, agents: {} },
			}));
		}
		assert.deepEqual(readdirSync(secretDir).filter((entry) => entry.endsWith(".tmp")), []);
		assert.equal(statSync(path.join(secretDir, target)).isDirectory(), true);
	}
});

test("冷启动按 Registry 同文件提交标记恢复跨文件密文事务", async () => {
	for (const committed of [false, true]) {
		const { app, credentials, teams, dir } = await makeStack();
		try {
			const agentName = "puddingclaw";
			const credentialsPath = path.join(dir, "sec", "credentials.json");
			const journalPath = path.join(dir, "sec", "binding-transaction.json");
			await credentials.setSecrets(agentName, { PUDDINGCLAW_TOKEN: "old-value" });
			const before = JSON.parse(readFileSync(credentialsPath, "utf8"));
			await credentials.setSecrets(agentName, { PUDDINGCLAW_TOKEN: "new-value" });
			const after = JSON.parse(readFileSync(credentialsPath, "utf8"));
			const id = `recovery-${committed ? "committed" : "uncommitted"}`;
			writeFileSync(journalPath, JSON.stringify({ version: 1, id, agentName, before, after }), { mode: 0o600 });
			if (committed) {
				const agent = (await teams.getAgent(agentName))!;
				await teams.setConnectorBinding(agentName, {
					...(agent.connector ?? { extensionId: "puddingclaw", connectorId: "puddingclaw", transport: "spawn" }),
					config: {}, secretRefs: { PUDDINGCLAW_TOKEN: "PUDDINGCLAW_TOKEN" },
				}, { expectedRevision: agent.extensionRevision ?? 0, id });
				writeFileSync(credentialsPath, JSON.stringify(before));
			}
			const restartedCredentials = new CredentialsStore(path.join(dir, "sec"));
			await restartedCredentials.init();
			const restartedTeams = new TeamsStore(
				{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
				dir, 900_000, restartedCredentials,
			);
			await restartedTeams.init();
			assert.deepEqual(await restartedCredentials.getSecrets(agentName), {
				PUDDINGCLAW_TOKEN: committed ? "new-value" : "old-value",
			});
			assert.equal(existsSync(journalPath), false);
			assert.equal(readFileSync(credentialsPath, "utf8").includes("new-value"), false);
			assert.equal(readFileSync(path.join(dir, "teams", "agents.json"), "utf8").includes("new-value"), false);
		} finally { await app.close(); }
	}
});

test("Registry 已提交但事务记录清理失败时返回部分结果并在重启后前滚", async () => {
	const { app, credentials, teams, registry, dir } = await makeStack();
	try {
		registry.registerBuiltin({
			...puddingClawConnectorManifest,
			id: "cleanup-fixture",
			connector: {
				...puddingClawConnectorManifest.connector,
				id: "cleanup-fixture",
				secretSchema: [{ key: "CLEANUP_TOKEN", label: "Cleanup Token", required: false }],
			},
		});
		const storage = credentials as unknown as { clearBindingTransaction: () => Promise<void> };
		const original = storage.clearBindingTransaction.bind(credentials);
		storage.clearBindingTransaction = async () => { throw new Error("injected journal cleanup failure"); };
		let response;
		try {
			response = await app.inject({
				method: "PUT", url: "/api/agents/puddingclaw/connector",
				payload: {
					expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision,
					extensionId: "cleanup-fixture", connectorId: "cleanup-fixture", transport: "spawn", config: {},
					secrets: { CLEANUP_TOKEN: "committed-value" },
				},
			});
		} finally { storage.clearBindingTransaction = original; }
		assert.equal(response.statusCode, 202, response.body);
		assert.equal(response.json().credentialsCleanup, "pending");
		assert.equal((await teams.getAgent("puddingclaw"))?.connector?.secretRefs?.CLEANUP_TOKEN, "CLEANUP_TOKEN");
		assert.ok(existsSync(path.join(dir, "sec", "binding-transaction.json")));
		await assert.rejects(credentials.getSecrets("puddingclaw"), /requires startup recovery/);
		const blocked = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/config", payload: { description: "must-wait" } });
		assert.equal(blocked.statusCode, 503, blocked.body);
		assert.notEqual((await teams.getAgent("puddingclaw"))?.description, "must-wait");
		const restartedCredentials = new CredentialsStore(path.join(dir, "sec"));
		await restartedCredentials.init();
		const restartedTeams = new TeamsStore(
			{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
			dir, 900_000, restartedCredentials,
		);
		await restartedTeams.init();
		assert.deepEqual(await restartedCredentials.getSecrets("puddingclaw"), { CLEANUP_TOKEN: "committed-value" });
		assert.equal(existsSync(path.join(dir, "sec", "binding-transaction.json")), false);
	} finally { await app.close(); }
});

test("Registry 提交后响应边界抛错时回读并报告已提交", async () => {
	const { app, credentials, teams, registry, dir } = await makeStack();
	try {
		registry.registerBuiltin({
			...puddingClawConnectorManifest,
			id: "response-fixture",
			connector: {
				...puddingClawConnectorManifest.connector,
				id: "response-fixture",
				secretSchema: [{ key: "RESPONSE_TOKEN", label: "Response Token", required: false }],
			},
		});
		const original = teams.setConnectorBinding.bind(teams);
		teams.setConnectorBinding = async (...args) => {
			await original(...args);
			throw new Error("injected response loss after registry commit");
		};
		let response;
		try {
			response = await app.inject({
				method: "PUT", url: "/api/agents/puddingclaw/connector",
				payload: {
					expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision,
					extensionId: "response-fixture", connectorId: "response-fixture", transport: "spawn", config: {},
					secrets: { RESPONSE_TOKEN: "committed-value" },
				},
			});
		} finally { teams.setConnectorBinding = original; }
		assert.equal(response.statusCode, 202, response.body);
		assert.equal(response.json().commitState, "committed_readback");
		assert.equal(response.json().agent.connector.connectorId, "response-fixture");
		assert.deepEqual(await credentials.getSecrets("puddingclaw"), { RESPONSE_TOKEN: "committed-value" });
		assert.equal(existsSync(path.join(dir, "sec", "binding-transaction.json")), false);
	} finally { await app.close(); }
});

test("回滚写入也失败时封锁当前进程并在冷启动恢复旧密文", async () => {
	const { app, credentials, teams, registry, dir } = await makeStack();
	try {
		registry.registerBuiltin({
			...puddingClawConnectorManifest,
			id: "rollback-fixture",
			connector: {
				...puddingClawConnectorManifest.connector,
				id: "rollback-fixture",
				secretSchema: [{ key: "ROLLBACK_TOKEN", label: "Rollback Token", required: false }],
			},
		});
		await credentials.setSecrets("puddingclaw", { ROLLBACK_TOKEN: "old-value" });
		const storage = credentials as unknown as { writeFile: (data: unknown) => Promise<void> };
		const original = storage.writeFile.bind(credentials);
		storage.writeFile = async () => { throw new Error("injected persistent credential write failure"); };
		try {
			const response = await app.inject({
				method: "PUT", url: "/api/agents/puddingclaw/connector",
				payload: {
					expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision,
					extensionId: "rollback-fixture", connectorId: "rollback-fixture", transport: "spawn", config: {},
					secrets: { ROLLBACK_TOKEN: "new-value" },
				},
			});
			assert.equal(response.statusCode, 503, response.body);
			assert.match(response.body, /requires startup recovery/);
		} finally { storage.writeFile = original; }
		assert.ok(existsSync(path.join(dir, "sec", "binding-transaction.json")));
		await assert.rejects(credentials.getSecrets("puddingclaw"), /requires startup recovery/);
		const restartedCredentials = new CredentialsStore(path.join(dir, "sec"));
		await restartedCredentials.init();
		const restartedTeams = new TeamsStore(
			{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
			dir, 900_000, restartedCredentials,
		);
		await restartedTeams.init();
		assert.deepEqual(await restartedCredentials.getSecrets("puddingclaw"), { ROLLBACK_TOKEN: "old-value" });
		assert.equal((await restartedTeams.getAgent("puddingclaw"))?.connector?.connectorId, "puddingclaw");
		assert.equal(existsSync(path.join(dir, "sec", "binding-transaction.json")), false);
	} finally { await app.close(); }
});

test("同 Agent 绑定写入期间通用密钥删除等待新引用落盘后再校验", async () => {
	const { app, credentials, registry, teams, dir } = await makeStack();
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "gate-cap")));
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const original = credentials.transactBinding.bind(credentials);
		credentials.transactBinding = async (...args) => {
			entered();
			await gate;
			return original(...args);
		};
		try {
			const add = app.inject({
				method: "POST", url: "/api/agents/manager/extensions",
				payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "new-value" } },
			});
			await started;
			const remove = app.inject({ method: "DELETE", url: "/api/agents/manager/secrets/CAP_TOKEN" });
			release();
			const [added, rejected] = await Promise.all([add, remove]);
			assert.equal(added.statusCode, 200, added.body);
			assert.equal(rejected.statusCode, 409, rejected.body);
			assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "new-value" });
		} finally {
			release();
			credentials.transactBinding = original;
		}
	} finally { await app.close(); }
});

test("损坏的凭据事务记录使启动失败且不覆盖现有密文", async () => {
	const { app, credentials, dir } = await makeStack();
	try {
		await credentials.setSecrets("puddingclaw", { KEEP_TOKEN: "keep-value" });
		const credentialsPath = path.join(dir, "sec", "credentials.json");
		const journalPath = path.join(dir, "sec", "binding-transaction.json");
		const before = readFileSync(credentialsPath, "utf8");
		writeFileSync(journalPath, '{"version":1,"id":"broken"');
		const restartedCredentials = new CredentialsStore(path.join(dir, "sec"));
		await restartedCredentials.init();
		const restartedTeams = new TeamsStore(
			{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
			dir, 900_000, restartedCredentials,
		);
		await assert.rejects(restartedTeams.init(), /binding credentials transaction is invalid/);
		assert.equal(readFileSync(credentialsPath, "utf8"), before);
		assert.ok(existsSync(journalPath));
	} finally { await app.close(); }
});

test("在途事务记录仅含加密 payload、权限 0600 且提交后无临时残留", async () => {
	const { app, credentials, teams, registry, dir } = await makeStack();
	try {
		registry.registerBuiltin({
			...puddingClawConnectorManifest,
			id: "journal-fixture",
			connector: {
				...puddingClawConnectorManifest.connector,
				id: "journal-fixture",
				secretSchema: [{ key: "JOURNAL_TOKEN", label: "Journal Token", required: false }],
			},
		});
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const original = teams.setConnectorBinding.bind(teams);
		teams.setConnectorBinding = async (...args) => {
			entered();
			await gate;
			return original(...args);
		};
		try {
			const request = app.inject({
				method: "PUT", url: "/api/agents/puddingclaw/connector",
				payload: {
					expectedRevision: (await teams.getAgent("puddingclaw"))?.extensionRevision,
					extensionId: "journal-fixture", connectorId: "journal-fixture", transport: "spawn", config: {},
					secrets: { JOURNAL_TOKEN: "plaintext-must-not-appear" },
				},
			});
			await started;
			const journalPath = path.join(dir, "sec", "binding-transaction.json");
			assert.equal(statSync(journalPath).mode & 0o777, 0o600);
			assert.equal(readFileSync(journalPath, "utf8").includes("plaintext-must-not-appear"), false);
			assert.equal(readFileSync(path.join(dir, "sec", "credentials.json"), "utf8").includes("plaintext-must-not-appear"), false);
			release();
			const response = await request;
			assert.equal(response.statusCode, 200, response.body);
			assert.equal(existsSync(journalPath), false);
			assert.equal(readdirSync(path.join(dir, "sec")).some((name) => name.endsWith(".tmp")), false);
			assert.deepEqual(await credentials.getSecrets("puddingclaw"), { JOURNAL_TOKEN: "plaintext-must-not-appear" });
		} finally {
			release();
			teams.setConnectorBinding = original;
		}
	} finally { await app.close(); }
});

test("子进程在三个跨文件提交点强制退出后，冷启动选择完整旧态或新态", async () => {
	const childCode = `
		import path from "node:path";
		import { CredentialsStore } from "./src/store/credentials.ts";
		import { TeamsStore } from "./src/store/teams.ts";
		const [home, stage] = process.argv.slice(1);
		const credentials = new CredentialsStore(path.join(home, "sec"));
		await credentials.init();
		const teams = new TeamsStore({ state: path.join(home, "teams"), assets: path.join(home, "teams"), managedWorkspaces: path.join(home, "managed") }, home, 900000, credentials);
		await teams.init();
		const agent = await teams.getAgent("puddingclaw");
		if (stage === "after_journal") credentials.writeFile = async () => process.exit(65);
		await credentials.transactBinding("puddingclaw", { CRASH_TOKEN: "new-value" }, { CRASH_TOKEN: "old-value" }, async (id) => {
			if (stage === "after_credentials") process.exit(66);
			await teams.setConnectorBinding("puddingclaw", { ...agent.connector, secretRefs: { CRASH_TOKEN: "CRASH_TOKEN" } }, { expectedRevision: agent.extensionRevision ?? 0, id });
			if (stage === "after_registry") process.exit(67);
		}, (id) => teams.credentialTransactionCommitted("puddingclaw", id));
	`;
	for (const [stage, exitCode, expected] of [
		["after_journal", 65, "old-value"],
		["after_credentials", 66, "old-value"],
		["after_registry", 67, "new-value"],
	] as const) {
		const { app, credentials, dir } = await makeStack();
		await credentials.setSecrets("puddingclaw", { CRASH_TOKEN: "old-value" });
		await app.close();
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, dir, stage], {
			cwd: path.resolve(import.meta.dirname, "../.."),
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.equal(child.status, exitCode, child.stderr || child.error?.message);
		assert.ok(existsSync(path.join(dir, "sec", "binding-transaction.json")));
		const restartedCredentials = new CredentialsStore(path.join(dir, "sec"));
		await restartedCredentials.init();
		const restartedTeams = new TeamsStore(
			{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
			dir, 900_000, restartedCredentials,
		);
		await restartedTeams.init();
		assert.deepEqual(await restartedCredentials.getSecrets("puddingclaw"), { CRASH_TOKEN: expected });
		assert.equal(existsSync(path.join(dir, "sec", "binding-transaction.json")), false);
		assert.equal(Boolean((await restartedTeams.getAgent("puddingclaw"))?.connector?.secretRefs?.CRASH_TOKEN), stage === "after_registry");
	}
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
		payload: { expectedRevision: (await teams.getAgent("alpha"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext" },
	});
	assert.equal(early.statusCode, 400);

	await registry.install(writeCapabilityPackage(path.join(dir, "ext-cap")));
	const managerCreated = await app.inject({
		method: "POST",
		url: "/api/agents/manager/extensions",
		payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", config: { owner: "manager" } },
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
		payload: { expectedRevision: rev0, extensionId: "cap-ext", capabilityId: "cap-ext", config: { k: 1 }, activation: "searchable" },
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
		payload: { expectedRevision: createdBody.revision, enabled: false },
	});
	assert.equal(patched.statusCode, 200);
	assert.equal((patched.json() as { revision: number }).revision, rev0 + 2);
	const probe2 = await app.inject({ method: "POST", url: `/api/agents/alpha/extensions/${binding.id}/probe` });
	assert.equal((probe2.json() as { probe: { enabled: boolean } }).probe.enabled, false);

	// DELETE 移除绑定。
	const del = await app.inject({ method: "DELETE", url: `/api/agents/alpha/extensions/${binding.id}`, headers: { "x-expected-revision": String(patched.json().revision) } });
	assert.equal(del.statusCode, 200);
	assert.equal(((await teams.getAgent("alpha"))!.capabilityExtensions ?? []).length, 0);
	// 不存在的 binding → 404。
	const missing = await app.inject({ method: "DELETE", url: "/api/agents/alpha/extensions/nope" });
	assert.equal(missing.statusCode, 404);
	await app.close();
});

test("过期绑定表单的 PATCH 拒绝覆盖新配置和密钥", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "revision-cap")));
		const created = await app.inject({
			method: "POST", url: "/api/agents/manager/extensions",
			payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", config: { value: "initial" } },
		});
		assert.equal(created.statusCode, 200, created.body);
		const bindingId = created.json().agent.capabilityExtensions[0].id as string;
		const originalRevision = created.json().revision as number;
		const updated = await app.inject({
			method: "PATCH", url: `/api/agents/manager/extensions/${bindingId}`,
			payload: { expectedRevision: originalRevision, config: { value: "newer" } },
		});
		assert.equal(updated.statusCode, 200, updated.body);
		const stale = await app.inject({
			method: "PATCH", url: `/api/agents/manager/extensions/${bindingId}`,
			payload: { expectedRevision: originalRevision, config: { value: "stale" }, secrets: { CAP_TOKEN: "stale-secret" } },
		});
		assert.equal(stale.statusCode, 409, stale.body);
		assert.equal(stale.json().code, "binding_conflict");
		assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions?.[0]?.config, { value: "newer" });
		assert.deepEqual(await credentials.getSecrets("manager"), {});
		const missing = await app.inject({
			method: "PATCH", url: `/api/agents/manager/extensions/${bindingId}`,
			payload: { config: { value: "missing-version" } },
		});
		assert.equal(missing.statusCode, 400, missing.body);
	} finally { await app.close(); }
});

test("过期绑定列表不能新增或删除绑定，且不改动密钥", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "add-delete-revision-cap")));
		const initialRevision = (await teams.getAgent("manager"))?.extensionRevision ?? 0;
		const url = "/api/agents/manager/extensions";
		const created = await app.inject({ method: "POST", url, payload: { expectedRevision: initialRevision, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "newer-secret" } } });
		assert.equal(created.statusCode, 200, created.body);
		const bindingId = created.json().agent.capabilityExtensions[0].id as string;
		const staleAdd = await app.inject({ method: "POST", url, payload: { expectedRevision: initialRevision, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "stale-secret" } } });
		assert.equal(staleAdd.statusCode, 409, staleAdd.body);
		assert.equal(staleAdd.json().code, "binding_conflict");
		const staleDelete = await app.inject({ method: "DELETE", url: `${url}/${bindingId}`, headers: { "x-expected-revision": String(initialRevision) } });
		assert.equal(staleDelete.statusCode, 409, staleDelete.body);
		assert.equal(staleDelete.json().code, "binding_conflict");
		assert.equal((await teams.getAgent("manager"))?.capabilityExtensions?.length, 1);
		assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "newer-secret" });
		const missingAdd = await app.inject({ method: "POST", url, payload: { extensionId: "cap-ext", capabilityId: "cap-ext" } });
		assert.equal(missingAdd.statusCode, 400, missingAdd.body);
		const missingDelete = await app.inject({ method: "DELETE", url: `${url}/${bindingId}` });
		assert.equal(missingDelete.statusCode, 400, missingDelete.body);
	} finally { await app.close(); }
});

test("Capability 密钥清空后不保留虚假的 secretRefs", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	await registry.install(writeCapabilityPackage(path.join(dir, "secret-cap")));
	const created = await app.inject({
		method: "POST", url: "/api/agents/manager/extensions",
		payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "cap-secret" } },
	});
	assert.equal(created.statusCode, 200, created.body);
	const binding = created.json().agent.capabilityExtensions[0];
	assert.deepEqual(binding.secretRefs, { CAP_TOKEN: "CAP_TOKEN" });
	assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "cap-secret" });
	const cleared = await app.inject({
		method: "PATCH", url: `/api/agents/manager/extensions/${binding.id}`,
		payload: { expectedRevision: created.json().revision, secrets: { CAP_TOKEN: "" } },
	});
	assert.equal(cleared.statusCode, 200, cleared.body);
	assert.deepEqual(cleared.json().agent.capabilityExtensions[0].secretRefs, {});
	assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions?.[0]?.secretRefs, {});
	assert.deepEqual(await credentials.getSecrets("manager"), {});
	await app.close();
});

test("Capability 新增与更新的 Registry 失败均恢复旧密文和旧引用", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "rollback-cap")));
		await credentials.setSecrets("manager", { CAP_TOKEN: "old-value" });
		const originalAdd = teams.addCapabilityBinding.bind(teams);
		teams.addCapabilityBinding = async () => { throw new Error("injected add registry failure"); };
		try {
			const failed = await app.inject({
				method: "POST", url: "/api/agents/manager/extensions",
				payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "new-value" } },
			});
			assert.equal(failed.statusCode, 400, failed.body);
		} finally { teams.addCapabilityBinding = originalAdd; }
		assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "old-value" });
		assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions ?? [], []);
		const created = await app.inject({
			method: "POST", url: "/api/agents/manager/extensions",
			payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "old-value" } },
		});
		assert.equal(created.statusCode, 200, created.body);
		const before = (await teams.getAgent("manager"))!.capabilityExtensions![0]!;
		const originalPatch = teams.patchCapabilityBinding.bind(teams);
		teams.patchCapabilityBinding = async () => { throw new Error("injected patch registry failure"); };
		try {
			for (const value of ["new-value", ""]) {
				const failed = await app.inject({
					method: "PATCH", url: `/api/agents/manager/extensions/${before.id}`,
					payload: { expectedRevision: created.json().revision, secrets: { CAP_TOKEN: value } },
				});
				assert.equal(failed.statusCode, 400, failed.body);
				assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "old-value" });
				assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions?.[0], before);
			}
		} finally { teams.patchCapabilityBinding = originalPatch; }
		assert.equal(existsSync(path.join(dir, "sec", "binding-transaction.json")), false);
	} finally { await app.close(); }
});

test("两个 Capability 引用同一 Agent 密钥时，清空一侧不删除另一侧的密文", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	await registry.install(writeCapabilityPackage(path.join(dir, "shared-cap")));
	const create = async (secrets: Record<string, string>) => app.inject({
		method: "POST", url: "/api/agents/manager/extensions",
		payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets },
	});
	const first = await create({ CAP_TOKEN: "shared-secret" });
	assert.equal(first.statusCode, 200, first.body);
	const second = await create({ CAP_TOKEN: "shared-secret" });
	assert.equal(second.statusCode, 200, second.body);
	const [firstBinding, secondBinding] = second.json().agent.capabilityExtensions;
	const genericDelete = await app.inject({ method: "DELETE", url: "/api/agents/manager/secrets/CAP_TOKEN" });
	assert.equal(genericDelete.statusCode, 409, genericDelete.body);
	const genericEmpty = await app.inject({
		method: "PUT", url: "/api/agents/manager/secrets", payload: { secrets: { CAP_TOKEN: "" } },
	});
	assert.equal(genericEmpty.statusCode, 409, genericEmpty.body);
	const overwrite = await app.inject({
		method: "PATCH", url: `/api/agents/manager/extensions/${firstBinding.id}`,
		payload: { expectedRevision: second.json().revision, secrets: { CAP_TOKEN: "different-secret" } },
	});
	assert.equal(overwrite.statusCode, 400, overwrite.body);
	assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "shared-secret" });
	const cleared = await app.inject({
		method: "PATCH", url: `/api/agents/manager/extensions/${firstBinding.id}`,
		payload: { expectedRevision: second.json().revision, secrets: { CAP_TOKEN: "" } },
	});
	assert.equal(cleared.statusCode, 200, cleared.body);
	assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions?.[0]?.secretRefs, {});
	assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions?.[1]?.secretRefs, { CAP_TOKEN: "CAP_TOKEN" });
	assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "shared-secret" });
	assert.equal(secondBinding.id, (await teams.getAgent("manager"))?.capabilityExtensions?.[1]?.id);
	await app.close();
});

test("删除 Capability 绑定按最后引用回收密文，Registry 失败则保留旧状态", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "revoke-cap")));
		const create = async () => app.inject({ method: "POST", url: "/api/agents/manager/extensions", payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "shared-secret" } } });
		assert.equal((await create()).statusCode, 200);
		const second = await create();
		assert.equal(second.statusCode, 200, second.body);
		const [firstBinding, secondBinding] = second.json().agent.capabilityExtensions;
		const first = await app.inject({ method: "DELETE", url: `/api/agents/manager/extensions/${firstBinding.id}`, headers: { "x-expected-revision": String(second.json().revision) } });
		assert.equal(first.statusCode, 200, first.body);
		assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "shared-secret" });
		const original = teams.removeCapabilityBinding.bind(teams);
		teams.removeCapabilityBinding = async () => { throw new Error("injected removal failure"); };
		try {
			const failed = await app.inject({ method: "DELETE", url: `/api/agents/manager/extensions/${secondBinding.id}`, headers: { "x-expected-revision": String(first.json().revision) } });
			assert.equal(failed.statusCode, 400, failed.body);
			assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "shared-secret" });
			assert.equal((await teams.getAgent("manager"))?.capabilityExtensions?.length, 1);
		} finally { teams.removeCapabilityBinding = original; }
		const last = await app.inject({ method: "DELETE", url: `/api/agents/manager/extensions/${secondBinding.id}`, headers: { "x-expected-revision": String(first.json().revision) } });
		assert.equal(last.statusCode, 200, last.body);
		assert.deepEqual(await credentials.getSecrets("manager"), {});
		assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions, []);
		assert.equal(existsSync(path.join(dir, "sec", "binding-transaction.json")), false);
	} finally { await app.close(); }
});

test("共享密钥解绑与通用删除交错时，仍在引用的 Capability 保住密文", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "shared-race-cap")));
		const create = async () => app.inject({
			method: "POST", url: "/api/agents/manager/extensions",
			payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "shared-secret" } },
		});
		assert.equal((await create()).statusCode, 200);
		const second = await create();
		assert.equal(second.statusCode, 200, second.body);
		const [firstBinding, secondBinding] = second.json().agent.capabilityExtensions;
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const original = teams.patchCapabilityBinding.bind(teams);
		teams.patchCapabilityBinding = async (...args) => {
			entered();
			await gate;
			return original(...args);
		};
		try {
			const clear = app.inject({
				method: "PATCH", url: `/api/agents/manager/extensions/${firstBinding.id}`,
				payload: { expectedRevision: second.json().revision, secrets: { CAP_TOKEN: "" } },
			});
			await started;
			const remove = app.inject({ method: "DELETE", url: "/api/agents/manager/secrets/CAP_TOKEN" });
			release();
			const [cleared, rejected] = await Promise.all([clear, remove]);
			assert.equal(cleared.statusCode, 200, cleared.body);
			assert.equal(rejected.statusCode, 409, rejected.body);
			assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "shared-secret" });
			assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions?.find((binding) => binding.id === secondBinding.id)?.secretRefs, { CAP_TOKEN: "CAP_TOKEN" });
		} finally {
			release();
			teams.patchCapabilityBinding = original;
		}
	} finally { await app.close(); }
});

test("Capability 无效配置在密钥写入前拒绝，绑定与密文不变", async () => {
	const { app, registry, credentials, teams, dir } = await makeStack();
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "invalid-cap")));
		const url = "/api/agents/manager/extensions";
		for (const invalid of [{ enabled: "false" }, { config: [] }, { versionPin: 1 }]) {
			const response = await app.inject({ method: "POST", url, payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "unexpected" }, ...invalid } });
			assert.equal(response.statusCode, 400, response.body);
			assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions ?? [], []);
			assert.deepEqual(await credentials.getSecrets("manager"), {});
		}
		for (const invalidSecrets of [null, [], "CAP_TOKEN=value"]) {
			const response = await app.inject({ method: "POST", url, payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: invalidSecrets } });
			assert.equal(response.statusCode, 400, response.body);
			assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions ?? [], []);
			assert.deepEqual(await credentials.getSecrets("manager"), {});
		}
		const created = await app.inject({ method: "POST", url, payload: { expectedRevision: (await teams.getAgent("manager"))?.extensionRevision ?? 0, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "original" } } });
		assert.equal(created.statusCode, 200, created.body);
		const before = await teams.getAgent("manager");
		const bindingId = before?.capabilityExtensions?.[0]?.id;
		assert.ok(bindingId);
		for (const invalid of [{ enabled: "false" }, { config: [] }, { versionPin: 1 }]) {
			const response = await app.inject({ method: "PATCH", url: `${url}/${bindingId}`, payload: { expectedRevision: before?.extensionRevision ?? 0, secrets: { CAP_TOKEN: "unexpected" }, ...invalid } });
			assert.equal(response.statusCode, 400, response.body);
			assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions, before?.capabilityExtensions);
			assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "original" });
		}
		for (const invalidSecrets of [null, [], "CAP_TOKEN=value"]) {
			const response = await app.inject({ method: "PATCH", url: `${url}/${bindingId}`, payload: { expectedRevision: before?.extensionRevision ?? 0, secrets: invalidSecrets } });
			assert.equal(response.statusCode, 400, response.body);
			assert.deepEqual((await teams.getAgent("manager"))?.capabilityExtensions, before?.capabilityExtensions);
			assert.deepEqual(await credentials.getSecrets("manager"), { CAP_TOKEN: "original" });
		}
	} finally {
		await app.close();
	}
});

test("Connector 的非法版本锁定与密钥载荷在写入前拒绝", async () => {
	const { app, credentials, teams } = await makeStack();
	try {
		const before = await teams.getAgent("puddingclaw");
		const binding = { extensionId: "puddingclaw", connectorId: "puddingclaw", transport: "spawn", config: {} };
		for (const invalid of [
			{ versionPin: 1, secrets: { PUDDINGCLAW_TOKEN: "unexpected" } },
			{ secrets: null }, { secrets: [] }, { secrets: "PUDDINGCLAW_TOKEN=value" },
		]) {
			const response = await app.inject({ method: "PUT", url: "/api/agents/puddingclaw/connector", payload: { ...binding, expectedRevision: before?.extensionRevision, ...invalid } });
			assert.equal(response.statusCode, 400, response.body);
			assert.deepEqual((await teams.getAgent("puddingclaw"))?.connector, before?.connector);
			assert.deepEqual(await credentials.getSecrets("puddingclaw"), {});
		}
	} finally {
		await app.close();
	}
});

test("Capability 停用保留密钥、解绑回收密钥，均不向 Connector Driver 注入", async () => {
	const { app, registry, credentials, drivers, dir } = await makeStack();
	await registry.install(writeCapabilityPackage(path.join(dir, "orphan-cap")));
	const created = await app.inject({
		method: "POST", url: "/api/agents/puddingclaw/extensions",
		payload: { expectedRevision: (await app.inject({ method: "GET", url: "/api/agents/puddingclaw/extensions" })).json().revision, extensionId: "cap-ext", capabilityId: "cap-ext", secrets: { CAP_TOKEN: "orphan-secret" } },
	});
	assert.equal(created.statusCode, 200, created.body);
	const bindingId = created.json().agent.capabilityExtensions[0].id;
	const receivedEnvs: NodeJS.ProcessEnv[] = [];
	const driver = makeDriver("puddingclaw");
	driver.listConfigOptions = async (_field, ctx) => {
		receivedEnvs.push(ctx.env);
		return [];
	};
	drivers.registerFactory("puddingclaw", () => driver, "puddingclaw");
	const optionsUrl = "/api/agents/puddingclaw/connector/config-options/model";
	assert.equal((await app.inject({ method: "GET", url: optionsUrl })).statusCode, 200);
	assert.equal(receivedEnvs.length, 1);
	assert.equal(receivedEnvs.at(-1)?.CAP_TOKEN, "orphan-secret", "启用绑定的凭证应可供运行时使用");
	const disabled = await app.inject({ method: "PATCH", url: `/api/agents/puddingclaw/extensions/${bindingId}`, payload: { expectedRevision: created.json().revision, enabled: false } });
	assert.equal(disabled.statusCode, 200, disabled.body);
	assert.deepEqual(await credentials.getSecrets("puddingclaw"), { CAP_TOKEN: "orphan-secret" }, "停用不删除密文，以便重新启用");
	assert.equal((await app.inject({ method: "GET", url: optionsUrl })).statusCode, 200);
	assert.equal(receivedEnvs.length, 2);
	assert.equal(receivedEnvs.at(-1)?.CAP_TOKEN, undefined, "停用的 Capability 不得把密钥注入 Connector Driver");
	const deleted = await app.inject({ method: "DELETE", url: `/api/agents/puddingclaw/extensions/${bindingId}`, headers: { "x-expected-revision": String(disabled.json().revision) } });
	assert.equal(deleted.statusCode, 200, deleted.body);
	assert.deepEqual(await credentials.getSecrets("puddingclaw"), {}, "解绑最后一个引用时必须回收密文");
	const options = await app.inject({ method: "GET", url: optionsUrl });
	assert.equal(options.statusCode, 200, options.body);
	assert.equal(receivedEnvs.length, 3);
	assert.equal(receivedEnvs.at(-1)?.CAP_TOKEN, undefined);
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
	await delegations.transitionDelegation(d.id, ["admitted"], { executionState: "running", runHandle: "run-1" });
	const staleRevision = (await teams.getAgent("alpha"))!.extensionRevision!;
	await teams.bumpAgentRevision("alpha");
	const staleCancel = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false, resolve: "cancel", expectedRevision: staleRevision } });
	assert.equal(staleCancel.statusCode, 409, "旧表单不能取消较新版本的 Run");
	assert.equal(cancelled, 0);
	assert.equal((await teams.getAgent("alpha"))!.enabled, true);
	const missingRevision = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false, resolve: "cancel" } });
	assert.equal(missingRevision.statusCode, 400);
	assert.equal(cancelled, 0);

	// 无 resolve → 409 + Run 清单，Agent 仍启用。
	const conflict = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false, expectedRevision: (await teams.getAgent("alpha"))?.extensionRevision } });
	assert.equal(conflict.statusCode, 409);
	const conflictBody = conflict.json() as { runs: Array<{ delegationId: string; executionState: string }> };
	assert.deepEqual(conflictBody.runs.map((run) => [run.delegationId, run.executionState]), [[d.id, "running"]]);
	assert.equal((await teams.getAgent("alpha"))!.enabled, true, "409 不得改变启用状态");

	// resolve:"keep" → 禁用成功，Run 保留（不静默杀死）。
	const keep = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false, resolve: "keep", expectedRevision: (await teams.getAgent("alpha"))?.extensionRevision } });
	assert.equal(keep.statusCode, 200);
	assert.equal((await teams.getAgent("alpha"))!.enabled, false);
	assert.equal((await teams.getAgent("alpha"))!.runConfigRevision, staleRevision + 1, "启停不改变 Run 的执行配置版本");
	assert.equal((await delegations.getDelegation(d.id))!.executionState, "running", "keep 必须保留 Run");
	assert.equal(cancelled, 0);

	// 重新启用后 resolve:"cancel" → Runtime 取消 Run 再禁用。
	await teams.setEnabled("alpha", true);
	const cancel = await app.inject({ method: "PUT", url: "/api/agents/alpha/enabled", payload: { enabled: false, resolve: "cancel", expectedRevision: (await teams.getAgent("alpha"))?.extensionRevision } });
	assert.equal(cancel.statusCode, 200);
	assert.equal(cancelled, 1, "cancel 必须走 Runtime 取消");
	assert.equal((await delegations.getDelegation(d.id))!.executionState, "observation_lost");
	await app.close();
});

test("Phase5: 等待平台准入与已接单 Run 均须进入停用冲突清单", async () => {
	const { app, teams, delegations } = await makeStack();
	try {
		await teams.upsertAgent({ name: "approval-worker", description: "approval", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		const waiting = await delegations.createDelegation({ windowId: "w1", workspaceId: "workspace-1", cwdSnapshot: process.cwd(), managerSessionId: "s1", agentId: "approval-worker", agentRevision: 1, operation: "run" });
		await delegations.transitionDelegation(waiting.id, ["admitted"], { executionState: "waiting_admission" });
		const admitted = await delegations.createDelegation({ windowId: "w1", workspaceId: "workspace-1", cwdSnapshot: process.cwd(), managerSessionId: "s1", agentId: "approval-worker", agentRevision: 1, operation: "run" });
		const response = await app.inject({ method: "PUT", url: "/api/agents/approval-worker/enabled", payload: { enabled: false, expectedRevision: (await teams.getAgent("approval-worker"))?.extensionRevision } });
		assert.equal(response.statusCode, 409, response.body);
		assert.deepEqual(new Set(response.json().runs.map((run: { executionState: string }) => run.executionState)), new Set(["waiting_admission", "admitted"]));
		assert.equal((await teams.getAgent("approval-worker"))?.enabled, true);
		assert.ok(admitted);
	} finally { await app.close(); }
});

test("Phase5: 停用清单快照与提交期间不得接单新 Run", async () => {
	const { app, teams, runtime, drivers } = await makeStack();
	try {
		const agent = await teams.upsertAgent({ name: "race-worker", description: "race", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		drivers.register(makeDriver(agent.name));
		const window = await teams.createWindow({ type: "direct", members: [agent.name], sessionId: "manager-race" });
		const invoker = new AgentInvoker(teams, runtime, drivers, undefined, process.cwd());
		const originalList = runtime.listDelegations.bind(runtime);
		let snapshotReached!: () => void;
		const reached = new Promise<void>((resolve) => { snapshotReached = resolve; });
		let releaseSnapshot!: () => void;
		const hold = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
		let paused = false;
		runtime.listDelegations = async (...args) => {
			const snapshot = await originalList(...args);
			if (!paused) { paused = true; snapshotReached(); await hold; }
			return snapshot;
		};
		const disable = app.inject({ method: "PUT", url: `/api/agents/${agent.name}/enabled`, payload: { enabled: false, resolve: "cancel", expectedRevision: agent.extensionRevision } });
		await reached;
		let created = false;
		const delegation = invoker.delegate({ windowId: window.id, managerSessionId: "manager-race", agent, message: "work", mode: "run", onDelegationCreated: () => { created = true; } }).then(() => undefined, () => undefined);
		await new Promise((resolve) => setTimeout(resolve, 100));
		releaseSnapshot();
		const response = await disable;
		await delegation;
		assert.equal(response.statusCode, 200, response.body);
		assert.equal(created, false, "停用快照之后不能接单又逃过 cancel 清单");
		assert.equal((await runtime.listDelegations()).length, 0);
	} finally { await app.close(); }
});

test("Phase5: 先进入接单门禁的 Run 必须出现在随后停用的冲突清单", async () => {
	const { app, teams, runtime, drivers } = await makeStack();
	try {
		const agent = await teams.upsertAgent({ name: "first-worker", description: "first", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		drivers.register({
			...makeDriver(agent.name),
			async *run() {
				await new Promise((resolve) => setTimeout(resolve, 250));
				yield { type: "failed", result: { agentId: agent.name, status: "failed", errorCode: "done", error: "done", recoverable: false } } as AgentEvent;
			},
		});
		const window = await teams.createWindow({ type: "direct", members: [agent.name], sessionId: "manager-first" });
		const invoker = new AgentInvoker(teams, runtime, drivers, undefined, process.cwd());
		const originalDelegate = runtime.delegate.bind(runtime);
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		runtime.delegate = async (...args) => { entered(); await hold; return originalDelegate(...args); };
		const delegation = invoker.delegate({ windowId: window.id, managerSessionId: "manager-first", agent, message: "work", mode: "run" });
		await reached;
		let disableSettled = false;
		const disable = app.inject({ method: "PUT", url: `/api/agents/${agent.name}/enabled`, payload: { enabled: false, expectedRevision: agent.extensionRevision } }).then((response) => { disableSettled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(disableSettled, false, "停用须等待已进入准入的 Run 落盘");
		release();
		const response = await disable;
		assert.equal(response.statusCode, 409, response.body);
		assert.equal(response.json().runs.length, 1);
		assert.equal((await teams.getAgent(agent.name))?.enabled, true);
		await delegation;
	} finally { await app.close(); }
});

test("Phase5: 配置写入不能穿过委托最后版本检查与持久接单", async () => {
	const { app, teams, runtime, drivers } = await makeStack();
	try {
		const agent = await teams.upsertAgent({ name: "config-race", description: "before", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		drivers.register(makeDriver(agent.name));
		const window = await teams.createWindow({ type: "direct", members: [agent.name], sessionId: "manager-config-race" });
		const invoker = new AgentInvoker(teams, runtime, drivers, undefined, process.cwd());
		const originalDelegate = runtime.delegate.bind(runtime);
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		runtime.delegate = async (...args) => { entered(); await hold; return originalDelegate(...args); };
		const delegation = invoker.delegate({ windowId: window.id, managerSessionId: "manager-config-race", agent, message: "work", mode: "run" });
		await reached;
		let configSettled = false;
		const change = app.inject({ method: "PUT", url: `/api/agents/${agent.name}/config`, payload: { description: "after", expectedRevision: agent.extensionRevision } }).then((response) => { configSettled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(configSettled, false, "配置不得在最后检查与 Delegation 落盘之间提交");
		release();
		await delegation;
		const response = await change;
		assert.equal(response.statusCode, 200, response.body);
		assert.equal((await teams.getAgent(agent.name))?.description, "after");
		assert.equal((await runtime.listDelegations())[0]?.agentRevision, agent.runConfigRevision);
	} finally { await app.close(); }
});

test("Phase5: Pi MCP 选择写入须等待同 Agent 的接单门禁", async () => {
	const { app, teams } = await makeStack();
	try {
		const agent = (await teams.getAgent("pi-b"))!;
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		const admission = teams.withAgentRunAdmission(agent.name, async () => { entered(); await hold; });
		await reached;
		let settled = false;
		const change = app.inject({ method: "PUT", url: `/api/agents/${agent.name}/mcp`, payload: { serverIds: [], expectedRevision: agent.extensionRevision } }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "MCP 选择不得在同 Agent 接单期间提交");
		release();
		await admission;
		const response = await change;
		assert.equal(response.statusCode, 200, response.body);
	} finally { await app.close(); }
});

test("Phase5: MCP Server 定义更新须等待引用它的 Agent 完成接单", async () => {
	const { app, teams } = await makeStack();
	try {
		const created = await app.inject({ method: "POST", url: "/api/extensions/mcp/servers", payload: { id: "race-mcp", displayName: "Race MCP", definition: { command: "echo" } } });
		assert.equal(created.statusCode, 201, created.body);
		const agent = (await teams.getAgent("pi-b"))!;
		const selected = await app.inject({ method: "PUT", url: `/api/agents/${agent.name}/mcp`, payload: { serverIds: ["race-mcp"], expectedRevision: agent.extensionRevision } });
		assert.equal(selected.statusCode, 200, selected.body);
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		const admission = teams.withAgentRunAdmission(agent.name, async () => { entered(); await hold; });
		await reached;
		let settled = false;
		const update = app.inject({ method: "PUT", url: "/api/extensions/mcp/servers/race-mcp", payload: { displayName: "Updated MCP", definition: { command: "echo", args: ["updated"] } } }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "MCP 目录与 Agent 修订号须跨接单原子排序");
		release();
		await admission;
		const response = await update;
		assert.equal(response.statusCode, 200, response.body);
		assert.equal((await teams.getAgent(agent.name))?.extensionRevision, selected.json().revision + 1);
	} finally { await app.close(); }
});

test("Phase5: MCP 密钥已提交但 Agent 修订失败时保守对账，返回未确认而非成功", async () => {
	const { app, teams, mcpServers, dir } = await makeStack();
	try {
		const created = await app.inject({ method: "POST", url: "/api/extensions/mcp/servers", payload: {
			id: "docs", displayName: "Docs", definition: { command: "echo", env: { API_TOKEN: "${API_TOKEN}" } }, secrets: { API_TOKEN: "old-token" },
		} });
		assert.equal(created.statusCode, 201, created.body);
		const agent = (await teams.getAgent("pi-b"))!;
		const selected = await app.inject({ method: "PUT", url: `/api/agents/${agent.name}/mcp`, payload: {
			serverIds: ["docs"], expectedRevision: agent.extensionRevision,
		} });
		assert.equal(selected.statusCode, 200, selected.body);
		const revision = (await teams.getAgent(agent.name))!.extensionRevision;
		const original = teams.bumpAgentRevision.bind(teams);
		let failed = false;
		teams.bumpAgentRevision = async (name) => {
			if (name === agent.name && !failed) { failed = true; throw new Error("injected revision write failure"); }
			return original(name);
		};
		const response = await app.inject({ method: "PUT", url: "/api/extensions/mcp/servers/docs", payload: {
			displayName: "Docs", definition: { command: "echo", env: { API_TOKEN: "${API_TOKEN}" } }, secrets: { API_TOKEN: "new-token" },
		} });
		assert.equal(response.statusCode, 503, response.body);
		assert.equal((await teams.getAgent(agent.name))?.extensionRevision, (revision ?? 0) + 1);
		assert.equal((await mcpServers.definitionsFor(["docs"])).docs?.env?.API_TOKEN, "new-token");
		await assert.rejects(() => access(path.join(dir, "teams", "mcp-mutation-pending.json")), { code: "ENOENT" });
		const invalid = await app.inject({ method: "PUT", url: "/api/extensions/mcp/servers/docs", payload: {
			displayName: "Docs", definition: { command: "echo", url: "https://invalid.test" },
		} });
		assert.equal(invalid.statusCode, 400);
		assert.equal((await teams.getAgent(agent.name))?.extensionRevision, (revision ?? 0) + 1);
	} finally { await app.close(); }
});

test("Phase5: MCP 选择不得在目录更新期间改变受影响 Agent 集合", async () => {
	const { app, teams } = await makeStack();
	try {
		const agent = (await teams.getAgent("pi-b"))!;
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		const catalog = teams.withAgentCatalogMutation(async () => { entered(); await hold; });
		await reached;
		let settled = false;
		const selection = app.inject({ method: "PUT", url: `/api/agents/${agent.name}/mcp`, payload: { serverIds: [], expectedRevision: agent.extensionRevision } }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "MCP 选择须等待目录更新完成");
		release();
		await catalog;
		assert.equal((await selection).statusCode, 200);
	} finally { await app.close(); }
});

test("Phase5: Extension 更新须等待已绑定 Agent 完成接单", async () => {
	const { app, teams, registry, dir } = await makeStack();
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "update-race-cap")));
		const original = (await teams.getAgent("pi-b"))!;
		await teams.addCapabilityBinding("pi-b", { extensionId: "cap-ext", capabilityId: "cap-ext", enabled: true, config: {} });
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		const admission = teams.withAgentRunAdmission("pi-b", async () => { entered(); await hold; });
		await reached;
		let settled = false;
		const update = app.inject({ method: "POST", url: "/api/extensions/cap-ext/update", payload: {} }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "Extension 模块替换与 Agent 修订号须跨接单同序");
		release();
		await admission;
		const response = await update;
		assert.equal(response.statusCode, 200, response.body);
		assert.equal((await teams.getAgent("pi-b"))?.extensionRevision, (original.extensionRevision ?? 0) + 2);
	} finally { release(); await app.close(); }
});

test("Phase5: 独立 Manager PATCH 须等待同 Agent 的接单门禁", async () => {
	const { app, teams } = await makeStack();
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	try {
		const before = (await teams.getAgent("manager"))!;
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		const admission = teams.withAgentRunAdmission("manager", async () => { entered(); await hold; });
		await reached;
		let settled = false;
		const patch = app.inject({ method: "PATCH", url: "/api/agents/manager/manager", payload: { description: "after admission", expectedRevision: before.extensionRevision } }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "独立 Manager 写入须与持久接单同序");
		release();
		await admission;
		assert.equal((await patch).statusCode, 200);
	} finally { release(); await app.close(); }
});

test("Phase5: Extension 更新期间不得新增引用它的 Agent 绑定", async () => {
	const { app, teams, registry, dir } = await makeStack();
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "binding-race-cap")));
		const originalUpdate = registry.update.bind(registry);
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		registry.update = async (id, opts) => { entered(); await hold; return originalUpdate(id, opts); };
		const update = app.inject({ method: "POST", url: "/api/extensions/cap-ext/update", payload: {} });
		await reached;
		let settled = false;
		const before = (await teams.getAgent("pi-b"))!;
		const binding = app.inject({ method: "POST", url: "/api/agents/pi-b/extensions", payload: { extensionId: "cap-ext", capabilityId: "cap-ext", expectedRevision: before.extensionRevision } }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "绑定须等待 Extension 目录更新完成并进入其受影响集合");
		release();
		assert.equal((await update).statusCode, 200);
		assert.equal((await binding).statusCode, 200);
	} finally { release(); await app.close(); }
});

test("Phase5: 关闭开发者模式须等待本地 Extension 引用者完成接单", async () => {
	const { app, teams, registry, dir } = await makeStack();
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	try {
		await registry.install(writeCapabilityPackage(path.join(dir, "mode-race-cap")));
		await teams.addCapabilityBinding("pi-b", { extensionId: "cap-ext", capabilityId: "cap-ext", enabled: true, config: {} });
		const before = (await teams.getAgent("pi-b"))!;
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		const admission = teams.withAgentRunAdmission("pi-b", async () => { entered(); await hold; });
		await reached;
		let settled = false;
		const disabling = app.inject({ method: "PUT", url: "/api/extensions/developer-mode", payload: { enabled: false } }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "关闭模式不得在引用者接单时撤销模块");
		release();
		await admission;
		const response = await disabling;
		assert.equal(response.statusCode, 200, response.body);
		assert.equal(registry.get("cap-ext")?.loaded, false);
		assert.equal((await teams.getAgent("pi-b"))?.extensionRevision, (before.extensionRevision ?? 0) + 1);
	} finally { release(); await app.close(); }
});

test("Phase5: 安装缺失 Extension 须等待历史引用者完成接单并递增修订号", async () => {
	const { app, teams, dir } = await makeStack();
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	try {
		const source = writeCapabilityPackage(path.join(dir, "install-race-cap"));
		await teams.addCapabilityBinding("pi-b", { extensionId: "cap-ext", capabilityId: "cap-ext", enabled: true, config: {} });
		const before = (await teams.getAgent("pi-b"))!;
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		const admission = teams.withAgentRunAdmission("pi-b", async () => { entered(); await hold; });
		await reached;
		let settled = false;
		const install = app.inject({ method: "POST", url: "/api/extensions/install", payload: { path: source } }).then((response) => { settled = true; return response; });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, "历史绑定的模块恢复安装须与接单同序");
		release();
		await admission;
		const response = await install;
		assert.equal(response.statusCode, 200, response.body);
		assert.equal((await teams.getAgent("pi-b"))?.extensionRevision, (before.extensionRevision ?? 0) + 1);
	} finally { release(); await app.close(); }
});

test("Phase5: Extension 目录已提交但 Agent 修订写入失败，重启对账阻断旧执行身份", async () => {
	const { app, teams, registry, credentials, dir } = await makeStack();
	const journalPath = path.join(dir, "teams", "extension-mutation-pending.json");
	const originalBump = teams.bumpAgentRevision.bind(teams);
	try {
		const source = writeCapabilityPackage(path.join(dir, "crash-race-cap"));
		await registry.install(source);
		await teams.addCapabilityBinding("pi-b", { extensionId: "cap-ext", capabilityId: "cap-ext", enabled: true, config: {} });
		const before = (await teams.getAgent("pi-b"))!;
		const manifestPath = path.join(source, EXTENSION_MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "1.0.1" }));
		teams.bumpAgentRevision = async () => { throw new Error("simulated agents.json write failure"); };
		const response = await app.inject({ method: "POST", url: "/api/extensions/cap-ext/update", payload: {} });
		assert.equal(response.statusCode, 400, response.body);
		assert.equal(registry.get("cap-ext")?.version, "1.0.1", "Extension 目录已提交新版");
		assert.equal((await teams.getAgent("pi-b"))?.runConfigRevision, before.runConfigRevision, "故障前 Agent 执行修订尚未提交");
		assert.equal(existsSync(journalPath), true, "待对账记录必须先于目录写入落盘并保留");
		await assert.rejects(() => teams.withAgentRunAdmission("pi-b", async () => undefined), /待对账/);

		const restartedTeams = new TeamsStore(
			{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
			dir, 900_000, credentials,
		);
		await restartedTeams.init();
		const journal = new ExtensionMutationJournal(journalPath);
		assert.deepEqual(await journal.recover(async (name) => { if (await restartedTeams.getAgent(name)) await restartedTeams.bumpAgentRevision(name); }, async () => undefined), ["pi-b"]);
		assert.equal((await restartedTeams.getAgent("pi-b"))?.runConfigRevision, (before.runConfigRevision ?? 0) + 1);
		assert.equal(existsSync(journalPath), false);
		assert.deepEqual(await journal.recover(async () => { throw new Error("must not replay"); }, async () => undefined), []);
	} finally {
		teams.bumpAgentRevision = originalBump;
		await app.close();
	}
});

test("Phase5: 删除有活动 Run 的 Worker 返回冲突，处理 Run 后才移除身份", async () => {
	const { app, teams, delegations, drivers } = await makeStack();
	try {
		await teams.upsertAgent({ name: "delete-busy", description: "busy worker", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		drivers.register(makeDriver("delete-busy"));
		const delegation = await delegations.createDelegation({
			windowId: "w1", workspaceId: "workspace-1", cwdSnapshot: process.cwd(), managerSessionId: "s1",
			agentId: "delete-busy", agentRevision: 0, operation: "run",
		});
		await delegations.transitionDelegation(delegation.id, ["admitted"], { executionState: "running", runHandle: "run-delete" });
		const conflict = await app.inject({ method: "DELETE", url: "/api/agents/delete-busy" });
		assert.equal(conflict.statusCode, 409, conflict.body);
		assert.deepEqual(conflict.json().runs.map((run: { delegationId: string; executionState: string }) => [run.delegationId, run.executionState]), [[delegation.id, "running"]]);
		assert.ok(await teams.getAgent("delete-busy"));
		const disabled = await app.inject({ method: "PUT", url: "/api/agents/delete-busy/enabled", payload: { enabled: false, resolve: "cancel", expectedRevision: (await teams.getAgent("delete-busy"))?.extensionRevision } });
		assert.equal(disabled.statusCode, 200, disabled.body);
		assert.equal((await app.inject({ method: "DELETE", url: "/api/agents/delete-busy" })).statusCode, 204);
		assert.equal(await teams.getAgent("delete-busy"), undefined);
	} finally { await app.close(); }
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

test("MCP Catalog 可添加/删除，Pi Agent 单独勾选且引用期间禁止删除", async () => {
	const { app, teams } = await makeStack();
	const created = await app.inject({
		method: "POST",
		url: "/api/extensions/mcp/servers",
		payload: {
			id: "docs",
			displayName: "Docs MCP",
			definition: { url: "https://mcp.example.test", headers: { Authorization: "Bearer ${API_TOKEN}" } },
			secrets: { API_TOKEN: "secret" },
		},
	});
	assert.equal(created.statusCode, 201, created.body);

	const initialRevision = (await app.inject({ method: "GET", url: "/api/agents/manager/mcp" })).json<{ revision: number }>().revision;
	const selected = await app.inject({ method: "PUT", url: "/api/agents/manager/mcp", payload: { expectedRevision: initialRevision, serverIds: ["docs", "docs"] } });
	assert.equal(selected.statusCode, 200, selected.body);
	assert.deepEqual((await teams.getAgent("manager"))?.mcpServerIds, ["docs"]);
	const stale = await app.inject({ method: "PUT", url: "/api/agents/manager/mcp", payload: { expectedRevision: initialRevision, serverIds: [] } });
	assert.equal(stale.statusCode, 409, stale.body);
	assert.deepEqual((await teams.getAgent("manager"))?.mcpServerIds, ["docs"], "stale tab cannot clear the current allowlist");
	const noRevision = await app.inject({ method: "PUT", url: "/api/agents/manager/mcp", payload: { serverIds: [] } });
	assert.equal(noRevision.statusCode, 400, noRevision.body);
	const catalog = await app.inject({ method: "GET", url: "/api/extensions/mcp/servers" });
	assert.deepEqual((catalog.json() as { servers: Array<{ usedBy: Array<{ id: string }> }> }).servers[0]?.usedBy, [{ id: "manager", displayName: "manager" }]);

	const conflict = await app.inject({ method: "DELETE", url: "/api/extensions/mcp/servers/docs" });
	assert.equal(conflict.statusCode, 409, conflict.body);
	assert.match(conflict.body, /先取消勾选/);
	const missing = await app.inject({ method: "PUT", url: "/api/agents/manager/mcp", payload: { expectedRevision: selected.json<{ revision: number }>().revision, serverIds: ["missing"] } });
	assert.equal(missing.statusCode, 400);

	await teams.upsertAgent({
		name: "not-pi",
		description: "command worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
		enabled: true,
	});
	const unsupported = await app.inject({ method: "PUT", url: "/api/agents/not-pi/mcp", payload: { serverIds: ["docs"] } });
	assert.equal(unsupported.statusCode, 400);

	const cleared = await app.inject({ method: "PUT", url: "/api/agents/manager/mcp", payload: { expectedRevision: selected.json<{ revision: number }>().revision, serverIds: [] } });
	assert.equal(cleared.statusCode, 200, cleared.body);
	const removed = await app.inject({ method: "DELETE", url: "/api/extensions/mcp/servers/docs" });
	assert.equal(removed.statusCode, 204, removed.body);
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

test("用户授权 API 校验声明动作，返回非敏感会话并支持自动确认与取消", async () => {
	const { app, registry, dir } = await makeStack();
	await registry.installOrUpdateFromDir(writeCapabilityPackage(path.join(dir, "auth-cap")));
	const module = registry.capabilityModuleOf("cap-ext")!;
	module.listConnections = () => [{ id: "main", name: "测试连接", state: "connected", actions: [{ id: "authorize", label: "用户授权", kind: "authorization" }], checkedAt: new Date().toISOString() }];
	let state: "pending" | "completed" | "cancelled" = "pending";
	let starts = 0;
	module.authorization = {
		async begin(connectionId, actionId) {
			assert.equal(connectionId, "main");
			assert.equal(actionId, "authorize");
			starts++;
			return { id: "opaque-session", state, verificationUrl: "https://accounts.feishu.cn/authorize", expiresAt: new Date(Date.now() + 60_000).toISOString() };
		},
		async status(connectionId, sessionId) { return connectionId === "main" && sessionId === "opaque-session" ? { id: sessionId, state, expiresAt: new Date().toISOString() } : undefined; },
		async cancel() { state = "cancelled"; },
	};
	const base = "/api/extensions/cap-ext/connections/main/authorizations";
	const undeclared = await app.inject({ method: "POST", url: base, payload: { actionId: "arbitrary" } });
	assert.equal(undeclared.statusCode, 409);
	assert.equal(starts, 0);
	const begin = await app.inject({ method: "POST", url: base, payload: { actionId: "authorize" } });
	assert.equal(begin.statusCode, 200, begin.body);
	assert.equal(begin.headers["cache-control"], "no-store");
	assert.equal(begin.json().session.id, "opaque-session");
	const poll = await app.inject({ method: "GET", url: `${base}/opaque-session` });
	assert.equal(poll.json().session.state, "pending");
	state = "completed";
	assert.equal((await app.inject({ method: "GET", url: `${base}/opaque-session` })).json().session.state, "completed");
	assert.equal((await app.inject({ method: "GET", url: `${base}/unknown` })).statusCode, 404);
	assert.equal((await app.inject({ method: "GET", url: "/api/extensions/cap-ext/connections/other/authorizations/opaque-session" })).statusCode, 404);
	assert.equal((await app.inject({ method: "DELETE", url: `${base}/opaque-session` })).statusCode, 204);
	assert.equal((await app.inject({ method: "GET", url: `${base}/opaque-session` })).json().session.state, "cancelled");
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
			kind: "capability", engines: { puddingteams: ">=1 <2" }, entry: "index.mjs",
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
