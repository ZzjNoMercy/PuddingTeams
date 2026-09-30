import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { McpCatalogRecoveryRequiredError, McpServerStore } from "../store/mcp-servers.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { AgentRuntime } from "./runtime.js";
import { DriverRegistry } from "./driver-registry.js";
import { AgentInvoker } from "./invoker.js";
import type { AgentDriver, AgentEvent, DriverCapabilities } from "./types.js";

test("已接单 Pi Worker 在延迟启动时仍使用接单时的 MCP 定义快照", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-mcp-snapshot-"));
	const teams = new TeamsStore({ state: path.join(root, "state"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "managed") }, root);
	await teams.init();
	const credentials = new CredentialsStore(path.join(root, "mcp-secrets"));
	await credentials.init();
	const mcp = new McpServerStore(path.join(root, "config"), credentials);
	await mcp.create({ id: "docs", displayName: "Docs", definition: { command: "echo", env: { API_TOKEN: "${API_TOKEN}" } }, secrets: { API_TOKEN: "old-token" } });
	const agent = await teams.upsertAgent({ name: "pi_snapshot", description: "Pi snapshot", connector: {
		extensionId: "pi", connectorId: "pi", transport: "sdk", config: {},
	}, mcpServerIds: ["docs"], enabled: true });
	const window = await teams.createWindow({ type: "direct", members: [agent.name], sessionId: "manager-snapshot" });
	const observations: string[] = [];
	const originalDefinitionsFor = mcp.definitionsFor.bind(mcp);
	mcp.definitionsFor = async (ids) => {
		const definitions = await originalDefinitionsFor(ids);
		observations.push(definitions.docs?.env?.API_TOKEN ?? "missing");
		return definitions;
	};
	let entered!: () => void;
	const reached = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	let starts = 0;
	const drivers = new DriverRegistry();
	drivers.registerFactory("pi", (config): AgentDriver => {
		const capabilities: DriverCapabilities = { operations: ["run", "continue", "respond", "cancel"], interactionKinds: [], progress: "none", transport: "sdk" };
		const run = async function* (): AsyncIterable<AgentEvent> {
			if (starts++ === 0) { entered(); await hold; }
			const factories = config.managedExtensionFactoriesFor as (() => Promise<unknown[]>) | undefined;
			assert.ok(factories);
			await factories();
			yield { type: "completed", result: { agentId: "pi", status: "completed", content: "done" } };
		};
		return {
			id: "pi", capabilities: async () => capabilities, run, continue: run, respond: run,
			cancel: async () => undefined,
			probe: async () => ({ extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true, compatibility: "supported", capabilities, issues: [] }),
		};
	});
	const delegations = new DelegationStore(path.join(root, "delegations"));
	await delegations.init();
	const interactionSecrets = new InteractionSecretStore(path.join(root, "interaction-secrets"));
	await interactionSecrets.init();
	const runtime = new AgentRuntime(delegations, interactionSecrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, root, undefined, undefined, undefined, undefined, mcp);
	const first = invoker.delegate({ windowId: window.id, managerSessionId: "manager-snapshot", agent, message: "first", mode: "run" });
	await reached;
	assert.deepEqual(observations, ["old-token"], "MCP 定义必须在接单门禁内冻结");
	await mcp.update("docs", { displayName: "Docs", definition: { command: "echo", env: { API_TOKEN: "${API_TOKEN}" } }, secrets: { API_TOKEN: "new-token" } });
	await teams.bumpAgentRevision(agent.name);
	release();
	assert.equal((await first).status, "completed");
	assert.deepEqual(observations, ["old-token"], "延迟的 Worker 启动不得重新读取新凭据");
	const nextAgent = (await teams.getAgent(agent.name))!;
	assert.equal((await invoker.delegate({ windowId: window.id, managerSessionId: "manager-snapshot", agent: nextAgent, message: "second", mode: "run" })).status, "completed");
	assert.deepEqual(observations, ["old-token", "new-token"]);
	let degradedReads = 0;
	mcp.definitionsFor = async () => { degradedReads++; throw new Error("injected catalog read failure"); };
	assert.equal((await invoker.delegate({ windowId: window.id, managerSessionId: "manager-snapshot", agent: nextAgent, message: "catalog unavailable", mode: "run" })).status, "completed", "普通 MCP 读取故障只降级工具");
	assert.equal(degradedReads, 1, "降级后的 Driver 装配不能二次读取故障 Catalog");
	assert.deepEqual(observations, ["old-token", "new-token"], "降级后不能回退到旧 MCP 凭据");
	mcp.definitionsFor = async () => { throw new McpCatalogRecoveryRequiredError(); };
	await assert.rejects(
		() => invoker.delegate({ windowId: window.id, managerSessionId: "manager-snapshot", agent: nextAgent, message: "catalog uncertain", mode: "run" }),
		McpCatalogRecoveryRequiredError,
		"目录提交状态未知时必须阻断接单",
	);
});
