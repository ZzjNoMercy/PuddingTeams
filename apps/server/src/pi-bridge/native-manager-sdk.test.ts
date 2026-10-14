import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { WorkStateStore } from "../store/work-state.js";
import { CredentialsStore } from "../store/credentials.js";
import { McpServerStore } from "../store/mcp-servers.js";
import { WorkspaceExecutionCoordinator } from "../agent-runtime/workspace-execution.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { upsertCustomProvider } from "./custom-providers.js";
import { configureSharedModelRuntime, resetSharedModelRuntime } from "./model-runtime.js";
import { NativeToolExecution } from "./native-tool-execution.js";
import { PiSessionStore } from "./session-store.js";

test("真实 Pi 1.2 SDK：solo/group 原生 read/edit/bash→Goal 提交，与受管 MCP 共存，重建保持工具边界", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-native-manager-sdk-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	const cwd = path.join(root, "project"); await mkdir(cwd);
	await writeFile(path.join(cwd, "existing.txt"), "user baseline\n");
	const stateDir = path.join(root, "state");
	const states = new WorkStateStore(stateDir); await states.init();
	let sessionId = ""; let stage = 0; let modelCalls = 0; let mcpGet = 0; let mcpCalls = 0;
	const seenTools: string[][] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
		if (req.url === "/mcp") {
			if (req.method === "GET") { mcpGet++; res.writeHead(404).end(); return; }
			const rpc = JSON.parse(Buffer.concat(chunks).toString() || "{}");
			if (rpc.method === "notifications/initialized" || rpc.id === undefined) { res.writeHead(202).end(); return; }
			if (rpc.method === "tools/call") mcpCalls++;
			const result = rpc.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
				: rpc.method === "tools/list" ? { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }] }
					: { content: [{ type: "text", text: "pong" }] };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\r\n\r\n`); return;
		}
		if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
		const body = JSON.parse(Buffer.concat(chunks).toString());
		const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
		seenTools.push(tools); modelCalls++;
		const current = (await states.getActive(sessionId))!;
		const calls: Array<{ name: string; arguments: unknown }> = [
			{ name: "advance_manager_work_item", arguments: { goalId: current.goalId, workItemId: "W1", expectedRevision: current.revision, status: "in_progress" } },
			{ name: "read", arguments: { path: "existing.txt" } },
			{ name: "write", arguments: { path: "result.txt", content: "before\n" } },
			{ name: "edit", arguments: { path: "result.txt", edits: [{ oldText: "before", newText: "after" }] } },
			{ name: "bash", arguments: { command: 'test "$(cat result.txt)" = after' } },
			{ name: tools.find((name: string) => name.endsWith("_ping")) ?? "missing_mcp", arguments: {} },
			{ name: "advance_manager_work_item", arguments: { goalId: current.goalId, workItemId: "W1", expectedRevision: current.revision, status: "submitted", summary: "result.txt was written, edited and checked" } },
		];
		const call = calls[stage++];
		const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${modelCalls}`, object: "chat.completion.chunk", created: 1780000000, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (call) { send({ role: "assistant", tool_calls: [{ index: 0, id: `call-${modelCalls}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }); send({}, "tool_calls"); }
		else { send({ role: "assistant", content: "已提交实际执行证据" }); send({}, "stop"); }
		res.end("data: [DONE]\n\n");
	});
	let sessions: PiSessionStore | undefined;
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address(); assert(address && typeof address === "object");
		await upsertCustomProvider("native-manager-fixture", { name: "Fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "secrets", "auth.json"); await mkdir(path.dirname(authPath), { recursive: true });
		await writeFile(authPath, JSON.stringify({ "native-manager-fixture": { type: "api_key", key: "fixture-only" } }));
		resetSharedModelRuntime(); configureSharedModelRuntime({ authPath });
		const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "managed") }, cwd); await teams.init();
		await teams.upsertAgent({ name: "allowed-b", description: "Second Allowed Worker", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		await teams.upsertAgent({ name: "allowed", description: "Allowed Worker", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		await teams.upsertAgent({ name: "outside", description: "Outside Worker", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
		const credentials = new CredentialsStore(path.join(root, "mcp-secrets")); await credentials.init();
		const mcp = new McpServerStore(path.join(root, "config"), credentials);
		await mcp.create({ id: "docs", displayName: "Docs", definition: { url: `http://127.0.0.1:${address.port}/mcp` } });
		await teams.setMcpServerIds("manager", ["docs"], (await teams.getManager())!.extensionRevision ?? 0);
		const coordinator = new WorkspaceExecutionCoordinator(stateDir, { worktreeRoot: path.join(root, "worktrees") }); await coordinator.init();
		const native = new NativeToolExecution(stateDir, coordinator, teams, states); await native.init();
		const delegations = new DelegationStore(path.join(root, "runtime")); await delegations.init();
		const secrets = new InteractionSecretStore(path.join(root, "interaction-secrets")); await secrets.init();
		const drivers = new DriverRegistry(); const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), undefined, undefined, undefined, coordinator);
		const invoker = new AgentInvoker(teams, runtime, drivers, undefined, cwd); invoker.setNativeExecutionGuard((id) => native.assertDelegationReady(id));
		sessions = new PiSessionStore(cwd, path.join(root, "sessions"), teams, invoker, undefined, states, undefined, undefined, undefined, undefined, undefined, mcp, native);
		for (const type of ["solo", "group"] as const) {
			stage = 0;
			const summary = await sessions.create("native-manager-fixture/fixture-model", { type, members: type === "group" ? ["allowed", "allowed-b"] : [], cwd }); sessionId = summary.id;
			if (type === "solo") await teams.ensureSoloWindow(async () => ({ id: sessionId }), async () => true);
			else await teams.createWindow({ type, members: ["allowed", "allowed-b"], sessionId });
			const goal = await states.create({ sessionId, goal: "produce checked result", completionBoundary: "result checked and submitted", verificationPolicy: { minimumWorkItemMode: "manager_review", finalGoalMode: "manager_review", source: "user", reason: "SDK fixture", trigger: "manager_request" } });
			await states.updatePlan(sessionId, goal.revision, { upsertItems: [{ id: "W1", title: "write result", assignedAgentId: "manager", acceptanceCriteria: ["result checked"], workspaceExecutionClass: "non_git_write" }], reason: "fixture" }, `plan-${type}`, goal.execution.epoch, goal.goalId);
			const session = await sessions.open(sessionId); await session.prompt("请直接执行、验证并提交自己的工作项");
			const results = session.messages.filter((entry) => entry.role === "toolResult");
			assert.equal(results.length, 7); assert.ok(results.every((entry) => !entry.isError), JSON.stringify(results.filter((entry) => entry.isError)));
			const submission = (await states.getActive(sessionId))!.plan!.items.W1!.submissions[0]!;
			assert.equal(submission.source, "manager"); assert.equal(submission.nativeExecutions?.length, 4);
			assert.equal(submission.delegationId, undefined); assert.equal(await readFile(path.join(cwd, "result.txt"), "utf8"), "after\n");
			assert.equal((await runtime.listDelegations()).length, 0);
			const tools = session.getActiveToolNames();
			for (const name of ["read", "grep", "find", "ls", "edit", "write", "bash"]) assert(tools.includes(name));
			if (type === "group") assert.deepEqual((session.getAllTools().find(tool => tool.name === "delegation")!.parameters as { properties: { workerId: { enum: string[] } } }).properties.workerId.enum, ["allowed", "allowed-b"]);
		}
		assert.equal(mcpCalls, 2); assert.equal(mcpGet, 0);
		assert(seenTools.every((tools) => tools.includes("bash") && tools.some((name) => name.endsWith("_ping"))));
		await sessions.disposeAll();
		await teams.setMcpServerIds("manager", [], (await teams.getManager())!.extensionRevision ?? 0);
		const reopened = await sessions.open(sessionId);
		assert(reopened.getActiveToolNames().includes("bash"));
		assert(!reopened.getAllTools().some((tool) => tool.name.endsWith("_ping")), "explicit empty MCP selection must remain empty after reopen");
	} finally {
		await sessions?.disposeAll(); resetSharedModelRuntime(); configureSharedModelRuntime({ authPath: path.join(root, "reset-auth.json") });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
