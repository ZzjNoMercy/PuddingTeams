import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import type { AgentDriver } from "../agent-runtime/types.js";
import type { AgentConfig } from "../store/teams.js";
import { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { createCompileAdmission } from "../knowledge/compile-admission.js";
import { CompileJobStore } from "../knowledge/compile-jobs.js";
import type { CompileJob, KnowledgeBinding, PublicationBatch } from "../knowledge/contracts.js";
import { publicationManifestHash } from "../knowledge/contracts.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeObservationService } from "../knowledge/observation.js";
import { KnowledgeSearchIndex } from "../knowledge/search-index.js";
import { PublishJournal } from "../knowledge/wiki/publish-journal.js";
import { MarkdownWikiPublisher, type PublishStepHook } from "../knowledge/wiki/publisher-markdown.js";
import { ReviewStore } from "../knowledge/wiki/review-store.js";
import { syncCandidateBatches } from "../knowledge/wiki/candidate-sync.js";
import { imageAssetPath } from "../knowledge/image-publication.js";
import { localViewerIdentity } from "./identity.js";
import { registerWikiRoutes, type WikiRouteDeps } from "./wiki.js";

interface WikiFixture {
	root: string;
	vault: string;
	app: FastifyInstance;
	binding: KnowledgeBinding;
	acceptanceId: string;
	acceptance: KnowledgeAcceptanceStore;
	objects: KnowledgeObjectStore;
	jobs: CompileJobStore;
	reviews: ReviewStore;
	journal: PublishJournal;
	searchIndex: KnowledgeSearchIndex;
	publisherCalls: string[];
	delegations: DelegationStore;
	deps: WikiRouteDeps;
	behavior: { candidates: Record<string, string> | null; hang: boolean; started: number };
	knobs: { packageDigest: string | undefined; commandOk: boolean };
}

async function wikiFixture(opts?: { now?: () => number; realPublisher?: boolean; stepHook?: PublishStepHook }): Promise<WikiFixture> {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pt-wiki-route-")));
	const vault = path.join(root, "vault");
	await mkdir(vault);
	await writeFile(path.join(vault, "a.md"), "# Accepted\n");
	const ownerId = localViewerIdentity().user.id;
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
	const binding = await bindings.create({ ownerId, name: "Wiki", description: "Test", rootPath: vault });
	const objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const blob = await objects.put(await readFile(path.join(vault, "a.md")));
	const acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"));
	await acceptance.adopt(binding.id, [{ relativePath: "a.md", contentHash: blob.hash, snapshotRef: blob.hash, acceptedBy: ownerId }], 0);
	const acceptanceId = Object.values((await acceptance.getSnapshot(binding.id)).entries)[0]!.acceptanceId;
	const observation = new KnowledgeObservationService(acceptance, { objects });
	const jobs = new CompileJobStore(path.join(root, "state"));
	const commandPath = path.join(root, "codex-stub");
	await writeFile(commandPath, "#!/bin/sh\nexit 0\n");
	await chmod(commandPath, 0o755);
	const commandSha256 = createHash("sha256").update(await readFile(commandPath)).digest("hex");
	const behavior: WikiFixture["behavior"] = { candidates: null, hang: false, started: 0 };
	const knobs: WikiFixture["knobs"] = { packageDigest: "a".repeat(64), commandOk: true };
	const driver: AgentDriver = {
		id: "codex",
		async capabilities() {
			return { operations: ["run", "cancel"], interactionKinds: [], progress: "none", transport: "spawn", cancelConfirmation: "acknowledged" };
		},
		async *run(_request, ctx) {
			behavior.started++;
			yield { type: "started", runHandle: "run-1" };
			if (behavior.hang) {
				await new Promise<void>((resolve) => {
					if (ctx.signal?.aborted) return resolve();
					ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				yield { type: "failed", result: { agentId: "codex", status: "cancelled", errorCode: "cancelled", error: "已取消", recoverable: true } };
				return;
			}
			for (const [relative, content] of Object.entries(behavior.candidates ?? {})) {
				const target = path.join(ctx.cwd, relative);
				await mkdir(path.dirname(target), { recursive: true });
				await writeFile(target, content);
			}
			yield { type: "completed", result: { agentId: "codex", status: "completed", content: "done" } };
		},
		async *continue() { throw new Error("unused"); },
		async *respond() { throw new Error("unused"); },
		async cancel() { /* acknowledged */ },
		async probe() { throw new Error("unused"); },
	};
	const agent = { name: "codex", description: "Compiler", enabled: true,
		connector: { connectorId: "codex", transport: "spawn", config: {} }, extensionRevision: 1 } as AgentConfig;
	const teams = { getAgent: async (name: string) => name === "codex" ? agent : undefined };
	const admission = createCompileAdmission({
		jobs, bindings, acceptance, observation, objects, teams,
		extensions: { attestBundledDriver: async () => knobs.packageDigest },
	});
	const delegations = new DelegationStore(path.join(root, "delegations"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(root, "secrets"));
	await secrets.init();
	const runtime = new AgentRuntime(delegations, secrets, () => driver, undefined, undefined, undefined, undefined, admission);
	const reviews = new ReviewStore(path.join(root, "reviews"), opts?.now);
	const journal = new PublishJournal(path.join(root, "operations"), opts?.now);
	const searchIndex = new KnowledgeSearchIndex(path.join(root, "index-cache"), objects);
	const publisherCalls: string[] = [];
	const publisher = opts?.realPublisher
		? new MarkdownWikiPublisher({
			bindings, reviews, journal, acceptance, observation, objects, searchIndex,
			operationsDir: path.join(root, "operations"),
			...(opts.stepHook ? { stepHook: opts.stepHook } : {}),
		})
		: {
			onApproved: async (batch: PublicationBatch) => {
				publisherCalls.push(batch.id);
				return { accepted: true, note: "stub" };
			},
		};
	const deps: WikiRouteDeps = {
		jobs, bindings, acceptance, observation, objects, teams,
		resolveDriver: () => driver,
		attestCompiler: async () => knobs.packageDigest,
		resolveCommand: async () => {
			if (!knobs.commandOk) throw Object.assign(new Error("未检测到 Codex CLI，请先安装并完成登录"), { code: "capability_unavailable" });
			return { commandPath, commandSha256 };
		},
		runCompileJob: (jobId) => runtime.runCompileJob(jobId),
		cancelDelegation: (delegationId, ctx) => runtime.cancel(delegationId, ctx),
		compileRoot: path.join(root, "cache", "compile"),
		reviews,
		publisher,
		publications: journal,
	};
	const app = Fastify();
	registerWikiRoutes(app, deps);
	return { root, vault, app, binding, acceptanceId, acceptance, objects, jobs, reviews, journal, searchIndex, publisherCalls, delegations, deps, behavior, knobs };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const payload = (fixture: WikiFixture, operationId: string) => ({
	operationId, bindingId: fixture.binding.id, agentId: "codex", task: "整理我的笔记", sourceAcceptanceIds: [fixture.acceptanceId],
});

let directBatchSeq = 0;

/** 绕过编译链直接登记一个合法候选批次（字节入对象库，manifestHash 回填）。 */
async function registerBatchDirect(fixture: WikiFixture,
	files: Array<{ targetPath: string; content: string; operation?: "create" | "update" }>): Promise<PublicationBatch> {
	directBatchSeq += 1;
	const batch: PublicationBatch = {
		id: `direct-batch-${directBatchSeq}`,
		revision: 1,
		bindingId: fixture.binding.id,
		manifestHash: "",
		rootIdentity: fixture.binding.rootIdentity,
		files: await Promise.all(files.map(async (file) => {
			const blob = await fixture.objects.put(Buffer.from(file.content, "utf8"));
			const operation = file.operation ?? "create";
			return {
				targetPath: file.targetPath,
				operation,
				expectedHashOrAbsent: operation === "create" ? null :
					createHash("sha256").update("# Accepted\n").digest("hex"),
				candidateHash: blob.hash,
				blobRef: blob.hash,
			};
		})),
		sourceSnapshots: ["snapshot-direct"],
		bindingRevision: 1,
		trustRevision: 1,
		dependencyGroups: [files.map((file) => file.targetPath)],
		validationReceipt: "{}",
		compilerVersion: "test-compiler",
		status: "candidate",
	};
	batch.manifestHash = publicationManifestHash(batch);
	await fixture.reviews.registerCandidate(batch, localViewerIdentity().user.id);
	return batch;
}

const reviewBody = (batch: PublicationBatch, overrides: Record<string, unknown> = {}) => ({
	operationId: `review-${batch.id}`,
	decision: "approve",
	manifestHash: batch.manifestHash,
	expectedBatchRevision: 1,
	reviewedFiles: batch.files.map((file) => file.targetPath),
	...overrides,
});

test("图片审核接口返回固定原图元数据和bytes，未入批次/跨归属/撤权访问拒绝", async () => {
	const f = await wikiFixture();
	try {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
		const image = await f.objects.put(png), assetPath = imageAssetPath(image.hash, "image/png");
		const page = await f.objects.put(Buffer.from(`---\nsources: [image-source]\n---\n![original](../../${assetPath})\n`));
		const batch: PublicationBatch = { id: "image-api", revision: 1, bindingId: f.binding.id, manifestHash: "", rootIdentity: f.binding.rootIdentity, bindingRevision: 1, trustRevision: 1, sourceSnapshots: [image.hash], compilerVersion: "test", status: "candidate", validationReceipt: JSON.stringify({ sources: [{ id: "image-source", kind: "image", mediaType: "image/png", originalHash: image.hash }] }), files: [
			{ kind: "image", targetPath: assetPath, mediaType: "image/png", sourceIds: ["image-source"], operation: "create", expectedHashOrAbsent: null, candidateHash: image.hash, blobRef: image.hash },
			{ targetPath: "facts/nested/page.md", operation: "create", expectedHashOrAbsent: null, candidateHash: page.hash, blobRef: page.hash }
		], dependencyGroups: [[assetPath, "facts/nested/page.md"]] };
		batch.manifestHash = publicationManifestHash(batch);
		await f.reviews.registerCandidate(batch, localViewerIdentity().user.id);
		const base = `/api/wiki/batches/${batch.id}`;
		const file = await f.app.inject(`${base}/file?path=${encodeURIComponent(assetPath)}`);
		assert.equal(file.statusCode, 200); assert.deepEqual(file.json(), { kind: "image", path: assetPath, operation: "create", sourceIds: ["image-source"], candidate: { hash: image.hash, mediaType: "image/png", base64: png.toString("base64") }, baseline: null });
		const raw = await f.app.inject(`${base}/assets?path=${encodeURIComponent(assetPath)}`); assert.equal(raw.statusCode, 200); assert.deepEqual(raw.rawPayload, png);
		assert.equal(raw.headers["x-content-type-options"], "nosniff");
		const unrelated = await f.objects.put(Buffer.concat([png, Buffer.from("private-other")]));
		assert.equal((await f.app.inject(`${base}/assets?path=${encodeURIComponent(imageAssetPath(unrelated.hash, "image/png"))}`)).statusCode, 404);
		const other = { ...batch, id: "other-owner" }; other.manifestHash = publicationManifestHash(other); await f.reviews.registerCandidate(other, "other");
		assert.equal((await f.app.inject(`/api/wiki/batches/other-owner/assets?path=${encodeURIComponent(assetPath)}`)).statusCode, 404);
		await new KnowledgeBindingRegistry(path.join(f.root, "state")).revoke(localViewerIdentity().user.id, f.binding.id, f.binding.bindingRevision);
		assert.equal((await f.app.inject(`${base}/assets?path=${encodeURIComponent(assetPath)}`)).statusCode, 404);
	} finally { await f.app.close(); }
});

test("wiki 编译读取根目录唯一 schema，并把冻结契约交给 Worker 与候选校验", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture();
	const schema = {
		formatVersion: 1, schemaId: "ai-wiki", revision: 1, name: "AI Wiki", description: "test",
		entities: [{ type: "note", directory: "Notes", fields: [
			{ name: "type", type: "text", required: true },
			{ name: "title", type: "text", required: true },
			{ name: "sources", type: "text_list", required: true },
		] }], relations: [],
	};
	await writeFile(path.join(fixture.vault, "wiki.schema.json"), JSON.stringify(schema));
	fixture.behavior.candidates = { "Notes/new.md": `---\ntype: note\ntitle: 新笔记\nsources:\n  - ${fixture.acceptanceId}\n---\n# 新笔记\n` };
	const body = payload(fixture, "op-root-schema");
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: body });
	assert.equal(created.statusCode, 202, JSON.stringify(created.json()));
	const job = created.json().job as CompileJob;
	assert.match(job.schemaHash ?? "", /^[a-f0-9]{64}$/);
	assert.equal(JSON.parse(job.schemaContract ?? "{}").schemaId, "ai-wiki");
	assert.ok(job.task.includes("目标 Wiki 的结构契约"));
	const done = await waitFor(() => fixture.jobs.get(job.id), (item) => item?.status === "candidate_ready" || item?.status === "failed");
	assert.equal(done?.status, "candidate_ready", done?.failureCode);
	const replay = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: body });
	assert.equal(replay.statusCode, 202);
	assert.equal(replay.json().replayed, true);
	await fixture.app.close();
});

test("wiki 编译路由：POST 202 → 运行至 candidate_ready → 幂等重放与查询", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture();
	fixture.behavior.candidates = {
		"Daily/2026-09-28.md": `---\nsources:\n  - ${fixture.acceptanceId}\n---\n# Daily\n`,
		"a.md": `---\nsources:\n  - ${fixture.acceptanceId}#a.md\n---\n# Updated\n`,
	};
	const body = payload(fixture, "op-happy");
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: body });
	assert.equal(created.statusCode, 202);
	assert.equal(created.json().replayed, false);
	const job = created.json().job as CompileJob;
	assert.equal(job.status, "queued");
	const ready = (await waitFor(() => fixture.jobs.get(job.id), (current) => current?.status === "candidate_ready"))!;
	assert.equal(ready.candidateBatchId, `compile-candidate:${job.id}`);
	const detail = await fixture.app.inject({ method: "GET", url: `/api/wiki/compile-jobs/${job.id}` });
	assert.equal(detail.statusCode, 200);
	const batch = detail.json().batch;
	assert.deepEqual(batch.files.map((file: { operation: string; targetPath: string }) => `${file.operation}:${file.targetPath}`),
		["create:Daily/2026-09-28.md", "update:a.md"]);
	const updatedBlob = await fixture.objects.get(batch.files[1].blobRef);
	assert.ok(updatedBlob.toString("utf8").includes("# Updated"));
	// 正式库与账本零变化；候选字节只进对象库与 Job 私有批次文件
	assert.equal(await readFile(path.join(fixture.vault, "a.md"), "utf8"), "# Accepted\n");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 1);
	// 幂等重放：同 operationId 同参数 → 同一 Job，不重新运行
	const replay = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: body });
	assert.equal(replay.statusCode, 202);
	assert.equal(replay.json().replayed, true);
	assert.equal((replay.json().job as CompileJob).id, job.id);
	assert.equal(fixture.behavior.started, 1);
	// 同键不同参数 → 409
	const conflict = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: { ...body, task: "别的任务" } });
	assert.equal(conflict.statusCode, 409);
	// list 过滤与详情归属
	const list = await fixture.app.inject({ method: "GET", url: `/api/wiki/compile-jobs?bindingId=${fixture.binding.id}` });
	assert.equal((list.json().jobs as CompileJob[]).length, 1);
	const listEmpty = await fixture.app.inject({ method: "GET", url: "/api/wiki/compile-jobs?bindingId=other-binding" });
	assert.equal((listEmpty.json().jobs as CompileJob[]).length, 0);
	// 终态不可取消
	const cancel = await fixture.app.inject({ method: "POST", url: `/api/wiki/compile-jobs/${job.id}/cancel` });
	assert.equal(cancel.statusCode, 409);
	await fixture.app.close();
});

test("wiki 编译路由：queued 任务可取消，重放不重启已终结 Job", async () => {
	const fixture = await wikiFixture();
	fixture.deps.runCompileJob = () => new Promise(() => undefined); // 永不领取，Job 停在 queued
	const body = payload(fixture, "op-queued");
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: body });
	assert.equal(created.statusCode, 202);
	const job = created.json().job as CompileJob;
	const cancel = await fixture.app.inject({ method: "POST", url: `/api/wiki/compile-jobs/${job.id}/cancel` });
	assert.equal(cancel.statusCode, 200);
	assert.equal((cancel.json().job as CompileJob).status, "cancelled");
	const replay = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: body });
	assert.equal(replay.statusCode, 202);
	assert.equal((replay.json().job as CompileJob).status, "cancelled", "已取消的 Job 不得因重放重新点火");
	assert.equal(fixture.behavior.started, 0);
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 1);
	assert.equal(await readFile(path.join(fixture.vault, "a.md"), "utf8"), "# Accepted\n");
	await fixture.app.close();
});

test("wiki 编译路由：running 任务取消后 Job 与 Delegation 收敛，正式库零变化", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture();
	fixture.behavior.hang = true;
	const body = payload(fixture, "op-running");
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: body });
	assert.equal(created.statusCode, 202);
	const job = created.json().job as CompileJob;
	const running = (await waitFor(() => fixture.jobs.get(job.id), (current) => current?.status === "running" && !!current.delegationId))!;
	// Job admission precedes the Driver's started receipt. This case tests
	// acknowledged cancellation of a running Driver, so wait for its run handle.
	await waitFor(() => fixture.delegations.getDelegation(running.delegationId!), (record) => record?.executionState === "running" && !!record.runHandle);
	const cancel = await fixture.app.inject({ method: "POST", url: `/api/wiki/compile-jobs/${job.id}/cancel` });
	assert.equal(cancel.statusCode, 200);
	assert.equal((cancel.json().job as CompileJob).status, "cancelled");
	await waitFor(() => fixture.delegations.getDelegation(running.delegationId!), (record) => record?.executionState === "cancelled");
	const detail = await fixture.app.inject({ method: "GET", url: `/api/wiki/compile-jobs/${job.id}` });
	assert.equal(detail.statusCode, 200);
	assert.equal(detail.json().batch, undefined, "取消的 Job 无候选批次");
	assert.equal(await readFile(path.join(fixture.vault, "a.md"), "utf8"), "# Accepted\n");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 1);
	await fixture.app.close();
});

test("wiki 编译路由：无来源声明的候选整批拒绝，Job 失败且正式库不变", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture();
	fixture.behavior.candidates = { "evil.md": "# No sources\n" };
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: payload(fixture, "op-invalid") });
	assert.equal(created.statusCode, 202);
	const job = created.json().job as CompileJob;
	const failed = (await waitFor(() => fixture.jobs.get(job.id), (current) => current?.status === "failed"))!;
	assert.equal(failed.failureCode, "candidate_validation_failed");
	const detail = await fixture.app.inject({ method: "GET", url: `/api/wiki/compile-jobs/${job.id}` });
	assert.equal(detail.json().batch, undefined);
	assert.equal(await readFile(path.join(fixture.vault, "a.md"), "utf8"), "# Accepted\n");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 1);
	await fixture.app.close();
});

test("wiki 编译路由：参数、归属与能力快速校验", async () => {
	const fixture = await wikiFixture();
	const body = payload(fixture, "op-validate");
	const missing = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: {} });
	assert.equal(missing.statusCode, 400);
	const duplicated = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs",
		payload: { ...body, sourceAcceptanceIds: [fixture.acceptanceId, fixture.acceptanceId] } });
	assert.equal(duplicated.statusCode, 400);
	const unknownBinding = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: { ...body, bindingId: "nope" } });
	assert.equal(unknownBinding.statusCode, 404);
	const unknownAgent = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: { ...body, agentId: "nope" } });
	assert.equal(unknownAgent.statusCode, 400);
	const unknownSource = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: { ...body, sourceAcceptanceIds: ["missing"] } });
	assert.equal(unknownSource.statusCode, 400);
	const unknownJob = await fixture.app.inject({ method: "GET", url: "/api/wiki/compile-jobs/nope" });
	assert.equal(unknownJob.statusCode, 404);
	const cancelUnknown = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs/nope/cancel" });
	assert.equal(cancelUnknown.statusCode, 404);
	fixture.knobs.packageDigest = undefined;
	const untrusted = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: { ...body, operationId: "op-untrusted" } });
	assert.equal(untrusted.statusCode, 422);
	fixture.knobs.packageDigest = "a".repeat(64);
	fixture.knobs.commandOk = false;
	const noCli = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: { ...body, operationId: "op-no-cli" } });
	assert.equal(noCli.statusCode, 422);
	assert.equal((await fixture.jobs.list()).length, 0, "快速校验失败不得留下 Job");
	await fixture.app.close();
});

test("wiki 审核路由：编译候选转正 → 列表/详情/文件 diff → approve 全流程与幂等", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture();
	fixture.behavior.candidates = {
		"Daily/2026-09-28.md": `---\nsources:\n  - ${fixture.acceptanceId}\n---\n# Daily\n`,
		"a.md": `---\nsources:\n  - ${fixture.acceptanceId}#a.md\n---\n# Updated\n`,
	};
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: payload(fixture, "op-review-e2e") });
	assert.equal(created.statusCode, 202);
	const job = created.json().job as CompileJob;
	await waitFor(() => fixture.jobs.get(job.id), (current) => current?.status === "candidate_ready");
	// 读后转正：列表出现 pending_review 批次
	const list = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches" });
	assert.equal(list.statusCode, 200);
	const summaries = list.json().batches as Array<{ id: string; status: string; revision: number; fileCount: number }>;
	assert.equal(summaries.length, 1);
	assert.equal(summaries[0]!.id, `compile-candidate:${job.id}`);
	assert.equal(summaries[0]!.status, "pending_review");
	assert.equal(summaries[0]!.revision, 1);
	assert.equal(summaries[0]!.fileCount, 2);
	// 详情：manifestHash 与 24h 审核截止
	const detail = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${summaries[0]!.id}` });
	assert.equal(detail.statusCode, 200);
	const detailBody = detail.json();
	assert.match(detailBody.manifestHash, /^[a-f0-9]{64}$/);
	assert.equal(Date.parse(detailBody.reviewDeadline) - Date.parse(detailBody.enteredReviewAt), 24 * 60 * 60 * 1000);
	const batch = detailBody.batch as PublicationBatch;
	assert.deepEqual(batch.files.map((file) => `${file.operation}:${file.targetPath}`), ["create:Daily/2026-09-28.md", "update:a.md"]);
	// 文件端点：create 无基线全 add；update 以正式库为基线含 del+add
	const created_file = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${batch.id}/file?path=${encodeURIComponent("Daily/2026-09-28.md")}` });
	assert.equal(created_file.statusCode, 200);
	assert.equal(created_file.json().baseline, null);
	const createdKinds = (created_file.json().hunks as Array<{ lines: Array<{ kind: string }> }>).flatMap((h) => h.lines).map((line) => line.kind);
	assert.ok(createdKinds.includes("add") && !createdKinds.includes("del"), "create 无基线，diff 只增不删");
	const updated = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${batch.id}/file?path=a.md` });
	assert.equal(updated.statusCode, 200);
	assert.equal(updated.json().baseline.content, "# Accepted\n");
	const kinds = (updated.json().hunks as Array<{ lines: Array<{ kind: string }> }>).flatMap((h) => h.lines).map((line) => line.kind);
	assert.ok(kinds.includes("del") && kinds.includes("add"));
	// approve：决定落账、publisher 挂载点被调一次、publishRequestedAt 登记
	const approve = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch) });
	assert.equal(approve.statusCode, 200);
	assert.equal(approve.json().status, "approved");
	assert.equal(approve.json().batch.status, "approved");
	assert.equal(approve.json().replayed, false);
	assert.equal(approve.json().decision.revision, batch.revision);
	assert.ok(approve.json().publishRequestedAt);
	assert.deepEqual(fixture.publisherCalls, [batch.id]);
	// 同 body 重放：仍为 approved 的批次会重驱幂等 publisher
	const replay = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch) });
	assert.equal(replay.statusCode, 200);
	assert.equal(replay.json().replayed, true);
	assert.equal(fixture.publisherCalls.length, 2);
	// 已决批次再审（新 operationId）→ 409
	const again = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch, { operationId: "review-again" }) });
	assert.equal(again.statusCode, 409);
	// 正式库与账本零变化
	assert.equal(await readFile(path.join(fixture.vault, "a.md"), "utf8"), "# Accepted\n");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 1);
	await fixture.app.close();
});

test("wiki 审核路由：reject 与审核防伪造校验", async () => {
	const fixture = await wikiFixture();
	const batch = await registerBatchDirect(fixture, [{ targetPath: "notes/a.md", content: "# A\n" }]);
	// 伪造 manifestHash → 409
	const forged = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch, { manifestHash: "d".repeat(64) }) });
	assert.equal(forged.statusCode, 409);
	// 陈旧 revision → 409
	const stale = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch, { expectedBatchRevision: 2 }) });
	assert.equal(stale.statusCode, 409);
	// 部分覆盖 → 409
	const partial = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch, { reviewedFiles: ["notes/a.md", "notes/missing.md"] }) });
	assert.equal(partial.statusCode, 409);
	// 跨批借用 manifestHash → 409
	const other = await registerBatchDirect(fixture, [{ targetPath: "notes/b.md", content: "# B\n" }]);
	const cross = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch, { manifestHash: other.manifestHash }) });
	assert.equal(cross.statusCode, 409);
	// 参数快速校验 → 400
	const bad = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: { decision: "approve" } });
	assert.equal(bad.statusCode, 400);
	// reject：200，批次转 rejected；再次决定 → 409
	const rejected = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch, { decision: "reject" }) });
	assert.equal(rejected.statusCode, 200);
	assert.equal(rejected.json().status, "rejected");
	assert.equal(rejected.json().publish, undefined, "reject 不触发发布挂载点");
	assert.equal(fixture.publisherCalls.length, 0);
	const decided = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch, { operationId: "review-post-reject" }) });
	assert.equal(decided.statusCode, 409);
	await fixture.app.close();
});

test("wiki 审核路由：归属、未知批次与 list 过滤", async () => {
	const fixture = await wikiFixture();
	const batch = await registerBatchDirect(fixture, [{ targetPath: "notes/a.md", content: "# A\n" }]);
	const unknownDetail = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches/nope" });
	assert.equal(unknownDetail.statusCode, 404);
	const unknownFile = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${batch.id}/file?path=not-in-batch.md` });
	assert.equal(unknownFile.statusCode, 404);
	const unknownReview = await fixture.app.inject({ method: "POST", url: "/api/wiki/batches/nope/reviews", payload: reviewBody(batch) });
	assert.equal(unknownReview.statusCode, 404);
	const all = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches" });
	assert.equal((all.json().batches as unknown[]).length, 1);
	const filtered = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches?bindingId=${fixture.binding.id}` });
	assert.equal((filtered.json().batches as unknown[]).length, 1);
	const empty = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches?bindingId=other-binding" });
	assert.equal((empty.json().batches as unknown[]).length, 0);
	await fixture.app.close();
});

test("wiki 审核路由：24 小时审核窗超期 → conflict，决定被拒并提示重新编译", async () => {
	let now = Date.parse("2026-09-28T00:00:00Z");
	const fixture = await wikiFixture({ now: () => now });
	const batch = await registerBatchDirect(fixture, [{ targetPath: "notes/a.md", content: "# A\n" }]);
	const fresh = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${batch.id}` });
	assert.equal(fresh.json().status, "pending_review");
	now += 25 * 60 * 60 * 1000;
	const expired = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${batch.id}` });
	assert.equal(expired.statusCode, 200);
	assert.equal(expired.json().status, "conflict");
	assert.equal(expired.json().batch.status, "conflict");
	const decision = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch) });
	assert.equal(decision.statusCode, 409);
	assert.equal(decision.json().code, "expired");
	assert.match(decision.json().error, /重新编译/);
	assert.equal(fixture.publisherCalls.length, 0);
	await fixture.app.close();
});

test("wiki 发布 e2e：compile → approve → published → 磁盘/账本/索引/查询一致", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture({ realPublisher: true });
	const updatedContent = `---\nsources:\n  - ${fixture.acceptanceId}#a.md\n---\n# Updated\n`;
	fixture.behavior.candidates = {
		"Daily/2026-09-28.md": `---\nsources:\n  - ${fixture.acceptanceId}\n---\n# Daily\n`,
		"a.md": updatedContent,
	};
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: payload(fixture, "op-pub-e2e") });
	assert.equal(created.statusCode, 202);
	const job = created.json().job as CompileJob;
	await waitFor(() => fixture.jobs.get(job.id), (current) => current?.status === "candidate_ready");
	const detail = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/compile-candidate:${job.id}` });
	assert.equal(detail.statusCode, 200);
	const batch = detail.json().batch as PublicationBatch;
	const approve = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch) });
	assert.equal(approve.statusCode, 200);
	assert.equal(approve.json().status, "published");
	assert.equal(approve.json().publish.accepted, true);
	assert.match(approve.json().publish.note, /已发布 2 个文件/);
	// 磁盘落盘
	assert.equal(await readFile(path.join(fixture.vault, "a.md"), "utf8"), updatedContent);
	assert.match(await readFile(path.join(fixture.vault, "Daily", "2026-09-28.md"), "utf8"), /# Daily/);
	// 账本回写
	const ledger = await fixture.acceptance.getSnapshot(fixture.binding.id);
	assert.equal(ledger.acceptanceRevision, 2);
	const entries = Object.values(ledger.entries);
	assert.equal(entries.find((entry) => entry.relativePath === "a.md")!.contentHash, createHash("sha256").update(updatedContent).digest("hex"));
	assert.ok(entries.some((entry) => entry.relativePath === "Daily/2026-09-28.md"));
	// 索引含新笔记
	const index = await fixture.searchIndex.load(fixture.binding.id, ledger);
	assert.ok(index.notesByPath.has("Daily/2026-09-28.md"));
	// publications 查询：列表 + 逐项 receipt 明细
	const list = await fixture.app.inject({ method: "GET", url: `/api/wiki/publications?bindingId=${fixture.binding.id}` });
	assert.equal(list.statusCode, 200);
	const publications = list.json().publications as Array<{ id: string; state: string; batchId: string; committedGroups: number }>;
	assert.equal(publications.length, 1);
	assert.equal(publications[0]!.state, "published");
	assert.equal(publications[0]!.batchId, batch.id);
	assert.equal(publications[0]!.committedGroups, 1);
	const operation = await fixture.app.inject({ method: "GET", url: `/api/wiki/publications/${publications[0]!.id}` });
	assert.equal(operation.statusCode, 200);
	const files = operation.json().files as Array<{ targetPath: string; status: string; receipts: Array<{ step: string }>; beforeImageRef: string | null }>;
	const updated = files.find((file) => file.targetPath === "a.md")!;
	assert.equal(updated.status, "applied");
	assert.deepEqual(updated.receipts.map((receipt) => receipt.step), ["preflight", "before_image", "write", "verify"]);
	assert.ok(updated.beforeImageRef);
	assert.equal(files.find((file) => file.targetPath === "Daily/2026-09-28.md")!.status, "applied");
	await fixture.app.close();
});

test("wiki 发布 e2e：审核后外部改动 → 预读冲突整批中止，磁盘与账本不动", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture({ realPublisher: true });
	fixture.behavior.candidates = { "a.md": `---\nsources:\n  - ${fixture.acceptanceId}#a.md\n---\n# Updated\n` };
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: payload(fixture, "op-pub-conflict") });
	assert.equal(created.statusCode, 202);
	const job = created.json().job as CompileJob;
	await waitFor(() => fixture.jobs.get(job.id), (current) => current?.status === "candidate_ready");
	// 审核之后、发布之前的外部改动
	await writeFile(path.join(fixture.vault, "a.md"), "# External\n");
	const detail = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/compile-candidate:${job.id}` });
	const batch = detail.json().batch as PublicationBatch;
	const approve = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch) });
	assert.equal(approve.statusCode, 200);
	assert.equal(approve.json().status, "conflict");
	assert.equal(approve.json().publish.accepted, true);
	assert.match(approve.json().publish.note, /未写入任何字节/);
	assert.equal(await readFile(path.join(fixture.vault, "a.md"), "utf8"), "# External\n", "外部改动原样保留");
	assert.equal((await fixture.acceptance.getSnapshot(fixture.binding.id)).acceptanceRevision, 2, "真实外部编辑自动同步，冲突候选没有发布");
	assert.equal(Object.values((await fixture.acceptance.getSnapshot(fixture.binding.id)).entries)[0]!.contentHash, createHash("sha256").update("# External\n").digest("hex"));
	const list = await fixture.app.inject({ method: "GET", url: `/api/wiki/publications?bindingId=${fixture.binding.id}` });
	const publications = list.json().publications as Array<{ id: string; state: string }>;
	assert.equal(publications.length, 1);
	assert.equal(publications[0]!.state, "conflict");
	const operation = await fixture.app.inject({ method: "GET", url: `/api/wiki/publications/${publications[0]!.id}` });
	const files = operation.json().files as Array<{ targetPath: string; status: string; error?: string }>;
	assert.equal(files[0]!.status, "conflict");
	assert.match(files[0]!.error ?? "", /基线/);
	assert.match(operation.json().stopReason, /未写入任何字节/);
	assert.equal(operation.json().conflictReason, "publish_preflight");
	// A later schema change is current context, not a rewrite of the historic baseline conflict.
	const requireUsable = fixture.deps.bindings.requireUsable.bind(fixture.deps.bindings);
	fixture.deps.bindings.requireUsable = async (owner, id) => ({ ...await requireUsable(owner, id), schemaRef: {
		format: "teams-schema", id: "changed", revision: 2, hash: "a".repeat(64),
	} });
	const diagnosed = await fixture.app.inject({ method: "GET", url: `/api/wiki/publications/${publications[0]!.id}` });
	assert.equal(diagnosed.statusCode, 200);
	assert.match(diagnosed.json().currentContextChanges.join("；"), /结构已更新/);
	assert.equal(diagnosed.json().stopReason, operation.json().stopReason);
	assert.equal((await fixture.journal.get(publications[0]!.id))!.stopReason, operation.json().stopReason);
	const missing = await fixture.app.inject({ method: "GET", url: "/api/wiki/publications/nope" });
	assert.equal(missing.statusCode, 404);
	await fixture.app.close();
});


test("wiki 审核：批准 hook 失败后同 operation 重放能恢复发布，不重复审核决定", async () => {
	const fixture = await wikiFixture({ realPublisher: true });
	const batch = await registerBatchDirect(fixture, [{ targetPath: "retry.md", content: "# Retry\n" }]);
	const publisher = fixture.deps.publisher!;
	let calls = 0;
	fixture.deps.publisher = { onApproved: async (frozen, decision) => {
		calls++;
		if (calls === 1) throw new Error("dispatch unavailable");
		return publisher.onApproved(frozen, decision);
	} };
	const request = { method: "POST" as const, url: `/api/wiki/batches/${batch.id}/reviews`, payload: reviewBody(batch) };
	const first = await fixture.app.inject(request);
	assert.equal(first.json().status, "approved");
	assert.equal(first.json().publish.accepted, false);
	const replay = await fixture.app.inject(request);
	assert.equal(replay.json().replayed, true);
	assert.equal(replay.json().status, "published");
	assert.equal((await fixture.reviews.decisionsFor(batch.id)).length, 1);
	await fixture.app.inject(request);
	assert.equal(calls, 2);
	assert.equal((await fixture.journal.list()).length, 1);
	await fixture.app.close();
});

test("wiki 审核列表：跨库分页真实总数、过滤计数，撤销授权不泄漏，离线历史保留", async () => {
	const fixture = await wikiFixture();
	const registry = new KnowledgeBindingRegistry(path.join(fixture.root, "state"));
	const ownerId = localViewerIdentity().user.id;
	const secondVault = path.join(fixture.root, "second-vault");
	await mkdir(secondVault);
	const second = await registry.create({ ownerId, name: "Second", description: "test", rootPath: secondVault });
	const first = await registerBatchDirect(fixture, [{ targetPath: "first.md", content: "# First\n" }]);
	await registerBatchDirect({ ...fixture, binding: second }, [{ targetPath: "second.md", content: "# Second\n" }]);
	await registerBatchDirect(fixture, [{ targetPath: "third.md", content: "# Third\n" }]);
	const list = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches?status=pending&limit=1&offset=1" });
	assert.equal(list.json().batches.length, 1);
	assert.equal(list.json().filteredTotal, 3);
	assert.equal(list.json().pendingCount, 3);
	assert.ok(list.json().batches[0].bindingName);
	const query = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches?q=Second&limit=1" });
	assert.equal(query.json().filteredTotal, 1);
	assert.equal(query.json().pendingCount, 3);
	await registry.revoke(ownerId, fixture.binding.id, 1);
	const visible = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches?limit=1" });
	assert.equal(visible.json().filteredTotal, 1);
	assert.equal(visible.json().pendingCount, 1);
	assert.equal(visible.json().batches[0].bindingName, "Second");
	assert.equal((await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${first.id}` })).statusCode, 404);
	assert.equal((await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${first.id}/reviews`, payload: reviewBody(first) })).statusCode, 404);
	await import("node:fs/promises").then(({ rename }) => rename(secondVault, `${secondVault}-offline`));
	const offline = await fixture.app.inject({ method: "GET", url: "/api/wiki/batches?limit=1" });
	assert.equal(offline.json().pendingCount, 1);
	assert.equal(offline.json().batches[0].bindingAvailability, "offline");
	assert.equal((await fixture.app.inject({ method: "GET", url: "/api/wiki/batches?offset=-1" })).statusCode, 400);
	await fixture.app.close();
});


test("wiki 候选主动登记：Job 完成后无需读页面，重启恢复/重复同步不重置审核窗口", { skip: process.platform !== "darwin" }, async () => {
	const fixture = await wikiFixture();
	fixture.behavior.candidates = { "new.md": `---\nsources:\n  - ${fixture.acceptanceId}\n---\n# New\n` };
	const created = await fixture.app.inject({ method: "POST", url: "/api/wiki/compile-jobs", payload: payload(fixture, "sync-candidate") });
	const job = created.json().job as CompileJob;
	await waitFor(() => fixture.jobs.get(job.id), (current) => current?.status === "candidate_ready");
	assert.equal((await fixture.reviews.list()).length, 0);
	const restarted = new ReviewStore(path.join(fixture.root, "reviews"));
	const result = await syncCandidateBatches({ jobs: fixture.jobs, reviews: restarted });
	assert.equal(result.registered, 1);
	assert.deepEqual(result.unavailable, []);
	const before = (await restarted.list())[0]!;
	const replay = await syncCandidateBatches({ jobs: fixture.jobs, reviews: restarted });
	assert.equal(replay.registered, 0);
	assert.equal((await restarted.list())[0]!.enteredReviewAt, before.enteredReviewAt);
	await fixture.app.close();
});

test("wiki 审核详情：对象引用与候选字节 hash 不匹配时拒绝展示", async () => {
	const fixture = await wikiFixture();
	const batch = await registerBatchDirect(fixture, [{ targetPath: "corrupt.md", content: "# Visible\n" }]);
	batch.files[0]!.candidateHash = "a".repeat(64);
	batch.manifestHash = publicationManifestHash(batch);
	await fixture.reviews.registerCandidate(batch, localViewerIdentity().user.id);
	const response = await fixture.app.inject({ method: "GET", url: `/api/wiki/batches/${batch.id}/file?path=corrupt.md` });
	assert.equal(response.statusCode, 409);
	assert.equal(response.json().code, "candidate_unavailable");
	await fixture.app.close();
});


test("wiki审核：未读文件也可拒绝，receipt不伪造全量已阅", async () => {
	const fixture = await wikiFixture();
	const batch = await registerBatchDirect(fixture, [{ targetPath: "reject.md", content: "# No\n" }]);
	const response = await fixture.app.inject({ method: "POST", url: `/api/wiki/batches/${batch.id}/reviews`,
		payload: reviewBody(batch, { decision: "reject", reviewedFiles: [] }) });
	assert.equal(response.statusCode, 200);
	assert.equal(response.json().status, "rejected");
	assert.deepEqual(response.json().decision.reviewedFiles, []);
	assert.equal(fixture.publisherCalls.length, 0);
	await fixture.app.close();
});

test("关闭冲突：幂等、持久化、需处理计数归零且历史完整；未知状态拒绝关闭", async () => {
	const f = await wikiFixture();
	try {
		const batch = await registerBatchDirect(f, [{ targetPath: "close.md", content: "# Candidate\n" }]);
		const decision = await f.reviews.decide({ batchId: batch.id, actorId: localViewerIdentity().user.id, operationId: "approve-before-conflict", decision: "approve", manifestHash: batch.manifestHash, expectedBatchRevision: 1, reviewedFiles: ["close.md"] });
		const operation = (await f.journal.begin({ batch, ownerId: localViewerIdentity().user.id, actorId: localViewerIdentity().user.id, reviewId: decision.decision.id, idempotencyKey: decision.decision.id })).record;
		await f.journal.setRunning(operation.id); await f.reviews.markPublishing(batch.id);
		await f.journal.settle(operation.id, "unknown"); await f.reviews.settlePublish(batch.id, "conflict", "publish_uncertain");
		const body = { operationId: "close-conflict-one", manifestHash: batch.manifestHash, expectedBatchRevision: 1 };
		const url = `/api/wiki/batches/${encodeURIComponent(batch.id)}/close-conflict`;
		assert.equal((await f.app.inject({method:"POST",url,payload:body})).statusCode,409);
		await f.journal.settle(operation.id, "conflict");
		assert.equal((await f.app.inject({method:"POST",url,payload:{...body,manifestHash:"0".repeat(64)}})).statusCode,409);
		const closed = await f.app.inject({method:"POST",url,payload:body}); assert.equal(closed.statusCode,200);
		assert.ok(closed.json().conflictClosure.closedAt);
		const replay = await f.app.inject({method:"POST",url,payload:body}); assert.equal(replay.statusCode,200);
		assert.equal(replay.json().conflictClosure.closedAt,closed.json().conflictClosure.closedAt);
		const needs = (await f.app.inject({method:"GET",url:`/api/wiki/batches?bindingId=${f.binding.id}&status=needs_action`})).json();
		assert.equal(needs.needsActionCount,0); assert.equal(needs.filteredTotal,0); assert.equal(needs.processedCount,1);
		const processed = (await f.app.inject({method:"GET",url:`/api/wiki/batches?bindingId=${f.binding.id}&status=processed`})).json();
		assert.equal(processed.batches[0].id,batch.id); assert.ok(processed.batches[0].conflictClosure);
		assert.equal((await f.journal.get(operation.id))!.state,"conflict"); assert.equal((await f.reviews.decisionsFor(batch.id))[0]!.decision,"approve");
		assert.deepEqual((await f.reviews.get(batch.id))!.batch.files,batch.files);
		assert.equal((await f.app.inject({method:"POST",url:"/api/wiki/batches/not-owned/close-conflict",payload:body})).statusCode,404);
	} finally { await f.app.close(); }
});
