import { schemaContentPrefix, schemaEntityDirectory } from "../knowledge/schema-layout.js";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentDriver, InvocationContext } from "../agent-runtime/types.js";
import { agentRunConfigRevision, type TeamsStore } from "../store/teams.js";
import type { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import type { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { composeCompileTask, readCandidateBatch } from "../knowledge/candidate.js";
import { materializeCompileSource } from "../knowledge/compile-source.js";
import { resolveEffectiveSchema } from "../knowledge/schema-impact.js";
import type { CompileJobStore } from "../knowledge/compile-jobs.js";
import type { CompileJob, PublicationBatch, ReviewDecision } from "../knowledge/contracts.js";
import { diffNoteContent } from "../knowledge/note-diff.js";
import type { KnowledgeObjectStore } from "../knowledge/objects.js";
import type { KnowledgeObservationService } from "../knowledge/observation.js";
import { REVIEW_WINDOW_MS, ReviewStore, ReviewStoreError, type StoredReviewBatch } from "../knowledge/wiki/review-store.js";
import { syncCandidateBatches } from "../knowledge/wiki/candidate-sync.js";
import { toPublishOperation, type PublishJournal } from "../knowledge/wiki/publish-journal.js";
import { publicationContextChanges } from "../knowledge/wiki/publication-context.js";
import { assertConflictResolution, conflictResolutionBlock } from "../knowledge/wiki/conflict-resolution.js";
import { withKnowledgeMutation } from "../knowledge/mutation-lock.js";
import { localViewerIdentity } from "./identity.js";
import { assertImageAssetBytes, assertImageBatchIntegrity } from "../knowledge/image-publication.js";

export const COMPILER_REF = "@puddingteams/connector-codex";

export interface WikiRouteDeps {
	revisions?: { followup(record: StoredReviewBatch): Promise<StoredReviewBatch["returnRequest"]> };
	jobs: CompileJobStore;
	bindings: Pick<KnowledgeBindingRegistry, "requireUsable" | "list">;
	acceptance: Pick<KnowledgeAcceptanceStore, "getSnapshot">;
	observation: Pick<KnowledgeObservationService, "scan">;
	objects: Pick<KnowledgeObjectStore, "get">;
	teams: Pick<TeamsStore, "getAgent">;
	resolveDriver: (agentId: string) => AgentDriver | undefined | Promise<AgentDriver | undefined>;
	attestCompiler: (driver: AgentDriver) => Promise<string | undefined>;
	/** 生产实现 = resolveCodexCompileCommand；测试注入受控 stub。 */
	resolveCommand: () => Promise<{ commandPath: string; commandSha256: string }>;
	runCompileJob: (jobId: string) => Promise<unknown>;
	cancelDelegation: (delegationId: string, ctx: InvocationContext) => Promise<unknown>;
	compileRoot: string;
	reviews: ReviewStore;
	/** 发布挂载点（W3 实现真发布）：approve 落账后回调；缺省为记录意图的 stub。 */
	publisher?: WikiPublisher;
	/** 发布操作日志（T42）：publications 查询路由的事实源。 */
	publications: PublishJournal;
}

/**
 * 发布挂载点接口形状（W3 对接用）：批次与审核决定均已持久化，状态机已进入
 * approved；实现方负责 approved → publishing → published/partial/conflict 的
 * 后续推进。返回 accepted=false 时批次保持 approved 且 publishRequestedAt 不登记，
 * 供后续对账重试。
 */
export interface WikiPublisher {
	onApproved(batch: PublicationBatch, review: ReviewDecision): Promise<{ accepted: boolean; note?: string }>;
}

const defaultWikiPublisher: WikiPublisher = {
	onApproved: async () => ({ accepted: true, note: "发布链路（W3）未接入，批次保持 approved 待发布" }),
};

class WikiRouteError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "capability_unavailable" | "conflict" | "state_conflict" | "candidate_unavailable" | "expired",
		message: string) {
		super(message);
	}
}

function sendWikiError(reply: FastifyReply, error: unknown) {
	const candidate = error instanceof Error ? (error as { code?: unknown }).code : undefined;
	const code = typeof candidate === "string" ? candidate : undefined;
	if (error instanceof Error && code) {
		const status = code === "not_found" ? 404 : code === "invalid_input" || code === "invalid_path" ? 400 :
			code === "capability_unavailable" ? 422 : 409;
		return reply.code(status).send({ error: error.message, code });
	}
	// 编译链路的未分类失败（来源漂移、物化冲突等）一律按状态冲突处理。
	return reply.code(409).send({ error: error instanceof Error ? error.message : String(error), code: "conflict" });
}

/** cache/knowledge/compile：0700 + 规范路径；返回规范形式供下游拼接 Job 目录。 */
async function ensureCompileRoot(compileRoot: string): Promise<string> {
	await mkdir(compileRoot, { recursive: true, mode: 0o700 });
	await chmod(compileRoot, 0o700);
	return realpath(compileRoot);
}

/** 生产 CLI 解析：在 PATH 上找 codex 可执行文件，取规范路径与内容摘要。 */
export async function resolveCodexCompileCommand(env: NodeJS.ProcessEnv = process.env): Promise<{ commandPath: string; commandSha256: string }> {
	for (const directory of (env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, "codex");
		const info = await stat(candidate).catch(() => null);
		if (!info?.isFile()) continue;
		if (await access(candidate, fsConstants.X_OK).then(() => false, () => true)) continue;
		const commandPath = await realpath(candidate);
		const commandSha256 = createHash("sha256").update(await readFile(commandPath)).digest("hex");
		return { commandPath, commandSha256 };
	}
	throw new WikiRouteError("capability_unavailable", "未检测到 Codex CLI，请先安装并完成登录");
}

/** 各 Job 的 staging/private/来源目录全局唯一，同 operationId 重放只能做语义比对。 */
function sameJobRequest(job: CompileJob, request: { ownerId: string; bindingId: string; agentId: string; sourceAcceptanceIds: string[]; rawTask: string }): boolean {
	return job.ownerId === request.ownerId && job.targetBindingId === request.bindingId && job.agentId === request.agentId &&
		job.sourceAcceptanceIds.length === request.sourceAcceptanceIds.length &&
		job.sourceAcceptanceIds.every((id) => request.sourceAcceptanceIds.includes(id)) &&
		job.task === composeCompileTask(request.rawTask, job);
}

/** 物化来源目录是只读（0500）；删除 Job 目录前先把目录权限改回可写。 */
async function removeJobDir(root: string): Promise<void> {
	const restore = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as never[]);
		for (const entry of entries) {
			if (entry.isDirectory()) await restore(path.join(directory, entry.name));
		}
		await chmod(directory, 0o700).catch(() => undefined);
	};
	await restore(root).catch(() => undefined);
	await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

interface CompileRequestBody {
	operationId?: string;
	bindingId?: string;
	agentId?: string;
	task?: string;
	sourceAcceptanceIds?: string[];
}

interface ReviewRequestBody {
	operationId?: string;
	decision?: string;
	manifestHash?: string;
	reviewedFiles?: string[];
}

function presentBatch(record: StoredReviewBatch) {
	return {
		id: record.batch.id,
		bindingId: record.batch.bindingId,
		status: record.status,
		revision: record.revision,
		manifestHash: record.batch.manifestHash,
		fileCount: record.batch.files.length,
		enteredReviewAt: record.enteredReviewAt,
		reviewDeadline: new Date(Date.parse(record.enteredReviewAt) + REVIEW_WINDOW_MS).toISOString(),
		...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
		...(record.decisionId ? { decisionId: record.decisionId } : {}),
		...(record.publishRequestedAt ? { publishRequestedAt: record.publishRequestedAt } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.conflictClosure ? { conflictClosure: record.conflictClosure } : {}),
	};
}

/** 知识库编译生产入口：校验 → 物化来源 → 建 Job → fire-and-forget 运行。 */
export function registerWikiRoutes(app: FastifyInstance, deps: WikiRouteDeps): void {
	const ownerId = () => localViewerIdentity().user.id;
	// runCompileJob 的失败已由 Runtime 收敛进 Job 终态；这里只负责点火。
	const kick = (jobId: string): void => {
		void Promise.resolve().then(() => deps.runCompileJob(jobId)).catch(() => undefined);
	};

	app.post<{ Body: CompileRequestBody }>("/api/wiki/compile-jobs", async (req, reply) => {
		try {
			const body = req.body ?? {};
			const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
			const bindingId = typeof body.bindingId === "string" ? body.bindingId : "";
			const agentId = typeof body.agentId === "string" ? body.agentId : "";
			const rawTask = typeof body.task === "string" ? body.task : "";
			const sourceAcceptanceIds = Array.isArray(body.sourceAcceptanceIds) ? body.sourceAcceptanceIds : [];
			if (!operationId || operationId.length > 200 || !bindingId || !agentId || !rawTask.trim() || rawTask.length > 20_000 ||
				sourceAcceptanceIds.length === 0 || sourceAcceptanceIds.length > 1000 ||
				sourceAcceptanceIds.some((id) => typeof id !== "string" || !id.trim()) ||
				new Set(sourceAcceptanceIds).size !== sourceAcceptanceIds.length) {
				throw new WikiRouteError("invalid_input", "operationId、bindingId、agentId、task 与去重的 sourceAcceptanceIds 均为必填");
			}
			const request = { ownerId: ownerId(), bindingId, agentId, sourceAcceptanceIds, rawTask };

			// 幂等短路：同 operationId 已有冻结 Job → 语义一致则复用；queued 说明
			// 上次进程崩溃或未启动（启动围栏只处理 running），重新 kick。
			const existing = await deps.jobs.findByOperationId(operationId);
			if (existing) {
				if (existing.ownerId !== request.ownerId) throw new WikiRouteError("not_found", "编译任务不存在");
				if (!sameJobRequest(existing, request)) throw new WikiRouteError("conflict", "同一 operationId 已对应不同的编译请求");
				if (existing.status === "queued") kick(existing.id);
				return reply.code(202).send({ job: existing, replayed: true });
			}

			const binding = await deps.bindings.requireUsable(request.ownerId, bindingId);
			const effectiveSchema = await resolveEffectiveSchema(binding);
			if (effectiveSchema.origin === "none" && effectiveSchema.warnings.some((warning) => warning.startsWith("wiki.schema.json"))) {
				throw new WikiRouteError("invalid_input", effectiveSchema.warnings.join("；"));
			}
			const contentPrefix = await schemaContentPrefix(binding, effectiveSchema.schema);
   const schemaContract = effectiveSchema.schema ? JSON.stringify({ ...effectiveSchema.schema,
    pathRules: { contentPrefix, entityDirectories: effectiveSchema.schema.entities.map(entity => ({ type: entity.type, directory: schemaEntityDirectory(contentPrefix, entity.directory) })) } }) : undefined;
			const agent = await deps.teams.getAgent(agentId);
			if (!agent || agent.enabled === false || agent.connector?.connectorId !== "codex" || agent.connector.transport !== "spawn") {
				throw new WikiRouteError("invalid_input", "编译 Worker 必须是启用状态的本地 Codex Agent");
			}
			const driver = await deps.resolveDriver(agentId);
			if (!driver || driver.id !== "codex") throw new WikiRouteError("capability_unavailable", "Codex Connector 不可用");
			const compilerPackageSha256 = await deps.attestCompiler(driver);
			if (!compilerPackageSha256) throw new WikiRouteError("capability_unavailable", "Codex Connector 未通过第一方包身份核验");
			const { commandPath, commandSha256 } = await deps.resolveCommand();

			const ledger = await deps.acceptance.getSnapshot(binding.id);
			const byAcceptanceId = new Map(Object.values(ledger.entries).map((entry) => [entry.acceptanceId, entry]));
			for (const id of sourceAcceptanceIds) {
				const entry = byAcceptanceId.get(id);
				if (!entry || entry.noteIdentity.bindingId !== binding.id || entry.availability !== "current") {
					throw new WikiRouteError("invalid_input", "来源包含未采纳或已失效的条目，请刷新后重试");
				}
			}

			const compileRoot = await ensureCompileRoot(deps.compileRoot);
			const rawJobDir = path.join(compileRoot, randomUUID());
			await mkdir(rawJobDir, { mode: 0o700 });
			const jobDir = await realpath(rawJobDir);
			const stagingRoot = path.join(jobDir, "staging");
			const privateRoot = path.join(jobDir, "private");
			await mkdir(stagingRoot, { mode: 0o700 });
			await mkdir(privateRoot, { mode: 0o700 });
			try {
				const materialized = await materializeCompileSource(jobDir, ledger, sourceAcceptanceIds, deps.objects, binding,
					deps.observation, deps.acceptance);
				const job = await deps.jobs.create({
					operationId,
					ownerId: request.ownerId,
					targetBindingId: binding.id,
					bindingRevision: binding.bindingRevision,
					trustRevision: binding.trustRevision,
					rootIdentity: binding.rootIdentity,
					sourceAcceptanceIds: materialized.sourceAcceptanceIds,
					sourceSnapshotRefs: materialized.sourceSnapshotRefs,
					sourceSnapshotRoot: materialized.root,
					stagingRoot,
					privateRoot,
					compilerRef: COMPILER_REF,
					compilerPackageSha256,
					agentId,
					agentRevision: agentRunConfigRevision(agent),
					task: composeCompileTask(rawTask, {
						sourceSnapshotRoot: materialized.root,
						sourceAcceptanceIds: materialized.sourceAcceptanceIds,
						sourceSnapshotRefs: materialized.sourceSnapshotRefs,
						...(schemaContract ? { schemaContract } : {}),
					}),
					...(schemaContract ? { schemaContract } : {}),
					commandPath,
					commandSha256,
					...(effectiveSchema.schemaRef?.hash ? { schemaHash: effectiveSchema.schemaRef.hash } : {}),
				});
				kick(job.id);
				return reply.code(202).send({ job, replayed: false });
			} catch (error) {
				await removeJobDir(jobDir);
				// 并发同键：唯一约束拒绝 → 清理自家目录后返回赢家 Job（语义不符则 409）。
				if (error instanceof Error && /operation conflict|already used/.test(error.message)) {
					const winner = await deps.jobs.findByOperationId(operationId);
					if (winner && winner.ownerId === request.ownerId && sameJobRequest(winner, request)) {
						if (winner.status === "queued") kick(winner.id);
						return reply.code(202).send({ job: winner, replayed: true });
					}
					throw new WikiRouteError("conflict", "同一 operationId 已对应不同的编译请求");
				}
				throw error;
			}
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	app.get<{ Querystring: { bindingId?: string } }>("/api/wiki/compile-jobs", async (req, reply) => {
		try {
			const all = await deps.jobs.list();
			const jobs = all
				.filter((job) => job.ownerId === ownerId() && (!req.query.bindingId || job.targetBindingId === req.query.bindingId))
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			return { jobs };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	app.get<{ Params: { id: string } }>("/api/wiki/compile-jobs/:id", async (req, reply) => {
		try {
			const job = await deps.jobs.get(req.params.id);
			if (!job || job.ownerId !== ownerId()) throw new WikiRouteError("not_found", "编译任务不存在");
			if (job.status !== "candidate_ready" || !job.candidateBatchId) return { job };
			let batch: Awaited<ReturnType<typeof readCandidateBatch>>;
			try {
				batch = await readCandidateBatch(job);
			} catch {
				throw new WikiRouteError("candidate_unavailable", "候选批次缺失或已被篡改");
			}
			if (batch.id !== job.candidateBatchId) throw new WikiRouteError("candidate_unavailable", "候选批次缺失或已被篡改");
			return { job, batch };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	app.post<{ Params: { id: string } }>("/api/wiki/compile-jobs/:id/cancel", async (req, reply) => {
		try {
			const job = await deps.jobs.get(req.params.id);
			if (!job || job.ownerId !== ownerId()) throw new WikiRouteError("not_found", "编译任务不存在");
			if (job.status !== "queued" && job.status !== "running") throw new WikiRouteError("state_conflict", "任务已结束，不能取消");
			let cancelled: CompileJob;
			try {
				cancelled = await deps.jobs.cancel(job.id);
			} catch {
				const raced = await deps.jobs.get(job.id);
				if (raced && (raced.status === "queued" || raced.status === "running")) throw new WikiRouteError("conflict", "取消失败，请重试");
				throw new WikiRouteError("state_conflict", "任务已结束，不能取消");
			}
			// 账本先行收敛：正在进行的 validateCandidate/finish 会因 Job 非 running 被拒。
			// 再尽力停执行面；Delegation 绑定可能晚于取消登记，以最新记录为准补一次。
			const latest = await deps.jobs.get(job.id);
			const delegationId = latest?.delegationId ?? job.delegationId;
			if (delegationId) {
				await deps.cancelDelegation(delegationId, { cwd: job.stagingRoot, env: {} }).catch(() => undefined);
			}
			return { job: latest ?? cancelled };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	// Listing is a projection of durable reviews, filtered by current binding authorization.
	app.get<{ Querystring: { bindingId?: string; status?: string; q?: string; limit?: string; offset?: string } }>("/api/wiki/batches", async (req, reply) => {
		try {
			const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
			const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
			const groups: Record<string, readonly string[]> = {
				pending: ["pending_review"],
				needs_action: ["candidate", "approved", "publishing", "partial", "conflict"],
				processed: ["published", "rejected", "returned"],
			};
			const allowed = new Set([...Object.values(groups).flat(), "pending", "needs_action", "processed", "all"]);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 ||
				(req.query.status && !allowed.has(req.query.status)) || (req.query.q?.length ?? 0) > 500) {
				throw new WikiRouteError("invalid_input", "invalid review filters or pagination");
			}
			await syncCandidateBatches(deps, ownerId());
			const visibleBindings = new Map((await deps.bindings.list(ownerId())).map((binding) => [binding.id, binding]));
			const records = (await deps.reviews.list()).filter((record) => record.ownerId === ownerId() &&
				visibleBindings.has(record.batch.bindingId) && (!req.query.bindingId || record.batch.bindingId === req.query.bindingId));
			const inGroup = (record: StoredReviewBatch, group: string) => group === "processed" ? Boolean(record.conflictClosure) || groups.processed!.includes(record.status) :
				!record.conflictClosure && (groups[group] ?? [group]).includes(record.status);
			const count = (group: string) => records.filter(record => inGroup(record, group)).length;
			const counts = { pendingCount: count("pending"), needsActionCount: count("needs_action"), processedCount: count("processed"), total: records.length };
			const query = req.query.q?.trim().toLocaleLowerCase();
			const status = req.query.status;
			const filtered = records.filter((record) => (!status || status === "all" ||
				inGroup(record, status)) && (!query ||
				[record.batch.id, visibleBindings.get(record.batch.bindingId)!.name, ...record.batch.files.map((file) => file.targetPath)]
					.some((value) => value.toLocaleLowerCase().includes(query))))
				.sort((a, b) => b.enteredReviewAt.localeCompare(a.enteredReviewAt) || a.batch.id.localeCompare(b.batch.id));
			const batches = filtered.slice(offset, offset + limit).map((record) => {
				const binding = visibleBindings.get(record.batch.bindingId)!;
				return { ...presentBatch(record), bindingName: binding.name, bindingAvailability: binding.availability,
					title: record.batch.files[0]?.targetPath ?? record.batch.id };
			});
			return { batches, filteredTotal: filtered.length, ...counts, limit, offset };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	app.get<{ Params: { id: string } }>("/api/wiki/batches/:id", async (req, reply) => {
		try {
			await syncCandidateBatches(deps, ownerId());
			const record = await deps.reviews.get(req.params.id);
			if (!record || record.ownerId !== ownerId() || !(await deps.bindings.list(ownerId())).some((binding) => binding.id === record.batch.bindingId)) throw new WikiRouteError("not_found", "批次不存在");
			const request = deps.revisions ? await deps.revisions.followup(record) : record.returnRequest;
			const child = request && !deps.revisions ? (await deps.reviews.list()).find((candidate) => candidate.batch.parentBatchId === record.batch.id) : undefined;
			const conflictBlockedReason = record.status === "conflict" && !record.conflictClosure ? await conflictResolutionBlock(record, deps.publications) : undefined;
			return { ...presentBatch(record), batch: record.batch, ...(request ? { returnRequest: { ...request,
				...(child ? { newBatchId: child.batch.id } : {}) } } : {}), ...(conflictBlockedReason ? { conflictBlockedReason } : {}) };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	app.post<{ Params: { id: string }; Body: { operationId: string; manifestHash: string } }>("/api/wiki/batches/:id/close-conflict", async (req, reply) => {
		try {
			const record = await deps.reviews.get(req.params.id);
			if (!record || record.ownerId !== ownerId() || !(await deps.bindings.list(ownerId())).some(binding => binding.id === record.batch.bindingId)) throw new WikiRouteError("not_found", "审核批次不存在");
			const body = req.body;
			if (!body || typeof body.operationId !== "string" || typeof body.manifestHash !== "string") throw new WikiRouteError("invalid_input", "关闭冲突参数无效");
			const closed = await withKnowledgeMutation(record.batch.bindingId, async () => {
				const current = (await deps.reviews.get(record.batch.id))!;
				if (!current.conflictClosure) await assertConflictResolution(current, deps.publications);
				return deps.reviews.closeConflict({ ...body, batchId: current.batch.id, actorId: ownerId() });
			});
			return { ...presentBatch(closed), batch: closed.batch };
		} catch (error) { return sendWikiError(reply, error); }
	});

	app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/wiki/batches/:id/file", async (req, reply) => {
		try {
			await syncCandidateBatches(deps, ownerId());
			const record = await deps.reviews.get(req.params.id);
			if (!record || record.ownerId !== ownerId() || !(await deps.bindings.list(ownerId())).some((binding) => binding.id === record.batch.bindingId)) throw new WikiRouteError("not_found", "批次不存在");
			const targetPath = req.query.path ?? "";
			const file = record.batch.files.find((entry) => entry.targetPath === targetPath);
			if (!file) throw new WikiRouteError("not_found", "该文件不在批次内");
			if (!file.candidateHash) throw new WikiRouteError("candidate_unavailable", "批次文件缺少候选字节");
			const candidateBytes = await deps.objects.get(file.candidateHash).catch(() => null);
			if (!candidateBytes || createHash("sha256").update(candidateBytes).digest("hex") !== file.candidateHash) throw new WikiRouteError("candidate_unavailable", "候选字节缺失或已损坏");
			if (file.kind === "image") {
				await assertImageBatchIntegrity(record.batch, deps.objects);
				const mediaType = assertImageAssetBytes(file.targetPath, candidateBytes, file.mediaType);
				return { kind: "image", path: targetPath, operation: file.operation, sourceIds: file.sourceIds ?? [],
					candidate: { hash: file.candidateHash, mediaType, base64: candidateBytes.toString("base64") }, baseline: file.expectedHashOrAbsent ? { hash: file.expectedHashOrAbsent } : null };
			}
			let baseline: { content: string; hash: string } | null = null;
			if (file.expectedHashOrAbsent) {
				const baselineBytes = await deps.objects.get(file.expectedHashOrAbsent).catch(() => null);
				if (baselineBytes) baseline = { content: baselineBytes.toString("utf8"), hash: file.expectedHashOrAbsent };
			}
			const candidate = { content: candidateBytes.toString("utf8"), hash: file.candidateHash };
			const diff = diffNoteContent(baseline?.content ?? "", candidate.content);
			return { path: targetPath, operation: file.operation, candidate, baseline, hunks: diff.hunks, truncated: diff.truncated };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/wiki/batches/:id/assets", async (req, reply) => {
		try {
			const record = await deps.reviews.get(req.params.id);
			if (!record || record.ownerId !== ownerId() || !(await deps.bindings.list(ownerId())).some((binding) => binding.id === record.batch.bindingId)) throw new WikiRouteError("not_found", "批次不存在");
			const file = record.batch.files.find((file) => file.targetPath === req.query.path && file.kind === "image");
			if (!file?.candidateHash) throw new WikiRouteError("not_found", "图片不在固定候选内");
			await assertImageBatchIntegrity(record.batch, deps.objects);
			const bytes = await deps.objects.get(file.candidateHash), mediaType = assertImageAssetBytes(file.targetPath, bytes, file.mediaType);
			return reply.header("Content-Type", mediaType).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store").send(bytes);
		} catch (error) { return sendWikiError(reply, error); }
	});

	app.post<{ Params: { id: string }; Body: ReviewRequestBody }>("/api/wiki/batches/:id/reviews", async (req, reply) => {
		try {
			const body = req.body ?? {};
			const decision = body.decision;
			const reviewedFiles = Array.isArray(body.reviewedFiles) ? body.reviewedFiles : [];
			if ((decision !== "approve" && decision !== "reject") ||
				typeof body.manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(body.manifestHash) ||
				(decision === "approve" && reviewedFiles.length === 0) || !Array.isArray(body.reviewedFiles) || reviewedFiles.some((file) => typeof file !== "string" || !file) ||
				(body.operationId !== undefined && (typeof body.operationId !== "string" || !body.operationId.trim() || body.operationId.length > 200))) {
				throw new WikiRouteError("invalid_input", "decision、manifestHash 与 reviewedFiles 必填（拒绝可为空，批准必须覆盖全部文件）");
			}
			await syncCandidateBatches(deps, ownerId());
			const existing = await deps.reviews.get(req.params.id);
			if (!existing || existing.ownerId !== ownerId() || !(await deps.bindings.list(ownerId())).some((binding) => binding.id === existing.batch.bindingId)) throw new WikiRouteError("not_found", "批次不存在");
			let outcome;
			try {
				outcome = await deps.reviews.decide({
					batchId: req.params.id,
					operationId: body.operationId?.trim() || randomUUID(),
					actorId: ownerId(),
					decision,
					manifestHash: body.manifestHash!,
					reviewedFiles,
				});
			} catch (error) {
				if (error instanceof ReviewStoreError && error.code === "expired") {
					throw new WikiRouteError("expired", "审核窗口已超期（24 小时），批次已转入 conflict，请重新编译后再审");
				}
				if (error instanceof ReviewStoreError && error.code === "not_found") throw new WikiRouteError("not_found", "批次不存在");
				if (error instanceof ReviewStoreError && (error.code === "conflict" || error.code === "invalid_input")) {
					throw new WikiRouteError("state_conflict", "审核与当前批次不一致（批次已变化、已有审核决定或文件覆盖不完整），请刷新后重试");
				}
				throw error;
			}
			let publish: { accepted: boolean; note?: string } | undefined;
			let record = outcome.record;
			if (outcome.decision.decision === "approve" && record.status === "approved" && record.decisionId === outcome.decision.id) {
				publish = await (deps.publisher ?? defaultWikiPublisher).onApproved(record.batch, outcome.decision)
					.catch(() => ({ accepted: false, note: "发布挂载点调用失败，批次保持 approved 待发布" }));
				if (publish.accepted) {
					// 真 publisher 可能已同步推进到 publishing/published 等终态；
					// 只有仍在 approved 时才由路由补登记 publishRequestedAt。
					const current = await deps.reviews.get(record.batch.id);
					if (current && current.status === "approved") record = await deps.reviews.markPublishRequested(record.batch.id);
					else if (current) record = current;
				}
			}
			return { ...presentBatch(record), batch: record.batch, decision: outcome.decision, replayed: outcome.replayed, ...(publish ? { publish } : {}) };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	// T42：发布操作查询。逐项 receipt 明细供 UI 呈现 partial/conflict 时每项结果。
	app.get<{ Querystring: { bindingId?: string } }>("/api/wiki/publications", async (req, reply) => {
		try {
			const visibleBindings = new Set((await deps.bindings.list(ownerId())).map((binding) => binding.id));
			const records = (await deps.publications.list())
				.filter((record) => record.ownerId === ownerId() && visibleBindings.has(record.bindingId) && (!req.query.bindingId || record.bindingId === req.query.bindingId));
			return {
				publications: records.map((record) => ({
					id: record.id,
					batchId: record.batchId,
					bindingId: record.bindingId,
					state: record.state,
					journalRef: record.journalRef,
					fileCount: record.files.length,
					committedGroups: record.committedGroups.length,
					createdAt: record.createdAt,
					updatedAt: record.updatedAt,
					...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
				})),
			};
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});

	app.get<{ Params: { id: string } }>("/api/wiki/publications/:id", async (req, reply) => {
		try {
			const record = await deps.publications.get(req.params.id);
			if (!record || record.ownerId !== ownerId() || !(await deps.bindings.list(ownerId())).some((binding) => binding.id === record.bindingId)) throw new WikiRouteError("not_found", "发布操作不存在");
			const review = await deps.reviews.get(record.batchId);
			let currentContextChanges: string[] = [];
			if (record.state === "conflict" && review?.ownerId === ownerId()) {
				try {
					const binding = await deps.bindings.requireUsable(ownerId(), record.bindingId);
					currentContextChanges = await publicationContextChanges(review.batch, binding);
				} catch { currentContextChanges = ["当前无法访问或确认知识库，请检查连接和授权"]; }
			}
			return { ...toPublishOperation(record), bindingId: record.bindingId, files: record.files, committedGroups: record.committedGroups,
				...(record.stopReason ? { stopReason: record.stopReason } : {}),
				...(review?.conflictReason ? { conflictReason: review.conflictReason } : {}), currentContextChanges,
				createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}) };
		} catch (error) {
			return sendWikiError(reply, error);
		}
	});
}
