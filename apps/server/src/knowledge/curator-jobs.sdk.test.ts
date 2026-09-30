import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { upsertCustomProvider } from "../pi-bridge/custom-providers.js";
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

async function fixture(root: string) {
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
	const service = new WikiCuratorService({ jobs, bindings, acceptance, objects, reviews, runtime, teams, sources, cacheDir: path.join(root, "cache") });
	const publisher = new MarkdownWikiPublisher({ bindings, reviews, objects, acceptance, journal: new PublishJournal(path.join(root, "operations")),
		observation: new KnowledgeObservationService(acceptance, { objects }), searchIndex: new KnowledgeSearchIndex(path.join(root, "cache"), objects), operationsDir: path.join(root, "operations") });
	return { vault, cwd, teams, bindings, sources, binding, objects, acceptance, runtime, jobs, reviews, service, publisher };
}

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
