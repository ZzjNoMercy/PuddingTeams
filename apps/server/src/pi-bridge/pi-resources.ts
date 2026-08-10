import path from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { PiResourceConfig } from "../store/teams.js";

export function piResourceLoaderOptions(
	resources: PiResourceConfig | undefined,
	cwd: string,
	agentDir: string,
): {
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noContextFiles?: boolean;
} {
	const r = resources ?? {};
	const globalSkills = r.loadGlobalSkills !== false;
	const workspaceSkills = r.loadWorkspaceSkills !== false;
	const globalPrompts = r.loadGlobalPrompts !== false;
	const workspacePrompts = r.loadWorkspacePrompts !== false;
	const skillPaths = [...(r.skillPaths ?? [])];
	const promptPaths = [...(r.promptTemplatePaths ?? [])];
	if (!(globalSkills && workspaceSkills)) {
		if (globalSkills) skillPaths.unshift(path.join(agentDir, "skills"));
		if (workspaceSkills) skillPaths.unshift(path.join(cwd, ".pi", "skills"));
	}
	if (!(globalPrompts && workspacePrompts)) {
		if (globalPrompts) promptPaths.unshift(path.join(agentDir, "prompts"));
		if (workspacePrompts) promptPaths.unshift(path.join(cwd, ".pi", "prompts"));
	}
	return {
		...(skillPaths.length ? { additionalSkillPaths: skillPaths } : {}),
		...(promptPaths.length ? { additionalPromptTemplatePaths: promptPaths } : {}),
		...(!(globalSkills && workspaceSkills) ? { noSkills: true } : {}),
		...(!(globalPrompts && workspacePrompts) ? { noPromptTemplates: true } : {}),
		...(r.loadWorkspaceContext === false ? { noContextFiles: true } : {}),
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
}) {
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: SettingsManager.create(input.cwd, input.agentDir),
		...piResourceLoaderOptions(input.resources, input.cwd, input.agentDir),
		...(input.extensionFactories ? { extensionFactories: input.extensionFactories } : {}),
		...(input.noExtensions ? { noExtensions: true } : {}),
		systemPromptOverride: (base) => combinePiPrompt(base, input.resources, input.collaboration),
	});
	await loader.reload();
	return loader;
}

export async function previewPiResources(input: {
	cwd: string;
	agentDir: string;
	resources?: PiResourceConfig;
	collaboration?: string;
}) {
	const loader = await loadPiResources(input);
	const skills = loader.getSkills();
	const prompts = loader.getPrompts();
	const context = loader.getAgentsFiles().agentsFiles;
	const effectivePrompt = loader.getSystemPrompt() ?? "";
	return {
		cwd: input.cwd,
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
		skills: skills.skills.map((item) => ({ name: item.name, path: item.filePath })),
		prompts: prompts.prompts.map((item) => ({ name: item.name, path: item.filePath })),
		contextFiles: context.map((item) => item.path),
		diagnostics: [...skills.diagnostics, ...prompts.diagnostics],
	};
}
