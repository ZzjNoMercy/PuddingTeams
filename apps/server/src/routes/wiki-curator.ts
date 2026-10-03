import type { FastifyInstance } from "fastify";
import { localViewerIdentity } from "./identity.js";
import type { CuratorJob, CuratorJobStore, WikiCuratorService } from "../knowledge/curator-jobs.js";
import { curatorJobFeedback } from "../knowledge/curator-jobs.js";
import { curatorTaskView, inTaskGroup, taskGroups } from "../knowledge/curator-task-view.js";
import type { StoredReviewBatch, ReviewStore } from "../knowledge/wiki/review-store.js";
import type { KnowledgeObjectStore } from "../knowledge/objects.js";
import type { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import type { TeamsStore } from "../store/teams.js";
import type { UploadInput } from "../store/uploads.js";
import type { PublishJournal, StoredPublishOperation } from "../knowledge/wiki/publish-journal.js";
import type { WikiRevisionService } from "../knowledge/wiki/revision-service.js";

function presentJob(job: CuratorJob, review?: StoredReviewBatch, bindingName?: string, publication?: StoredPublishOperation) {
	return { ...curatorTaskView(job, review, bindingName, publication), id: job.id, operationId: job.operationId, targetBindingId: job.targetBindingId, agentId: job.agentId,
		task: job.task, ...curatorJobFeedback(job), candidateBatchId: job.candidateBatchId, diagnostics: job.diagnostics,
		canRetryRegistration: job.failureCode === "candidate_registration_failed" && Boolean(job.frozenCandidate),
		origin: job.origin, sources: job.sources, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

export function registerWikiCuratorRoutes(app: FastifyInstance, deps: {
	service: WikiCuratorService; jobs: CuratorJobStore; reviews: ReviewStore;
	objects: KnowledgeObjectStore; bindings: KnowledgeBindingRegistry;
	teams: TeamsStore;
	revisions?: WikiRevisionService; publications?: Pick<PublishJournal, "list">;
}) {
	const owner = () => localViewerIdentity().user.id;
	const visible = async (bindingId: string) => (await deps.bindings.list(owner())).some((binding) => binding.id === bindingId);
	const readReview = async (job: CuratorJob) => {
		const record = job.candidateBatchId ? await deps.reviews.get(job.candidateBatchId) : undefined;
		if (!record || record.ownerId !== job.ownerId || record.batch.bindingId !== job.targetBindingId) return undefined;
		return record.status === "returned" && deps.revisions ? { ...record, returnRequest: await deps.revisions.followup(record) } : record;
	};
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
	app.post<{ Body: { operationId?: string; bindingId?: string; agentId?: string; task?: string; material?: string; uploads?: UploadInput[] } }>("/api/wiki/curator-jobs", { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
		const body = req.body;
		if (!body || typeof body.operationId !== "string" || typeof body.bindingId !== "string" || typeof body.agentId !== "string" || typeof body.task !== "string")
			return reply.code(400).send({ error: "请填写目标知识库、Wiki 管理员、整理指令和 operationId" });
		if (body.material !== undefined && (typeof body.material !== "string" || body.material.length > 100_000 || (!body.material.trim() && !body.uploads?.length))) return reply.code(400).send({ error: "请提供资料内容或附件，文字最多十万字" });
		try {
			const result = await deps.service.create({ operationId: body.operationId, bindingId: body.bindingId, agentId: body.agentId, task: body.task, ...(body.material !== undefined ? { sourceText: body.material } : {}), uploads: body.uploads, ownerId: owner() });
			return reply.code(202).send({ job: presentJob(result.job), replayed: result.replayed });
		} catch (error) {
			const message = error instanceof Error ? error.message : "整理请求失败";
			return reply.code(message.includes("operationId 已用于") ? 409 : 400).send({ error: message });
		}
	});
	app.get<{ Querystring: { bindingId?: string; q?: string; group?: string; since?: string; limit?: string; offset?: string } }>("/api/wiki/curator-jobs", async (req, reply) => {
		const { bindingId, q = "", group = "all", since, limit: rawLimit = "25", offset: rawOffset = "0" } = req.query;
		if (!taskGroups.includes(group as typeof taskGroups[number]) || q.length > 200 || !/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset) || Number(rawLimit) < 1 || Number(rawLimit) > 100 || !Number.isSafeInteger(Number(rawOffset)) || (since && !Number.isFinite(Date.parse(since)))) return reply.code(400).send({error: "任务筛选参数无效"});
		const limit = Number(rawLimit), offset = Number(rawOffset);
		const bindings = new Map((await deps.bindings.list(owner())).map(binding => [binding.id,binding]));
		const authorized = (await deps.jobs.list(owner())).filter(job => bindings.has(job.targetBindingId) && (!bindingId || job.targetBindingId === bindingId));
		const publications = await deps.publications?.list() ?? [];
		const jobs = await Promise.all(authorized.map(async job => presentJob(job, await readReview(job), bindings.get(job.targetBindingId)?.name, publications.filter(p=>p.ownerId===owner() && p.bindingId===job.targetBindingId && p.batchId===job.candidateBatchId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0])));
		const scoped = jobs.filter(job => (!since || Date.parse(job.activityAt) >= Date.parse(since)) && `${job.title} ${job.bindingName} ${job.executionMode === "worker" ? "对话" : "添加资料"}`.toLowerCase().includes(q.trim().toLowerCase()));
		const counts = Object.fromEntries(taskGroups.map(key => [key, scoped.filter(job => inTaskGroup(job.displayStatus,key)).length]));
		const filtered = scoped.filter(job => inTaskGroup(job.displayStatus,group)).sort((a,b) => b.activityAt.localeCompare(a.activityAt) || a.id.localeCompare(b.id));
		return { jobs: filtered.slice(offset,offset+limit), total: filtered.length, counts, offset, limit };
	});
	app.get<{ Params: { id: string } }>("/api/wiki/curator-jobs/:id", async (req, reply) => {
		const job = await deps.jobs.get(req.params.id);
		if (!job || job.ownerId !== owner() || !await visible(job.targetBindingId)) return reply.code(404).send({ error: "整理任务不存在" });
		const bindings = await deps.bindings.list(owner());
		const publications = await deps.publications?.list() ?? [];
		const view = presentJob(job, await readReview(job), bindings.find(binding => binding.id === job.targetBindingId)?.name, publications.filter(p=>p.ownerId===owner() && p.bindingId===job.targetBindingId && p.batchId===job.candidateBatchId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]);
		const source = (job.sources ?? []).find(item => item.kind === "text" && item.ownerId === owner());
		let material: string | undefined, materialUnavailable = false;
		if (source?.textHash) { try { material = (await deps.objects.get(source.textHash)).toString("utf8"); } catch { materialUnavailable = true; } }
		return { job: { ...view, material, materialUnavailable, materialIsRequest: source?.origin?.channel === "agent_task" } };
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
		if (!job || job.ownerId !== owner() || job.candidateBatchId !== record.batch.id || job.targetBindingId !== record.batch.bindingId) return { sources: [], origin: null };
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
