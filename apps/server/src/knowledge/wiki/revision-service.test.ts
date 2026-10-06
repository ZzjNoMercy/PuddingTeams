import assert from "node:assert/strict";
import { localViewerIdentity } from "../../routes/identity.js";
const OWNER = localViewerIdentity().user.id;
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { TeamsStore } from "../../store/teams.js";
import { KnowledgeAcceptanceStore } from "../acceptance.js";
import { KnowledgeBindingRegistry } from "../bindings.js";
import { KnowledgeObjectStore } from "../objects.js";
import { KnowledgeSelectionStore } from "../selections.js";
import { KnowledgeRuntimeService } from "../runtime-service.js";
import { KnowledgeSourceStore } from "../sources.js";
import { CuratorJobStore, WikiCuratorService } from "../curator-jobs.js";
import { publicationManifestHash } from "../contracts.js";
import { ReviewStore } from "./review-store.js";
import { WikiRevisionService } from "./revision-service.js";
import { registerWikiCuratorRoutes } from "../../routes/wiki-curator.js";
import { PublishJournal } from "./publish-journal.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-revision-")), vault = path.join(root, "vault"); await mkdir(vault);
	const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "workspaces") }, root); await teams.init();
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state")), binding = await bindings.create({ ownerId: OWNER, rootPath: vault, name: "Wiki", description: "test" });
	const objects = new KnowledgeObjectStore(path.join(root, "objects")), acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"));
	const sources = new KnowledgeSourceStore({ stateDir: path.join(root, "state"), objects }), selections = new KnowledgeSelectionStore(path.join(root, "state"), bindings);
	const runtime = new KnowledgeRuntimeService({ bindings, acceptance, objects, selections, teams, stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache") });
	const jobs = new CuratorJobStore(path.join(root, "state")), reviews = new ReviewStore(path.join(root, "reviews"));
	let failRevision = false;
	const curator = new WikiCuratorService({ jobs, reviews, bindings, acceptance, objects, sources, runtime, teams, cacheDir: path.join(root, "cache"), generate: async (job, _surface, submit) => {
		if (job.revision && failRevision) throw new Error("revision model temporarily unavailable");
		await submit.execute("submit", { pages: [{ path: "note.md", content: `---\nsources: [${job.sources[0]!.id}]\n---\n${job.revision ? job.revision.feedback : "旧候选"}\n`, reason: job.revision?.feedback ?? "第一次整理" }] }, undefined, undefined, {} as never);
	} });
	const publications = new PublishJournal(path.join(root, "operations"));
	const revisions = new WikiRevisionService({ reviews, jobs, curator, bindings, objects, publications });
	const created = await curator.create({ ownerId: OWNER, operationId: "first", bindingId: binding.id, agentId: "wiki", task: "用户资料", origin: { windowId: "original-window", sessionId: "original-session" } }); await curator.waitForIdle();
	const job = (await jobs.get(created.job.id))!, record = (await reviews.get(job.candidateBatchId!))!;
	const input = { batchId: record.batch.id, actorId: OWNER, operationId: "return-one", manifestHash: record.batch.manifestHash, feedback: "澄清日期，不要合并同名人物", reviewedFiles: [] };
	return { root, vault, teams, binding, bindings, jobs, reviews, curator, revisions, objects, acceptance, runtime, sources, job, record, input, publications,
		setRevisionFailure: (value: boolean) => { failRevision = value; } };
}

test("退回生成独立Job/manifest，保留旧候选和真实已阅子集；重试同key同反馈幂等", async () => {
	const f = await fixture();
	try {
		const result = await f.revisions.request(f.input); await f.curator.waitForIdle();
		const revised = (await f.jobs.get(result.job.id))!, batch = (await f.reviews.get(revised.candidateBatchId!))!;
		assert.notEqual(revised.id, f.job.id); assert.notEqual(batch.batch.id, f.record.batch.id);
		assert.deepEqual(revised.origin, f.job.origin, "受信原始会话关联传播，删除会话不会删除新任务");
		assert.deepEqual(revised.sources.slice(0, f.job.sources.length).map((source) => source.id), f.job.sources.map((source) => source.id));
		assert.equal(revised.sources.length, f.job.sources.length + 1, "修改意见是独立新来源，原件身份保持");
		assert.equal((await f.sources.readText(OWNER, revised.sources.at(-1)!.id)).text, f.input.feedback);
		assert.deepEqual(revised.revision?.candidateFiles, f.record.batch.files.map((file) => ({ path: file.targetPath, contentHash: file.candidateHash})));
		assert.equal(batch.batch.parentBatchId, f.record.batch.id); assert.equal(batch.batch.revisionFeedback, f.input.feedback);
		assert.notEqual(publicationManifestHash({ ...batch.batch, revisionFeedback: "其他反馈" }), batch.batch.manifestHash);
		const old = (await f.reviews.get(f.record.batch.id))!;
		assert.equal(old.status, "returned"); assert.equal(old.batch.manifestHash, f.record.batch.manifestHash); assert.deepEqual(old.batch.files, f.record.batch.files);
		assert.equal(old.returnRequest?.jobId, revised.id); assert.deepEqual(old.returnRequest?.reviewedFiles, []);
		const replay = await new WikiRevisionService({ ...f, curator: f.curator }).request(f.input);
		assert.equal(replay.replayed, true); assert.equal(replay.job.id, revised.id);
		await assert.rejects(f.revisions.request({ ...f.input, feedback: "不同反馈" }), /operationId/);
		await assert.rejects(f.reviews.decide({ batchId: old.batch.id, operationId: "late-approve", actorId: OWNER, decision: "approve", manifestHash: old.batch.manifestHash, reviewedFiles: ["note.md"] }));
		assert.deepEqual(await readdir(f.vault), []);
	} finally { await f.curator.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("修订失败后重试链映射到新任务/候选，首次return操作因果和幂等不被改写", async () => {
	const f = await fixture();
	try {
		f.setRevisionFailure(true); const returned = await f.revisions.request(f.input); await f.curator.waitForIdle();
		assert.equal((await f.jobs.get(returned.job.id))?.status, "failed");
		f.setRevisionFailure(false); const retry = await f.curator.retry(OWNER, returned.job.id, "retry-revision"); await f.curator.waitForIdle();
		const latest = (await f.jobs.get(retry.job.id))!; assert.equal(latest.status, "pending_review");
		const parent = (await f.reviews.get(f.record.batch.id))!, followup = await f.revisions.followup(parent);
		assert.equal(parent.returnRequest?.jobId, returned.job.id, "首次因果保留");
		assert.equal(followup?.jobId, latest.id); assert.equal(followup?.newBatchId, latest.candidateBatchId);
		const replay = await f.revisions.request(f.input); assert.equal(replay.replayed, true); assert.equal(replay.job.id, returned.job.id);
		await f.revisions.recover(); assert.equal((await f.revisions.followup((await f.reviews.get(parent.batch.id))!))?.newBatchId, latest.candidateBatchId);
		assert.equal((await f.jobs.list()).length, 3);
	} finally { await f.curator.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("退回落账后创建Job失败可恢复，恢复两次只有一个新Job；批准与退回竞态只能一方成功", async () => {
	const f = await fixture();
	try {
		const create = f.curator.create.bind(f.curator); f.curator.create = async () => { throw new Error("crash after return commit"); };
		await assert.rejects(f.revisions.request(f.input), /crash/);
		assert.equal((await f.reviews.get(f.record.batch.id))?.status, "returned"); assert.equal((await f.jobs.list()).length, 1);
		f.curator.create = create; await f.revisions.recover(); await f.curator.waitForIdle(); await f.revisions.recover();
		assert.equal((await f.jobs.list()).length, 2); assert.ok((await f.reviews.get(f.record.batch.id))?.returnRequest?.jobId);
		const child = (await f.reviews.list()).find((batch) => batch.batch.parentBatchId === f.record.batch.id)!;
		const race = await Promise.allSettled([
			f.reviews.returnForRevision({ ...f.input, batchId: child.batch.id, operationId: "race-return", manifestHash: child.batch.manifestHash}),
			f.reviews.decide({ batchId: child.batch.id, operationId: "race-approve", actorId: OWNER, decision: "approve", manifestHash: child.batch.manifestHash, reviewedFiles: ["note.md"] }),
		]);
		assert.equal(race.filter((result) => result.status === "fulfilled").length, 1); assert.equal(race.filter((result) => result.status === "rejected").length, 1);
		assert.deepEqual(await readdir(f.vault), []);
	} finally { await f.curator.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("revision HTTP权限、反馈校验、幂等重放；client私有source/revision字段不授予权限", async () => {
	const f = await fixture(), app = Fastify();
	try {
		registerWikiCuratorRoutes(app, { ...f, service: f.curator, revisions: f.revisions });
		const url = `/api/wiki/batches/${encodeURIComponent(f.record.batch.id)}/revisions`;
		const body = { operationId: f.input.operationId, manifestHash: f.input.manifestHash, feedback: f.input.feedback, reviewedFiles: [] };
		assert.equal((await app.inject({ method: "POST", url, payload: { ...body, feedback: "" } })).statusCode, 400);
		assert.equal((await app.inject({ method: "POST", url, payload: { ...body, reviewedFiles: ["other.md"] } })).statusCode, 409);
		const result = await app.inject({ method: "POST", url, payload: { ...body, revision: { sourceIds: ["forged"] } } }); assert.equal(result.statusCode, 202);
		await f.curator.waitForIdle(); const replay = await app.inject({ method: "POST", url, payload: body }); assert.equal(replay.statusCode, 202); assert.equal(replay.json().replayed, true);
		assert.equal((await app.inject({ method: "POST", url, payload: { ...body, feedback: "different" } })).statusCode, 409);
		await f.bindings.revoke(OWNER, f.binding.id, 1); assert.equal((await app.inject({ method: "POST", url, payload: body })).statusCode, 404);
	} finally { await app.close(); await f.curator.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("连续退回保留已离开当前基线但经实际阅读的旧采纳来源", async () => {
	const f = await fixture();
	let curator: WikiCuratorService | undefined;
	try {
		const original = await f.objects.put(Buffer.from("# fixed accepted A\n"));
		await f.acceptance.adopt(f.binding.id, [{ relativePath: "source.md", contentHash: original.hash, acceptedBy: OWNER }], 0);
		const source = Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries)[0]!;
		curator = new WikiCuratorService({ ...f, cacheDir: path.join(f.root, "cache"), generate: async (job, surface, submit) => {
			const result = await surface.tools.find((tool) => tool.name === "knowledge_read")!.execute("read", { bindingId: f.binding.id, noteRef: source.acceptanceId }, undefined, undefined, {} as never);
			assert.match(JSON.stringify(result), /fixed accepted A/);
			await submit.execute("submit", { pages: [{ path: "output.md", content: `---\nsources: [${source.acceptanceId}]\n---\n${job.revision?.feedback ?? "first"}`, reason: "保留固定证据" }] }, undefined, undefined, {} as never);
		} });
		const service = new WikiRevisionService({ ...f, curator });
		const created = await curator.create({ ownerId: OWNER, operationId: "chain", bindingId: f.binding.id, agentId: "wiki", task: "据A整理" }); await curator.waitForIdle();
		let job = (await f.jobs.get(created.job.id))!;
		const newer = await f.objects.put(Buffer.from("# accepted B\n"));
		await f.acceptance.adopt(f.binding.id, [{ relativePath: "source.md", contentHash: newer.hash, acceptedBy: OWNER }], 1);
		for (const number of [1, 2]) {
			const record = (await f.reviews.get(job.candidateBatchId!))!;
			const result = await service.request({ batchId: record.batch.id, actorId: OWNER, operationId: `chain-return-${number}`, manifestHash: record.batch.manifestHash,
				feedback: `修订${number}`, reviewedFiles: [] }); await curator.waitForIdle(); job = (await f.jobs.get(result.job.id))!;
			assert.equal(job.status, "pending_review", JSON.stringify(job));
			assert.equal(job.revision?.acceptedSources?.[0]?.acceptanceId, source.acceptanceId);
			assert.equal(job.baseline[0]?.contentHash, newer.hash);
			assert.deepEqual((await f.reviews.get(job.candidateBatchId!))?.batch.sourceSnapshots, [original.hash]);
		}
	} finally { await curator?.waitForIdle(); await f.curator.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

async function makeConflict(f: Awaited<ReturnType<typeof fixture>>, uncertain = false) {
	const decision = await f.reviews.decide({ batchId: f.record.batch.id, actorId: OWNER, operationId: "original-approve", decision: "approve", manifestHash: f.record.batch.manifestHash, reviewedFiles: f.record.batch.files.map(file => file.targetPath) });
	const operation = (await f.publications.begin({ batch: f.record.batch, ownerId: OWNER, actorId: OWNER, reviewId: decision.decision.id, idempotencyKey: decision.decision.id })).record;
	await f.publications.setRunning(operation.id); await f.reviews.markPublishing(f.record.batch.id);
	await f.publications.settle(operation.id, uncertain ? "unknown" : "conflict", uncertain ? "结果未知" : "结构已变化，零写入");
	await f.reviews.settlePublish(f.record.batch.id, "conflict", uncertain ? "publish_uncertain" : "publish_preflight");
	return operation;
}

test("冲突直接重新整理：原始来源保留、新候选独立待审，重复请求仅一个任务", async () => {
	const f = await fixture();
	try {
		const operation = await makeConflict(f);
		const result = await f.revisions.request(f.input); await f.curator.waitForIdle();
		const replay = await f.revisions.request(f.input); assert.equal(replay.job.id, result.job.id); assert.equal(replay.replayed, true);
		const old = (await f.reviews.get(f.record.batch.id))!, next = (await f.jobs.get(result.job.id))!;
		assert.equal(old.status, "returned"); assert.equal(old.batch.manifestHash, f.record.batch.manifestHash); assert.ok(old.decisionId);
		assert.equal((await f.publications.get(operation.id))!.state, "conflict", "历史发布失败如实保留");
		assert.notEqual(next.candidateBatchId, old.batch.id); assert.equal((await f.reviews.get(next.candidateBatchId!))!.status, "pending_review");
		assert.deepEqual(next.sources.slice(0, f.job.sources.length).map(source => source.id), f.job.sources.map(source => source.id));
		assert.deepEqual(await readdir(f.vault), [], "重新整理不会直接发布");
	} finally { await f.curator.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});

test("未知发布结果不允许重新整理，关闭与重新整理竞态只接受一个处理", async () => {
	const f = await fixture();
	try {
		const operation = await makeConflict(f, true);
		await assert.rejects(f.revisions.request(f.input), /对账/);
		assert.equal((await f.jobs.list()).length, 1);
		await f.publications.settle(operation.id, "conflict");
		const race = await Promise.allSettled([
			f.revisions.request(f.input),
			f.reviews.closeConflict({ batchId: f.record.batch.id, actorId: OWNER, operationId: "close", manifestHash: f.record.batch.manifestHash}),
		]);
		assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
		assert.equal(race.filter(result => result.status === "rejected").length, 1);
	} finally { await f.curator.waitForIdle(); await rm(f.root, { recursive: true, force: true }); }
});
