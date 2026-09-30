import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { McpServerStore } from "../store/mcp-servers.js";
import { upsertCustomProvider } from "../pi-bridge/custom-providers.js";
import { configureSharedModelRuntime, resetSharedModelRuntime } from "../pi-bridge/model-runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { AgentRuntime } from "./runtime.js";
import { DriverRegistry } from "./driver-registry.js";
import { AgentInvoker } from "./invoker.js";
import { piExtensionHooks } from "./pi-extension.js";

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert(address && typeof address === "object");
	return address.port;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("真实 Pi SDK Worker 延迟启动仍以接单时 MCP 凭据完成工具调用", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-pi-worker-mcp-real-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	const seen: Array<{ method: string; token: string | undefined }> = [];
	const mcp = createServer(async (req, res) => {
		if (req.method === "GET") { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const data = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string | number; method?: string };
		if (data.method === "initialize" || data.method === "tools/list" || data.method === "tools/call") {
			seen.push({ method: data.method, token: req.headers.authorization });
		}
		if (data.method === "notifications/initialized") { res.writeHead(202).end(); return; }
		const result = data.method === "initialize"
			? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
			: data.method === "tools/list"
				? { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }] }
				: { content: [{ type: "text", text: "pong" }] };
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: data.id, result })}\r\n\r\n`);
	});
	let modelCalls = 0;
	const model = createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string }> };
		const ping = body.tools?.map((tool) => tool.function?.name).find((name) => name?.endsWith("_ping"));
		const callTool = Boolean(ping) && !(body.messages ?? []).some((message) => message.role === "tool");
		const id = `fixture-${++modelCalls}`;
		const send = (delta: unknown, finishReason: string | null = null): void => {
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1780000000, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
		};
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (callTool) {
			send({ role: "assistant", tool_calls: [{ index: 0, id: `call-${modelCalls}`, type: "function", function: { name: ping, arguments: "{}" } }] });
			send({}, "tool_calls");
		} else {
			send({ role: "assistant", content: "Pi Worker 已完成。" });
			send({}, "stop");
		}
		res.end("data: [DONE]\n\n");
	});
	try {
		const mcpPort = await listen(mcp);
		const modelPort = await listen(model);
		await upsertCustomProvider("fixture", { name: "Fixture", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "secrets", "auth.json");
		mkdirSync(path.dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify({ fixture: { type: "api_key", key: "fixture-only" } }));
		configureSharedModelRuntime({ authPath });
		resetSharedModelRuntime();
		const teams = new TeamsStore({ state: path.join(root, "state"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "managed") }, root);
		await teams.init();
		const credentials = new CredentialsStore(path.join(root, "mcp-secrets"));
		await credentials.init();
		const catalog = new McpServerStore(path.join(root, "config"), credentials);
		await catalog.create({ id: "docs", displayName: "Docs", definition: { url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: "Bearer ${API_TOKEN}" } }, secrets: { API_TOKEN: "old-token" } });
		const agent = await teams.upsertAgent({ name: "pi_snapshot", description: "Pi snapshot", connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: { model: "fixture/fixture-model" } }, mcpServerIds: ["docs"], enabled: true });
		const window = await teams.createWindow({ type: "direct", members: [agent.name], sessionId: "manager-real-snapshot" });
		const drivers = new DriverRegistry();
		const factory = piExtensionHooks({ sessionDir: path.join(root, "sessions", "workers") }).driverFactory;
		assert.ok(factory);
		drivers.registerFactory("pi", factory);
		const delegations = new DelegationStore(path.join(root, "delegations"));
		await delegations.init();
		const interactions = new InteractionSecretStore(path.join(root, "interactions"));
		await interactions.init();
		const runtime = new AgentRuntime(delegations, interactions, (id) => drivers.get(id), { ttlMs: 60_000 });
		const invoker = new AgentInvoker(teams, runtime, drivers, undefined, root, undefined, undefined, undefined, undefined, catalog);
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => { entered = resolve; });
		let release!: () => void;
		const hold = new Promise<void>((resolve) => { release = resolve; });
		let admittedId = "";
		const first = invoker.delegate({
			windowId: window.id, managerSessionId: "manager-real-snapshot", agent, message: "调用 Docs ping", mode: "run",
			onBeforeDriverStart: async (delegation) => { admittedId = delegation.id; entered(); await hold; },
		});
		try {
			await reached;
			assert.equal((await delegations.getDelegation(admittedId))?.executionState, "running", "暂停时 Run 已持久接单");
			assert.equal(seen.length, 0, "持久接单后尚未启动 Worker/MCP");
			await catalog.update("docs", { displayName: "Docs", definition: { url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: "Bearer ${API_TOKEN}" } }, secrets: { API_TOKEN: "new-token" } });
			await teams.bumpAgentRevision(agent.name);
		} finally { release(); }
		assert.equal((await first).status, "completed");
		assert.deepEqual(new Set(seen.map((item) => item.method)), new Set(["initialize", "tools/list", "tools/call"]));
		assert.ok(seen.every((item) => item.token === "Bearer old-token"), "旧 Run 的所有 MCP 请求必须使用接单快照");
		assert.deepEqual(seen.filter((item) => item.method === "tools/call").map((item) => item.token), ["Bearer old-token"]);
		const firstRequestCount = seen.length;
		const nextAgent = (await teams.getAgent(agent.name))!;
		assert.equal((await invoker.delegate({ windowId: window.id, managerSessionId: "manager-real-snapshot", agent: nextAgent, message: "再次调用 Docs ping", mode: "run" })).status, "completed");
		const nextRequests = seen.slice(firstRequestCount);
		assert.deepEqual(new Set(nextRequests.map((item) => item.method)), new Set(["initialize", "tools/list", "tools/call"]));
		assert.ok(nextRequests.every((item) => item.token === "Bearer new-token"), "下一条 Run 的所有 MCP 请求必须使用新凭据");
		assert.deepEqual(seen.filter((item) => item.method === "tools/call").map((item) => item.token), ["Bearer old-token", "Bearer new-token"]);
		assert.equal(modelCalls, 4);
	} finally {
		await close(model).catch(() => undefined);
		await close(mcp).catch(() => undefined);
		resetSharedModelRuntime();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
