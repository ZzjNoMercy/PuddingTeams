import type { FastifyInstance } from "fastify";
import { localViewerIdentity } from "./identity.js";
import type { CuratorJob, CuratorJobStore, WikiCuratorService } from "../knowledge/curator-jobs.js";
import type { ReviewStore } from "../knowledge/wiki/review-store.js";
import type { KnowledgeObjectStore } from "../knowledge/objects.js";
import type { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import type { TeamsStore } from "../store/teams.js";
import type { UploadInput } from "../store/uploads.js";
import type { WikiRevisionService } from "../knowledge/wiki/revision-service.js";

function presentJob(job: CuratorJob) {
	return { id: job.id, operationId: job.operationId, targetBindingId: job.targetBindingId, agentId: job.agentId,
		task: job.task, status: job.status === "submitting" ? "running" : job.status, candidateBatchId: job.candidateBatchId, failureCode: job.failureCode,
		origin: job.origin, sources: job.sources, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

export function registerWikiCuratorRoutes(app: FastifyInstance, deps: {
	service: WikiCuratorService; jobs: CuratorJobStore; reviews: ReviewStore;
	objects: KnowledgeObjectStore; bindings: KnowledgeBindingRegistry;
	teams: TeamsStore;
	revisions?: WikiRevisionService;
}) {
	const owner = () => localViewerIdentity().user.id;
	const visible = async (bindingId: string) => (await deps.bindings.list(owner())).some((binding) => binding.id === bindingId);
	app.post<{ Params: { id: string }; Body: { operationId?: string; manifestHash?: string; expectedBatchRevision?: number; feedback?: string; reviewedFiles?: string[] } }>("/api/wiki/batches/:id/revisions", async (req, reply) => {
		const record = await deps.reviews.get(req.params.id), body = req.body;
		if (!record || record.ownerId !== owner() || !await visible(record.batch.bindingId)) return reply.code(404).send({ error: "审核批次不存在" });
		if (!deps.revisions) return reply.code(422).send({ error: "退回修改能力尚未装配" });
		if (!body || typeof body.operationId !== "string" || typeof body.manifestHash !== "string" || typeof body.expectedBatchRevision !== "number" || typeof body.feedback !== "string" || !Array.isArray(body.reviewedFiles)) return reply.code(400).send({ error: "退回修改参数无效" });
		try {
			const result = await deps.revisions.request({ batchId: record.batch.id, actorId: owner(), operationId: body.operationId,
				manifestHash: body.manifestHash, expectedBatchRevision: body.expectedBatchRevision, feedback: body.feedback, reviewedFiles: body.reviewedFiles });
			return reply.code(202).send({ job: presentJob(result.job), replayed: result.replayed });
		} catch (error) { return reply.code((error as { code?: string }).code === "invalid_input" ? 400 : 409).send({ error: error instanceof Error ? error.message : "退回修改失败" }); }
	});
	app.post<{ Body: { operationId?: string; bindingId?: string; agentId?: string; task?: string; uploads?: UploadInput[] } }>("/api/wiki/curator-jobs", { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
		const body = req.body;
		if (!body || typeof body.operationId !== "string" || typeof body.bindingId !== "string" || typeof body.agentId !== "string" || typeof body.task !== "string")
			return reply.code(400).send({ error: "请填写目标知识库、Wiki 管理员、整理指令和 operationId" });
		try {
			const result = await deps.service.create({ operationId: body.operationId, bindingId: body.bindingId, agentId: body.agentId, task: body.task, uploads: body.uploads, ownerId: owner() });
			return reply.code(202).send({ job: presentJob(result.job), replayed: result.replayed });
		} catch (error) {
			const message = error instanceof Error ? error.message : "整理请求失败";
			return reply.code(message.includes("operationId 已用于") ? 409 : 400).send({ error: message });
		}
	});
	app.get<{ Querystring: { bindingId?: string } }>("/api/wiki/curator-jobs", async (req) => {
		const ids = new Set((await deps.bindings.list(owner())).map((binding) => binding.id));
		return { jobs: (await deps.jobs.list(owner())).filter((job) => ids.has(job.targetBindingId) && (!req.query.bindingId || job.targetBindingId === req.query.bindingId))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(presentJob) };
	});
	app.get<{ Params: { id: string } }>("/api/wiki/curator-jobs/:id", async (req, reply) => {
		const job = await deps.jobs.get(req.params.id);
		if (!job || job.ownerId !== owner() || !await visible(job.targetBindingId)) return reply.code(404).send({ error: "整理任务不存在" });
		return { job: presentJob(job) };
	});
	app.post<{ Params: { id: string } }>("/api/wiki/curator-jobs/:id/cancel", async (req, reply) => {
		const job = await deps.jobs.get(req.params.id);
		if (!job || job.ownerId !== owner() || !await visible(job.targetBindingId)) return reply.code(404).send({ error: "整理任务不存在" });
		try { return { job: presentJob(await deps.service.cancel(owner(), job.id)) }; }
		catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "整理任务不能取消" }); }
	});
	app.post<{ Params: { id: string }; Body: { operationId?: string } }>("/api/wiki/curator-jobs/:id/retry", async (req, reply) => {
		const job = await deps.jobs.get(req.params.id);
		if (!job || job.ownerId !== owner() || !await visible(job.targetBindingId)) return reply.code(404).send({ error: "整理任务不存在" });
		if (typeof req.body?.operationId !== "string") return reply.code(400).send({ error: "重试需要operationId" });
		try {
			const outcome = await deps.service.retry(owner(), job.id, req.body.operationId);
			return reply.code(202).send({ job: presentJob(outcome.job), replayed: outcome.replayed });
		} catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "整理任务不能重试" }); }
	});
	app.get<{ Params: { id: string } }>("/api/wiki/batches/:id/sources", async (req, reply) => {
		const record = await deps.reviews.get(req.params.id);
		if (!record || record.ownerId !== owner() || !await visible(record.batch.bindingId)) return reply.code(404).send({ error: "审批记录不存在" });
		let receipt: { jobId?: string } = {};
		try { receipt = JSON.parse(record.batch.validationReceipt) as { jobId?: string }; } catch { /* Non-curator receipt. */ }
		const job = receipt.jobId ? await deps.jobs.get(receipt.jobId) : undefined;
		if (!job || job.ownerId !== owner() || job.candidateBatchId !== record.batch.id) return { sources: [], origin: null };
		const sources = await Promise.all([...job.sources, ...(job.historicalSources ?? [])].map(async (source) => ({ ...source,
			...(source.textHash ? { content: (await deps.objects.get(source.textHash)).toString("utf8") } : {}),
			...(source.kind === "image" || source.kind === "pdf" ? { base64: (await deps.objects.get(source.originalHash)).toString("base64") } : {}) })));
		for (const source of job.historicalAcceptedSources ?? []) {
			sources.push({ id: source.id, ownerId: job.ownerId, kind: "markdown", title: `历史采纳来源：${source.path}`, mediaType: "text/markdown", byteSize: 0,
				originalHash: source.hash, textHash: source.hash, status: "ready", locations: [], warnings: ["只保留既有页面引用；不代表本次模型读取了该正文"], createdAt: job.createdAt,
				content: (await deps.objects.get(source.snapshotRef)).toString("utf8") });
		}
		return { sources, origin: job.origin ? { ...job.origin, sessionAvailable: Boolean(await deps.teams.contextForSession(job.origin.sessionId)) } : null };
	});
}
