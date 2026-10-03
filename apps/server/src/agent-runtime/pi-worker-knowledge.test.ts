import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { KnowledgeMountSurface } from "../knowledge/runtime-service.js";
import { upsertCustomProvider } from "../pi-bridge/custom-providers.js";
import { configureSharedModelRuntime, resetSharedModelRuntime } from "../pi-bridge/model-runtime.js";
import { LocalPiDriver, liveWorkerSession } from "./pi-driver.js";
import type { AgentEvent } from "./types.js";
import { piExtensionHooks } from "./pi-extension.js";
import { CredentialsStore } from "../store/credentials.js";
import { WebResearchSettings, webResearchTarget } from "../network/web-research.js";

interface ProviderRequest {
	tools?: Array<{ function?: { name?: string } }>;
	messages?: Array<{ role?: string; content?: unknown }>;
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert(address && typeof address === "object");
	return address.port;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<{ handle: string; events: AgentEvent[] }> {
	const result: AgentEvent[] = [];
	let handle = "";
	for await (const event of events) {
		result.push(event);
		if (event.type === "started") handle = event.sessionHandle ?? "";
	}
	assert.ok(handle, JSON.stringify(result));
	return { handle, events: result };
}

const knowledgeToolNames = ["knowledge_context", "knowledge_search", "knowledge_glob", "knowledge_read", "knowledge_links", "knowledge_request_curation"].sort();

function surface(fingerprint: string, text: string, onRead: () => void = () => {}): KnowledgeMountSurface {
	return {
		fingerprint, prompt: `平台固定挂载 ${fingerprint}；使用 knowledge_read 阅读正文。`,
		assertCurrent: async () => {},
		tools: knowledgeToolNames.map((name) => defineTool({
			name, label: name, description: `平台 ${name} 工具`, parameters: Type.Object({}),
			execute: async () => {
				if (name === "knowledge_read") onRead();
				return { content: [{ type: "text", text: name === "knowledge_read" ? text : "平台工具回执" }], details: {} };
			},
		})),
	};
}

test("真实 Pi SDK：Wiki 隔离与核权，新增普通 Worker 使用只读知识工具和专用 memory 请求", { timeout: 30_000 }, async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-pi-worker-knowledge-real-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	const requests: ProviderRequest[] = [];
	let requestedTool = "knowledge_read";
	const model = createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderRequest;
		requests.push(body);
		const hasRead = body.tools?.some((tool) => tool.function?.name === requestedTool);
		const lastUser = body.messages?.map(message => message.role).lastIndexOf("user") ?? -1;
		const callRead = hasRead && !body.messages?.slice(lastUser + 1).some(message => message.role === "tool");
		const id = `knowledge-fixture-${requests.length}`;
		const send = (delta: unknown, finishReason: string | null = null): void => {
			res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1780000000, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
		};
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (callRead) {
			send({ role: "assistant", tool_calls: [{ index: 0, id: `read-${requests.length}`, type: "function", function: { name: requestedTool, arguments: requestedTool === "fetch_url" ? JSON.stringify({url:"https://example.com"}) : "{}" } }] });
			send({}, "tool_calls");
		} else {
			send({ role: "assistant", content: "平台知识工具已完成。" });
			send({}, "stop");
		}
		res.end("data: [DONE]\n\n");
	});
	const handles: string[] = [];
	try {
		const port = await listen(model);
		await upsertCustomProvider("knowledge-fixture", { name: "Knowledge fixture", baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "secrets", "auth.json");
		mkdirSync(path.dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify({ "knowledge-fixture": { type: "api_key", key: "fixture-only" } }));
		writeFileSync(path.join(root, "AGENTS.md"), "CWD_UNTRUSTED_KNOWLEDGE_MARKER");
		resetSharedModelRuntime();
		configureSharedModelRuntime({ authPath });
		let mcpFactoryCalls = 0;
		let capabilityCalls = 0;
		let webCalls = 0;
		const credentials = new CredentialsStore(path.join(root,"secrets","web-research")); await credentials.init();
		const webResearch = new WebResearchSettings(credentials,undefined,async()=>{webCalls++;return {status:200,headers:{"content-type":"text/html"},body:Buffer.from("<main>PUBLIC_NETWORK_EVIDENCE</main>")};},
			{targets:async()=>[webResearchTarget({name:"wiki",builtinId:"wiki",description:"Wiki",connector:{extensionId:"pi",connectorId:"pi",transport:"sdk",config:{}}})]});
		let active = surface("mount-A-revision-1", "KB_A_SECRET_OLD_FIXED_VERSION");
		const driver = piExtensionHooks().driverFactory!({
			executionProfile: "wiki_curator", model: "knowledge-fixture/fixture-model", sessionDir: path.join(root, "sessions"),
			knowledgeFor: async () => active,
			managedExtensionFactoriesFor: async () => { mcpFactoryCalls++; throw new Error("Wiki must not instantiate MCP"); },
			capabilityRuntimeFor: async () => { capabilityCalls++; throw new Error("Wiki must not instantiate Capability"); },
			webResearchToolsFor: () => webResearch.tools("wiki"),
			managedExtensionsFingerprintFor: () => webResearch.accessFingerprint("wiki"),
		},"sdk");
		const ctx = { cwd: root, env: {} };
		const run = async (message: string, handle?: string) => {
			const result = await collect(handle
				? driver.continue({ sessionHandle: handle, message, requestId: message }, ctx)
				: driver.run({ message, requestId: message }, ctx));
			handles.push(result.handle);
			return result;
		};
		const first = await run("read-A");
		assert.equal(first.events.at(-1)?.type, "completed", JSON.stringify(first.events));
		assert.equal(requests.length, 2, "真实 SDK 应执行一次知识工具循环");
		assert.ok(JSON.stringify(requests[1]).includes("KB_A_SECRET_OLD_FIXED_VERSION"), "读取结果确实发往 provider");
		// A separate process has no resident-session cache: only the JSONL can restore context.
		const childFile = path.join(root, "cold-worker.mts");
		const localModule = (relative: string) => new URL(relative, import.meta.url).href;
		writeFileSync(childFile, `
import { LocalPiDriver } from ${JSON.stringify(localModule("./pi-driver.ts"))};
import { configureSharedModelRuntime } from ${JSON.stringify(localModule("../pi-bridge/model-runtime.ts"))};
import { upsertCustomProvider } from ${JSON.stringify(localModule("../pi-bridge/custom-providers.ts"))};
configureSharedModelRuntime({authPath:${JSON.stringify(authPath)}});
await upsertCustomProvider("knowledge-fixture", {name:"Knowledge fixture",baseUrl:${JSON.stringify(`http://127.0.0.1:${port}/v1`)},api:"openai-completions",models:[{id:"fixture-model"}]});
const driver=new LocalPiDriver({model:"knowledge-fixture/fixture-model",executionProfile:"wiki_curator",sessionDir:${JSON.stringify(path.join(root,"sessions"))},knowledgeFor:async()=>({fingerprint:"mount-A-revision-1",prompt:"当前没有新的读取请求",tools:[],assertCurrent:async()=>{}})});
let handle="", outcome="";
for await(const event of driver.continue({sessionHandle:${JSON.stringify(first.handle)},message:"进程重启后继续最初请求",requestId:"cold-resume"},{cwd:${JSON.stringify(root)},env:{}})){if(event.type==="started")handle=event.sessionHandle;if(["completed","failed"].includes(event.type))outcome=event.type;}
console.log("COLD_RESULT:"+JSON.stringify({handle,outcome}));
`);
		const coldStart = requests.length;
		const coldOutput = await new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), childFile], { env: process.env });
			let output = "", errors = "";
			child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
			child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(errors)));
		});
		const coldResult = JSON.parse(coldOutput.split("\n").find(line => line.startsWith("COLD_RESULT:"))!.slice("COLD_RESULT:".length));
		assert.equal(coldResult.handle, first.handle); assert.equal(coldResult.outcome, "completed");
		assert.equal(requests.length - coldStart, 1);
		assert.ok(JSON.stringify(requests.at(-1)?.messages).includes("read-A"));
		assert.ok(JSON.stringify(requests.at(-1)?.messages).includes("KB_A_SECRET_OLD_FIXED_VERSION"));
		assert.ok(JSON.stringify(requests.at(-1)?.messages).includes("进程重启后继续最初请求"));
		const same = await run("continue-A", first.handle);
		assert.equal(same.events.at(-1)?.type, "completed", JSON.stringify(same.events));
		assert.equal(same.handle, first.handle, "同一挂载可续接原会话");
		assert.ok(JSON.stringify(requests[2]).includes("KB_A_SECRET_OLD_FIXED_VERSION"));
		active = surface("mount-B-revision-2", "KB_B_SECRET_NEW_FIXED_VERSION");
		const changeStart = requests.length;
		const changed = await run("read-B", same.handle);
		assert.equal(changed.events.at(-1)?.type, "completed", JSON.stringify(changed.events));
		assert.equal(changed.handle, same.handle, "配置变化只重建工具，同聊天 JSONL 和上下文必须连续");
		assert.equal(requests.length - changeStart, 2);
		assert.ok(requests.slice(changeStart).every(request => JSON.stringify(request).includes("KB_A_SECRET_OLD_FIXED_VERSION")), "同聊天已读取的历史事实仍是上下文，不授予当前读取权限");
		assert.ok(JSON.stringify(requests.at(-1)).includes("KB_B_SECRET_NEW_FIXED_VERSION"));
		for (const request of requests.filter((_, index) => index !== coldStart)) {
			assert.deepEqual(request.tools?.map((tool) => tool.function?.name).sort(), knowledgeToolNames, "实际 provider 工具集不得含原生文件/执行/MCP 工具");
			assert.ok(!JSON.stringify(request).includes("CWD_UNTRUSTED_KNOWLEDGE_MARKER"), "Wiki 不加载 cwd AGENTS.md");
		}
		active = { fingerprint: "no-knowledge-revision-3", prompt: "本轮已撤销所有知识库挂载。", tools: [], assertCurrent: async () => {} };
		const narrowStart = requests.length;
		const narrowed = await run("no-knowledge", changed.handle);
		assert.equal(narrowed.events.at(-1)?.type, "completed", JSON.stringify(narrowed.events));
		assert.equal(narrowed.handle, changed.handle);
		assert.equal(requests.length - narrowStart, 1);
		assert.deepEqual(requests.at(-1)?.tools ?? [], []);
		assert.ok(JSON.stringify(requests.at(-1)).includes("KB_A_SECRET_OLD_FIXED_VERSION"));
		assert.ok(JSON.stringify(requests.at(-1)).includes("KB_B_SECRET_NEW_FIXED_VERSION"));
		assert.equal(mcpFactoryCalls, 0);
		assert.equal(capabilityCalls, 0);
		let revoked = false;
		active = surface("revoke-between-tool-and-provider", "REVOKED_KNOWLEDGE_MUST_NOT_LEAVE_HOST", () => { revoked = true; });
		active.assertCurrent = async () => { if (revoked) throw new Error("FIXTURE_KNOWLEDGE_REVOKED"); };
		const revokeStart = requests.length;
		const interrupted = await run("read-then-revoke");
		assert.equal(requests.length - revokeStart, 1, "工具后撤权须阻止下一次 provider 请求");
		assert.ok(!JSON.stringify(requests).includes("REVOKED_KNOWLEDGE_MUST_NOT_LEAVE_HOST"));
		assert.equal(interrupted.events.at(-1)?.type, "failed", JSON.stringify(interrupted.events));
		assert.equal(mcpFactoryCalls, 0);
		assert.equal(capabilityCalls, 0);
		// The Wiki role can explicitly enable host network tools without loading MCP,
		// native file/exec tools or general extensions. Exercise the real Pi factory.
		active = surface("wiki-public-web", "KB_WEB_READ_ONLY");
		let webView = await webResearch.view();
		webView = await webResearch.saveGrant("wiki",{expectedRevision:webView.revision,grant:{search:false,fetch:true}});
		requestedTool = "fetch_url";
		const webStart = requests.length;
		const webRun = await run("wiki-read-public-url");
		assert.equal(webRun.events.at(-1)?.type,"completed",JSON.stringify(webRun.events)); assert.equal(webCalls,1);
		for(const request of requests.slice(webStart)) assert.deepEqual(request.tools?.map(tool=>tool.function?.name).sort(),[...knowledgeToolNames,"fetch_url"].sort());
		assert.ok(JSON.stringify(requests.at(-1)).includes("PUBLIC_NETWORK_EVIDENCE"),"授权网页正文确实进入 SDK 工具回合");
		webView = await webResearch.save({expectedRevision:webView.revision,settings:{...webView.settings,enabled:true},grants:{wiki:{search:true,fetch:true}}});
		const bothStart = requests.length;
		const both = await run("wiki-network-expanded",webRun.handle);
		assert.equal(both.handle,webRun.handle,"新增工具重建运行实例但保留聊天历史");
		for(const request of requests.slice(bothStart)) assert.deepEqual(request.tools?.map(tool=>tool.function?.name).sort(),[...knowledgeToolNames,"fetch_url","web_search"].sort());
		await webResearch.saveGrant("wiki",{expectedRevision:webView.revision,grant:{search:false,fetch:false}});
		requestedTool = "knowledge_read";
		const revokeWebStart = requests.length;
		const revokeWeb = await run("wiki-network-revoked",both.handle);
		assert.equal(revokeWeb.handle,both.handle);
		for(const request of requests.slice(revokeWebStart)) assert.deepEqual(request.tools?.map(tool=>tool.function?.name).sort(),knowledgeToolNames);
		assert.equal(mcpFactoryCalls,0); assert.equal(capabilityCalls,0);
		// No Job or Worker transcript is needed to restore the real conversation.
		active = { fingerprint: "conversation-recovery", prompt: "当前没有挂载工具", tools: [], assertCurrent: async () => {} };
		let historyReads = 0;
		const fallback = new LocalPiDriver({ model: "knowledge-fixture/fixture-model", executionProfile: "wiki_curator", sessionDir: path.join(root, "sessions"),
			knowledgeFor: async () => active, conversationHistoryFor: async () => {
				historyReads++; return [{ role: "user", content: "原请求：2026-10-03 晚8点在北京与刘大强、周泽宇吃饭", timestamp: 1791022107900 },
					{ role: "assistant", content: "已读到原请求，尚未整理", timestamp: 1791022108000 }];
			} });
		const fallbackStart = requests.length;
		const recoveredChat = await collect(fallback.continue({ sessionHandle: "missing-worker-transcript", message: "继续", requestId: "restore" }, ctx));
		handles.push(recoveredChat.handle);
		assert.equal(recoveredChat.events.at(-1)?.type, "completed");
		assert.equal(historyReads, 1);
		const restoredRequest = requests[fallbackStart]!;
		assert.ok(JSON.stringify(restoredRequest.messages).includes("原请求：2026-10-03"));
		assert.ok(JSON.stringify(restoredRequest.messages).includes("已读到原请求"));
		assert.equal(restoredRequest.messages?.filter(message => message.role === "user" && JSON.stringify(message.content).includes("继续")).length, 1);
		active = { ...active, fingerprint: "conversation-recovery-new-tool-version" };
		const nextChat = await collect(fallback.continue({ sessionHandle: recoveredChat.handle, message: "仍然按原日期", requestId: "continue" }, ctx));
		assert.equal(nextChat.handle, recoveredChat.handle);
		assert.equal(historyReads, 1, "已有历史不重复注入来源聊天");
		assert.equal(requests.at(-1)?.messages?.filter(message => message.role === "user" && JSON.stringify(message.content).includes("原请求：2026-10-03")).length, 1);
		assert.ok(JSON.stringify(requests.at(-1)).includes("仍然按原日期"));
		// A newly constructed ordinary worker needs no wiki profile, template or per-agent resource setting.
		requestedTool = "memory_request_update";
		const ordinaryStart = requests.length;
		const ordinarySurface = surface("default-memory-for-new-worker", "MEMORY_READ_ONLY_RESULT");
		ordinarySurface.tools = ordinarySurface.tools.filter(tool => tool.name !== "knowledge_request_curation");
		ordinarySurface.tools.push(defineTool({ name: "memory_request_update", label: "更新记忆", description: "默认 memory 待审核请求",
			parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "MEMORY_REQUEST_PENDING_REVIEW" }], details: {} }) }));
		const ordinary = new LocalPiDriver({ model: "knowledge-fixture/fixture-model", sessionDir: path.join(root, "sessions"),
			knowledgeFor: async () => ordinarySurface });
		const ordinaryRun = await collect(ordinary.run({ message: "处理业务任务时请求记住长期偏好", requestId: "new-ordinary-worker" }, ctx));
		handles.push(ordinaryRun.handle);
		assert.equal(ordinaryRun.events.at(-1)?.type, "completed", JSON.stringify(ordinaryRun.events));
		assert.equal(requests.length - ordinaryStart, 2);
		for (const request of requests.slice(ordinaryStart)) {
			const names = request.tools?.map(tool => tool.function?.name) ?? [];
			assert(knowledgeToolNames.filter(name => name !== "knowledge_request_curation").every(name => names.includes(name)));
			assert(!names.includes("knowledge_request_curation"));
			assert(names.includes("memory_request_update"));
			assert(JSON.stringify(request).includes("default-memory-for-new-worker"));
		}
		assert(JSON.stringify(requests.at(-1)).includes("MEMORY_REQUEST_PENDING_REVIEW"));
	} finally {
		for (const handle of new Set(handles)) liveWorkerSession(handle)?.dispose();
		model.closeAllConnections();
		await new Promise<void>((resolve) => model.close(() => resolve()));
		resetSharedModelRuntime();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
