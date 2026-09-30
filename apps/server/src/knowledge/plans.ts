import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import { hashBufferSha256 } from "./hashing.js";
import { probeKnowledgeRoot } from "./probe.js";
import type { KnowledgeProbeRecord } from "./probes.js";
import { schemaPresetAgents } from "./schema-guidance.js";
import { copySchemaPreset, hashTeamsSchema, TEAMS_SCHEMA_PRESETS } from "./schema-presets.js";

export class KnowledgePlanError extends Error {
	constructor(
		readonly code: "invalid_input" | "not_found" | "overlapping_root" | "root_changed" | "context_unavailable" | "partial",
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

export interface KnowledgePlanFileItem {
	relativePath: string;
	/** 计划阶段冻结的正文（脚手架均为小文本文件），apply 不重算。 */
	content: string;
	contentHash: string;
	bytes: number;
}

export interface KnowledgePlan {
	version: 1;
	planId: string;
	ownerId: string;
	probeId: string;
	mode: "bind" | "create";
	name: string;
	description: string;
	canonicalBindingRoot: string;
	/** probe 时目录尚不存在（createRootDir）则为 null，apply 创建目录后重算。 */
	rootIdentity: string | null;
	/** true 表示根目录本身也由本计划创建（probe targetExists:false 的 create 计划）。 */
	createRootDir?: boolean;
	contentRoot: string;
	linkRoot: string;
	obsidianRoot?: string;
	schemaPresetId?: string;
	filesToCreate: KnowledgePlanFileItem[];
	filesToSkip: Array<{ relativePath: string; reason: string }>;
	warnings: string[];
	createdAt: string;
	planRevision: 1;
}

export interface ApplyReceipt {
	relativePath: string;
	status: "created" | "skipped_exists" | "failed";
	error?: string;
}

function scaffoldIndexMarkdown(name: string, description: string): string {
	const title = name.replace(/\s*\n\s*/g, " ");
	const body = description.replace(/\s*\n\s*/g, " ");
	return `# ${title}\n\n${body}\n\n> 本知识库由 PuddingTeams 初始化。\n`;
}

/** 生成计划：校验输入、拒绝重叠根、冻结脚手架字节（bind 模式零文件）；已存在的目标文件列入 filesToSkip。 */
export async function buildKnowledgePlan(
	ownerId: string,
	probe: KnowledgeProbeRecord,
	input: { name?: string; description?: string; mode?: string; obsidianRoot?: string; schemaPresetId?: string },
	existingOverlap: KnowledgeBinding | undefined,
): Promise<KnowledgePlan> {
	const name = (input.name ?? "").trim();
	const description = (input.description ?? "").trim();
	if (!name || name.length > 120) throw new KnowledgePlanError("invalid_input", "知识库名称必填且不超过 120 字");
	if (!description || description.length > 500) throw new KnowledgePlanError("invalid_input", "知识库描述必填且不超过 500 字");
	if (input.mode !== "bind" && input.mode !== "create") {
		throw new KnowledgePlanError("invalid_input", "mode 仅支持 bind/create");
	}
	const createRootDir = probe.targetExists === false;
	if (createRootDir && input.mode !== "create") {
		throw new KnowledgePlanError("invalid_input", "目标目录尚不存在，只能选择「初始化新库」模式");
	}
	let obsidianRoot: string | undefined;
	if (probe.obsidianRootCandidates) {
		if (!input.obsidianRoot || !probe.obsidianRootCandidates.includes(input.obsidianRoot)) {
			throw new KnowledgePlanError("invalid_input", "根目录与 wiki/ 均存在 .obsidian，必须从候选中显式选择 Obsidian 根");
		}
		obsidianRoot = input.obsidianRoot;
	} else if (input.obsidianRoot) {
		if (input.obsidianRoot !== probe.obsidianRoot) {
			throw new KnowledgePlanError("invalid_input", "所选 Obsidian 根不在探测候选内");
		}
		obsidianRoot = input.obsidianRoot;
	} else {
		obsidianRoot = probe.obsidianRoot;
	}
	if (input.schemaPresetId !== undefined) {
		if (input.mode !== "create") throw new KnowledgePlanError("invalid_input", "绑定既有目录时不生成结构脚手架");
		if (!TEAMS_SCHEMA_PRESETS[input.schemaPresetId]) throw new KnowledgePlanError("invalid_input", "未知的结构预置包");
	}
	if (existingOverlap) {
		throw new KnowledgePlanError("overlapping_root", `知识库根目录与现有绑定「${existingOverlap.name}」重叠或嵌套`);
	}

	const filesToCreate: KnowledgePlanFileItem[] = [];
	const filesToSkip: Array<{ relativePath: string; reason: string }> = [];
	const warnings = [...probe.warnings];
	if (input.mode === "create") {
		const scaffold: Array<{ relativePath: string; content: string }> = [
			{ relativePath: "wiki/index.md", content: scaffoldIndexMarkdown(name, description) },
		];
		if (input.schemaPresetId) {
			scaffold.push({
				relativePath: "wiki.schema.json",
				content: `${JSON.stringify(copySchemaPreset(input.schemaPresetId), null, 2)}\n`,
			});
			// 操作契约与结构声明并列落在库根：Agent 在库根工作时会先读到它，schema 负责"有哪些页面"，契约负责"怎么写"。
			const agents = schemaPresetAgents(input.schemaPresetId);
			if (agents) scaffold.push({ relativePath: "AGENTS.md", content: agents });
		}
		for (const file of scaffold) {
			const absolute = path.join(probe.canonicalBindingRoot, ...file.relativePath.split("/"));
			if (await lstat(absolute).catch(() => null)) {
				filesToSkip.push({ relativePath: file.relativePath, reason: "already_exists" });
				continue;
			}
			const bytes = Buffer.byteLength(file.content, "utf8");
			filesToCreate.push({ ...file, bytes, contentHash: hashBufferSha256(file.content) });
		}
		warnings.push("计划只创建缺项，已存在的同名文件不会被覆盖");
	}
	return {
		version: 1,
		planId: randomUUID(),
		ownerId,
		probeId: probe.probeId,
		mode: input.mode,
		name,
		description,
		canonicalBindingRoot: probe.canonicalBindingRoot,
		rootIdentity: probe.rootIdentity,
		...(createRootDir ? { createRootDir: true as const } : {}),
		contentRoot: probe.contentRoot,
		linkRoot: probe.linkRoot,
		...(obsidianRoot ? { obsidianRoot } : {}),
		...(input.schemaPresetId ? { schemaPresetId: input.schemaPresetId } : {}),
		filesToCreate,
		filesToSkip,
		warnings,
		createdAt: new Date().toISOString(),
		planRevision: 1,
	};
}

/**
 * 执行计划：先复核根身份（变化 → root_changed，离线/不可读 → context_unavailable），
 * create 模式逐项 `wx` 写入（已存在 → skipped_exists，不覆盖）；任何失败项不阻断其余项，
 * 最终若有失败或登记失败，仅清理"本操作创建且当前字节仍等于计划字节"的文件，
 * 以及"本操作创建且清理时为空"的目录。
 * createRootDir 计划（probe 时根目录不存在）跳过 root_changed 复核：根目录缺失则由
 * 本操作登记并创建；若已被外部创建（含同名脚手架文件），`wx` 语义天然逐项 skipped_exists。
 */
export async function applyKnowledgePlan(
	plan: KnowledgePlan,
	registry: KnowledgeBindingRegistry,
): Promise<{ binding: KnowledgeBinding; receipts: ApplyReceipt[] }> {
	const receipts: ApplyReceipt[] = plan.filesToSkip.map((item) => ({ relativePath: item.relativePath, status: "skipped_exists" as const }));
	const createdDirs: string[] = [];
	let bindingRootIdentity: string;
	if (plan.createRootDir) {
		const rootInfo = await lstat(plan.canonicalBindingRoot).catch(() => null);
		if (rootInfo && !rootInfo.isDirectory()) {
			throw new KnowledgePlanError("context_unavailable", "目标路径已被创建为文件而非目录，无法作为知识库根目录");
		}
		if (!rootInfo) {
			try {
				await mkdirTracked(plan.canonicalBindingRoot, plan.canonicalBindingRoot, createdDirs, true);
			} catch (error) {
				throw new KnowledgePlanError("context_unavailable", `无法创建目录：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const fresh = await probeKnowledgeRoot(plan.canonicalBindingRoot).catch(() => null);
		if (!fresh) {
			await cleanupPlannedFiles(plan, receipts, createdDirs);
			throw new KnowledgePlanError("context_unavailable", "目标目录离线或不可读，请核对后重试");
		}
		bindingRootIdentity = fresh.rootIdentity;
	} else {
		const probe = await probeKnowledgeRoot(plan.canonicalBindingRoot).catch(() => null);
		if (!probe) throw new KnowledgePlanError("context_unavailable", "目标目录离线或不可读，请核对后重试");
		if (probe.canonicalRoot !== plan.canonicalBindingRoot || probe.rootIdentity !== plan.rootIdentity) {
			throw new KnowledgePlanError("root_changed", "目标目录身份已变化，请重新探测并生成计划");
		}
		bindingRootIdentity = probe.rootIdentity;
	}

	for (const item of plan.filesToCreate) {
		const absolute = path.join(plan.canonicalBindingRoot, ...item.relativePath.split("/"));
		try {
			await mkdirTracked(path.dirname(absolute), plan.canonicalBindingRoot, createdDirs);
		} catch (error) {
			receipts.push({ relativePath: item.relativePath, status: "failed", error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		try {
			const handle = await open(absolute, "wx", 0o600);
			try {
				await handle.writeFile(item.content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			receipts.push({ relativePath: item.relativePath, status: "created" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				receipts.push({ relativePath: item.relativePath, status: "skipped_exists" });
			} else {
				receipts.push({ relativePath: item.relativePath, status: "failed", error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	if (receipts.some((receipt) => receipt.status === "failed")) {
		await cleanupPlannedFiles(plan, receipts, createdDirs);
		throw new KnowledgePlanError("partial", "部分文件创建失败，已保守清理本次创建且未被改动的文件", receipts);
	}

	const schemaRef = plan.schemaPresetId
		? { format: "teams-schema", id: plan.schemaPresetId, revision: 1, hash: hashTeamsSchema(copySchemaPreset(plan.schemaPresetId)), originPresetId: plan.schemaPresetId }
		: undefined;
	try {
		const binding = await registry.create({
			ownerId: plan.ownerId,
			name: plan.name,
			description: plan.description,
			rootPath: plan.canonicalBindingRoot,
			prepared: {
				canonicalRoot: plan.canonicalBindingRoot,
				rootIdentity: bindingRootIdentity,
				contentRoot: plan.contentRoot,
				linkRoot: plan.linkRoot,
				...(plan.obsidianRoot ? { obsidianRoot: plan.obsidianRoot } : {}),
				...(schemaRef ? { schemaRef } : {}),
			},
		});
		return { binding, receipts };
	} catch (error) {
		await cleanupPlannedFiles(plan, receipts, createdDirs);
		throw error;
	}
}

/** mkdir -p 并记录本次实际新建的目录（root 之下、调用前不存在的逐级路径，深→浅）；includeRoot 时根目录本身也纳入登记。 */
async function mkdirTracked(dir: string, root: string, createdDirs: string[], includeRoot = false): Promise<void> {
	const missing: string[] = [];
	for (let current = dir; current === root && includeRoot || current.startsWith(`${root}${path.sep}`); current = path.dirname(current)) {
		if (await lstat(current).catch(() => null)) break;
		missing.push(current);
	}
	await mkdir(dir, { recursive: true });
	createdDirs.push(...missing);
}

/**
 * 保守清理：先删本操作创建且读回字节仍等于计划字节的文件（外部改过的必须保留），
 * 再自底向上回收本操作创建且此刻为空的目录（有任何内容的目录保留，未登记的目录不碰）。
 */
export async function cleanupPlannedFiles(plan: KnowledgePlan, receipts: ApplyReceipt[], createdDirs: readonly string[] = []): Promise<void> {
	for (const receipt of receipts) {
		if (receipt.status !== "created") continue;
		const item = plan.filesToCreate.find((candidate) => candidate.relativePath === receipt.relativePath);
		if (!item) continue;
		const absolute = path.join(plan.canonicalBindingRoot, ...item.relativePath.split("/"));
		const current = await readFile(absolute).catch(() => null);
		if (current && current.length === item.bytes && hashBufferSha256(current) === item.contentHash) {
			await rm(absolute, { force: true });
		}
	}
	const dirs = [...new Set(createdDirs)].sort((a, b) => b.length - a.length);
	for (const dir of dirs) {
		// rmdir 只删空目录：非空（外部文件/未清理的子项）或已不存在都跳过。
		await rmdir(dir).catch(() => undefined);
	}
}

/** 计划持久化：state/knowledge/plans/<planId>.json，tmp + rename 原子替换。 */
export class KnowledgePlanStore {
	private readonly cache = new Map<string, KnowledgePlan>();

	constructor(private readonly directory: string) {}

	private fileFor(planId: string): string {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planId)) {
			throw new KnowledgePlanError("invalid_input", "计划标识非法");
		}
		return path.join(this.directory, `${planId}.json`);
	}

	async save(plan: KnowledgePlan): Promise<KnowledgePlan> {
		await mkdir(this.directory, { recursive: true });
		const file = this.fileFor(plan.planId);
		const temp = `${file}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, file);
		this.cache.set(plan.planId, plan);
		return plan;
	}

	async get(ownerId: string, planId: string): Promise<KnowledgePlan> {
		const cached = this.cache.get(planId);
		if (cached && cached.ownerId === ownerId) return cached;
		const raw = await readFile(this.fileFor(planId), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (raw === null) throw new KnowledgePlanError("not_found", "计划不存在，请重新生成");
		const parsed: unknown = JSON.parse(raw);
		const plan = parsed as KnowledgePlan;
		if (!plan || typeof plan !== "object" || plan.version !== 1 || plan.planId !== planId ||
			(plan.mode !== "bind" && plan.mode !== "create") || typeof plan.canonicalBindingRoot !== "string" ||
			!Array.isArray(plan.filesToCreate) || !Array.isArray(plan.filesToSkip)) {
			throw new KnowledgePlanError("not_found", "计划不存在或已损坏，请重新生成");
		}
		if (plan.ownerId !== ownerId) throw new KnowledgePlanError("not_found", "计划不存在，请重新生成");
		this.cache.set(planId, plan);
		return plan;
	}
}
