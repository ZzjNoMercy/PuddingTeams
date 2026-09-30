import { applyAndAcceptKnowledgePlan } from "../knowledge/apply-plan.js";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { probeKnowledgeRoot } from "../knowledge/probe.js";
import { KnowledgeProbeStore } from "../knowledge/probes.js";
import { buildKnowledgePlan, KnowledgePlanStore } from "../knowledge/plans.js";
import { hashTeamsSchema, TEAMS_SCHEMA_PRESETS, validateTeamsSchema, type TeamsSchemaPreset } from "../knowledge/schema-presets.js";
import { assessAcceptedNote, diffTeamsSchemas, resolveEffectiveSchema, type AffectedFile } from "../knowledge/schema-impact.js";
import { SchemaWriteError, writeTeamsSchema } from "../knowledge/schema-write.js";
import { KnowledgeReadError, listKnowledgeTree, readKnowledgeNote, type KnowledgeTreeNode } from "../knowledge/reader.js";
import { localViewerIdentity } from "./identity.js";
import { KnowledgeAcceptanceStore, parseNoteFrontmatterFields, type AcceptanceLedger, type StoredAcceptedNoteVersion } from "../knowledge/acceptance.js";
import { hashBufferSha256 } from "../knowledge/hashing.js";
import type { KnowledgeObjectStore } from "../knowledge/objects.js";
import { assertValidNoteRelativePath, KnowledgeObservationService, resolveNoteAbsolutePath, withinKnowledgeRoot, type ObservationRecord } from "../knowledge/observation.js";
import { diffNoteContent } from "../knowledge/note-diff.js";
import { KnowledgeSearchIndex, searchBuiltIndex } from "../knowledge/search-index.js";
import { resolveMarkdownLinkTarget, resolveWikiLink, splitWikiLinkTarget } from "../knowledge/links.js";
import { readKnowledgeAsset } from "../knowledge/assets.js";
import { KnowledgeSelectionStore } from "../knowledge/selections.js";
import type { KnowledgeHistoryStore } from "../knowledge/history-store.js";
import type { MemorySetupService } from "../knowledge/memory-setup.js";
import type { ReviewStore } from "../knowledge/wiki/review-store.js";
import { assertImageAssetBytes, assertImageBatchIntegrity, markdownImageTargets, resolveImagePath } from "../knowledge/image-publication.js";

export interface KnowledgeRouteDeps {
	memorySetup?: MemorySetupService;
	history?: KnowledgeHistoryStore;
	reviews?: Pick<ReviewStore, "get">;
	objects: KnowledgeObjectStore;
	acceptance: KnowledgeAcceptanceStore;
	observation: KnowledgeObservationService;
	searchIndex: KnowledgeSearchIndex;
	probes?: KnowledgeProbeStore;
	plans?: KnowledgePlanStore;
	selections?: KnowledgeSelectionStore;
}

class KnowledgeRouteError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "capability_unavailable" | "context_unavailable" | "baseline_conflict" | "schema_invalid", message: string,
		readonly details?: unknown) {
		super(message);
	}
}

function sendKnowledgeError(reply: FastifyReply, error: unknown) {
	const candidate = error instanceof Error ? (error as { code?: unknown }).code : undefined;
	const code = typeof candidate === "string" ? candidate : undefined;
	if (error instanceof Error && code) {
		const status = code === "not_found" ? 404 : code === "invalid_input" || code === "invalid_path" || code === "schema_invalid" ? 400 :
			code === "too_large" ? 413 : code === "capability_unavailable" ? 422 : 409;
		const details = (error as { details?: unknown }).details;
		return reply.code(status).send({ error: error.message, code, ...(details !== undefined ? { details } : {}) });
	}
	return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
}

async function ensureScan(deps: KnowledgeRouteDeps, bindingId: string, scan: () => Promise<ObservationRecord>): Promise<ObservationRecord> {
	return await scan();
}

async function schemaAffectedFiles(deps: KnowledgeRouteDeps, bindingId: string, current: TeamsSchemaPreset | null, next: TeamsSchemaPreset): Promise<AffectedFile[]> {
	const ledger = await deps.acceptance.getSnapshot(bindingId);
	const affectedFiles: AffectedFile[] = [];
	for (const entry of Object.values(ledger.entries)) {
		if (entry.availability !== "current") continue;
		const snapshot = await deps.objects.get(entry.snapshotRef).catch(() => null);
		if (!snapshot) continue;
		const affected = assessAcceptedNote(entry.relativePath, parseNoteFrontmatterFields(snapshot.toString("utf8")), current, next);
		if (affected) affectedFiles.push(affected);
	}
	affectedFiles.sort((a, b) => a.path.localeCompare(b.path));
	return affectedFiles;
}

function findLedgerEntry(ledger: AcceptanceLedger, scan: ObservationRecord | undefined, relativePath: string): { key: string; entry: StoredAcceptedNoteVersion } | undefined {
	const declaredId = scan?.files.get(relativePath)?.declaredId;
	if (declaredId && ledger.entries[`id:${declaredId}`]) return { key: `id:${declaredId}`, entry: ledger.entries[`id:${declaredId}`]! };
	if (ledger.entries[`path:${relativePath}`]) return { key: `path:${relativePath}`, entry: ledger.entries[`path:${relativePath}`]! };
	for (const [key, entry] of Object.entries(ledger.entries)) {
		if (entry.relativePath === relativePath) return { key, entry };
	}
	return undefined;
}

function joinTreeStatus(nodes: KnowledgeTreeNode[], scan: ObservationRecord): Array<KnowledgeTreeNode & { status?: string }> {
	return nodes.map((node) => {
		if (node.type === "directory") return { ...node, children: joinTreeStatus(node.children ?? [], scan) };
		const file = scan.files.get(node.path);
		// 账本有但磁盘缺失的文件不进树（missing 由 observations 呈现）。
		return file && file.state !== "missing" ? { ...node, status: file.state } : { ...node };
	});
}

function noteCounts(record: ObservationRecord): Record<string, number> {
	const counts: Record<string, number> = { current: 0, publishing: 0, unreadable: 0, missing: 0 };
	for (const file of record.files.values()) {
		if (file.control) continue;
		counts[file.state] = (counts[file.state] ?? 0) + 1;
	}
	return counts;
}

/** Local owner only; all file reads are scoped to a registered root. */
export function registerKnowledgeRoutes(app: FastifyInstance, registry: KnowledgeBindingRegistry, deps?: KnowledgeRouteDeps): void {
	const ownerId = () => localViewerIdentity().user.id;
	const requireDeps = (): KnowledgeRouteDeps => {
		if (!deps) throw new KnowledgeRouteError("capability_unavailable", "知识库 M2 能力未装配");
		return deps;
	};

	app.get("/api/knowledge", async () => ({ bindings: await registry.list(ownerId()) }));
	const memorySetup = () => {
		if (!deps?.memorySetup) throw new KnowledgeRouteError("capability_unavailable", "长期记忆初始化未装配");
		return deps.memorySetup;
	};
	app.get("/api/knowledge/memory-setup", async (_req, reply) => {
		try { return await memorySetup().status(ownerId()); }
		catch (error) { return sendKnowledgeError(reply, error); }
	});
	app.post("/api/knowledge/memory-setup/defer", async (_req, reply) => {
		try { return await memorySetup().defer(ownerId()); }
		catch (error) { return sendKnowledgeError(reply, error); }
	});
	app.post<{ Body: { path?: string } }>("/api/knowledge/memory-setup/plan", async (req, reply) => {
		try { return { plan: await memorySetup().plan(ownerId(), req.body?.path ?? "") }; }
		catch (error) { return sendKnowledgeError(reply, error); }
	});
	app.post<{ Body: { planId?: string } }>("/api/knowledge/memory-setup/apply", async (req, reply) => {
		try { return await memorySetup().apply(ownerId(), req.body?.planId ?? ""); }
		catch (error) { return sendKnowledgeError(reply, error); }
	});
	app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/knowledge/:id/history", async (req, reply) => {
		try {
			const services = requireDeps();
			if (!(await registry.list(ownerId())).some((binding) => binding.id === req.params.id)) throw new KnowledgeRouteError("not_found", "知识库不存在");
			assertValidNoteRelativePath(req.query.path ?? "");
			if (!services.history) throw new KnowledgeRouteError("capability_unavailable", "页面历史未装配");
			await services.acceptance.flushHistory(req.params.id);
			return services.history.list(req.params.id, req.query.path!);
		} catch (error) { return sendKnowledgeError(reply, error); }
	});
	app.get<{ Params: { id: string; versionId: string } }>("/api/knowledge/:id/history/:versionId", async (req, reply) => {
		try {
			const services = requireDeps();
			if (!(await registry.list(ownerId())).some((binding) => binding.id === req.params.id)) throw new KnowledgeRouteError("not_found", "知识库不存在");
			if (!services.history) throw new KnowledgeRouteError("capability_unavailable", "页面历史未装配");
			await services.acceptance.flushHistory(req.params.id);
			const version = await services.history.get(req.params.id, req.params.versionId);
			if (!version) throw new KnowledgeRouteError("not_found", "历史版本不存在");
			const bytes = await services.objects.get(version.snapshotRef), previous = version.previousSnapshotRef ? await services.objects.get(version.previousSnapshotRef) : undefined;
			if (hashBufferSha256(bytes) !== version.contentHash || (previous && hashBufferSha256(previous) !== version.previousHash)) throw new Error("历史快照校验失败");
			const content = bytes.toString("utf8"), previousContent = previous?.toString("utf8");
			return { version, content, ...(previousContent !== undefined ? { previousContent } : {}), previousVersionId: version.previousVersionId,
				diff: diffNoteContent(previousContent ?? "", content) };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});
	app.get<{ Params: { id: string; versionId: string }; Querystring: { path?: string } }>("/api/knowledge/:id/history/:versionId/assets", async (req, reply) => {
		try {
			const services = requireDeps();
			if (!(await registry.list(ownerId())).some((binding) => binding.id === req.params.id)) throw new KnowledgeRouteError("not_found", "知识库不存在");
			if (!services.history || !services.reviews) throw new KnowledgeRouteError("capability_unavailable", "固定历史图片未装配");
			await services.acceptance.flushHistory(req.params.id);
			const version = await services.history.get(req.params.id, req.params.versionId);
			const record = version?.batchId && version.channel === "agent_publish" ? await services.reviews.get(version.batchId) : undefined;
			if (!version || !record || record.ownerId !== ownerId() || record.batch.bindingId !== req.params.id || record.decisionId !== version.decisionId) throw new KnowledgeRouteError("not_found", "该版本没有固定图片发布回执");
			const page = record.batch.files.find((file) => file.kind !== "image" && file.targetPath === version.relativePath && file.candidateHash === version.contentHash);
			const asset = record.batch.files.find((file) => file.kind === "image" && file.targetPath === req.query.path);
			if (!page || !asset?.blobRef || !record.batch.dependencyGroups.some((group) => group.includes(page.targetPath) && group.includes(asset.targetPath))) throw new KnowledgeRouteError("not_found", "图片不属于该历史页面");
			const content = (await services.objects.get(version.snapshotRef)).toString("utf8");
			if (hashBufferSha256(content) !== version.contentHash || !markdownImageTargets(content).some((target) => resolveImagePath(version.relativePath, target) === asset.targetPath)) throw new KnowledgeRouteError("not_found", "历史正文未引用该固定图片");
			await assertImageBatchIntegrity(record.batch, services.objects);
			const bytes = await services.objects.get(asset.blobRef), mediaType = assertImageAssetBytes(asset.targetPath, bytes, asset.mediaType);
			return reply.header("Content-Type", mediaType).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store").send(bytes);
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Querystring: { contextKey?: string } }>("/api/knowledge-selection", async (req, reply) => {
		try {
			if (!deps?.selections) throw new KnowledgeRouteError("capability_unavailable", "知识库选择能力未装配");
			const contextKey = req.query.contextKey?.trim() ?? "";
			if (!contextKey || contextKey.length > 2_048) throw new KnowledgeRouteError("invalid_input", "知识库选择缺少有效工作上下文");
			return { selection: await deps.selections.effective(ownerId(), contextKey) };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.put<{ Body: { contextKey?: string; expectedRevision?: number; selectedBindingIds?: string[] } }>("/api/knowledge-selection", async (req, reply) => {
		try {
			if (!deps?.selections) throw new KnowledgeRouteError("capability_unavailable", "知识库选择能力未装配");
			const contextKey = req.body?.contextKey?.trim() ?? "";
			const expectedRevision = req.body?.expectedRevision;
			const selectedBindingIds = req.body?.selectedBindingIds;
			if (!contextKey || contextKey.length > 2_048 || !Number.isSafeInteger(expectedRevision) || (expectedRevision ?? -1) < 0 || !Array.isArray(selectedBindingIds)) {
				throw new KnowledgeRouteError("invalid_input", "知识库选择请求无效");
			}
			return { selection: await deps.selections.set(ownerId(), contextKey, expectedRevision!, selectedBindingIds) };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.post<{ Body: { path?: string; name?: string; description?: string } }>("/api/knowledge/probe", async (req, reply) => {
		try { return { probe: await probeKnowledgeRoot(req.body?.path ?? "") }; }
		catch (error) { return sendKnowledgeError(reply, error); }
	});

	// T20 接入管理：探测（10 分钟 TTL）→ 计划（持久化）→ 应用（复核根身份后落盘）。
	// intent=create 且目录不存在时返回"待创建"探测（targetExists:false），不写盘；省略或 bind 时行为不变。
	app.post<{ Body: { path?: string; intent?: string } }>("/api/knowledge/probes", async (req, reply) => {
		try {
			const probes = deps?.probes;
			if (!probes) throw new KnowledgeRouteError("capability_unavailable", "知识库接入探测能力未装配");
			const intent = req.body?.intent;
			if (intent !== undefined && intent !== "bind" && intent !== "create") {
				throw new KnowledgeRouteError("invalid_input", "intent 仅支持 bind/create");
			}
			const record = await probes.create(ownerId(), req.body?.path ?? "", intent === "create" ? { intent: "create" } : undefined);
			return reply.code(201).send({ probeId: record.probeId, probe: record });
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.post<{ Body: { probeId?: string; name?: string; description?: string; mode?: string; obsidianRoot?: string; schemaPresetId?: string } }>("/api/knowledge/plans", async (req, reply) => {
		try {
			const probes = deps?.probes;
			const plans = deps?.plans;
			if (!probes || !plans) throw new KnowledgeRouteError("capability_unavailable", "知识库接入计划能力未装配");
			const probe = probes.get(ownerId(), req.body?.probeId ?? "");
			const plan = await buildKnowledgePlan(ownerId(), probe, req.body ?? {}, await registry.findOverlap(probe.canonicalBindingRoot));
			await plans.save(plan);
			return reply.code(201).send({ plan });
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Params: { planId: string } }>("/api/knowledge/plans/:planId", async (req, reply) => {
		try {
			const plans = deps?.plans;
			if (!plans) throw new KnowledgeRouteError("capability_unavailable", "知识库接入计划能力未装配");
			return { plan: await plans.get(ownerId(), req.params.planId) };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.post<{ Params: { planId: string } }>("/api/knowledge/plans/:planId/apply", async (req, reply) => {
		try {
			const plans = deps?.plans;
			if (!plans) throw new KnowledgeRouteError("capability_unavailable", "知识库接入计划能力未装配");
			const plan = await plans.get(ownerId(), req.params.planId);
			const { binding, receipts } = await applyAndAcceptKnowledgePlan(plan, registry, requireDeps());
			return reply.code(201).send({ binding, receipts });
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	// T21/K05：预置只读；库内结构可先预览影响，再显式保存根声明。
	app.get("/api/knowledge/presets", async () => ({
		presets: Object.values(TEAMS_SCHEMA_PRESETS).map((preset) => ({ ...preset, hash: hashTeamsSchema(preset) })),
	}));

	app.get<{ Params: { id: string } }>("/api/knowledge/:id/schema", async (req, reply) => {
		try {
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const effective = await resolveEffectiveSchema(binding);
			return {
				origin: effective.origin,
				...(effective.schema ? { schema: effective.schema } : {}),
				...(effective.schemaRef ? { schemaRef: effective.schemaRef } : {}),
				capabilities: { read: true, structured: effective.origin !== "none", structuredPrepare: false, publish: false },
				warnings: effective.warnings,
			};
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.post<{ Params: { id: string }; Body: { schema?: TeamsSchemaPreset } }>("/api/knowledge/:id/schema-plans", async (req, reply) => {
		try {
			const services = requireDeps();
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const schema = req.body?.schema;
			if (!schema || typeof schema !== "object" || !Array.isArray(schema.entities) || !Array.isArray(schema.relations)) {
				throw new KnowledgeRouteError("schema_invalid", "结构定义不完整", ["invalid_header"]);
			}
			const errors = validateTeamsSchema(schema);
			if (errors.length > 0) throw new KnowledgeRouteError("schema_invalid", "结构定义未通过校验", errors);
			const current = await resolveEffectiveSchema(binding);
			const changes = diffTeamsSchemas(current.schema ?? null, schema);
			const affectedFiles = await schemaAffectedFiles(services, binding.id, current.schema ?? null, schema);
			return {
				impact: {
					changes,
					affectedFiles,
					unknownFieldsPreserved: true,
					note: "影响预览只读，不产生任何写入",
				},
			};
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.put<{ Params: { id: string }; Body: { schema?: TeamsSchemaPreset; expectedHash?: string; expectedAffectedFiles?: AffectedFile[]; acknowledgeAffected?: boolean } }>("/api/knowledge/:id/schema", async (req, reply) => {
		try {
			const services = requireDeps();
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const { schema, expectedHash, expectedAffectedFiles, acknowledgeAffected } = req.body ?? {};
			if (!schema || typeof schema !== "object" || !Array.isArray(schema.entities) || !Array.isArray(schema.relations) || !expectedHash || !Array.isArray(expectedAffectedFiles)) {
				throw new KnowledgeRouteError("invalid_input", "需要先预览影响，再提交结构草稿和当前结构哈希");
			}
			const errors = validateTeamsSchema(schema);
			if (errors.length) throw new KnowledgeRouteError("schema_invalid", "结构定义未通过校验", errors);
			const current = await resolveEffectiveSchema(binding);
			if (!current.schema || !current.schemaRef) throw new KnowledgeRouteError("capability_unavailable", "当前知识库没有可编辑的结构声明");
			if (current.schemaRef.hash !== expectedHash) throw new KnowledgeRouteError("baseline_conflict", "结构声明已变化，请刷新后重试");
			if (diffTeamsSchemas(current.schema, schema).length === 0) throw new KnowledgeRouteError("invalid_input", "实体和关系没有变化");
			const affectedFiles = await schemaAffectedFiles(services, binding.id, current.schema, schema);
			if (JSON.stringify(affectedFiles) !== JSON.stringify(expectedAffectedFiles)) {
				throw new KnowledgeRouteError("baseline_conflict", "受影响笔记已变化，请重新预览后保存");
			}
			if (affectedFiles.length > 0 && acknowledgeAffected !== true) {
				throw new KnowledgeRouteError("baseline_conflict", "存在受影响笔记，请确认影响后再保存", affectedFiles);
			}
			const saved = await writeTeamsSchema(binding, schema, expectedHash);
			return { schema: saved, schemaRef: { format: "teams-schema", id: saved.schemaId, revision: saved.revision, hash: hashTeamsSchema(saved) } };
		} catch (error) {
			if (error instanceof SchemaWriteError) return sendKnowledgeError(reply, new KnowledgeRouteError(error.code, error.message, error.details));
			return sendKnowledgeError(reply, error);
		}
	});

	app.post<{ Body: { path?: string; name?: string; description?: string } }>("/api/knowledge", async (req, reply) => {
		try {
			const binding = await registry.create({ ownerId: ownerId(), name: req.body?.name ?? "", description: req.body?.description ?? "", rootPath: req.body?.path ?? "" });
			return reply.code(201).send({ binding });
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.patch<{ Params: { id: string }; Body: { description?: string; expectedRevision?: number } }>("/api/knowledge/:id", async (req, reply) => {
		try {
			const binding = await registry.updateDescription(ownerId(), req.params.id, req.body?.expectedRevision ?? -1, req.body?.description ?? "");
			return { binding };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.delete<{ Params: { id: string }; Body: { expectedRevision?: number } }>("/api/knowledge/:id", async (req, reply) => {
		try {
			const binding = await registry.revoke(ownerId(), req.params.id, req.body?.expectedRevision ?? -1);
			return { binding };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Params: { id: string } }>("/api/knowledge/:id/tree", async (req, reply) => {
		try {
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const tree = await listKnowledgeTree(binding);
			if (!deps) return { tree };
			const scan = await ensureScan(deps, binding.id, () => deps.observation.scan(binding));
			return { tree: joinTreeStatus(tree, scan) };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Params: { id: string }; Querystring: { path?: string; version?: string } }>("/api/knowledge/:id/note", async (req, reply) => {
		try {
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const relativePath = req.query.path ?? "";
			const version = req.query.version ?? "observed";
			if (version !== "observed" && version !== "accepted") {
				throw new KnowledgeRouteError("invalid_input", "version 仅支持 observed/accepted");
			}
			if (version === "observed") {
				const note = await readKnowledgeNote(binding, relativePath);
				if (!deps) return { note };
				const scan = await ensureScan(deps, binding.id, () => deps.observation.scan(binding));
				const ledger = await deps.acceptance.getSnapshot(binding.id);
				const entry = findLedgerEntry(ledger, scan, relativePath)?.entry;
				return {
					note: {
						...note,
						version: "observed",
						contentHash: hashBufferSha256(note.content),
						status: scan.files.get(relativePath)?.state ?? "current",
						...(entry ? { acceptedAt: entry.acceptedAt } : {}),
					},
				};
			}
			const services = requireDeps();
			const scan = await ensureScan(services, binding.id, () => services.observation.scan(binding));
			const ledger = await services.acceptance.getSnapshot(binding.id);
			const found = findLedgerEntry(ledger, scan, relativePath);
			if (!found || found.entry.availability !== "current") throw new KnowledgeRouteError("not_found", "该笔记没有当前可读快照");
			const snapshot = await services.objects.get(found.entry.snapshotRef).catch(() => null);
			if (!snapshot) throw new KnowledgeRouteError("context_unavailable", "当前快照缺失，请重新同步");
			return {
				note: {
					path: relativePath,
					content: snapshot.toString("utf8"),
					size: snapshot.length,
					version: "accepted",
					contentHash: found.entry.contentHash,
					status: scan.files.get(relativePath)?.state ?? "missing",
					acceptedAt: found.entry.acceptedAt,
				},
			};
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	// T24：受控的“在 Obsidian 中打开”——服务端只校验并生成 URI，打开动作由桌面宿主复核后执行。
	app.post<{ Params: { id: string }; Body: { path?: string } }>("/api/knowledge/:id/obsidian-uri", async (req, reply) => {
		try {
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const relativePath = req.body?.path;
			if (typeof relativePath !== "string" || !relativePath) {
				throw new KnowledgeRouteError("invalid_input", "缺少笔记路径");
			}
			const absolute = await resolveNoteAbsolutePath(binding, relativePath);
			const obsidianRoot = binding.obsidianRoot ?? binding.contentRoot;
			if (!withinKnowledgeRoot(obsidianRoot, absolute)) {
				throw new KnowledgeReadError("invalid_path", "笔记不在 Obsidian 库根之内");
			}
			return { uri: `obsidian://open?path=${encodeURIComponent(absolute)}` };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.post<{ Params: { id: string } }>("/api/knowledge/:id/scan", async (req, reply) => {
		try {
			const services = requireDeps();
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const record = await services.observation.scan(binding);
			const ledger = await services.acceptance.getSnapshot(binding.id);
			return { scannedAt: record.scannedAt, counts: noteCounts(record), duplicates: record.duplicates, acceptanceRevision: ledger.acceptanceRevision };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Params: { id: string } }>("/api/knowledge/:id/observations", async (req, reply) => {
		try {
			const services = requireDeps();
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const record = await ensureScan(services, binding.id, () => services.observation.scan(binding));
			const ledger = await services.acceptance.getSnapshot(binding.id);
			return {
				scannedAt: record.scannedAt,
				files: [...record.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
				duplicates: record.duplicates,
				acceptanceRevision: ledger.acceptanceRevision,
			};
		} catch (error) { return sendKnowledgeError(reply, error); }
	});



	app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>("/api/knowledge/:id/search", async (req, reply) => {
		try {
			const services = requireDeps();
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const query = (req.query.q ?? "").trim();
			if (!query) throw new KnowledgeRouteError("invalid_input", "搜索关键词不能为空");
			let limit = 20;
			if (req.query.limit !== undefined) {
				const parsed = Number(req.query.limit);
				if (!Number.isSafeInteger(parsed) || parsed < 1) throw new KnowledgeRouteError("invalid_input", "limit 必须是正整数");
				limit = Math.min(parsed, 50);
			}
			await services.observation.scan(binding);
			const ledger = await services.acceptance.getSnapshot(binding.id);
			const index = await services.searchIndex.load(binding.id, ledger);
			const { results, truncated } = searchBuiltIndex(index, query, limit);
			return { results, truncated };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Params: { id: string }; Querystring: { from?: string; link?: string; kind?: string } }>("/api/knowledge/:id/resolve", async (req, reply) => {
		try {
			const services = requireDeps();
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const from = req.query.from ?? "";
			const rawLink = req.query.link ?? "";
			const kind = req.query.kind ?? "wiki";
			if (!rawLink.trim()) throw new KnowledgeRouteError("invalid_input", "链接目标不能为空");
			if (kind !== "wiki" && kind !== "md") throw new KnowledgeRouteError("invalid_input", "kind 仅支持 wiki/md");
			if (kind === "md") assertValidNoteRelativePath(from);
			const scan = await ensureScan(services, binding.id, () => services.observation.scan(binding));
			const ledger = await services.acceptance.getSnapshot(binding.id);
			const diskPaths = [...scan.files.values()].filter((file) => file.state === "current").map((file) => file.path);
			const titleOf = (relativePath: string): string =>
				findLedgerEntry(ledger, scan, relativePath)?.entry.title ??
				scan.files.get(relativePath)?.title ??
				relativePath.split("/").pop()!.replace(/\.md$/i, "");
			if (kind === "wiki") {
				// link 接受裸目标与完整 [[...]] 两种写法。
				const inner = rawLink.startsWith("[[") && rawLink.endsWith("]]") ? rawLink.slice(2, -2) : rawLink;
				const { target, anchor } = splitWikiLinkTarget(inner);
				if (!target) return { status: "broken" };
				const resolution = resolveWikiLink(diskPaths, target);
				if (resolution.status === "ok") {
					return { status: "ok", note: { path: resolution.path, title: titleOf(resolution.path) }, ...(anchor ? { anchor } : {}) };
				}
				if (resolution.status === "ambiguous") {
					return { status: "ambiguous", candidates: resolution.candidates.map((candidate) => ({ path: candidate, title: titleOf(candidate) })) };
				}
				return { status: "broken" };
			}
			const hashIndex = rawLink.indexOf("#");
			const target = (hashIndex >= 0 ? rawLink.slice(0, hashIndex) : rawLink).trim();
			const anchor = hashIndex >= 0 ? rawLink.slice(hashIndex + 1) : undefined;
			const resolvedPath = resolveMarkdownLinkTarget(from, target);
			if (!resolvedPath) return { status: "out_of_scope" };
			return { status: "ok", note: { path: resolvedPath, title: titleOf(resolvedPath) }, ...(anchor ? { anchor } : {}) };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/knowledge/:id/backlinks", async (req, reply) => {
		try {
			const services = requireDeps();
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const relativePath = req.query.path ?? "";
			assertValidNoteRelativePath(relativePath);
			await services.observation.scan(binding);
			const ledger = await services.acceptance.getSnapshot(binding.id);
			const index = await services.searchIndex.load(binding.id, ledger);
			return { backlinks: index.backlinks.get(relativePath) ?? [] };
		} catch (error) { return sendKnowledgeError(reply, error); }
	});

	app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/knowledge/:id/asset", async (req, reply) => {
		try {
			const binding = await registry.requireUsable(ownerId(), req.params.id);
			const asset = await readKnowledgeAsset(binding, req.query.path ?? "");
			return reply
				.header("Content-Type", asset.contentType)
				.header("Content-Security-Policy", "default-src 'none'")
				.header("Cache-Control", "private, max-age=60")
				.send(asset.content);
		} catch (error) { return sendKnowledgeError(reply, error); }
	});
}
