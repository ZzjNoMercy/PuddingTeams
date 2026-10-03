import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { upsertCustomProvider } from "../pi-bridge/custom-providers.js";
import { configureSharedModelRuntime, resetSharedModelRuntime, sharedModelRuntime } from "../pi-bridge/model-runtime.js";
import { TeamsStore } from "../store/teams.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSelectionStore } from "./selections.js";
import { KnowledgeRuntimeService, type KnowledgeMountSurface } from "./runtime-service.js";

test("真实 Manager SDK 配置变化和重建保留同聊天历史，当前权限仍在 provider 边界核对", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-manager-knowledge-sdk-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	const requests: Array<{ messages?: Array<{ role: string }>; tools?: unknown[] }> = [];
	const server = createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = JSON.parse(Buffer.concat(chunks).toString()) as typeof requests[number];
		requests.push(body);
		const read = !body.messages?.some((message) => message.role === "tool");
		const send = (delta: unknown, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({
			id: `manager-fixture-${requests.length}`, object: "chat.completion.chunk", created: 1780000000, model: "fixture-model",
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (read) {
			send({ role: "assistant", tool_calls: [{ index: 0, id: `read-${requests.length}`, type: "function", function: { name: "knowledge_read", arguments: "{}" } }] });
			send({}, "tool_calls");
		} else { send({ role: "assistant", content: "读取完成" }); send({}, "stop"); }
		res.end("data: [DONE]\n\n");
	});
	const sessions: AgentSession[] = [];
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address(); assert(address && typeof address === "object");
		await upsertCustomProvider("manager-knowledge-fixture", { name: "Manager fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "secrets", "auth.json"); await mkdir(path.dirname(authPath), { recursive: true });
		await writeFile(authPath, JSON.stringify({ "manager-knowledge-fixture": { type: "api_key", key: "fixture-only" } }));
		resetSharedModelRuntime(); configureSharedModelRuntime({ authPath });
		const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "managed") }, root); await teams.init();
		const bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
		const deps = { bindings, teams, objects: new KnowledgeObjectStore(path.join(root, "objects")), acceptance: new KnowledgeAcceptanceStore(path.join(root, "acceptance")),
			selections: new KnowledgeSelectionStore(path.join(root, "state"), bindings), stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache") };
		let active: KnowledgeMountSurface = { fingerprint: "manager-mount-A", prompt: "平台挂载 A", tools: [], assertCurrent: async () => {} };
		let swallowedContextThrows = 0;
		const runtime = await sharedModelRuntime(); const model = runtime.getModel("manager-knowledge-fixture", "fixture-model"); assert.ok(model);
		const sessionDir = path.join(root, "sessions");
		const open = async (manager: SessionManager): Promise<AgentSession> => {
			const service = new KnowledgeRuntimeService(deps);
			service.forSession = async () => active;
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager: SettingsManager.inMemory(),
				noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true,
				extensionFactories: [(pi) => { pi.on("context", async () => { swallowedContextThrows++; throw new Error("SDK_CONTEXT_EXTENSION_THROW_IS_SWALLOWED"); }); }, service.managerExtension(() => manager.getSessionId())],
			});
			await loader.reload();
			const { session } = await createAgentSession({ cwd: root, model, modelRuntime: runtime, sessionManager: manager, resourceLoader: loader,
				settingsManager: SettingsManager.inMemory(), noTools: "all", tools: ["knowledge_read"], customTools: [defineTool({
					name: "knowledge_read", label: "知识正文", description: "平台固定采纳正文", parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "PERSISTED_MANAGER_SECRET_A" }], details: {} }),
				})] });
			await session.bindExtensions({ mode: "rpc" });
			// A fresh service instance represents process/session reconstruction. The
			// real guard must use the JSONL profile, rather than extension closure state.
			service.guardManagerSession(session);
			sessions.push(session); return session;
		};
		const manager = SessionManager.create(root, sessionDir);
		const initial = await open(manager);
		await initial.prompt("读取 A");
		assert.equal(requests.length, 2, "初始读取真实执行工具并继续请求 provider");
		assert.ok(JSON.stringify(requests.at(-1)).includes("PERSISTED_MANAGER_SECRET_A"));
		assert.equal(swallowedContextThrows, 2, "SDK 的扩展异常确实被吞掉，不能作为核权边界");
		const profile = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "pudding:knowledge-profile");
		assert.ok(profile?.type === "custom"); assert.deepEqual(profile.data, { fingerprint: createHash("sha256").update(JSON.stringify(["manager-delegation-v1", active.fingerprint])).digest("hex"), profile: "manager" });
		const file = manager.getSessionFile(); assert.ok(file); initial.dispose();
		const same = await open(SessionManager.open(file, sessionDir));
		await same.prompt("相同挂载重启后续聊");
		assert.equal(requests.length, 3); assert.equal(same.sessionId, initial.sessionId);
		assert.ok(JSON.stringify(requests.at(-1)).includes("PERSISTED_MANAGER_SECRET_A")); same.dispose();
		active = { ...active, fingerprint: "manager-mount-B" };
		const changed = await open(SessionManager.open(file, sessionDir));
		await changed.prompt("重启后挂载 B");
		assert.equal(requests.length, 4, "配置变化不要求用户新建聊天");
		assert.equal(changed.sessionId, initial.sessionId);
		assert.ok(JSON.stringify(requests.at(-1)).includes("PERSISTED_MANAGER_SECRET_A")); changed.dispose();
		active = { fingerprint: "no-mounted-knowledge", prompt: "已撤销挂载", tools: [], assertCurrent: async () => {} };
		const narrowed = await open(SessionManager.open(file, sessionDir));
		await narrowed.prompt("重启后撤销全部挂载");
		assert.equal(requests.length, 5, "撤销挂载保留对话，当前路由元数据刷新");
		assert.equal(narrowed.sessionId, initial.sessionId);
		assert.ok(JSON.stringify(requests.at(-1)).includes("PERSISTED_MANAGER_SECRET_A")); narrowed.dispose();
		active = { fingerprint: "manager-mount-A", prompt: "平台挂载 A", tools: [], assertCurrent: async () => { throw new Error("MANAGER_AUTHORITY_REVOKED"); } };
		const revoked = await open(SessionManager.open(file, sessionDir));
		await revoked.prompt("同指纹但权限已撤销");
		assert.equal(requests.length, 5, "同指纹也须检查当前权限");
		assert.match(JSON.stringify(revoked.messages.at(-1)), /MANAGER_AUTHORITY_REVOKED/);
		assert.equal(swallowedContextThrows, 6, "失败请求仍经过会吞异常的扩展；仅 stream fence 阻止外发");
	} finally {
		for (const session of sessions) session.dispose(); server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve())); resetSharedModelRuntime();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
