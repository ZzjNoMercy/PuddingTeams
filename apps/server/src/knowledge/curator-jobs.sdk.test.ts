import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { upsertCustomProvider, applyThinkingCapabilityOverrides } from "../pi-bridge/custom-providers.js";
import { configureSharedModelRuntime, resetSharedModelRuntime } from "../pi-bridge/model-runtime.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSelectionStore } from "./selections.js";
import { KnowledgeRuntimeService } from "./runtime-service.js";
import { KnowledgeSourceStore } from "./sources.js";
import { CuratorJobStore, WikiCuratorService } from "./curator-jobs.js";
import { ReviewStore } from "./wiki/review-store.js";
import { MarkdownWikiPublisher } from "./wiki/publisher-markdown.js";
import { PublishJournal } from "./wiki/publish-journal.js";
import { KnowledgeObservationService } from "./observation.js";
import { KnowledgeSearchIndex } from "./search-index.js";
import { LocalPiDriver, liveWorkerSession } from "../agent-runtime/pi-driver.js";
import type { AgentEvent } from "../agent-runtime/types.js";

const schema = { formatVersion: 1, schemaId: "sdk-fixture", revision: 1, name: "SDK schema", description: "固定结构",
	entities: [{ type: "fact", directory: "facts", fields: [{ name: "type", type: "text", required: true },
		{ name: "title", type: "text", required: true }, { name: "sources", type: "text_list", required: true }] }], relations: [] };
const expectedTools = ["knowledge_context", "knowledge_search", "knowledge_glob", "knowledge_read", "knowledge_links", "knowledge_submit_candidate"].sort();
interface RequestBody {
	tools?: Array<{ function?: { name?: string } }>;
	messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
}
interface PromptPayload { task: string; sources: Array<{ id: string; content: string }>; schema: typeof schema; operationContract: string; allowedSourceIds: string[] }
function payload(body: RequestBody): PromptPayload {
	for (const message of body.messages ?? []) {
		if (message.role !== "user") continue;
		const text = typeof message.content === "string" ? message.content : message.content?.map((block) => block.text ?? "").join("") ?? "";
		try { const value = JSON.parse(text) as PromptPayload; if (value.sources && value.task) return value; } catch { /* Other SDK context messages. */ }
	}
	throw new Error("Missing actual Wiki Curator source payload");
}

test("真实SDK复现目录和日期拒绝后修正：根绑定wiki目录候选可审核发布", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-curator-schema-repair-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	let turns = 0, handlerError: unknown;
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
			const prompt = payload(body) as PromptPayload & { pathRules: { entityDirectories: Array<{ type: string; directory: string }> }; fieldFormats: { currentTimestamp: string } };
			turns++;
			assert.equal(prompt.pathRules.entityDirectories[0]!.directory, "wiki/facts");
			if (turns === 2) {
				const feedback = JSON.stringify(body.messages);
				assert.match(feedback, /invalid:created/); assert.match(feedback, /invalid_directory/);
				assert.match(feedback, /wiki\/facts/); assert.match(feedback, /ISO/);
			}
			assert(turns <= 2, "正常修正只需两次模型调用");
			const date = turns === 1 ? "2026-10-01" : prompt.fieldFormats.currentTimestamp;
			const directory = turns === 1 ? "facts" : prompt.pathRules.entityDirectories[0]!.directory;
			const content = `---\ntype: fact\ntitle: 修正测试\ncreated: ${date}\nupdated: ${date}\nsources: [${prompt.sources[0]!.id}]\n---\n# 修正测试\n隔离测试事实\n`;
			const args = { pages: [{ path: `${directory}/repaired.md`, content, reason: "固定来源整理" }] };
			const send = (delta: unknown, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `repair-${turns}`, object: "chat.completion.chunk", created: 1780000000,
				model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			send({ role: "assistant", tool_calls: [{ index: 0, id: `repair-${turns}`, type: "function", function: { name: "knowledge_submit_candidate", arguments: JSON.stringify(args) } }] });
			send({}, "tool_calls"); res.end("data: [DONE]\n\n");
		} catch (error) { handlerError = error; res.writeHead(500).end("fixture failure"); }
	});
	let f: Awaited<ReturnType<typeof fixture>> | undefined;
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address(); assert(address && typeof address === "object");
		await upsertCustomProvider("curator-sdk-fixture", { name: "Fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "auth.json");
		await writeFile(authPath, JSON.stringify({ "curator-sdk-fixture": { type: "api_key", key: "fixture-only" } }));
		resetSharedModelRuntime(); configureSharedModelRuntime({ authPath });
		f = await fixture(root);
		await mkdir(path.join(f.vault, "wiki")); await writeFile(path.join(f.vault, "wiki", "index.md"), "# Wiki\n");
		await writeFile(path.join(f.vault, "wiki.schema.json"), JSON.stringify({ ...schema, entities: [{ ...schema.entities[0], fields: [
			...schema.entities[0]!.fields, { name: "created", type: "datetime", required: false }, { name: "updated", type: "datetime", required: false },
		] }] }));
		const created = await f.service.create({ ownerId: "owner", operationId: "repair", bindingId: f.binding.id, agentId: "wiki", task: "整理测试事实", sourceText: "隔离测试事实" });
		await f.service.waitForIdle(); assert.equal(handlerError, undefined);
		const done = (await f.jobs.get(created.job.id))!;
		assert.equal(done.status, "pending_review", done.failureCode);
		assert.equal(done.contentPrefix, "wiki/"); assert.equal(turns, 2);
		assert.equal(done.diagnostics?.submitAttempts, 2); assert.equal(done.diagnostics?.submitErrors, 1);
		assert.deepEqual(done.diagnostics?.validationErrors, ["invalid:created", "invalid:updated", "invalid_directory"]);
		const batch = (await f.reviews.get(done.candidateBatchId!))!.batch;
		assert.deepEqual(batch.files.map(file => file.targetPath), ["wiki/facts/repaired.md"]);
		assert.deepEqual(await readdir(path.join(f.vault, "wiki")), ["index.md"], "批准前不写候选");
		const approved = await f.reviews.decide({ batchId: batch.id, operationId: "approve", actorId: "owner", decision: "approve", manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: batch.files.map(file => file.targetPath) });
		await f.publisher.onApproved(batch, approved.decision);
		assert.match(await readFile(path.join(f.vault, "wiki", "facts", "repaired.md"), "utf8"), /隔离测试事实/);
	} finally {
		await f?.service.waitForIdle(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
		resetSharedModelRuntime();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

async function fixture(root: string, workerTimeoutMs?: number) {
	const vault = path.join(root, "vault"), cwd = path.join(root, "project"); await mkdir(vault); await mkdir(cwd);
	await writeFile(path.join(vault, "wiki.schema.json"), JSON.stringify(schema));
	await writeFile(path.join(vault, "AGENTS.md"), "SDK固定库契约v1：提交候选后等待人工审核。");
	const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "workspaces") }, cwd); await teams.init();
	const wiki = (await teams.getAgent("wiki"))!;
	await teams.upsertAgent({ ...wiki, connector: { ...wiki.connector!, config: { model: "curator-sdk-fixture/fixture-model" } } });
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
	const binding = await bindings.create({ ownerId: "owner", rootPath: vault, name: "SDK Wiki", description: "Test" });
	const objects = new KnowledgeObjectStore(path.join(root, "objects")), acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"));
	const selections = new KnowledgeSelectionStore(path.join(root, "state"), bindings), sources = new KnowledgeSourceStore({ stateDir: path.join(root, "state"), objects });
	const runtime = new KnowledgeRuntimeService({ teams, bindings, acceptance, objects, selections, stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache") });
	const jobs = new CuratorJobStore(path.join(root, "state")), reviews = new ReviewStore(path.join(root, "reviews"));
	// Deliberately omit generate: this exercises the production SDK assembler.
	const service = new WikiCuratorService({ jobs, bindings, acceptance, objects, reviews, runtime, teams, sources, cacheDir: path.join(root, "cache"), workerTimeoutMs });
	const publisher = new MarkdownWikiPublisher({ bindings, reviews, objects, acceptance, journal: new PublishJournal(path.join(root, "operations")),
		observation: new KnowledgeObservationService(acceptance, { objects }), searchIndex: new KnowledgeSearchIndex(path.join(root, "cache"), objects), operationsDir: path.join(root, "operations") });
	return { vault, cwd, teams, bindings, sources, binding, objects, acceptance, runtime, jobs, reviews, service, publisher };
}

test("真实聊天Worker SDK同会话prepare与submit，提交即停；续接查询不创建后台任务", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-inline-wiki-sdk-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	let requests = 0, handlerError: unknown, bindingId = "", query = false;
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
			requests++;
			const names = body.tools?.map(tool => tool.function?.name) ?? [];
			assert(names.includes("knowledge_prepare_candidate")); assert(names.includes("knowledge_submit_candidate"));
			assert(!names.includes("knowledge_request_curation"));
			assert(!names.some(name => ["bash", "read", "write", "edit"].includes(name ?? "")));
			const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `worker-${requests}`, object: "chat.completion.chunk", created: 1780000000, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (query) { send({ role: "assistant", content: "这是只读查询回答。" }); send({}, "stop"); }
			else {
				const prepared = body.messages?.filter(message => message.role === "tool").map(message => {
					try { return JSON.parse(typeof message.content === "string" ? message.content : "{}"); } catch { return undefined; }
				}).find(value => value?.context?.sources);
				const name = prepared ? "knowledge_submit_candidate" : "knowledge_prepare_candidate";
				if (prepared) {
					assert.equal(prepared.context.sources[0].content, "用户提供的固定事实");
					assert.equal(prepared.context.pathRules.entityDirectories[0].directory, "facts");
				}
				const args = prepared ? { bindingId, pages: [{ path: "facts/chat.md", reason: "来源事实整理", content: `---\ntype: fact\ntitle: 聊天事实\nsources: [${prepared.context.sources[0].id}]\n---\n# 聊天事实\n用户提供的固定事实\n` }] } : { bindingId, task: "当前会话整理事实" };
				send({ role: "assistant", tool_calls: [{ index: 0, id: `worker-call-${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); send({}, "tool_calls");
			}
			res.end("data: [DONE]\n\n");
		} catch (error) { handlerError = error; res.end("data: [DONE]\n\n"); }
	});
	let f: Awaited<ReturnType<typeof fixture>> | undefined, sessionHandle: string | undefined;
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address(); assert(address && typeof address === "object");
		await upsertCustomProvider("curator-sdk-fixture", { name: "Fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "auth.json"); await writeFile(authPath, JSON.stringify({ "curator-sdk-fixture": { type: "api_key", key: "fixture-only" } }));
		resetSharedModelRuntime(); configureSharedModelRuntime({ authPath }); f = await fixture(root); bindingId = f.binding.id;
		let invocation = 0;
		const scope = { ownerId: "owner", windowId: "solo", sessionId: "manager-chat", contextKey: "manager-chat" };
		const driver = new LocalPiDriver({ executionProfile: "wiki_curator", model: "curator-sdk-fixture/fixture-model", sessionDir: path.join(root, "worker-sessions"),
			knowledgeFor: async () => f!.service.workerSurface(await f!.runtime.mount(scope, [bindingId]), { ...scope, operationId: `turn-${++invocation}`, sourceText: "用户提供的固定事实" }, "wiki") });
		const events: AgentEvent[] = [];
		for await (const event of driver.run({ requestId: "worker-run", message: "请将我的事实整理为待审核候选" }, { cwd: f.cwd, env: {}, delegationId: "same-worker" })) events.push(event);
		assert.equal(handlerError, undefined); assert.equal(requests, 2, "仅prepare和submit两次工具轮，无第三次模型请求或另一整理会话");
		const completed = [...events].reverse().find(event => event.type === "completed"); assert.ok(completed && completed.type === "completed");
		sessionHandle = completed.result.sessionHandle;
		assert.match(completed.result.content ?? "", /pending_review/); assert.match(completed.result.content ?? "", /reviewUrl/);
		const jobs = await f.jobs.list(); assert.equal(jobs.length, 1); assert.equal(jobs[0]!.executionMode, "worker"); assert.equal(jobs[0]!.status, "pending_review");
		assert.equal((await readdir(path.join(root, "worker-sessions"))).filter(name => name.endsWith(".jsonl")).length, 1);
		await assert.rejects(readdir(path.join(root, "cache", "curator-sessions")), /ENOENT/);
		assert.deepEqual(await readdir(f.vault), ["AGENTS.md", "wiki.schema.json"], "批准前零候选写入");
		query = true;
		const followup: AgentEvent[] = [];
		for await (const event of driver.continue({ requestId: "worker-query", sessionHandle: sessionHandle!, message: "只读解释这个结果" }, { cwd: f.cwd, env: {}, delegationId: "query" })) followup.push(event);
		const answer = [...followup].reverse().find(event => event.type === "completed"); assert.ok(answer && answer.type === "completed");
		assert.equal(answer.result.content, "这是只读查询回答。"); assert.equal((await f.jobs.list()).length, 1); assert.equal(requests, 3);
	} finally {
		if (sessionHandle) liveWorkerSession(sessionHandle)?.dispose();
		await f?.service.waitForIdle(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
		resetSharedModelRuntime(); if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("真实 WikiCurator 默认 generate 经 SDK 提交、人审发布，工具后契约变化阻止下一轮模型请求", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-curator-sdk-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	const requests: Array<{ mode: string; body: RequestBody }> = [];
	let mode = "submit", targetBindingId = "", submittedBytes = "", handlerError: unknown;
	const server = createServer(async (req, res) => {
		try {
			if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody; requests.push({ mode, body });
			const prompt = payload(body);
			assert.deepEqual(prompt.schema, schema); assert.match(prompt.operationContract, /固定库契约v1/);
			assert.deepEqual(prompt.allowedSourceIds, prompt.sources.map((source) => source.id));
			const entity = prompt.schema.entities[0]!;
			submittedBytes = `---\ntype: ${entity.type}\ntitle: SDK事实\nsources: [${prompt.sources.map((source) => source.id).join(", ")}]\n---\n# SDK事实\n${prompt.sources.map((source) => source.content).join("\n")}\n`;
			const name = mode === "submit" ? "knowledge_submit_candidate" : "knowledge_read";
			const args = mode === "submit" ? { pages: [{ path: `${entity.directory}/sdk.md`, content: submittedBytes, reason: "固定来源与结构整理" }] }
				: { bindingId: targetBindingId, noteRef: "facts/baseline.md" };
			const id = `curator-fixture-${requests.length}`;
			const send = (delta: unknown, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1780000000,
				model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			send({ role: "assistant", tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); send({}, "tool_calls");
			res.end("data: [DONE]\n\n");
		} catch (error) { handlerError = error; res.writeHead(500).end("fixture assertion failed"); }
	});
	let success: Awaited<ReturnType<typeof fixture>> | undefined, contract: Awaited<ReturnType<typeof fixture>> | undefined;
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address(); assert(address && typeof address === "object");
		await upsertCustomProvider("curator-sdk-fixture", { name: "Curator fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "secrets", "auth.json"); await mkdir(path.dirname(authPath), { recursive: true });
		await writeFile(authPath, JSON.stringify({ "curator-sdk-fixture": { type: "api_key", key: "fixture-only" } }));
		resetSharedModelRuntime(); configureSharedModelRuntime({ authPath });
		await mkdir(path.join(root, "success")); success = await fixture(path.join(root, "success"));
		const created = await success.service.create({ ownerId: "owner", operationId: "actual-sdk-submit", bindingId: success.binding.id, agentId: "wiki",
			task: "整理固定原始资料", sourceText: "原始文字：项目日期2026-10-23。", uploads: [{ filename: "source.md", mediaType: "text/markdown", data: Buffer.from("# 原始附件\n事实仍需审核。\n").toString("base64") }] });
		await success.service.waitForIdle(); assert.equal(handlerError, undefined);
		const finished = (await success.jobs.get(created.job.id))!;
		assert.equal(finished.status, "pending_review", JSON.stringify(finished));
		assert.equal(requests.length, 1, "提交成功即停在候选边界，不需第二轮模型请求");
		const actualPrompt = payload(requests[0]!.body);
		assert.deepEqual(actualPrompt.sources.map((source) => source.id), created.job.sources.map((source) => source.id));
		assert.deepEqual(actualPrompt.sources.map((source) => source.content), ["原始文字：项目日期2026-10-23。", "# 原始附件\n事实仍需审核。\n"]);
		assert.deepEqual(await readdir(success.vault), ["AGENTS.md", "wiki.schema.json"]);
		assert.deepEqual(await readdir(success.cwd), []);
		const record = (await success.reviews.get(finished.candidateBatchId!))!;
		assert.equal(record.status, "pending_review"); assert.equal(record.batch.contractHash, created.job.contractHash);
		assert.deepEqual(record.batch.sourceSnapshots, created.job.sources.map((source) => source.originalHash));
		assert.equal((await success.objects.get(record.batch.files[0]!.blobRef!)).toString("utf8"), submittedBytes);
		const approved = await success.reviews.decide({ batchId: record.batch.id, operationId: "human-sdk", actorId: "owner", decision: "approve",
			manifestHash: record.batch.manifestHash, expectedBatchRevision: record.batch.revision, reviewedFiles: ["facts/sdk.md"] });
		await success.publisher.onApproved(record.batch, approved.decision);
		assert.equal((await success.reviews.get(record.batch.id))?.status, "published");
		assert.equal(await readFile(path.join(success.vault, "facts", "sdk.md"), "utf8"), submittedBytes);
		assert.equal(Object.keys((await success.acceptance.getSnapshot(success.binding.id)).entries).length, 1);
		mode = "contract";
		await mkdir(path.join(root, "contract")); contract = await fixture(path.join(root, "contract")); targetBindingId = contract.binding.id;
		const baselineBytes = "---\ntype: fact\ntitle: 已采纳事实\nsources: [prior]\n---\nBASELINE_SECRET_MUST_NOT_REACH_SECOND_PROVIDER\n";
		const snapshot = await contract.objects.put(Buffer.from(baselineBytes)); await mkdir(path.join(contract.vault, "facts"));
		await writeFile(path.join(contract.vault, "facts", "baseline.md"), baselineBytes);
		await contract.acceptance.adopt(contract.binding.id, [{ relativePath: "facts/baseline.md", contentHash: snapshot.hash, snapshotRef: snapshot.hash, acceptedBy: "owner" }], 0);
		const originalMount = contract.runtime.mount.bind(contract.runtime); let realReads = 0;
		contract.runtime.mount = async (...args) => {
			const surface = await originalMount(...args), read = surface.tools.find((tool) => tool.name === "knowledge_read")!;
			const execute = read.execute;
			read.execute = async (...toolArgs) => {
				const result = await execute(...toolArgs); assert.match(JSON.stringify(result), /BASELINE_SECRET_MUST_NOT_REACH_SECOND_PROVIDER/); realReads++;
				await writeFile(path.join(contract!.vault, "AGENTS.md"), "SDK库契约v2：授权已变化。"); return result;
			}; return surface;
		};
		const second = await contract.service.create({ ownerId: "owner", operationId: "actual-sdk-contract", bindingId: contract.binding.id, agentId: "wiki", task: "先读已采纳事实" });
		await contract.service.waitForIdle(); assert.equal(handlerError, undefined);
		const failed = (await contract.jobs.get(second.job.id))!;
		assert.equal(realReads, 1, "确实执行真实知识正文工具后才修改契约");
		assert.equal(failed.status, "failed", JSON.stringify(failed));
		assert.equal(requests.filter((request) => request.mode === "contract").length, 1, "契约变化阻止携带工具结果的第二轮模型请求");
		assert.ok(!JSON.stringify(requests).includes("BASELINE_SECRET_MUST_NOT_REACH_SECOND_PROVIDER"));
		assert.deepEqual(await contract.reviews.list(), []);
		assert.equal(await readFile(path.join(contract.vault, "facts", "baseline.md"), "utf8"), baselineBytes);
		for (const request of requests) assert.deepEqual(request.body.tools?.map((tool) => tool.function?.name).sort(), expectedTools, "实际 SDK provider tools 仅5知识工具和提交，没有原生/MCP工具");
	} finally {
		await success?.service.waitForIdle(); await contract?.service.waitForIdle(); server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve())); resetSharedModelRuntime();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("视觉真实SDK提取后才生成候选；空结果可原件重试；文本模型阻断；契约改变阻断", {timeout:45000}, async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"pt-vision-sdk-")), previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=path.join(root,"agent");
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=","base64");
 let mode="success",error:unknown,active:Awaited<ReturnType<typeof fixture>>;
 const fixtures:Array<Awaited<ReturnType<typeof fixture>>>=[],requests:Array<{mode:string;image:boolean}>=[];
 const server=createServer(async(req,res)=>{try{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);const body=JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
  const image=JSON.stringify(body.messages).includes('"image_url"');requests.push({mode,image});const id=`vision-${requests.length}`;
  res.writeHead(200,{"content-type":"text/event-stream"});
  const send=(delta:unknown,finish:string|null=null)=>res.write(`data: ${JSON.stringify({id,object:"chat.completion.chunk",created:1780000000,model:"fixture-model",choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
  if(image){
   assert.equal(body.tools?.length??0,0);if(mode==="contract")await writeFile(path.join(active.vault,"AGENTS.md"),"契约改动");
   send({role:"assistant",content:JSON.stringify({segments:mode==="empty"?[]:[{text:"图片日期2026-10-23",region:{x:0,y:0,width:1,height:1},warnings:["数字需核对"]}],warnings:[]})});send({},"stop");
  }else{
   const p=payload(body);assert(p.sources.some(s=>s.content.includes("图片日期")));
   const content=`---\ntype: fact\ntitle: 图像\nsources: [${p.sources.map(s=>s.id).join(", ")}]\n---\n# 图像\n${p.sources.map(s=>s.content).join("\n")}\n`;
   send({role:"assistant",tool_calls:[{index:0,id:`tool-${id}`,type:"function",function:{name:"knowledge_submit_candidate",arguments:JSON.stringify({pages:[{path:"facts/image.md",content,reason:"提取待人审"}]})}}]});send({},"tool_calls");
  }res.end("data: [DONE]\n\n");
 }catch(e){error=e;res.writeHead(500).end();}});
 try{
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});const address=server.address();assert(address&&typeof address==="object");
  await upsertCustomProvider("curator-sdk-fixture",{name:"vision",baseUrl:`http://127.0.0.1:${address.port}/v1`,api:"openai-completions",models:[{id:"fixture-model",vision:true},{id:"text-only"}]});
  const authPath=path.join(root,"auth.json");await writeFile(authPath,JSON.stringify({"curator-sdk-fixture":{type:"api_key",key:"fixture-only"}}));resetSharedModelRuntime();configureSharedModelRuntime({authPath});
  const make=async(name:string)=>{const dir=path.join(root,name);await mkdir(dir);const f=await fixture(dir);fixtures.push(f);active=f;return f;};
  const input=(f:Awaited<ReturnType<typeof fixture>>,op:string)=>({ownerId:"owner",operationId:op,bindingId:f.binding.id,agentId:"wiki",task:"按图整理，待人审",uploads:[{filename:"image.png",mediaType:"image/png",data:png.toString("base64")}]});
  const f=await make("success"),start=await f.service.create(input(f,"vision"));await f.service.waitForIdle();assert.equal(error,undefined);
  const done=(await f.jobs.get(start.job.id))!;assert.equal(done.status,"pending_review",JSON.stringify(done));assert.deepEqual(requests.map(r=>r.image),[true,false]);
  const image=done.sources.find(s=>s.kind==="image")!;assert(image.extraction);assert.equal(image.derivedFrom,start.job.sources[1]!.id);assert.equal((await f.sources.get("owner",image.derivedFrom!))!.status,"needs_attention");
  assert.deepEqual((await f.sources.readOriginal("owner",image.id)).bytes,png);assert(image.warnings.includes("数字需核对"));assert.deepEqual((await readdir(f.vault)).sort(),["AGENTS.md","wiki.schema.json"]);
  const record=(await f.reviews.get(done.candidateBatchId!))!,approved=await f.reviews.decide({batchId:record.batch.id,operationId:"human",actorId:"owner",decision:"approve",manifestHash:record.batch.manifestHash,expectedBatchRevision:1,reviewedFiles:record.batch.files.map(file=>file.targetPath)});
  const page=record.batch.files.find(file=>file.targetPath==="facts/image.md")!,asset=record.batch.files.find(file=>file.kind==="image")!;assert(asset);assert.match((await f.objects.get(page.blobRef!)).toString(),/!\[.*\]\(\.\.\/assets\/images\/[a-f0-9]{64}\.png\)/);
  await f.publisher.onApproved(record.batch,approved.decision);assert.equal((await f.reviews.get(record.batch.id))!.status,"published");assert.equal(await readFile(path.join(f.vault,"facts/image.md"),"utf8"),(await f.objects.get(page.blobRef!)).toString());assert.deepEqual(await readFile(path.join(f.vault,asset.targetPath)),png);
  mode="empty";const empty=await make("empty"),fail=await empty.service.create(input(empty,"empty"));await empty.service.waitForIdle();assert.equal((await empty.jobs.get(fail.job.id))!.status,"needs_attention");assert.deepEqual(await empty.reviews.list(),[]);
  mode="retry";const retry=await empty.service.retry("owner",fail.job.id,"retry"),replay=await empty.service.retry("owner",fail.job.id,"retry");assert.equal(replay.job.id,retry.job.id);assert(replay.replayed);await empty.service.waitForIdle();assert.equal((await empty.jobs.get(retry.job.id))!.status,"pending_review");assert.equal((await empty.jobs.get(fail.job.id))!.status,"needs_attention");
  mode="text-only";const text=await make("text"),wiki=(await text.teams.getAgent("wiki"))!;await text.teams.upsertAgent({...wiki,connector:{...wiki.connector!,config:{model:"curator-sdk-fixture/text-only"}}});
  const unsupported=await text.service.create(input(text,"text"));await text.service.waitForIdle();assert.match((await text.jobs.get(unsupported.job.id))!.failureCode!,/不支持图片/);assert.equal(requests.filter(r=>r.mode==="text-only").length,0);
  mode="contract";const changed=await make("contract"),job=await changed.service.create(input(changed,"contract"));await changed.service.waitForIdle();assert.equal((await changed.jobs.get(job.job.id))!.status,"needs_attention");assert.equal(requests.filter(r=>r.mode==="contract").length,1);assert.deepEqual(await changed.reviews.list(),[]);assert.equal(error,undefined);
 }finally{for(const f of fixtures)await f.service.waitForIdle();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));resetSharedModelRuntime();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(root,{recursive:true,force:true});}
});

test("真实SDK精确诊断结束状态；aborted partialcall零候选，已CAS提交不被超时改失败", { timeout: 30_000 }, async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pt-curator-feedback-sdk-")), oldAgentDir = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
 let mode = "stop", handlerError: unknown; const requests: RequestBody[] = [];
 const server = createServer(async (req, res) => {
  try {
   const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
   const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody; requests.push(body);
   const prompt = payload(body); assert.deepEqual(body.tools?.map(tool => tool.function?.name).sort(), expectedTools);
   if (mode === "error") { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_ERROR_NEVER_IN_DIAGNOSTICS", type: "invalid_request_error" } })); return; }
   res.writeHead(200, { "content-type": "text/event-stream" });
   const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "feedback-fixture", object: "chat.completion.chunk", created: 1780000000, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
   if (mode === "stop") { send({ role: "assistant", content: "已经整理并进入审核（模型假成功）" }); send({}, "stop"); }
   else {
    const args = { pages: [{ path: "facts/feedback.md", content: `---\ntype: fact\ntitle: 事实\nsources: [${prompt.sources[0]!.id}]\n---\n已获准事实\n`, reason: "固定来源" }] };
    send({ role: "assistant", tool_calls: [{ index: 0, id: "submit-call", type: "function", function: { name: "knowledge_submit_candidate", arguments: JSON.stringify(args) } }] });
    if (mode === "timeout") return;
    send({}, mode === "length" ? "length" : "tool_calls");
   }
   res.end("data: [DONE]\n\n");
  } catch (error) { handlerError = error; res.writeHead(500).end(); }
 });
 const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = [];
 try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert(address && typeof address === "object");
  await upsertCustomProvider("curator-sdk-fixture", { name: "Feedback fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
  const authPath = path.join(root, "auth.json"); await writeFile(authPath, JSON.stringify({ "curator-sdk-fixture": { type: "api_key", key: "fixture-only" } }));
  resetSharedModelRuntime(); configureSharedModelRuntime({ authPath });
  for (const entry of [{ mode: "stop", code: "worker_no_submission", stop: "stop" }, { mode: "length", code: "model_output_limit", stop: "length" }, { mode: "error", code: "model_error", stop: "error" }, { mode: "timeout", code: "model_timeout", stop: "aborted" }, { mode: "late_submission", code: null, stop: null }]) {
   mode = entry.mode; const location = path.join(root, mode); await mkdir(location);
	const f = await fixture(location, mode === "timeout" || mode === "late_submission" ? 500 : 5_000); fixtures.push(f);
   if (mode === "late_submission") {
    const register = f.reviews.registerCandidate.bind(f.reviews);
    f.reviews.registerCandidate = async (...args) => { await new Promise(resolve => setTimeout(resolve, 800)); return register(...args); };
   }
   const beforeRequests = requests.length;
   const created = await f.service.create({ ownerId: "owner", operationId: mode, bindingId: f.binding.id, agentId: "wiki", task: "整理事实", sourceText: "PRIVATE_USER_SOURCE_NEVER_IN_DIAGNOSTICS" });
   await f.service.waitForIdle(); const job = (await f.jobs.get(created.job.id))!;
   assert.equal(handlerError, undefined); assert.equal(requests.length - beforeRequests, 1, "不自动追加模型轮次");
   assert.equal(job.diagnostics?.modelTurns, 1); assert(!JSON.stringify(job.diagnostics).includes("PRIVATE_"));
   assert.deepEqual(await readdir(f.vault), ["AGENTS.md", "wiki.schema.json"]);
   if (entry.code) {
    assert.equal(job.status, "failed", JSON.stringify(job)); assert.equal(job.failureCode, entry.code); assert.equal(job.diagnostics?.stopReason, entry.stop);
    assert.equal(job.diagnostics?.submitAttempts, 0); assert.equal(job.candidateBatchId, undefined); assert.deepEqual(await f.reviews.list(), []);
    const replay = await f.service.create({ ownerId: "owner", operationId: mode, bindingId: f.binding.id, agentId: "wiki", task: "整理事实", sourceText: "PRIVATE_USER_SOURCE_NEVER_IN_DIAGNOSTICS" });
    assert.equal(replay.job.status, "failed"); assert.equal(replay.job.id, job.id); assert(replay.replayed);
   } else {
    assert.equal(job.status, "pending_review", JSON.stringify(job)); assert.equal(job.diagnostics?.submitAttempts, 1); assert.equal(job.failureCode, undefined);
    assert.equal((await f.reviews.get(job.candidateBatchId!))!.status, "pending_review");
   }
  }
 } finally {
  for (const f of fixtures) await f.service.waitForIdle(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  resetSharedModelRuntime(); if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
 }
});

test("独立Curator真实SDK尊重Wiki显式thinkingLevel而非SDK默认档位", { timeout: 15_000 }, async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pt-curator-thinking-sdk-")), oldAgentDir = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
 const requests: Array<RequestBody & { reasoning_effort?: string }> = [];
 const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "thinking-fixture", object: "chat.completion.chunk", created: 1780000000, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  send({ role: "assistant", tool_calls: [{ index: 0, id: "submit-nochanges", type: "function", function: { name: "knowledge_submit_candidate", arguments: JSON.stringify({ pages: [] }) } }] });
  send({}, "tool_calls"); res.end("data: [DONE]\n\n");
 });
 let f: Awaited<ReturnType<typeof fixture>> | undefined;
 try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert(address && typeof address === "object");
  await upsertCustomProvider("curator-sdk-fixture", { name: "Thinking fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model", reasoning: true }] });
  await applyThinkingCapabilityOverrides({ "curator-sdk-fixture/fixture-model": { supportsReasoningEffort: true } });
  const authPath = path.join(root, "auth.json"); await writeFile(authPath, JSON.stringify({ "curator-sdk-fixture": { type: "api_key", key: "fixture-only" } }));
  resetSharedModelRuntime(); configureSharedModelRuntime({ authPath });
  const location = path.join(root, "fixture"); await mkdir(location); f = await fixture(location, 5_000);
  const wiki = (await f.teams.getAgent("wiki"))!;
  await f.teams.upsertAgent({ ...wiki, connector: { ...wiki.connector!, config: { ...wiki.connector!.config, thinkingLevel: "low" } } });
  const created = await f.service.create({ ownerId: "owner", operationId: "explicit-thinking", bindingId: f.binding.id, agentId: "wiki", task: "检查无需修改" });
  await f.service.waitForIdle(); const job = (await f.jobs.get(created.job.id))!;
  assert.equal(job.status, "no_changes", JSON.stringify(job)); assert.equal(requests.length, 1); assert.equal(requests[0]!.reasoning_effort, "low");
  assert.deepEqual(requests[0]!.tools?.map(tool => tool.function?.name).sort(), expectedTools);
  const files = await readdir(path.join(location, "cache", "curator-sessions"));
  const session = await readFile(path.join(location, "cache", "curator-sessions", files.find(file => file.endsWith(".jsonl"))!), "utf8");
  const entries = session.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.find(entry => entry.type === "thinking_level_change").thinkingLevel, "low", "真实SDK持久会话记录与外发effort均来自Wiki配置");
  assert.deepEqual(await readdir(f.vault), ["AGENTS.md", "wiki.schema.json"]);
 } finally {
  await f?.service.waitForIdle(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  resetSharedModelRuntime(); if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
 }
});

test("冷启动SDK只收到继续时从宿主发现并恢复原饭局，提交原来源且不重复候选", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-wiki-resume-sdk-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	let requests = 0, error: unknown, bindingId = "", jobId = "", sourceId = "", repeat = false;
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody; requests++;
			const toolResults = (body.messages ?? []).filter(m => m.role === "tool").map(m => { try { return JSON.parse(typeof m.content === "string" ? m.content : "{}"); } catch { return {}; } });
			const prepared = [...toolResults].reverse().find(value => value.context?.sources);
			const context = [...toolResults].reverse().find(value => value.curationTasks);
			const turn = repeat ? requests - 3 : requests;
			const name = turn === 1 ? "knowledge_context" : turn === 2 ? "knowledge_prepare_candidate" : "knowledge_submit_candidate";
			if (turn === 1) assert((body.messages ?? []).some(m => m.role === "user" && (typeof m.content === "string" ? m.content : m.content?.map(b => b.text ?? "").join("") ?? "").includes("继续")));
			if (turn === 2) { assert.equal(context.curationTasks[0].jobId, jobId); assert.equal(context.curationTasks[0].resumable, !repeat); }
			if (turn === 3) {
				assert.equal(prepared.context.sources.length, 1); assert.equal(prepared.context.sources[0].id, sourceId);
				assert.match(prepared.context.sources[0].content, /刘大强.*周泽宇.*北京/); assert.match(prepared.context.task, /2026-10-03/);
			}
			const args = turn === 1 ? {} : turn === 2 ? { bindingId, jobId } : { bindingId, pages: [{ path: "facts/dinner.md", content: `---\ntype: fact\ntitle: 北京饭局\nsources: [${sourceId}]\n---\n2026-10-03 20:00，用户和刘大强、周泽宇在北京有一个饭局。\n`, reason: "恢复原饭局" }] };
			const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `resume-${requests}`, object: "chat.completion.chunk", created: 1780000000, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" }); send({ role: "assistant", tool_calls: [{ index: 0, id: `resume-${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); send({}, "tool_calls"); res.end("data: [DONE]\n\n");
		} catch (caught) { error = caught; res.end("data: [DONE]\n\n"); }
	});
	let f: Awaited<ReturnType<typeof fixture>> | undefined, handle: string | undefined;
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address(); assert(address && typeof address === "object");
		await upsertCustomProvider("curator-sdk-fixture", { name: "Fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture-model" }] });
		const authPath = path.join(root, "auth.json"); await writeFile(authPath, JSON.stringify({ "curator-sdk-fixture": { type: "api_key", key: "fixture-only" } }));
		resetSharedModelRuntime(); configureSharedModelRuntime({ authPath }); f = await fixture(root); bindingId = f.binding.id;
		const scope = { ownerId: "owner", windowId: "window", sessionId: "same-chat", contextKey: "same-chat" };
		const original = await f.service.create({ ownerId: "owner", operationId: "original", bindingId, agentId: "wiki", task: "记录2026-10-03 20:00的北京饭局", sourceText: "今天晚上8点和刘大强还有周泽宇在北京有一个饭局，帮我做个记录吧", executionMode: "worker", origin: { sessionId: scope.sessionId, windowId: scope.windowId } });
		jobId = original.job.id; sourceId = original.job.sources[0]!.id;
		await f.jobs.transition(jobId, ["running"], { status: "failed", failureCode: "server_restart" });
		const restarted = new WikiCuratorService({ ...f, jobs: new CuratorJobStore(path.join(root, "state")), reviews: new ReviewStore(path.join(root, "reviews")), cacheDir: path.join(root, "cache") });
		const driver = new LocalPiDriver({ executionProfile: "wiki_curator", model: "curator-sdk-fixture/fixture-model", sessionDir: path.join(root, "worker-sessions"), knowledgeFor: async () => restarted.workerSurface(await f!.runtime.mount(scope, [bindingId]), { ...scope, operationId: "continue", resolveSources: async () => { throw new Error("不准拿继续做新事实"); } }, "wiki") });
		let result: Extract<AgentEvent, { type: "completed" }> | undefined;
		for await (const event of driver.run({ requestId: "continue", message: "继续" }, { cwd: f.cwd, env: {}, delegationId: "resumed" })) if (event.type === "completed") result = event;
		assert.equal(error, undefined); assert.ok(result); handle = result.result.sessionHandle; assert.match(result.result.content ?? "", /pending_review/); assert.equal(requests, 3);
		assert.equal((await f.jobs.list()).length, 1); assert.equal((await f.reviews.list()).length, 1);
		assert.deepEqual(await readdir(f.vault), ["AGENTS.md", "wiki.schema.json"]);
		repeat = true;
		for await (const event of driver.continue({ requestId: "again", sessionHandle: handle!, message: "继续" }, { cwd: f.cwd, env: {}, delegationId: "again" })) if (event.type === "completed") result = event;
		assert.equal(error, undefined); assert.equal(requests, 5); assert.equal((await f.jobs.list()).length, 1); assert.equal((await f.reviews.list()).length, 1);
	} finally {
		if (handle) liveWorkerSession(handle)?.dispose(); await f?.service.waitForIdle(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
		resetSharedModelRuntime(); if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(root, { recursive: true, force: true });
	}
});
