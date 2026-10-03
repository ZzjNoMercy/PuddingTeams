import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { upsertCustomProvider } from "../pi-bridge/custom-providers.js";
import { configureSharedModelRuntime, resetSharedModelRuntime, sharedModelRuntime } from "../pi-bridge/model-runtime.js";
import { TeamsStore } from "../store/teams.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSelectionStore } from "./selections.js";
import { KnowledgeRuntimeService } from "./runtime-service.js";
import { KnowledgeSourceStore } from "./sources.js";
import { ChatKnowledgeIntake } from "./chat-intake.js";
import { WikiCuratorService, type CuratorJob } from "./curator-jobs.js";
import { buildManagerExtensionFactories, type ManagerExtensionDeps } from "../pi-bridge/agent-extensions.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";

test("实际Manager SDK只委派知识管家；Worker整理引用原话与图片，委派不能替换事实，撤权后无第二轮外发", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-chat-intake-sdk-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages?: unknown[] }> = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = JSON.parse(Buffer.concat(chunks).toString()) as typeof requests[number]; requests.push(body);
		const first = !JSON.stringify(body.messages).includes('"role":"tool"');
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1780000000, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		if (first) { send({ role: "assistant", tool_calls: [{ index: 0, id: `request-${requests.length}`, type: "function", function: { name: "agent_wiki__delegate", arguments: JSON.stringify({ task: "目标binding：模型整理指令：虚构日期10月30日" }) } }] }); send({}, "tool_calls"); }
		else { send({ role: "assistant", content: "知识管家已返回宿主回执，请按实际状态继续。" }); send({}, "stop"); }
		res.end("data: [DONE]\n\n");
	});
	const sessions: AgentSession[] = [];
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address(); assert(address && typeof address === "object");
		await upsertCustomProvider("chat-intake-fixture", { name: "fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fixture", vision: true }] });
		const authPath = path.join(root, "auth.json"); await writeFile(authPath, JSON.stringify({ "chat-intake-fixture": { type: "api_key", key: "fixture-only" } })); resetSharedModelRuntime(); configureSharedModelRuntime({ authPath });
		const models = await sharedModelRuntime(), model = models.getModel("chat-intake-fixture", "fixture"); assert.ok(model);
		const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "workspaces") }, root); await teams.init();
		const wiki = await teams.getAgent("wiki"); assert.ok(wiki);
		teams.windowForSession = async () => ({ id: "window", type: "group", members: ["wiki"] }) as never;
		const bindings = new KnowledgeBindingRegistry(path.join(root, "state")), objects = new KnowledgeObjectStore(path.join(root, "objects"));
		const sources = new KnowledgeSourceStore({ stateDir: path.join(root, "state"), objects }), intakes = new ChatKnowledgeIntake({ stateDir: path.join(root, "state"), sources });
		const deps = { teams, bindings, objects, acceptance: new KnowledgeAcceptanceStore(path.join(root, "acceptance")), selections: new KnowledgeSelectionStore(path.join(root, "state"), bindings), stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache") };
		const original = "用户原话：真实日期10月23日。";
		await mkdir(path.join(root, ".pi", "skills", "record"), { recursive: true });
		await writeFile(path.join(root, ".pi", "skills", "record", "SKILL.md"), "---\nname: record\ndescription: fixture记录技能\n---\n可信技能展开文本：整理前核对用户资料。\n");
		await mkdir(path.join(root, ".pi", "prompts"), { recursive: true });
		await writeFile(path.join(root, ".pi", "prompts", "record.md"), "---\ndescription: fixture记录模板\n---\n\n可信模板展开文本：$ARGUMENTS\n");
		const image = { name: "camera", mediaType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", size: 68, path: "/untrusted/never/read" };
		for (const { revoke, expand, template } of [{ revoke: false, expand: false, template: false }, { revoke: true, expand: false, template: false }, { revoke: false, expand: true, template: false }, { revoke: false, expand: false, template: true }]) {
			const userInput = expand ? `/skill:record ${original}` : template ? `/record ${original}` : original;
			const service = new KnowledgeRuntimeService(deps); let revoked = false;
			const templates = await service.mount({ ownerId: "owner", windowId: "window", sessionId: "schema", contextKey: "schema" }, []);
			const context = templates.tools.find((tool) => tool.name === "knowledge_context")!;
			service.forSession = async () => ({ ...templates, fingerprint: "fixture-authorized", prompt: "固定授权知识库", managerPrompt: '授权库：binding。通过 agent_wiki__delegate 委派知识管家。', assertCurrent: async () => { if (revoked) throw new Error("知识库授权已撤销"); }, tools: templates.tools.map(tool => tool.name === "knowledge_context" ? { ...context, execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ mounts: [{ bindingId: "binding" }] }) }], details: {} }) } : tool) });
			// Real Worker surface and Manager SDK registration. Only durable storage,
			// extraction and candidate validation are stubbed; no second Agent runs.
			let currentJob: CuratorJob | undefined;
			const curator = new WikiCuratorService({ jobs: {
				get: async () => currentJob,
				transition: async (_id: string, from: string[], patch: Partial<CuratorJob>) => {
					assert.ok(currentJob && from.includes(currentJob.status));
					currentJob = { ...currentJob, ...patch }; return currentJob;
				},
			}, workerTimeoutMs: 5_000 } as never);
			let created: Parameters<WikiCuratorService["create"]>[0] | undefined, createCalls = 0, preparationCalls = 0;
			curator.create = async (input) => {
				created = input; createCalls++; if (revoke) revoked = true;
				currentJob = { id: "fixed-job", executionMode: input.executionMode, ownerId: input.ownerId,
					targetBindingId: input.bindingId, status: "running", sources: (await sources.manifest(input.ownerId, input.sourceIds!)).sources } as CuratorJob;
				return { job: currentJob, replayed: false };
			};
			const fixture = curator as unknown as {
				prepareSources(job: CuratorJob): Promise<CuratorJob>;
				candidateContext(job: CuratorJob): Promise<unknown>;
				assertAuthority(job: CuratorJob): Promise<void>;
			};
			fixture.prepareSources = async job => { await fixture.assertAuthority(job); preparationCalls++; return job; };
			fixture.assertAuthority = async () => { if (revoked) throw new Error("知识库授权已撤销"); };
			fixture.candidateContext = async job => ({ sources: await Promise.all(job.sources.map(async source => ({ ...source,
				...(source.kind === "text" ? { content: (await sources.readText(job.ownerId, source.id)).text } : {}) }))) });
			curator.submit = async job => { currentJob = { ...job, status: "no_changes" }; return currentJob; };
			let session!: AgentSession;
			let delegatedTask: string | undefined;
			const invoker = { requireAgent: async () => wiki, delegationsForManagerSession: async () => [],
				delegate: async (input: Parameters<AgentInvoker["delegate"]>[0]) => {
					assert.equal(input.agent.name, "wiki"); assert.equal(input.managerSessionId, session.sessionId);
					delegatedTask = input.message;
					const worker = curator.workerSurface(await service.forSession(input.managerSessionId!), { ownerId: "owner", windowId: "window", sessionId: input.managerSessionId!, operationId: "delegation",
						resolveSources: () => intakes.resolve(session, "owner", { toolCallId: input.managerToolCallId }) }, "wiki");
					assert.ok(worker.tools.some(tool => tool.name === "knowledge_search"));
					assert.ok(!worker.tools.some(tool => tool.name === "knowledge_request_curation"), "聊天Worker不得另开后台整理");
					const prepare = worker.tools.find(tool => tool.name === "knowledge_prepare_candidate")!;
					try {
						const result = await prepare.execute("worker-prepare", { bindingId: "binding", task: input.message }, undefined, undefined, {} as never);
						const payload = JSON.parse((result.content[0] as { text: string }).text);
						assert.equal(payload.context.sources[0].content, userInput, "委派指令不能替换冻结用户原话");
						assert.equal(payload.context.sources[1].kind, "image");
						assert.equal(payload.context.sources[1].originalHash, (await sources.get("owner", payload.context.sources[1].id))!.originalHash);
						const submit = worker.tools.find(tool => tool.name === "knowledge_submit_candidate")!;
						await submit.execute("worker-submit", { bindingId: "binding", pages: [] }, undefined, undefined, {} as never);
						assert.equal(await worker.workerExecution!.shouldStop(), true);
						const receipt = await worker.workerExecution!.finish("worker_no_submission");
						assert.equal(receipt?.status, "completed");
						return { status: "completed", content: receipt!.content, details: { worker: "wiki" } };
					} finally { await worker.workerExecution!.finish("model_error"); }
				} } as unknown as AgentInvoker;
			service.setChatIntake(async (active) => {
				const sm = active.sessionManager as unknown as { fileEntries: unknown[]; flushed: boolean };
				if (!existsSync(active.sessionFile!)) { writeFileSync(active.sessionFile!, sm.fileEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" }); sm.flushed = true; }
				await intakes.admitManager(active);
			}, (sessionId, prompt, images) => intakes.observeExecution(sessionId, prompt, images));
			const sessionDir = path.join(root, "sessions"); await mkdir(sessionDir, { recursive: true });
			const manager = SessionManager.create(root, sessionDir);
			const delegation = buildManagerExtensionFactories({ agents: [wiki], managed: new Set(["agent_wiki__delegate"]), active: new Set(["agent_wiki__delegate"]) }, {
				store: teams, invoker, catalog: { get: () => undefined }, getSessionId: () => manager.getSessionId(), ctx: { type: "group" }, resolveContext: async () => undefined,
			} as unknown as ManagerExtensionDeps).find(factory => typeof factory === "object" && factory.name === "agent-wiki-delegation")!;
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR!, noExtensions: true, noSkills: !expand, noContextFiles: true, noPromptTemplates: !template,
				settingsManager: SettingsManager.inMemory(), extensionFactories: [delegation, service.managerExtension(() => manager.getSessionId())] }); await loader.reload();
			({ session } = await createAgentSession({ cwd: root, model, modelRuntime: models, sessionManager: manager, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), noTools: "builtin" }));
			await session.bindExtensions({ mode: "rpc" }); service.guardManagerSession(session); sessions.push(session);
			const refs = await intakes.prepare({ ownerId: "owner", windowId: "window", sessionId: session.sessionId, operationId: `op-${revoke}-${expand}-${template}`, text: userInput, uploads: [image] });
			const disarm = intakes.armManager(session, refs, userInput, [image]); const before = requests.length;
			await session.prompt(userInput, { images: [{ type: "image", data: image.base64, mimeType: image.mediaType }] }); disarm();
			assert.equal(requests.length - before, revoke ? 1 : 2);
			assert.deepEqual(requests[before]!.tools!.map((tool) => tool.function.name), ["agent_wiki__delegate"]);
			assert.ok(JSON.stringify(requests[before]!.messages).includes(image.base64));
			assert.equal(delegatedTask, "目标binding：模型整理指令：虚构日期10月30日");
			assert.equal(created?.task, delegatedTask); assert.equal(created?.sourceText, undefined); assert.deepEqual(created?.sourceIds, refs.sourceIds);
			assert.equal(created?.executionMode, "worker"); assert.equal(createCalls, 1);
			assert.equal(preparationCalls, revoke ? 0 : 1);
			assert.equal((await sources.readText("owner", refs.sourceIds[0]!)).text, userInput);
			if (expand) {
				assert.ok(JSON.stringify(requests[before]!.messages).includes("可信技能展开文本"), "使用真实SDK技能加载和展开，不是测试手动改写prompt");
				assert.match(disarm.executionText(), /可信技能展开文本/, "HTTP waiter仍可读取可信执行文本，即使本轮已完成disarm");
				assert.doesNotMatch((await sources.readText("owner", refs.sourceIds[0]!)).text, /可信技能展开文本/, "SDK技能指令不能冒充用户原话事实");
			}
			if (template) {
				assert.ok(JSON.stringify(requests[before]!.messages).includes("可信模板展开文本"));
				assert.match(disarm.executionText(), /可信模板展开文本/);
				assert.doesNotMatch((await sources.readText("owner", refs.sourceIds[0]!)).text, /可信模板展开文本/);
			}
			assert.equal((await sources.get("owner", refs.sourceIds[1]!))?.kind, "image");
			assert.deepEqual((await sources.readOriginal("owner", refs.sourceIds[1]!)).bytes, Buffer.from(image.base64, "base64"));
			if (revoke) assert.match(JSON.stringify(session.messages.at(-1)), /授权已撤销/);
		}
	} finally {
		for (const session of sessions) session.dispose(); await new Promise<void>((resolve) => server.close(() => resolve())); resetSharedModelRuntime();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
