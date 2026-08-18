import type { AgentConfig, AgentResponsibilityProfile, PiManagerSettings, PiResourceConfig } from "@/lib/types";

/**
 * 独立配置页的页面级草稿：概览 / 模型与运行 / 提示词 / 模板四个分区；
 * Skills 的资源库与作用域由扩展页管理，草稿仍保留资源字段以便保存时不丢失既有配置。
 * 编辑同一份草稿，页面级一个「保存」调 PUT /api/agents/:name/config 一次提交。
 * 文本类字段保持字符串（owns 等每行一项、skillPaths 每行一个路径），保存时才解析。
 */
export interface ConfigDraft {
	/** 显示名（可改）；空串 = 清除，展示回退内部 id（agent.name）。 */
	displayName: string;
	description: string;
	identity: string;
	domain: string;
	owns: string;
	excludes: string;
	escalateWhen: string;
	/** pinned manager 的 SDK 配置（worker 不用）。 */
	manager: PiManagerSettings;
	/** pi worker 的 connector config（pinned 不用）。 */
	connectorConfig: Record<string, unknown>;
	systemPrompt: string;
	/** 每行一个额外挂载路径。 */
	skillPaths: string;
	promptTemplatePaths: string;
	enabledSkills: string[];
	enabledPrompts: string[];
	loadWorkspaceSkills: boolean;
	loadWorkspacePrompts: boolean;
	loadWorkspaceContext: boolean;
}

export function splitList(value: string): string[] {
	return [...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))];
}

function splitPaths(value: string): string[] {
	return [...new Set(value.split(/\n/).map((item) => item.trim()).filter(Boolean))];
}

export function draftFromAgent(agent: AgentConfig): ConfigDraft {
	const resources = agent.piResources ?? {};
	return {
		displayName: agent.displayName ?? "",
		description: agent.description ?? "",
		identity: agent.responsibility?.identity ?? "",
		domain: agent.responsibility?.domain ?? "",
		owns: (agent.responsibility?.owns ?? []).join("\n"),
		excludes: (agent.responsibility?.excludes ?? []).join("\n"),
		escalateWhen: (agent.responsibility?.escalateWhen ?? []).join("\n"),
		manager: { ...(agent.manager ?? {}) },
		connectorConfig: { ...(agent.connector?.config ?? {}) },
		systemPrompt: resources.systemPrompt ?? "",
		skillPaths: (resources.skillPaths ?? []).join("\n"),
		promptTemplatePaths: (resources.promptTemplatePaths ?? []).join("\n"),
		enabledSkills: [...(resources.enabledSkills ?? [])],
		enabledPrompts: [...(resources.enabledPrompts ?? [])],
		loadWorkspaceSkills: resources.loadWorkspaceSkills !== false,
		loadWorkspacePrompts: resources.loadWorkspacePrompts !== false,
		loadWorkspaceContext: resources.loadWorkspaceContext !== false,
	};
}

/** 草稿序列化：与初始草稿对比得出 dirty。 */
export function serializeDraft(draft: ConfigDraft): string {
	return JSON.stringify(draft);
}

/** 责任边界：全空 = null（清除）；填了任一字段则 domain 必填。 */
export function buildResponsibility(draft: ConfigDraft): AgentResponsibilityProfile | null {
	const has = Boolean(
		draft.identity.trim() || draft.domain.trim() || draft.owns.trim() || draft.excludes.trim() || draft.escalateWhen.trim(),
	);
	if (!has) return null;
	if (!draft.domain.trim()) throw new Error("填写责任边界时，责任领域不能为空");
	return {
		...(draft.identity.trim() ? { identity: draft.identity.trim() } : {}),
		domain: draft.domain.trim(),
		owns: splitList(draft.owns),
		excludes: splitList(draft.excludes),
		...(draft.escalateWhen.trim() ? { escalateWhen: splitList(draft.escalateWhen) } : {}),
	};
}

/** PiResourceConfig 整体替换语义：空数组/空串不提交（等价清除）。 */
export function buildPiResources(draft: ConfigDraft): PiResourceConfig {
	const skillPaths = splitPaths(draft.skillPaths);
	const promptTemplatePaths = splitPaths(draft.promptTemplatePaths);
	return {
		...(draft.systemPrompt.trim() ? { systemPrompt: draft.systemPrompt.trim() } : {}),
		...(skillPaths.length ? { skillPaths } : {}),
		...(promptTemplatePaths.length ? { promptTemplatePaths } : {}),
		...(draft.enabledSkills.length ? { enabledSkills: [...draft.enabledSkills].sort() } : {}),
		...(draft.enabledPrompts.length ? { enabledPrompts: [...draft.enabledPrompts].sort() } : {}),
		loadWorkspaceSkills: draft.loadWorkspaceSkills,
		loadWorkspacePrompts: draft.loadWorkspacePrompts,
		loadWorkspaceContext: draft.loadWorkspaceContext,
	};
}

/**
 * 统一保存的请求体：pinned manager 走 manager 键级合并（空 model / 默认
 * thinkingLevel 不提交，与 manager-dialog 语义一致）；pi worker 走
 * connector.config 整体替换。
 */
export function buildConfigBody(
	agent: AgentConfig,
	draft: ConfigDraft,
): {
	displayName: string | null;
	description: string;
	responsibility: AgentResponsibilityProfile | null;
	manager?: Partial<PiManagerSettings>;
	connector?: { config: Record<string, unknown> };
	piResources: PiResourceConfig;
} {
	const base = {
		// 空串 → null：服务端清除显示名，展示回退内部 id。
		displayName: draft.displayName.trim() || null,
		description: draft.description.trim(),
		responsibility: buildResponsibility(draft),
		piResources: buildPiResources(draft),
	};
	if (agent.pinned) {
		const manager: Partial<PiManagerSettings> = {
			builtinTools: draft.manager.builtinTools ?? true,
			noExtensions: draft.manager.noExtensions ?? false,
		};
		if (draft.manager.model?.trim()) manager.model = draft.manager.model.trim();
		if (draft.manager.thinkingLevel) manager.thinkingLevel = draft.manager.thinkingLevel;
		return { ...base, manager };
	}
	return { ...base, connector: { config: draft.connectorConfig } };
}

/** 本配置页只承载 pinned manager 与 pi Connector worker。 */
export function isPiAgent(agent: AgentConfig): boolean {
	return agent.pinned === true || agent.connector?.connectorId === "pi";
}
