import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSelectionStore } from "./selections.js";
import { KnowledgeRuntimeService } from "./runtime-service.js";
import { KnowledgeSourceStore } from "./sources.js";
import { CuratorJobStore, WikiCuratorService, type CuratorJob } from "./curator-jobs.js";
import { ReviewStore } from "./wiki/review-store.js";
import { MarkdownWikiPublisher } from "./wiki/publisher-markdown.js";
import { PublishJournal } from "./wiki/publish-journal.js";
import { KnowledgeObservationService } from "./observation.js";
import { KnowledgeSearchIndex } from "./search-index.js";
import { ChatKnowledgeIntake } from "./chat-intake.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { KnowledgeHistoryStore } from "./history-store.js";
import { registerKnowledgeRoutes } from "../routes/knowledge.js";
import { localViewerIdentity } from "../routes/identity.js";
import Fastify from "fastify";
import { imageAssetPath } from "./image-publication.js";
import { ReadLaterStore } from "../read-later/store.js";
import { ReadLaterCaptureService } from "../read-later/capture-service.js";
import { ReadLaterPromoter } from "../read-later/promote.js";

async function fixture(generate?: ConstructorParameters<typeof WikiCuratorService>[0]["generate"], extractImage?: ConstructorParameters<typeof WikiCuratorService>[0]["extractImage"], ownerId = "owner") {
	const root = await mkdtemp(path.join(tmpdir(), "pt-curator-")), vault = path.join(root, "vault"), cwd = path.join(root, "project");
	await mkdir(vault); await mkdir(cwd);
	const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "workspaces") }, cwd);
	await teams.init();
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
	const binding = await bindings.create({ ownerId, rootPath: vault, name: "Wiki", description: "Test" });
	const history = new KnowledgeHistoryStore(path.join(root, "history"));
	const objects = new KnowledgeObjectStore(path.join(root, "objects")), acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"), history);
	const selections = new KnowledgeSelectionStore(path.join(root, "state"), bindings), sources = new KnowledgeSourceStore({ stateDir: path.join(root, "state"), objects });
	const runtime = new KnowledgeRuntimeService({ teams, bindings, acceptance, objects, selections, stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache") });
	const jobs = new CuratorJobStore(path.join(root, "state")), reviews = new ReviewStore(path.join(root, "reviews"));
	const service = new WikiCuratorService({ jobs, bindings, acceptance, objects, reviews, runtime, teams, sources, cacheDir: path.join(root, "cache"),
		extractImage, generate: generate ?? (async (job, _surface, submit) => {
			await submit.execute("submit", { pages: [{ path: "note.md", content: `---\nsources: [${job.sources[0]!.id}]\n---\n# 记录\n${job.task}\n`, reason: "整理用户原话" }] }, undefined, undefined, {} as never);
		}) });
	const publisher = new MarkdownWikiPublisher({ bindings, reviews, objects, acceptance, journal: new PublishJournal(path.join(root, "operations")),
		observation: new KnowledgeObservationService(acceptance, { objects }), searchIndex: new KnowledgeSearchIndex(path.join(root, "cache"), objects), operationsDir: path.join(root, "operations") });
	return { root, vault, cwd, teams, bindings, binding, objects, acceptance, history, runtime, jobs, reviews, sources, service, publisher };
}
async function completed(jobs: CuratorJobStore, id: string): Promise<CuratorJob> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const job = (await jobs.get(id))!;
		if (job.status !== "queued" && job.status !== "running" && job.status !== "submitting") return job;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("job did not settle");
}

test("普通 Pi Worker 对 Wiki 只读，memory 专用请求不能改目标，默认库变更后工具失效", async () => {
	const f = await fixture();
	try {
		const scope = { ownerId: "owner", windowId: "window", sessionId: "ordinary-worker", contextKey: "session:ordinary-worker" };
		const base = await f.runtime.mount(scope, [f.binding.id]);
		const input = { ...scope, operationId: "memory-turn", sourceText: "用户明确要求：以后回复用中文" };
		const regular = f.service.requestSurface(base, input);
		assert.equal(regular.prompt, base.prompt);
		const ordinaryReadOnly = f.service.workerSurface(base, input);
		assert.deepEqual(ordinaryReadOnly.tools.map(tool => tool.name).sort(), ["knowledge_context", "knowledge_glob", "knowledge_links", "knowledge_read", "knowledge_search"]);
		assert(f.service.workerSurface(base, input, "wiki").tools.some(tool => tool.name === "knowledge_request_curation"));
		let current = true;
		const defaultMemory = { bindingId: f.binding.id, assertCurrent: async () => { if (!current) throw new Error("默认 memory 已变化"); } };
		assert(!f.service.workerSurface(base, input, undefined, defaultMemory).tools.some(tool => tool.name === "memory_request_update"), "没有实际挂载 memory 不提供更新入口");
		const memory = f.service.workerSurface({ ...base, memoryBindingIds: [f.binding.id] }, input, undefined, defaultMemory);
		assert.match(memory.prompt, /用户明确要求记住、纠正或忘记/);
		assert.match(memory.prompt, /memory_request_update/);
		assert(!memory.tools.some(tool => tool.name === "knowledge_request_curation"));
		assert.notEqual(memory.fingerprint, ordinaryReadOnly.fingerprint, "工具变化必须重建会话");
		assert(!memory.tools.some(tool => ["write", "edit", "publish", "approve"].includes(tool.name)));
		const request = memory.tools.find(tool => tool.name === "memory_request_update")!;
		assert(!JSON.stringify(request.parameters).includes("bindingId"));
		const result = await request.execute("remember", { bindingId: "another-wiki", task: "记录长期回复偏好" }, undefined, undefined, {} as never);
		const jobId = JSON.parse((result.content[0] as { text: string }).text).jobId;
		await f.service.waitForIdle();
		assert.equal((await f.jobs.get(jobId))?.status, "pending_review");
		assert.equal((await f.jobs.get(jobId))?.targetBindingId, f.binding.id, "即便伪造额外参数也只能请求宿主指定的 memory");
		assert.deepEqual(await readdir(f.vault), []);
		current = false;
		await assert.rejects(memory.assertCurrent(), /默认 memory 已变化/);
		await assert.rejects(request.execute("stale", { task: "再次提交" }, undefined, undefined, {} as never), /默认 memory 已变化/);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

const assetPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
test("稍后读晋升冻结网页与图片；删除收藏后仍可审核发布", async () => {
	const f = await fixture();
	const store = new ReadLaterStore(path.join(f.root, "read-later"));
	const image = Buffer.concat([assetPng, Buffer.alloc(300)]);
	const capture = new ReadLaterCaptureService(store, async url => ({ url, status: 200, headers: { "content-type": url.includes("img.") ? "image/png" : "text/html" }, body: url.includes("img.") ? image : Buffer.from(`<article>${"正文中的事实必须保留出处，并经人工审核后才能发布。".repeat(20)}<img src="https://img.example.com/a.png"></article>`) }));
	const promoter = new ReadLaterPromoter({ store, capture, sources: f.sources, curator: f.service, bindings: f.bindings, teams: f.teams });
	try {
		const saved = store.create("owner", { operationId: "save", url: "https://example.com/article", note: "私人想法" }); capture.start();
		for (let i = 0; i < 200 && store.get("owner", saved.item.id).parseStatus !== "ready"; i++) await new Promise(r => setTimeout(r, 5));
		const item = store.get("owner", saved.item.id);
		const input = { operationId: "promote", items: [{ id: item.id, versionId: item.activeVersionId! }], bindingId: f.binding.id, task: "整理原文事实" };
		const outcome = await promoter.promote("owner", input); await f.service.waitForIdle();
		const done = (await f.jobs.get(outcome.job.id))!; assert.equal(done.status, "pending_review", done.failureCode);
		const source = done.sources[0]!; assert(source.webCapture); assert.equal(source.assets?.length, 1); assert.doesNotMatch((await f.sources.readText("owner", source.id)).text, /私人想法/);
		await capture.remove("owner", item.id, store.get("owner", item.id).revision);
		assert.equal((await promoter.promote("owner", input)).job.id, outcome.job.id);
		assert.equal((await f.sources.readAsset("owner", source.id, source.assets![0]!.hash)).equals(image), true);
		const batch = (await f.reviews.get(done.candidateBatchId!))!.batch; assert.equal(batch.files.filter(file => file.kind === "image").length, 1);
		await f.publisher.onApproved(batch, (await f.reviews.decide({ batchId: batch.id, operationId: "approve-web", actorId: "owner", decision: "approve", manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: batch.files.map(file => file.targetPath) })).decision);
		assert.match(await readFile(path.join(f.vault, "note.md"), "utf8"), /assets\/images/);
	} finally { await capture.close(); await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});
const extractFixture: NonNullable<ConstructorParameters<typeof WikiCuratorService>[0]["extractImage"]> = async input => ({ version: 1, extractorId: "pi-vision", extractorVersion: "1", modelRef: "fixture/vision", configHash: "f".repeat(64), originalHash: input.originalHash, width: 1, height: 1, segments: [{ text: "原图事实", warnings: [] }], warnings: [], createdAt: new Date().toISOString() });

test("Curator原图随采用页固定；未采纳/无变化页的图片不入发布包", async () => {
	let firstContent = "", mode = "first";
	const f = await fixture(async (job, _surface, submit) => {
		const image = job.sources.find(source => source.kind === "image")!, text = job.sources.find(source => source.kind === "text")!;
		const content = mode === "first" ? `---\nsources: [${text.id}, ${image.id}]\n---\n# 原图事实\n` : firstContent;
		await submit.execute("submit", { pages: [{ path: "facts/nested/page.md", content, reason: "采纳首图" }, ...(mode === "first" ? [] : [{ path: "new.md", content: `---\nsources: [${text.id}]\n---\n# 仅文字新页\n`, reason: "文字新增" }])] }, undefined, undefined, {} as never);
	}, extractFixture);
	try {
		const unused = Buffer.concat([assetPng, Buffer.from("unused")]);
		const created = await f.service.create({ ownerId: "owner", operationId: "images", bindingId: f.binding.id, agentId: "wiki", task: "只采用首图", uploads: [assetPng, unused].map((bytes, index) => ({ filename: `${index}.png`, mediaType: "image/png", data: bytes.toString("base64") })) });
		await f.service.waitForIdle(); const done = (await f.jobs.get(created.job.id))!; assert.equal(done.status, "pending_review", done.failureCode);
		const batch = (await f.reviews.get(done.candidateBatchId!))!.batch;
		assert.equal(batch.files.filter(file => file.kind === "image").length, 1);
		const asset = batch.files.find(file => file.kind === "image")!, page = batch.files.find(file => file.kind !== "image")!;
		firstContent = (await f.objects.get(page.blobRef!)).toString(); assert.match(firstContent, /!\[.*\]\(\.\.\/\.\.\/assets\/images\/[a-f0-9]{64}\.png\)/);
		assert.deepEqual(batch.dependencyGroups, [[asset.targetPath, page.targetPath]]);
		assert.deepEqual(await readdir(f.vault), []);
		const decision = (await f.reviews.decide({ batchId: batch.id, operationId: "human", actorId: "owner", decision: "approve", manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: batch.files.map(file => file.targetPath) })).decision;
		await f.publisher.onApproved(batch, decision);
		assert.deepEqual(await readdir(path.join(f.vault, "assets/images")), [path.basename(asset.targetPath)]);
		assert.equal((await f.history.list(f.binding.id, page.targetPath)).versions.length, 1);
		assert.equal((await f.history.list(f.binding.id, asset.targetPath)).versions.length, 0);
		mode = "noop";
		const next = await f.service.create({ ownerId: "owner", operationId: "noop", bindingId: f.binding.id, agentId: "wiki", task: "只增加文字页", sourceIds: done.sources.map(source => source.id) });
		await f.service.waitForIdle(); const nextDone = (await f.jobs.get(next.job.id))!; assert.equal(nextDone.status, "pending_review", nextDone.failureCode);
		assert.deepEqual((await f.reviews.get(nextDone.candidateBatchId!))!.batch.files.map(file => file.targetPath), ["new.md"]);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("历史原图只读取该固定版本实际引用的审核bytes，磁盘变异不污染历史，撤权拒绝", async () => {
	const owner = localViewerIdentity().user.id;
	const f = await fixture(async (job, _surface, submit) => {
		const images = job.sources.filter(source => source.kind === "image");
		await submit.execute("submit", { pages: images.map((source, index) => ({ path: `facts/${index}.md`, content: `---\nsources: [${source.id}]\n---\n# 页面${index}\n`, reason: "独立采纳原图" })) }, undefined, undefined, {} as never);
	}, extractFixture, owner);
	const app = Fastify();
	registerKnowledgeRoutes(app, f.bindings, { objects: f.objects, acceptance: f.acceptance, history: f.history, reviews: f.reviews, observation: new KnowledgeObservationService(f.acceptance, { objects: f.objects }), searchIndex: new KnowledgeSearchIndex(path.join(f.root, "cache"), f.objects) });
	try {
		const originals = [assetPng, Buffer.concat([assetPng, Buffer.from("second-image")])];
		const created = await f.service.create({ ownerId: owner, operationId: "history-images", bindingId: f.binding.id, agentId: "wiki", task: "分别采纳两图", uploads: originals.map((bytes, i) => ({ filename: `${i}.png`, mediaType: "image/png", data: bytes.toString("base64") })) });
		await f.service.waitForIdle(); const done = (await f.jobs.get(created.job.id))!; assert.equal(done.status, "pending_review", done.failureCode);
		const batch = (await f.reviews.get(done.candidateBatchId!))!.batch;
		await f.publisher.onApproved(batch, (await f.reviews.decide({ batchId: batch.id, operationId: "history-human", actorId: owner, decision: "approve", manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: batch.files.map(file => file.targetPath) })).decision);
		const version = (await f.history.list(f.binding.id, "facts/0.md")).versions[0]!;
		const ownAsset = imageAssetPath(done.sources.filter(source => source.kind === "image")[0]!.originalHash, "image/png"), otherAsset = imageAssetPath(done.sources.filter(source => source.kind === "image")[1]!.originalHash, "image/png");
		const url = (target: string) => `/api/knowledge/${f.binding.id}/history/${version.id}/assets?path=${encodeURIComponent(target)}`;
		assert.equal((await app.inject(url(otherAsset))).statusCode, 404, "同批但本页未引用原图不可读");
		const unknown = await f.objects.put(Buffer.concat([assetPng, Buffer.from("unrelated-object")]));
		assert.equal((await app.inject(url(imageAssetPath(unknown.hash, "image/png")))).statusCode, 404, "不能按猜测hash读取独立对象库");
		await writeFile(path.join(f.vault, ownAsset), "external-corruption");
		const frozen = await app.inject(url(ownAsset)); assert.equal(frozen.statusCode, 200); assert.deepEqual(frozen.rawPayload, originals[0]);
		assert.equal((await app.inject(`/api/knowledge/${f.binding.id}/asset?path=${encodeURIComponent(ownAsset)}`)).statusCode, 200, "用户外部图片变更不受原图SHA命名约束");
		await f.bindings.revoke(owner, f.binding.id, f.binding.bindingRevision);
		assert.equal((await app.inject(url(ownAsset))).statusCode, 404);
	} finally { await app.close(); await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("聊天固定sourceIDs进入Curator，模型任务独立于用户原话；请求重放与撤权均守边界", async () => {
	const f = await fixture(async (job, _surface, submit) => {
		assert.equal(job.task, "模型整理任务：错误日期10月30日");
		assert.equal(job.sources.length, 1);
		const source = await f.sources.readText("owner", job.sources[0]!.id);
		assert.equal(source.text, "用户原话：真实日期10月23日");
		await submit.execute("submit", { pages: [{ path: "fact.md", content: `---\nsources: [${job.sources[0]!.id}]\n---\n${source.text}\n`, reason: "仅固定用户素材作事实" }] }, undefined, undefined, {} as never);
	});
	try {
		const intake = new ChatKnowledgeIntake({ stateDir: path.join(f.root, "state"), sources: f.sources });
		const refs = await intake.prepare({ ownerId: "owner", windowId: "window", sessionId: "chat", operationId: "accepted-user", text: "用户原话：真实日期10月23日", uploads: [] });
		const entry = { id: "direct-user", type: "custom_message", customType: "pudding:user_message", details: { operationId: refs.operationId, sourceRefs: refs } };
		const file = path.join(f.root, "chat.jsonl"); await writeFile(file, JSON.stringify(entry) + "\n");
		const session = { sessionId: "chat", sessionFile: file, sessionManager: { getBranch: () => [entry] } } as unknown as AgentSession;
		await intake.admitDirect(session, refs);
		const base = await f.runtime.mount({ ownerId: "owner", windowId: "window", sessionId: "chat", contextKey: "chat" }, [f.binding.id]);
		const request = f.service.requestSurface(base, { ownerId: "owner", windowId: "window", sessionId: "chat", operationId: "delegation",
			resolveSources: () => intake.resolve(session, "owner", { operationId: refs.operationId }) }).tools.find((tool) => tool.name === "knowledge_request_curation")!;
		const args = { bindingId: f.binding.id, task: "模型整理任务：错误日期10月30日" };
		const first = await request.execute("tool", args, undefined, undefined, {} as never);
		const replay = await request.execute("tool", args, undefined, undefined, {} as never);
		const result = JSON.parse(first.content[0]!.type === "text" ? first.content[0]!.text : "{}");
		assert.equal(JSON.parse(replay.content[0]!.type === "text" ? replay.content[0]!.text : "{}").jobId, result.jobId);
		const final = await completed(f.jobs, result.jobId); assert.equal(final.status, "pending_review");
		assert.deepEqual(final.sources.map((source) => source.id), refs.sourceIds);
		const batch = (await f.reviews.get(final.candidateBatchId!))!;
		const bytes = (await f.objects.get(batch.batch.files[0]!.blobRef!)).toString(); assert.match(bytes, /真实日期10月23日/); assert.doesNotMatch(bytes, /错误日期10月30日/);
		await f.bindings.revoke("owner", f.binding.id, f.binding.bindingRevision);
		await assert.rejects(request.execute("new-tool", args, undefined, undefined, {} as never), /撤|授权|不可|信任|not found/);
		assert.equal((await f.jobs.list("owner")).length, 1);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("空库文字→固定候选→人审→按已审字节发布，cwd与Vault分离", async () => {
	const f = await fixture();
	try {
		const { job } = await f.service.create({ ownerId: "owner", operationId: "op", bindingId: f.binding.id, agentId: "wiki", task: "项目截止日期为2026-10-23。" });
		const final = await completed(f.jobs, job.id);
		assert.equal(final.status, "pending_review");
		assert.deepEqual(await readdir(f.vault), [], "审核前Vault零写入");
		assert.deepEqual(await readdir(f.cwd), [], "不把库挂成cwd也不写入项目");
		const record = (await f.reviews.get(final.candidateBatchId!))!;
		const approved = await f.reviews.decide({ batchId: record.batch.id, operationId: "human", actorId: "owner", decision: "approve",
			manifestHash: record.batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: ["note.md"] });
		await f.publisher.onApproved(record.batch, approved.decision);
		assert.equal((await f.reviews.get(record.batch.id))?.status, "published");
		assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), (await f.objects.get(record.batch.files[0]!.blobRef!)).toString("utf8"));
		assert.equal(Object.keys((await f.acceptance.getSnapshot(f.binding.id)).entries).length, 1);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("幂等重放复用Job；新文字同key冲突；MD保留原文和独立来源", async () => {
	const f = await fixture();
	try {
		const input = { ownerId: "owner", operationId: "op", bindingId: f.binding.id, agentId: "wiki", task: "整理资料", uploads: [{ filename: "source.md", mediaType: "text/markdown", data: Buffer.from("# 原件\n张三与另一位张三不同。\n").toString("base64") }] };
		const first = await f.service.create(input), replay = await f.service.create(input);
		assert.equal(replay.replayed, true); assert.equal(replay.job.id, first.job.id);
		await assert.rejects(f.service.create({ ...input, task: "修改内容" }), /operationId/);
		const final = await completed(f.jobs, first.job.id);
		assert.equal(final.sources[1]?.kind, "markdown");
		assert.match((await f.sources.readText("owner", final.sources[1]!.id)).text, /另一位张三/);
		assert.equal(await f.sources.get("other", final.sources[1]!.id), undefined);
		assert.deepEqual(await readdir(f.vault), []);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("来源会话删除后拒绝与审批来源可读取，重启不依赖会话目录", async () => {
	const f = await fixture();
	try {
		const sessionRoot = path.join(f.root, "session"); await mkdir(sessionRoot); await writeFile(path.join(sessionRoot, "chat.jsonl"), "user");
		const created = await f.service.create({ ownerId: "owner", operationId: "op", bindingId: f.binding.id, agentId: "wiki", task: "待确认事实",
			origin: { sessionId: "deleted", windowId: "deleted" } });
		const final = await completed(f.jobs, created.job.id);
		await rm(sessionRoot, { recursive: true });
		const reopened = new ReviewStore(path.join(f.root, "reviews")), record = (await reopened.get(final.candidateBatchId!))!;
		await reopened.decide({ batchId: record.batch.id, operationId: "reject", actorId: "owner", decision: "reject", manifestHash: record.batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: [] });
		assert.equal((await reopened.get(record.batch.id))?.status, "rejected");
		assert.equal((await new KnowledgeSourceStore({ stateDir: path.join(f.root, "state"), objects: f.objects }).readText("owner", final.sources[0]!.id)).text, "待确认事实");
		assert.deepEqual(await readdir(f.vault), []);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("候选不覆盖未采纳外部文件，不允许伪造来源或越界路径", async () => {
	for (const violation of ["external", "source", "path"]) {
		const f = await fixture(async (job, _surface, submit) => {
			const pages = [{ path: violation === "path" ? "../outside.md" : "note.md", content: `---\nsources: [${violation === "source" ? "invented" : job.sources[0]!.id}]\n---\n更新`, reason: "test" }];
			await submit.execute("submit", { pages }, undefined, undefined, {} as never);
		});
		try {
			if (violation === "external") await writeFile(path.join(f.vault, "note.md"), "外部未采纳资料");
			const { job } = await f.service.create({ ownerId: "owner", operationId: "op", bindingId: f.binding.id, agentId: "wiki", task: "整理" });
			assert.equal((await completed(f.jobs, job.id)).status, "failed");
			assert.equal((await f.reviews.list()).length, 0);
			if (violation === "external") assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "外部未采纳资料");
		} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
	}
});

test("PDF原件保留但未提取不得生成候选", async () => {
	const f = await fixture();
	try {
		const { job } = await f.service.create({ ownerId: "owner", operationId: "op", bindingId: f.binding.id, agentId: "wiki", task: "整理PDF",
			uploads: [{ filename: "source.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-1.7\nfixture").toString("base64") }] });
		assert.equal(job.status, "needs_attention");
		assert.equal(job.sources[1]?.textHash, undefined);
		assert.match(job.failureCode!, /尚未接入/);
		assert.deepEqual(await readdir(f.vault), []);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("并发提交只有一个固定候选，跨数据库崩溃按同一manifest恢复", async () => {
	let outcomes: PromiseSettledResult<unknown>[] = [];
	const f = await fixture(async (job, _surface, submit) => {
		outcomes = await Promise.allSettled(["候选A", "候选B"].map((text) => submit.execute("submit", { pages: [{ path: "note.md", content: `---\nsources: [${job.sources[0]!.id}]\n---\n${text}`, reason: text }] }, undefined, undefined, {} as never)));
	});
	try {
		const { job } = await f.service.create({ ownerId: "owner", operationId: "race", bindingId: f.binding.id, agentId: "wiki", task: "facts" });
		const settled = await completed(f.jobs, job.id);
		await f.service.waitForIdle();
		assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
		assert.equal((await f.reviews.get(settled.candidateBatchId!))?.batch.manifestHash, settled.frozenCandidate?.manifestHash);
		const originalRegister = f.reviews.registerCandidate.bind(f.reviews);
		f.reviews.registerCandidate = async () => { throw new Error("simulated crash after durable claim"); };
		const second = await f.service.create({ ownerId: "owner", operationId: "crash", bindingId: f.binding.id, agentId: "wiki", task: "facts" });
		for (let n = 0; n < 200 && (await f.jobs.get(second.job.id))?.status !== "submitting"; n++) await new Promise((r) => setTimeout(r, 10));
		await f.service.waitForIdle();
		const staged = (await f.jobs.get(second.job.id))!;
		assert.equal(staged.status, "submitting");
		f.reviews.registerCandidate = originalRegister;
		await f.service.recover();
		const recovered = (await f.jobs.get(second.job.id))!;
		assert.equal(recovered.status, "pending_review");
		assert.equal((await f.reviews.get(recovered.candidateBatchId!))?.batch.manifestHash, staged.frozenCandidate?.manifestHash);
		assert.deepEqual(await readdir(f.vault), []);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("运行中取消使迟到提交失败，操作契约新增或变更使候选失效", async () => {
	for (const mode of ["cancel", "contract"]) {
		let resume!: () => void, started!: () => void;
		const gate = new Promise<void>((resolve) => { resume = resolve; }), entered = new Promise<void>((resolve) => { started = resolve; });
		const f = await fixture(async (job, _surface, submit) => {
			started(); await gate;
			await submit.execute("submit", { pages: [{ path: "note.md", content: `---\nsources: [${job.sources[0]!.id}]\n---\nfact`, reason: "facts" }] }, undefined, undefined, {} as never);
		});
		try {
			const { job } = await f.service.create({ ownerId: "owner", operationId: mode, bindingId: f.binding.id, agentId: "wiki", task: "facts" });
			await entered;
			if (mode === "cancel") await f.service.cancel("owner", job.id);
			else await writeFile(path.join(f.vault, "AGENTS.md"), "index与log只允许追加");
			resume();
			const final = await completed(f.jobs, job.id);
			assert.equal(final.status, mode === "cancel" ? "cancelled" : "failed");
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal((await f.reviews.list()).length, 0);
			assert(! (await readdir(f.vault)).includes("note.md"));
		} finally { resume(); await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
	}
});

test("更新保留该页真实历史来源，历史来源不授予其他页凭空引用", async () => {
	for (const mode of ["preserve", "forge"]) {
		const f = await fixture(async (job, _surface, submit) => {
			const id = job.historicalSources![0]!.id;
			await submit.execute("submit", { pages: [{ path: mode === "preserve" ? "note.md" : "other.md", content: `---\nsources: [${id}]\n---\n保留历史事实并修订标题`, reason: "修订" }] }, undefined, undefined, {} as never);
		});
		try {
			const old = await f.sources.createText("owner", "已审核历史事实");
			const bytes = Buffer.from(`---\nsources: [${old.id}]\n---\n历史事实`), snapshot = await f.objects.put(bytes);
			await writeFile(path.join(f.vault, "note.md"), bytes);
			await f.acceptance.adopt(f.binding.id, [{ relativePath: "note.md", contentHash: snapshot.hash, snapshotRef: snapshot.hash, acceptedBy: "owner" }], 0);
			const { job } = await f.service.create({ ownerId: "owner", operationId: mode, bindingId: f.binding.id, agentId: "wiki", task: "只修订标题" });
			const final = await completed(f.jobs, job.id);
			assert.equal(final.status, mode === "preserve" ? "pending_review" : "failed");
			if (mode === "preserve") assert.deepEqual((await f.reviews.get(final.candidateBatchId!))?.batch.sourceSnapshots, [old.originalHash]);
			assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), bytes.toString());
		} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
	}
});

test("固定契约随审核冻结，候选不能改写AGENTS，批准后契约变化仍零写入", async () => {
	const f = await fixture();
	try {
		await writeFile(path.join(f.vault, "AGENTS.md"), "库操作契约v1");
		const { job } = await f.service.create({ ownerId: "owner", operationId: "contract", bindingId: f.binding.id, agentId: "wiki", task: "事实" });
		const final = await completed(f.jobs, job.id), record = (await f.reviews.get(final.candidateBatchId!))!;
		assert.equal(record.batch.contractHash, job.contractHash);
		const approved = await f.reviews.decide({ batchId: record.batch.id, operationId: "human", actorId: "owner", decision: "approve", manifestHash: record.batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: ["note.md"] });
		await writeFile(path.join(f.vault, "AGENTS.md"), "库操作契约v2");
		await f.publisher.onApproved(record.batch, approved.decision).catch(() => undefined);
		assert(!(await readdir(f.vault)).includes("note.md"));
		assert.notEqual((await f.reviews.get(record.batch.id))?.status, "published");
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("历史已采纳来源版本离开实时账本后，仍沿实际发布receipt保留引用", async () => {
	const f = await fixture(async (job, surface, submit) => {
		let sourceId: string;
		if (job.task === "first") {
			const read = await surface.tools.find((tool) => tool.name === "knowledge_read")!.execute("read", { bindingId: job.targetBindingId, noteRef: "source.md" }, undefined, undefined, {} as never);
			sourceId = JSON.parse((read.content[0] as { text: string }).text).noteRef;
		} else sourceId = job.historicalAcceptedSources![0]!.id;
		await submit.execute("submit", { pages: [{ path: "output.md", content: `---\nsources: [${sourceId}]\n---\n${job.task}`, reason: "保留已核实来源" }] }, undefined, undefined, {} as never);
	});
	try {
		const firstSource = await f.objects.put(Buffer.from("# source v1"));
		await writeFile(path.join(f.vault, "source.md"), "# source v1");
		await f.acceptance.adopt(f.binding.id, [{ relativePath: "source.md", contentHash: firstSource.hash, snapshotRef: firstSource.hash, acceptedBy: "owner" }], 0);
		const first = await f.service.create({ ownerId: "owner", operationId: "first", bindingId: f.binding.id, agentId: "wiki", task: "first" });
		const ready = await completed(f.jobs, first.job.id); await f.service.waitForIdle();
		const batch = (await f.reviews.get(ready.candidateBatchId!))!.batch;
		const approved = await f.reviews.decide({ batchId: batch.id, operationId: "approve", actorId: "owner", decision: "approve", manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: ["output.md"] });
		await f.publisher.onApproved(batch, approved.decision);
		const secondSource = await f.objects.put(Buffer.from("# source v2"));
		await writeFile(path.join(f.vault, "source.md"), "# source v2");
		await f.acceptance.adopt(f.binding.id, [{ relativePath: "source.md", contentHash: secondSource.hash, snapshotRef: secondSource.hash, acceptedBy: "owner" }], 2);
		const second = await f.service.create({ ownerId: "owner", operationId: "second", bindingId: f.binding.id, agentId: "wiki", task: "second" });
		const final = await completed(f.jobs, second.job.id); await f.service.waitForIdle();
		assert.equal(final.status, "pending_review");
		assert.equal(final.historicalAcceptedSources?.[0]?.snapshotRef, firstSource.hash);
		assert.deepEqual((await f.reviews.get(final.candidateBatchId!))?.batch.sourceSnapshots, [firstSource.hash]);
		assert.match(await readFile(path.join(f.vault, "output.md"), "utf8"), /first/);
	} finally { await f.service.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("图片衍生保存中的取消/授权撤销：缓存可留，来源账本和候选不落", async()=>{
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=","base64");
 for(const mode of ["cancel","revoke"]){
  const f=await fixture(undefined,async(input)=>({version:1,extractorId:"pi-vision",extractorVersion:"1",modelRef:"fixture/vision",configHash:"f".repeat(64),originalHash:input.originalHash,width:1,height:1,segments:[{text:"图像事实",warnings:[]}],warnings:[],createdAt:new Date().toISOString()}));
  let release!:()=>void,enter!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>enter=resolve);
  const put=f.objects.put.bind(f.objects);f.objects.put=async(bytes)=>{if(bytes.toString().includes('"sourceId"')){enter();await blocked;}return put(bytes);};
  try{
   const {job}=await f.service.create({ownerId:"owner",operationId:mode,bindingId:f.binding.id,agentId:"wiki",task:"图片整理",uploads:[{filename:"image.png",mediaType:"image/png",data:png.toString("base64")}]});
   await entered;if(mode==="cancel")await f.service.cancel("owner",job.id);else await f.bindings.revoke("owner",f.binding.id,f.binding.bindingRevision);
   release();await f.service.waitForIdle();assert.equal((await f.jobs.get(job.id))!.status,mode==="cancel"?"cancelled":"needs_attention");assert.deepEqual(await f.reviews.list(),[]);
   const db=new DatabaseSync(path.join(f.root,"state","sources.sqlite"));try{assert.equal((db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get() as {n:number}).n,2,"没有提交新衍生source");}finally{db.close();}
   assert.deepEqual(await readdir(f.vault),[]);
  }finally{release();await f.service.waitForIdle();await rm(f.root,{recursive:true,force:true});}
 }
});
