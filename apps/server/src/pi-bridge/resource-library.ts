import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
