import { realpathSync } from "node:fs";
import path from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
	type InlineExtension,
	type PromptTemplate,
	type ResourceDiagnostic,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { PiResourceConfig } from "../store/teams.js";
import type { WorkspaceResourceAccess, WorkspaceTrust } from "../store/workspaces.js";

type SkillsPayload = { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
type PromptsPayload = { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };

/**
 * filePath 是否位于 dir 下。SDK 扫描会 realpath 解析路径（macOS 上
 * /tmp → /private/tmp），所以两端都同时尝试 resolve 与 realpath，
 * 并补上尾部分隔符防止前缀误匹配（/a/b 误中 /a/bc）。
 */
function isUnderDir(filePath: string, dir: string): boolean {
	const targets = new Set<string>([path.resolve(filePath)]);
	try {
		targets.add(realpathSync(filePath));
	} catch {
		// 文件已消失时只用 resolve 结果。
	}
	const roots = new Set<string>([path.resolve(dir)]);
	try {
		roots.add(realpathSync(dir));
	} catch {
		// 目录不存在时只用 resolve 结果。
	}
	for (const target of targets) {
		for (const root of roots) {
			const prefix = root.endsWith(path.sep) ? root : root + path.sep;
			if (target === root || target.startsWith(prefix)) return true;
		}
	}
	return false;
}

/**
 * 装配 DefaultResourceLoader 的 piResources 选项。全局 skills/prompts 目录
 * 由 pi 默认加载；白名单（enabledSkills/enabledPrompts，缺省 = 不启用任何
 * 库资源）通过 skillsOverride/promptsOverride 过滤「库资源」——filePath 位于
 * 全局目录下且 name 不在名单内的条目被剔除；workspace（.pi/）与 skillPaths
 * 额外挂载的资源不受白名单管，仍由 loadWorkspace* 开关控制。diagnostics
 * 原样透传。
 *
 * workspaceAccess（信任门 §7.2）：服务端按 workspaceId + trust 计算的三类
 * 放行结果；传入后与 Agent 自己的 loadWorkspace* 开关取与（两个都开才加载）。
 * 不传 = 无服务端判定（probe 等非窗口上下文），维持只看 Agent 开关的旧语义。
 */
export function piResourceLoaderOptions(
	resources: PiResourceConfig | undefined,
	cwd: string,
	agentDir: string,
	workspaceAccess?: WorkspaceResourceAccess,
): {
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noContextFiles?: boolean;
	skillsOverride?: (base: SkillsPayload) => SkillsPayload;
	promptsOverride?: (base: PromptsPayload) => PromptsPayload;
} {
	const r = resources ?? {};
	const workspaceContext = r.loadWorkspaceContext !== false && (workspaceAccess?.context ?? true);
	const workspaceSkills = r.loadWorkspaceSkills !== false && (workspaceAccess?.skills ?? true);
	const workspacePrompts = r.loadWorkspacePrompts !== false && (workspaceAccess?.prompts ?? true);
	const skillPaths = [...(r.skillPaths ?? [])];
	const promptPaths = [...(r.promptTemplatePaths ?? [])];
	// 关闭 workspace 来源时，全局目录改为显式挂载（filePath 不变，白名单照常生效）。
	if (!workspaceSkills) skillPaths.unshift(path.join(agentDir, "skills"));
	if (!workspacePrompts) promptPaths.unshift(path.join(agentDir, "prompts"));
	const globalSkillsDir = path.join(agentDir, "skills");
	const globalPromptsDir = path.join(agentDir, "prompts");
	const enabledSkills = new Set(r.enabledSkills ?? []);
	const enabledPrompts = new Set(r.enabledPrompts ?? []);
	return {
		...(skillPaths.length ? { additionalSkillPaths: skillPaths } : {}),
		...(promptPaths.length ? { additionalPromptTemplatePaths: promptPaths } : {}),
		...(!workspaceSkills ? { noSkills: true } : {}),
		...(!workspacePrompts ? { noPromptTemplates: true } : {}),
		...(!workspaceContext ? { noContextFiles: true } : {}),
		skillsOverride: (base) => ({
			skills: base.skills.filter((s) => !isUnderDir(s.filePath, globalSkillsDir) || enabledSkills.has(s.name)),
			diagnostics: base.diagnostics,
		}),
		promptsOverride: (base) => ({
			prompts: base.prompts.filter((p) => !isUnderDir(p.filePath, globalPromptsDir) || enabledPrompts.has(p.name)),
			diagnostics: base.diagnostics,
		}),
	};
}

export function combinePiPrompt(
	base: string | undefined,
	resources: PiResourceConfig | undefined,
	collaboration?: string,
): string | undefined {
	const parts = [base?.trim(), resources?.systemPrompt?.trim(), collaboration?.trim()].filter(Boolean);
	return parts.length ? parts.join("\n\n") : undefined;
}

export async function loadPiResources(input: {
	cwd: string;
	agentDir: string;
	resources?: PiResourceConfig;
	collaboration?: string;
	extensionFactories?: InlineExtension[];
	noExtensions?: boolean;
	/** 信任门判定结果（§7.2）；传入后与 Agent 开关取与。 */
	workspaceAccess?: WorkspaceResourceAccess;
	/** false 时跳过白名单过滤（preview 需要列出全部资源并标注启用状态）。 */
	applyWhitelist?: boolean;
}) {
	const options = piResourceLoaderOptions(input.resources, input.cwd, input.agentDir, input.workspaceAccess);
	if (input.applyWhitelist === false) {
		delete options.skillsOverride;
		delete options.promptsOverride;
	}
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: SettingsManager.create(input.cwd, input.agentDir),
		...options,
		...(input.extensionFactories ? { extensionFactories: input.extensionFactories } : {}),
		...(input.noExtensions ? { noExtensions: true } : {}),
		systemPromptOverride: (base) => combinePiPrompt(base, input.resources, input.collaboration),
	});
	await loader.reload();
	return loader;
}

export type PiResourceSource = "global" | "workspace" | "extra";

export async function previewPiResources(input: {
	cwd: string;
	agentDir: string;
	resources?: PiResourceConfig;
	collaboration?: string;
	/** 信任门判定结果（§7.2）；denied 的来源不进入预览候选集。 */
	workspaceAccess?: WorkspaceResourceAccess;
	/** 显式 workspace 标识（含信任状态）；无 workspaceId 的窗口为 null（§6.3）。 */
	workspace?: { id: string; trust: WorkspaceTrust } | null;
}) {
	// 不过滤地扫全部资源，再按白名单标注 enabled，供配置页渲染选用开关。
	const loader = await loadPiResources({ ...input, applyWhitelist: false });
	const skills = loader.getSkills();
	const prompts = loader.getPrompts();
	const context = loader.getAgentsFiles().agentsFiles;
	const effectivePrompt = loader.getSystemPrompt() ?? "";
	const globalSkillsDir = path.join(input.agentDir, "skills");
	const globalPromptsDir = path.join(input.agentDir, "prompts");
	const workspaceSkillsDir = path.join(input.cwd, ".pi", "skills");
	const workspacePromptsDir = path.join(input.cwd, ".pi", "prompts");
	const enabledSkills = new Set(input.resources?.enabledSkills ?? []);
	const enabledPrompts = new Set(input.resources?.enabledPrompts ?? []);
	const sourceOf = (filePath: string, globalDir: string, workspaceDir: string): PiResourceSource =>
		isUnderDir(filePath, globalDir) ? "global" : isUnderDir(filePath, workspaceDir) ? "workspace" : "extra";
	// 信任门拒绝的来源不进候选集（global/extra 不受影响）。
	const skillAllowed = (source: PiResourceSource): boolean => source !== "workspace" || (input.workspaceAccess?.skills ?? true);
	const promptAllowed = (source: PiResourceSource): boolean => source !== "workspace" || (input.workspaceAccess?.prompts ?? true);
	return {
		cwd: input.cwd,
		workspace: input.workspace ?? null,
		segments: [
			{ source: "pi-base", content: "（Pi SDK 内置基础提示词在请求装配时注入）", collapsed: true },
			...(input.resources?.systemPrompt?.trim()
				? [{ source: "agent-profile", content: input.resources.systemPrompt.trim(), collapsed: false }]
				: []),
			...(input.collaboration?.trim()
				? [{ source: "window-collaboration", content: input.collaboration.trim(), collapsed: false }]
				: []),
			...context.map((item) => ({ source: "workspace-context", path: item.path, content: item.content, collapsed: true })),
		],
		effectivePrompt,
		estimatedCharacters: effectivePrompt.length + context.reduce((sum, item) => sum + item.content.length, 0),
		skills: skills.skills
			.map((item) => {
				const source = sourceOf(item.filePath, globalSkillsDir, workspaceSkillsDir);
				return {
					name: item.name,
					description: item.description,
					path: item.filePath,
					source,
					enabled: source !== "global" || enabledSkills.has(item.name),
				};
			})
			.filter((item) => skillAllowed(item.source)),
		prompts: prompts.prompts
			.map((item) => {
				const source = sourceOf(item.filePath, globalPromptsDir, workspacePromptsDir);
				return {
					name: item.name,
					description: item.description,
					...(item.argumentHint ? { argumentHint: item.argumentHint } : {}),
					path: item.filePath,
					source,
					enabled: source !== "global" || enabledPrompts.has(item.name),
				};
			})
			.filter((item) => promptAllowed(item.source)),
		contextFiles: context.map((item) => item.path),
		diagnostics: [...skills.diagnostics, ...prompts.diagnostics],
	};
}
