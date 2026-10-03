import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../store/teams.js";
import {
	ExtensionCatalog,
	resolveAgentCapabilityRuntime,
	type CapabilityExtensionModule,
	type SharedCapabilityConnection,
} from "./extensions.js";

test("Capability Session runtime 同时覆盖 Manager 与 Pi Worker，且 binding 状态互相隔离", async () => {
	const stateRoot = mkdtempSync(path.join(tmpdir(), "pt-capability-state-"));
	const skillPath = path.join(stateRoot, "skills");
	const seen: Array<{ agentId: string; pinned: boolean; connectorId?: string; stateDir: string }> = [];
	const module: CapabilityExtensionModule = {
		manifest: { id: "lark-like", kind: "capability", name: "Lark-like", version: "1", tools: [] },
		register() {},
		runtime: {
			resolveSession(ctx) {
				seen.push({
					agentId: ctx.agent.id,
					pinned: ctx.agent.pinned,
					...(ctx.agent.connectorId ? { connectorId: ctx.agent.connectorId } : {}),
					stateDir: ctx.stateDir,
				});
				return { skillPaths: [skillPath], env: { ...ctx.env, LARK_BINDING: ctx.agent.id } };
			},
		},
	};
	const catalog = new ExtensionCatalog();
	catalog.register(module);
	const binding = { id: "binding-1", extensionId: "lark-like", capabilityId: "lark-like", enabled: true, config: {} };
	const manager = {
		name: "manager",
		description: "manager",
		pinned: true,
		enabled: true,
		invoke: { type: "pi" },
		capabilityExtensions: [binding],
	} as AgentConfig;
	const worker = {
		name: "pi-worker",
		description: "worker",
		enabled: true,
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		capabilityExtensions: [binding],
	} as AgentConfig;

	const [managerRuntime, workerRuntime] = await Promise.all([
		resolveAgentCapabilityRuntime({ agent: manager, catalog, stateRoot, cwd: process.cwd(), env: {} }),
		resolveAgentCapabilityRuntime({ agent: worker, catalog, stateRoot, cwd: process.cwd(), env: {} }),
	]);
	assert.deepEqual(managerRuntime.skillPaths, [skillPath]);
	assert.deepEqual(workerRuntime.skillPaths, [skillPath]);
	assert.equal(managerRuntime.env.LARK_BINDING, "manager");
	assert.equal(workerRuntime.env.LARK_BINDING, "pi-worker");
	assert.equal(seen.find((item) => item.agentId === "manager")?.pinned, true);
	assert.equal(seen.find((item) => item.agentId === "pi-worker")?.connectorId, "pi");
	assert.notEqual(seen[0]?.stateDir, seen[1]?.stateDir, "Manager 与 Worker 各自保管 Skills 等绑定状态");
});

test("多个 Agent 注入同一共享连接，绑定本身不发起授权", async () => {
	const stateRoot = mkdtempSync(path.join(tmpdir(), "pt-shared-connection-"));
	let authorizations = 0;
	const service: SharedCapabilityConnection = {
		status: async () => ({ id: "default", name: "飞书", state: "connected", checkedAt: new Date().toISOString() }),
		begin: async () => { authorizations++; return { id: "test", state: "pending", expiresAt: new Date().toISOString() }; },
		authorizationStatus: async () => undefined,
		cancel: async () => {},
		runtimeEnv: async () => ({ PUDDING_LARK_BROKER_URL: "http://127.0.0.1:1234" }),
	};
	const seen: Array<{ connection?: SharedCapabilityConnection; stateDir: string }> = [];
	const catalog = new ExtensionCatalog();
	catalog.register({
		manifest: { id: "lark-like", kind: "capability", name: "飞书", version: "1", tools: [] },
		register() {},
		runtime: { resolveSession: async ctx => {
			seen.push({ connection: ctx.connection, stateDir: ctx.stateDir });
			return { env: await ctx.connection!.runtimeEnv() };
		} },
	});
	catalog.setConnection("lark-like", service);
	const agents = ["manager", "worker-a", "worker-b"].map((name, index) => ({
		name, description: name, enabled: true, pinned: index === 0, invoke: { type: "pi" },
		capabilityExtensions: [{ id: "binding", extensionId: "lark-like", capabilityId: "lark-like", enabled: true, config: {} }],
	}) as AgentConfig);
	const runtimes = await Promise.all(agents.map(agent => resolveAgentCapabilityRuntime({ agent, catalog, stateRoot, cwd: process.cwd(), env: {} })));
	assert.equal(seen.length, 3);
	assert.ok(seen.every(item => item.connection === service));
	assert.equal(new Set(seen.map(item => item.stateDir)).size, 3);
	assert.ok(runtimes.every(runtime => runtime.env.PUDDING_LARK_BROKER_URL === "http://127.0.0.1:1234"));
	assert.equal(authorizations, 0);
});
