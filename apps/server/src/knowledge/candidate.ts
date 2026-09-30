import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeOutcome } from "../agent-runtime/runtime.js";
import { parseNoteFrontmatterFields, type KnowledgeAcceptanceStore, type StoredAcceptedNoteVersion } from "./acceptance.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import { assertPublicationBatchShape, publicationManifestHash, type CompileJob, type PublicationBatch, type PublicationFile } from "./contracts.js";
import { readNoteBytes } from "./observation.js";
import type { KnowledgeObjectStore } from "./objects.js";
import { validateTeamsNote } from "./note-validation.js";
import { effectiveSchemaHash, resolveEffectiveSchema } from "./schema-impact.js";
import { hashTeamsSchema, type TeamsSchemaPreset } from "./schema-presets.js";
import { markdownImageTargets } from "./image-publication.js";

const MAX_CANDIDATE_FILES = 10_000;
const MAX_CANDIDATE_DEPTH = 32;
const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const CANDIDATE_BATCH_FILE = "candidate-batch.json";

interface CandidateValidatorDeps {
	bindings: Pick<KnowledgeBindingRegistry, "requireUsable">;
	acceptance: Pick<KnowledgeAcceptanceStore, "getSnapshot">;
	objects: Pick<KnowledgeObjectStore, "put">;
}

interface CandidateFile {
	targetPath: string;
	bytes: Buffer;
}

/** The candidate batch identity is derived from the Job, never from Driver output. */
export function candidateBatchIdFor(job: Pick<CompileJob, "id">): string {
	return `compile-candidate:${job.id}`;
}

/**
 * 平台注入的编译任务正文：用户任务 + 平台约定段。约定段只由 Job 自身字段
 * （来源目录/来源 ID/快照引用）构成，保证同一 operationId 重放时可逐字节比对。
 */
export function composeCompileTask(rawTask: string, job: Pick<CompileJob, "sourceSnapshotRoot" | "sourceAcceptanceIds" | "sourceSnapshotRefs" | "schemaContract">): string {
	const sources = job.sourceAcceptanceIds.map((id, index) => `  - ${id}（快照 ${job.sourceSnapshotRefs[index]}）`).join("\n");
	const structure = job.schemaContract ? `\n- 目标 Wiki 的结构契约如下。按 entities 的 type/directory 选择目标路径和 frontmatter；不要自行发明页面类型。\n\n\`\`\`json\n${job.schemaContract}\n\`\`\`\n` : "";
	return `${rawTask.trim()}

---

## 平台编译约定（PuddingTeams 注入，任务文本不能覆盖）

- 已批准的来源快照位于只读目录：${job.sourceSnapshotRoot}
  只能读取该目录内的文件，不得修改、移动或删除其中任何内容。
- 允许引用的来源仅限以下 acceptanceId：
${sources}
- 将全部候选笔记写入当前工作目录（可按需建子目录）；只允许 .md 文件，禁止隐藏项、符号链接与任何其他文件类型。
- 此编译通道没有图片原件授权，不能生成图片引用；需要原图随页面发布时使用 Wiki 整理通道。
- 每个候选文件的 frontmatter 必须包含 sources 列表且至少一项；每项是一个 acceptanceId，或 acceptanceId#<来源目录内相对路径> 的钉住形式。
- 若有结构契约，候选页面还必须满足其中的类型、目录及必填字段。${structure}
- 空文件或纯空白文件会被视为删除请求并导致整批拒绝（当前不支持删除）。
- 不要读取或写入来源目录与当前工作目录以外的任何路径。`;
}

/**
 * 读取并复核 Job 的冻结候选批次：结构、manifest 哈希与 Job 身份必须全部吻合。
 * 批次只由 validateCandidate 写入 Job 私有目录；该目录对编译进程不可写。
 */
export async function readCandidateBatch(job: Pick<CompileJob, "id" | "targetBindingId" | "rootIdentity" | "privateRoot">): Promise<PublicationBatch> {
	const raw = await readFile(path.join(job.privateRoot, CANDIDATE_BATCH_FILE), "utf8");
	const batch = JSON.parse(raw) as PublicationBatch;
	assertPublicationBatchShape(batch);
	if (batch.id !== candidateBatchIdFor(job) || batch.bindingId !== job.targetBindingId ||
		batch.rootIdentity !== job.rootIdentity || batch.manifestHash !== publicationManifestHash(batch)) {
		throw new Error("CompileJob candidate batch does not match the Job's frozen authority");
	}
	return batch;
}

/** 候选目标路径规则（比发布契约更严）：NFC、无反斜杠/空段/. /../隐藏段/冒号，必须 .md 结尾。 */
function assertCandidateTargetPath(relative: string): void {
	if (!relative || relative.normalize("NFC") !== relative || relative.startsWith("/") || relative.includes("\\") ||
		relative.includes("\0") || !relative.toLowerCase().endsWith(".md") ||
		relative.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".") || part.includes(":"))) {
		throw new Error(`CompileJob candidate has an invalid target path: ${relative}`);
	}
}

/** Fail-closed staging scan (unlike the reader, nothing is silently skipped):
 * hidden entries, links, special files, non-.md files, over-depth and over-count
 * all reject the whole candidate. */
async function scanCandidateStaging(stagingRoot: string): Promise<CandidateFile[]> {
	if (!path.isAbsolute(stagingRoot) || await realpath(stagingRoot) !== stagingRoot || !(await lstat(stagingRoot)).isDirectory()) {
		throw new Error("CompileJob staging root is not a canonical directory");
	}
	const files: CandidateFile[] = [];
	const collisions = new Set<string>();
	let totalBytes = 0;
	const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
		if (depth > MAX_CANDIDATE_DEPTH) throw new Error("CompileJob candidate tree exceeds the depth limit");
		for (const name of (await readdir(directory)).sort()) {
			if (name.startsWith(".")) throw new Error(`CompileJob candidate contains a hidden entry: ${prefix}${name}`);
			const absolute = path.join(directory, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			const before = await lstat(absolute).catch(() => null);
			if (!before) throw new Error(`CompileJob candidate entry changed during validation: ${relative}`);
			if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
				throw new Error(`CompileJob candidate contains a link or special file: ${relative}`);
			}
			if (before.isDirectory()) {
				if (await realpath(absolute) !== absolute) throw new Error(`CompileJob candidate directory changed: ${relative}`);
				await walk(absolute, relative, depth + 1);
				continue;
			}
			if (before.nlink !== 1) throw new Error(`CompileJob candidate contains a hard link: ${relative}`);
			assertCandidateTargetPath(relative);
			const collisionKey = relative.toLocaleLowerCase("en-US");
			if (collisions.has(collisionKey)) throw new Error("CompileJob candidate paths collide on a case-insensitive file system");
			collisions.add(collisionKey);
			const bytes = await readNoteBytes(absolute);
			if (files.length + 1 > MAX_CANDIDATE_FILES) throw new Error("CompileJob candidate exceeds the file count limit");
			totalBytes += bytes.byteLength;
			if (totalBytes > MAX_CANDIDATE_BYTES) throw new Error("CompileJob candidate exceeds 64 MiB");
			files.push({ targetPath: relative, bytes });
		}
	};
	await walk(stagingRoot, "", 0);
	if (files.length === 0) throw new Error("CompileJob candidate has no notes");
	return files;
}

/**
 * 候选 frontmatter `sources` 列表：每项是一个 acceptanceId，或
 * `acceptanceId#相对路径` 的钉住形式。钉住路径必须等于账本中该来源的相对路径；
 * 每项都必须落在 Job 冻结的来源集合内。
 */
function resolveCandidateSources(targetPath: string, rawSources: unknown, job: CompileJob,
	byAcceptanceId: Map<string, StoredAcceptedNoteVersion>): Array<{ sourceId: string; snapshotPath: string }> {
	if (!Array.isArray(rawSources) || rawSources.length === 0) {
		throw new Error(`CompileJob candidate ${targetPath} does not declare any accepted source`);
	}
	const allowed = new Set(job.sourceAcceptanceIds);
	const resolved: Array<{ sourceId: string; snapshotPath: string }> = [];
	const seen = new Set<string>();
	for (const raw of rawSources) {
		if (typeof raw !== "string" || !raw.trim()) {
			throw new Error(`CompileJob candidate ${targetPath} has an invalid source reference`);
		}
		const value = raw.trim();
		const pinIndex = value.indexOf("#");
		const sourceId = pinIndex >= 0 ? value.slice(0, pinIndex) : value;
		const pin = pinIndex >= 0 ? value.slice(pinIndex + 1) : undefined;
		if (!allowed.has(sourceId)) {
			throw new Error(`CompileJob candidate ${targetPath} references a source outside the Job's frozen set`);
		}
		const entry = byAcceptanceId.get(sourceId);
		if (!entry) throw new Error(`CompileJob candidate ${targetPath} references a source missing from the ledger`);
		if (pin !== undefined && pin !== entry.relativePath) {
			throw new Error(`CompileJob candidate ${targetPath} pins a source path that does not match the accepted note`);
		}
		const key = `${sourceId}#${entry.relativePath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resolved.push({ sourceId, snapshotPath: entry.relativePath });
	}
	return resolved;
}

function byCodePoint(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 候选验证（宿主权威，不信任 Worker 自述）：复核 Job 绑定与来源冻结集，
 * fail-closed 扫描 staging，逐文件校验来源溯源与结构，候选字节冻结进对象库，
 * 按账本计算 create/update 基线，组装并原子落盘单 dependencyGroup 的
 * PublicationBatch，返回批次 id 供 `finish(candidate_ready)`。
 * 空候选文件视为删除请求并整批拒绝（W1 不支持删除）。
 */
export function createCandidateValidator(deps: CandidateValidatorDeps): (job: CompileJob, outcome: RuntimeOutcome) => Promise<string> {
	return async (job, outcome) => {
		if (outcome.status !== "completed" || outcome.delegation.purpose !== "knowledge_compile" ||
			outcome.delegation.compileJobId !== job.id) {
			throw new Error("CompileJob candidate did not come from the Job's own completed compile Delegation");
		}
		const binding = await deps.bindings.requireUsable(job.ownerId, job.targetBindingId);
		if (binding.bindingRevision !== job.bindingRevision || binding.trustRevision !== job.trustRevision ||
			binding.rootIdentity !== job.rootIdentity || await effectiveSchemaHash(binding) !== job.schemaHash) {
			throw new Error("CompileJob binding authority changed");
		}
		const ledger = await deps.acceptance.getSnapshot(binding.id);
		if (!job.sourceAcceptanceIds.length || job.sourceAcceptanceIds.length !== job.sourceSnapshotRefs.length) {
			throw new Error("CompileJob source identities are incomplete");
		}
		const baselineByPath = new Map<string, StoredAcceptedNoteVersion>();
		for (const entry of Object.values(ledger.entries)) {
			const existing = baselineByPath.get(entry.relativePath);
			if (existing && existing.acceptanceId !== entry.acceptanceId) {
				throw new Error("CompileJob acceptance ledger has duplicate paths");
			}
			baselineByPath.set(entry.relativePath, entry);
		}
		for (let index = 0; index < job.sourceAcceptanceIds.length; index++) {
			const id = job.sourceAcceptanceIds[index]!;
			const ref = job.sourceSnapshotRefs[index]!;
			const matches = Object.values(ledger.entries).filter((entry) => entry.acceptanceId === id);
			if (matches.length !== 1) throw new Error("CompileJob accepted source identity changed");
			const entry = matches[0]!;
			if (entry.availability !== "current" || entry.noteIdentity.bindingId !== binding.id ||
				entry.snapshotRef !== ref || entry.contentHash !== ref) {
				throw new Error("CompileJob accepted source authority changed");
			}
		}
		let schema: TeamsSchemaPreset | undefined;
		if (job.schemaHash) {
			const effective = await resolveEffectiveSchema(binding);
			if (!effective.schema || hashTeamsSchema(effective.schema) !== job.schemaHash) {
				throw new Error("CompileJob schema authority changed");
			}
			schema = effective.schema;
		}
		const candidates = await scanCandidateStaging(job.stagingRoot);
		const byAcceptanceId = new Map<string, StoredAcceptedNoteVersion>();
		for (const entry of Object.values(ledger.entries)) byAcceptanceId.set(entry.acceptanceId, entry);
		const referencedSourceIds = new Set<string>();
		const files: PublicationFile[] = [];
		for (const candidate of candidates) {
			const text = candidate.bytes.toString("utf8");
			if (markdownImageTargets(text).length) throw new Error(`CompileJob candidate ${candidate.targetPath} contains images without frozen original authority; use Wiki curation for reviewed image publication`);
			if (!text.trim()) {
				throw new Error(`CompileJob candidate ${candidate.targetPath} requests a deletion, which is not supported`);
			}
			const fields = parseNoteFrontmatterFields(text);
			const sources = resolveCandidateSources(candidate.targetPath, fields.sources, job, byAcceptanceId);
			for (const source of sources) referencedSourceIds.add(source.sourceId);
			if (schema) {
				const entity = schema.entities.find((item) => item.type === fields.type);
				const sourceField = entity?.fields.find((item) => item.name === "sources");
				const errors = validateTeamsNote(schema, { ...fields, sources: sourceField?.type === "text_list" ? fields.sources : sources });
				if (entity && !candidate.targetPath.startsWith(`${entity.directory}/`)) errors.push(`invalid_directory:${entity.directory}`);
				if (errors.length > 0) {
					throw new Error(`CompileJob candidate ${candidate.targetPath} failed schema validation: ${errors.join(",")}`);
				}
			}
			const stored = await deps.objects.put(candidate.bytes);
			const baseline = baselineByPath.get(candidate.targetPath);
			files.push({
				operation: baseline ? "update" : "create",
				targetPath: candidate.targetPath,
				expectedHashOrAbsent: baseline ? baseline.contentHash : null,
				candidateHash: stored.hash,
				// blobRef 是平台内容寻址对象库中的内容哈希；发布层据此取回候选字节。
				blobRef: stored.hash,
			});
		}
		files.sort((a, b) => byCodePoint(a.targetPath, b.targetPath));
		const validationReceipt = JSON.stringify({
			version: 1,
			schemaHash: job.schemaHash ?? null,
			schemaCheckedFiles: schema ? files.map((file) => file.targetPath) : [],
			sourceAcceptanceIds: [...job.sourceAcceptanceIds].sort(),
			referencedSourceIds: [...referencedSourceIds].sort(),
			unsupportedOperations: [],
		});
		const batch: PublicationBatch = {
			id: candidateBatchIdFor(job),
			revision: 1,
			bindingId: binding.id,
			manifestHash: "",
			rootIdentity: job.rootIdentity,
			files,
			sourceSnapshots: [...job.sourceSnapshotRefs].sort(),
			...(job.schemaHash ? { schemaHash: job.schemaHash } : {}),
			bindingRevision: binding.bindingRevision,
			trustRevision: binding.trustRevision,
			dependencyGroups: [files.map((file) => file.targetPath)],
			validationReceipt,
			compilerVersion: `${job.compilerRef}#${job.compilerPackageSha256}`,
			status: "candidate",
		};
		batch.manifestHash = publicationManifestHash(batch);
		assertPublicationBatchShape(batch);
		if (await realpath(job.privateRoot) !== job.privateRoot) {
			throw new Error("CompileJob private root is not canonical");
		}
		const target = path.join(job.privateRoot, CANDIDATE_BATCH_FILE);
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(batch, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, target);
		return batch.id;
	};
}
