import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import {
	DefaultResourceLoader,
	getAgentDir,
	loadSkillsFromDir,
	type ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";

/**
 * pi 资源库（§10.5）：库根 = pi 全局目录（getAgentDir()）下的 skills/ 与
 * prompts/，与 pi CLI 共享同一份资源。技能落盘为 skills/<name>/SKILL.md，
 * 模板落盘为 prompts/<name>.md。list 用 SDK loader 复扫以拿到校验
 * diagnostics；单条读写的 frontmatter 用本文件的简版解析（仅平铺标量）。
 */

export const RESOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESOURCE_CONTENT_MAX_BYTES = 256 * 1024;

/** 带 HTTP 状态码的库错误，路由层直接映射（400 校验 / 404 不存在 / 409 重名）。 */
export class ResourceLibraryError extends Error {
	constructor(
		readonly status: 400 | 404 | 409,
		message: string,
	) {
		super(message);
	}
}

export interface SkillEntry {
	name: string;
	description: string;
	disableModelInvocation: boolean;
	path: string;
}

export interface SkillDocument extends SkillEntry {
	/** SKILL.md 正文（frontmatter 之外的部分）。 */
	content: string;
}

export interface TemplateEntry {
	name: string;
	description: string;
	argumentHint?: string;
	path: string;
}

export interface TemplateDocument extends TemplateEntry {
	content: string;
}

export interface SkillInput {
	description?: string;
	disableModelInvocation?: boolean;
	content: string;
}

export interface TemplateInput {
	description?: string;
	argumentHint?: string;
	content: string;
}

function skillsDir(baseDir: string): string {
	return path.join(baseDir, "skills");
}

function promptsDir(baseDir: string): string {
	return path.join(baseDir, "prompts");
}

function assertValidName(name: string): void {
	if (!RESOURCE_NAME_PATTERN.test(name)) {
		throw new ResourceLibraryError(400, `无效名称「${name}」：须匹配 ${RESOURCE_NAME_PATTERN.source}`);
	}
}

function assertContentSize(content: string): void {
	if (Buffer.byteLength(content, "utf-8") > RESOURCE_CONTENT_MAX_BYTES) {
		throw new ResourceLibraryError(400, `内容超过 ${RESOURCE_CONTENT_MAX_BYTES / 1024}KB 上限`);
	}
}

async function exists(target: string): Promise<boolean> {
	return stat(target).then(
		() => true,
		() => false,
	);
}

/** filePath 是否位于 dir 下（考虑 realpath 与尾部分隔符）。 */
function isUnderDir(filePath: string, dir: string): boolean {
	const root = path.resolve(dir);
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	const target = path.resolve(filePath);
	return target === root || target.startsWith(prefix);
}

// ---- frontmatter（平铺标量的简版解析/拼装；SDK 侧用完整 YAML 校验） ----

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { fields: {}, body: normalized.trim() };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { fields: {}, body: normalized.trim() };
	const fields: Record<string, string> = {};
	for (const line of normalized.slice(3, end).split("\n")) {
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) continue;
		let value = m[2]!.trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				// 保留原样。
			}
		}
		fields[m[1]!] = value;
	}
	return { fields, body: normalized.slice(end + 4).trim() };
}

/** 纯文本可直接平铺；含特殊字符时退到 YAML 双引号标量（JSON 转义是其子集）。 */
function yamlScalar(value: string): string {
	return /^[A-Za-z0-9][A-Za-z0-9 _.,/-]*$/.test(value) ? value : JSON.stringify(value);
}

function serializeSkill(name: string, input: SkillInput): string {
	const lines = ["---", `name: ${yamlScalar(name)}`];
	if (input.description?.trim()) lines.push(`description: ${yamlScalar(input.description.trim())}`);
	if (input.disableModelInvocation) lines.push("disable-model-invocation: true");
	lines.push("---", "", input.content.trim());
	return lines.join("\n") + "\n";
}

function serializeTemplate(input: TemplateInput): string {
	const lines = ["---"];
	if (input.description?.trim()) lines.push(`description: ${yamlScalar(input.description.trim())}`);
	if (input.argumentHint?.trim()) lines.push(`argument-hint: ${yamlScalar(input.argumentHint.trim())}`);
	lines.push("---", "", input.content.trim());
	return lines.join("\n") + "\n";
}

// ---- skills ----

export async function listSkills(
	baseDir: string = getAgentDir(),
): Promise<{ skills: SkillEntry[]; diagnostics: ResourceDiagnostic[] }> {
	const dir = skillsDir(baseDir);
	await mkdir(dir, { recursive: true });
	const result = loadSkillsFromDir({ dir, source: "library" });
	return {
		skills: result.skills
			.map((s) => ({
				name: s.name,
				description: s.description,
				disableModelInvocation: s.disableModelInvocation,
				path: s.filePath,
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics: result.diagnostics,
	};
}

/** 定位技能目录：优先 skills/<name>/，其次 list 里 frontmatter name 匹配的条目。 */
async function resolveSkillDir(
	name: string,
	baseDir: string,
): Promise<{ dir: string; file: string } | undefined> {
	const direct = path.join(skillsDir(baseDir), name);
	if (await exists(path.join(direct, "SKILL.md"))) return { dir: direct, file: path.join(direct, "SKILL.md") };
	const { skills } = await listSkills(baseDir);
	const entry = skills.find((s) => s.name === name);
	return entry ? { dir: path.dirname(entry.path), file: entry.path } : undefined;
}

export async function readSkill(name: string, baseDir: string = getAgentDir()): Promise<SkillDocument> {
	assertValidName(name);
	const found = await resolveSkillDir(name, baseDir);
	if (!found) throw new ResourceLibraryError(404, `skill not found: ${name}`);
	const { fields, body } = parseFrontmatter(await readFile(found.file, "utf-8"));
	return {
		name,
		description: fields.description ?? "",
		disableModelInvocation: fields["disable-model-invocation"] === "true",
		path: found.file,
		content: body,
	};
}

export async function createSkill(
	name: string,
	input: SkillInput,
	baseDir: string = getAgentDir(),
): Promise<SkillDocument> {
	assertValidName(name);
	assertContentSize(input.content);
	const dir = path.join(skillsDir(baseDir), name);
	if (await exists(dir)) throw new ResourceLibraryError(409, `skill 已存在：${name}`);
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "SKILL.md");
	await writeFile(file, serializeSkill(name, input), "utf-8");
	return {
		name,
		description: input.description?.trim() ?? "",
		disableModelInvocation: input.disableModelInvocation === true,
		path: file,
		content: input.content.trim(),
	};
}

export async function updateSkill(
	name: string,
	input: SkillInput,
	baseDir: string = getAgentDir(),
): Promise<SkillDocument> {
	assertValidName(name);
	assertContentSize(input.content);
	const found = await resolveSkillDir(name, baseDir);
	if (!found) throw new ResourceLibraryError(404, `skill not found: ${name}`);
	await writeFile(found.file, serializeSkill(name, input), "utf-8");
	return {
		name,
		description: input.description?.trim() ?? "",
		disableModelInvocation: input.disableModelInvocation === true,
		path: found.file,
		content: input.content.trim(),
	};
}

export async function deleteSkill(name: string, baseDir: string = getAgentDir()): Promise<void> {
	assertValidName(name);
	const direct = path.join(skillsDir(baseDir), name);
	if (await exists(direct)) {
		await rm(direct, { recursive: true, force: true });
		return;
	}
	const found = await resolveSkillDir(name, baseDir);
	if (!found) throw new ResourceLibraryError(404, `skill not found: ${name}`);
	await rm(found.dir, { recursive: true, force: true });
}

/**
 * 导入技能：目录须含 SKILL.md（否则 400）；单 .md 文件作为 SKILL.md 导入。
 * 名称取目录名/文件名，重名 409。
 */
export async function importSkill(sourcePath: string, baseDir: string = getAgentDir()): Promise<SkillDocument> {
	const source = path.resolve(sourcePath.trim());
	const info = await stat(source).catch(() => {
		throw new ResourceLibraryError(400, `导入路径不存在：${sourcePath}`);
	});
	let name: string;
	if (info.isDirectory()) {
		if (!(await exists(path.join(source, "SKILL.md")))) {
			throw new ResourceLibraryError(400, `导入目录缺少 SKILL.md：${source}`);
		}
		name = path.basename(source);
	} else if (info.isFile() && source.endsWith(".md")) {
		name = path.basename(source, ".md");
	} else {
		throw new ResourceLibraryError(400, `导入路径须为含 SKILL.md 的目录或 .md 文件：${source}`);
	}
	assertValidName(name);
	const dir = path.join(skillsDir(baseDir), name);
	if (await exists(dir)) throw new ResourceLibraryError(409, `skill 已存在：${name}`);
	await mkdir(dir, { recursive: true });
	if (info.isDirectory()) await cp(source, dir, { recursive: true });
	else await cp(source, path.join(dir, "SKILL.md"));
	return readSkill(name, baseDir);
}

// ---- zip 批量导入 ----

export interface ZipImportSkipped {
	name: string;
	reason: string;
}

export interface ZipImportResult {
	imported: SkillEntry[];
	skipped: ZipImportSkipped[];
	diagnostics: ResourceDiagnostic[];
}

/** zip 里技能根（SKILL.md 所在目录）允许的最大深度（相对 zip 根的目录段数）。 */
const ZIP_SKILL_ROOT_MAX_DEPTH = 3;

/**
 * 从 zip 批量导入技能：以 SKILL.md 所在目录为技能根整组拷贝（保留根内相对
 * 路径，helper 脚本一并落盘）；技能名取 SKILL.md frontmatter name，缺省用根
 * 目录名。重名记 skipped 继续；空 zip / 无技能 400；含 `..` 或绝对路径的
 * zip-slip 条目整包拒绝。
 */
export async function importSkillsFromZip(zipBuffer: Uint8Array, baseDir: string = getAgentDir()): Promise<ZipImportResult> {
	let archive: Record<string, Uint8Array>;
	try {
		archive = unzipSync(zipBuffer);
	} catch {
		throw new ResourceLibraryError(400, "无效的 zip 文件");
	}

	// 规范化条目：统一分隔符、去 ./ 前缀；忽略目录项、__MACOSX/ 与 . 开头文件；
	// zip-slip（绝对路径 / .. 段）整包拒绝。
	const files = new Map<string, Uint8Array>();
	for (const [rawName, data] of Object.entries(archive)) {
		let name = rawName.replace(/\\/g, "/");
		while (name.startsWith("./")) name = name.slice(2);
		if (!name || name.endsWith("/")) continue; // 目录项
		const segments = name.split("/");
		if (name.startsWith("/") || /^[A-Za-z]:\//.test(name) || segments.includes("..")) {
			throw new ResourceLibraryError(400, `zip 含非法路径条目：${rawName}`);
		}
		const base = segments[segments.length - 1]!;
		if (segments[0] === "__MACOSX" || base.startsWith(".")) continue;
		files.set(name, data);
	}
	if (files.size === 0) throw new ResourceLibraryError(400, "zip 中没有可导入的技能");

	const libDir = skillsDir(baseDir);
	await mkdir(libDir, { recursive: true });
	const libRoot = await realpath(libDir);

	const imported: SkillEntry[] = [];
	const skipped: ZipImportSkipped[] = [];
	const taken = new Set<string>();

	/** 拷贝一个技能根到 skills/<name>/；entries 为 [根内相对路径, 内容]。 */
	const copySkill = async (name: string, entries: [string, Uint8Array][]): Promise<void> => {
		if (!RESOURCE_NAME_PATTERN.test(name)) {
			skipped.push({ name, reason: `无效名称：须匹配 ${RESOURCE_NAME_PATTERN.source}` });
			return;
		}
		if (taken.has(name) || (await exists(path.join(libDir, name)))) {
			skipped.push({ name, reason: "skill 已存在" });
			return;
		}
		// libRoot 已 realpath（macOS /var→/private/var），目标路径基于它构造，
		// 保证 isUnderDir 的 realpath 比较一致。
		const target = path.resolve(libRoot, name);
		if (!isUnderDir(target, libRoot)) {
			skipped.push({ name, reason: "目标路径越出技能库" });
			return;
		}
		for (const [rel, data] of entries) {
			const dest = path.resolve(target, rel);
			if (!isUnderDir(dest, libRoot)) {
				throw new ResourceLibraryError(400, `zip 条目目标越出技能库：${rel}`);
			}
			await mkdir(path.dirname(dest), { recursive: true });
			await writeFile(dest, data);
		}
		taken.add(name);
	};

	// 找技能根：SKILL.md 条目，根深度 ≤ ZIP_SKILL_ROOT_MAX_DEPTH；被更浅技能根
	// 覆盖的嵌套 SKILL.md 不单独成技能（属于根内文件，整组拷贝时自然带上）。
	const candidates: string[] = [];
	for (const name of files.keys()) {
		if (path.posix.basename(name) !== "SKILL.md") continue;
		const root = path.posix.dirname(name);
		if (root !== "." && root.split("/").length > ZIP_SKILL_ROOT_MAX_DEPTH) continue;
		candidates.push(root === "." ? "" : root);
	}
	const skillRoots = candidates.filter(
		(root) => !candidates.some((other) => root !== other && root.startsWith(other ? `${other}/` : "")),
	);

	if (skillRoots.length === 0) {
		// 无 SKILL.md 结构：zip 根下有单个 .md → 按单文件技能导入。
		const mdFiles = [...files.keys()].filter((n) => !n.includes("/") && n.endsWith(".md"));
		if (mdFiles.length !== 1) {
			throw new ResourceLibraryError(400, "zip 中没有可导入的技能（未找到 SKILL.md）");
		}
		const zipName = mdFiles[0]!;
		await copySkill(path.posix.basename(zipName, ".md"), [["SKILL.md", files.get(zipName)!]]);
	} else {
		for (const root of skillRoots.sort()) {
			const prefix = root ? `${root}/` : "";
			const skillMd = files.get(`${prefix}SKILL.md`)!;
			const { fields } = parseFrontmatter(Buffer.from(skillMd).toString("utf-8"));
			const name = fields.name?.trim() || (root ? path.posix.basename(root) : "");
			if (!name) {
				skipped.push({ name: root || "(zip 根)", reason: "缺少技能名（frontmatter name 与目录名均不可用）" });
				continue;
			}
			const entries = [...files.entries()]
				.filter(([n]) => n.startsWith(prefix))
				.map(([n, d]): [string, Uint8Array] => [n.slice(prefix.length), d]);
			await copySkill(name, entries);
		}
	}

	const { skills, diagnostics } = await listSkills(baseDir);
	for (const name of taken) {
		const entry = skills.find((s) => s.name === name);
		if (entry) imported.push(entry);
		else imported.push({ name, description: "", disableModelInvocation: false, path: path.join(libDir, name, "SKILL.md") });
	}
	if (imported.length === 0 && skipped.length === 0) {
		throw new ResourceLibraryError(400, "zip 中没有可导入的技能");
	}
	return { imported, skipped, diagnostics };
}

// ---- templates ----

export async function listTemplates(
	baseDir: string = getAgentDir(),
): Promise<{ templates: TemplateEntry[]; diagnostics: ResourceDiagnostic[] }> {
	const dir = promptsDir(baseDir);
	await mkdir(dir, { recursive: true });
	// 用 SDK loader 复扫全局 prompts 目录拿校验 diagnostics；cwd 指向库内一个
	// 不存在的目录，避免把 project prompts 混进库清单。
	const loader = new DefaultResourceLoader({
		cwd: path.join(baseDir, ".resource-library-scan"),
		agentDir: baseDir,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noThemes: true,
	});
	await loader.reload();
	const { prompts, diagnostics } = loader.getPrompts();
	return {
		templates: prompts
			.filter((p) => isUnderDir(p.filePath, dir))
			.map((p) => ({
				name: p.name,
				description: p.description,
				...(p.argumentHint ? { argumentHint: p.argumentHint } : {}),
				path: p.filePath,
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
		diagnostics,
	};
}

export async function readTemplate(name: string, baseDir: string = getAgentDir()): Promise<TemplateDocument> {
	assertValidName(name);
	const file = path.join(promptsDir(baseDir), `${name}.md`);
	if (!(await exists(file))) throw new ResourceLibraryError(404, `template not found: ${name}`);
	const { fields, body } = parseFrontmatter(await readFile(file, "utf-8"));
	return {
		name,
		description: fields.description ?? "",
		...(fields["argument-hint"] ? { argumentHint: fields["argument-hint"] } : {}),
		path: file,
		content: body,
	};
}

export async function createTemplate(
	name: string,
	input: TemplateInput,
	baseDir: string = getAgentDir(),
): Promise<TemplateDocument> {
	assertValidName(name);
	assertContentSize(input.content);
	const file = path.join(promptsDir(baseDir), `${name}.md`);
	if (await exists(file)) throw new ResourceLibraryError(409, `template 已存在：${name}`);
	await mkdir(promptsDir(baseDir), { recursive: true });
	await writeFile(file, serializeTemplate(input), "utf-8");
	return readTemplate(name, baseDir);
}

export async function updateTemplate(
	name: string,
	input: TemplateInput,
	baseDir: string = getAgentDir(),
): Promise<TemplateDocument> {
	assertValidName(name);
	assertContentSize(input.content);
	const file = path.join(promptsDir(baseDir), `${name}.md`);
	if (!(await exists(file))) throw new ResourceLibraryError(404, `template not found: ${name}`);
	await writeFile(file, serializeTemplate(input), "utf-8");
	return readTemplate(name, baseDir);
}

export async function deleteTemplate(name: string, baseDir: string = getAgentDir()): Promise<void> {
	assertValidName(name);
	const file = path.join(promptsDir(baseDir), `${name}.md`);
	if (!(await exists(file))) throw new ResourceLibraryError(404, `template not found: ${name}`);
	await rm(file);
}

/** 导入模板：仅支持单 .md 文件，名称取文件名，重名 409。 */
export async function importTemplate(sourcePath: string, baseDir: string = getAgentDir()): Promise<TemplateDocument> {
	const source = path.resolve(sourcePath.trim());
	const info = await stat(source).catch(() => {
		throw new ResourceLibraryError(400, `导入路径不存在：${sourcePath}`);
	});
	if (!info.isFile() || !source.endsWith(".md")) {
		throw new ResourceLibraryError(400, `模板导入须为 .md 文件：${source}`);
	}
	const name = path.basename(source, ".md");
	assertValidName(name);
	const file = path.join(promptsDir(baseDir), `${name}.md`);
	if (await exists(file)) throw new ResourceLibraryError(409, `template 已存在：${name}`);
	await mkdir(promptsDir(baseDir), { recursive: true });
	await cp(source, file);
	return readTemplate(name, baseDir);
}
