import type { AgentConfig, AgentResponsibilityProfile, PiManagerSettings, PiResourceConfig, ThinkingLevel } from "@/lib/types";
import { THINKING_LEVELS } from "@/lib/model-catalog";
import { buildConfigBody, type ConfigDraft } from "./draft";

/** 可导入的 Pi Agent 配置；独立密钥存储中的凭证不进入此格式。 */
export interface ConfigTransfer {
	description?: string;
	responsibility?: AgentResponsibilityProfile | null;
	manager?: PiManagerSettings;
	codeSearch?: AgentConfig["codeSearch"];
	connectorConfig?: Record<string, unknown>;
	piResources?: PiResourceConfig | null;
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
	return value as Record<string, unknown>;
}

function allowFields(value: Record<string, unknown>, fields: string[], scope: string): void {
	const unsupported = Object.keys(value).find((field) => !fields.includes(field));
	if (unsupported) throw new Error(`${scope} 不支持字段 ${unsupported}`);
}

function optionalString(value: unknown, field: string): void {
	if (value !== undefined && typeof value !== "string") throw new Error(`${field} 必须是字符串`);
}

function optionalBoolean(value: unknown, field: string): void {
	if (value !== undefined && typeof value !== "boolean") throw new Error(`${field} 必须是布尔值`);
}

function optionalStringList(value: unknown, field: string): void {
	if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string")))
		throw new Error(`${field} 必须是字符串列表`);
}

export function parseConfigTransfer(value: unknown, target: "manager" | "worker"): ConfigTransfer {
	const transfer = record(value, "配置");
	const fields = ["description", "responsibility", "manager", "codeSearch", "connectorConfig", "piResources"];
	allowFields(transfer, fields, "配置");
	if (!fields.some((field) => transfer[field] !== undefined)) throw new Error("文件没有可导入的 Agent 配置字段");
	if (target === "manager" && transfer.connectorConfig !== undefined)
		throw new Error("Pi Worker 的 Connector 配置不能导入 Manager；请使用「从其他 Agent 复制」迁移通用模型设置");
	if (target === "worker" && transfer.manager !== undefined)
		throw new Error("Manager 运行配置不能导入 Pi Worker；请使用「从其他 Agent 复制」迁移通用模型设置");
	if (target === "manager" && transfer.codeSearch !== undefined)
		throw new Error("Pi Worker 的代码搜索策略不能导入 Manager");
	if (transfer.codeSearch !== undefined && (typeof transfer.codeSearch !== "string" || !["inherit", "builtin", "fff"].includes(transfer.codeSearch)))
		throw new Error("codeSearch 无效");
	optionalString(transfer.description, "description");
	if (transfer.responsibility !== undefined && transfer.responsibility !== null) {
		const profile = record(transfer.responsibility, "responsibility");
		allowFields(profile, ["identity", "domain", "owns", "excludes", "escalateWhen"], "responsibility");
		optionalString(profile.identity, "responsibility.identity");
		optionalString(profile.domain, "responsibility.domain");
		optionalStringList(profile.owns, "responsibility.owns");
		optionalStringList(profile.excludes, "responsibility.excludes");
		optionalStringList(profile.escalateWhen, "responsibility.escalateWhen");
		if (typeof profile.domain !== "string" || !profile.domain.trim()) throw new Error("responsibility.domain 不能为空");
	}
	if (transfer.manager !== undefined) {
		const manager = record(transfer.manager, "manager");
		allowFields(manager, ["model", "codeSearch", "builtinTools", "noExtensions", "thinkingLevel"], "manager");
		optionalString(manager.model, "manager.model");
		optionalBoolean(manager.builtinTools, "manager.builtinTools");
		optionalBoolean(manager.noExtensions, "manager.noExtensions");
		if (manager.codeSearch !== undefined && (typeof manager.codeSearch !== "string" || !["off", "builtin", "fff"].includes(manager.codeSearch)))
			throw new Error("manager.codeSearch 无效");
		if (manager.thinkingLevel !== undefined && (typeof manager.thinkingLevel !== "string" || !THINKING_LEVELS.includes(manager.thinkingLevel as ThinkingLevel)))
			throw new Error("manager.thinkingLevel 无效");
	}
	if (transfer.connectorConfig !== undefined) {
		const config = record(transfer.connectorConfig, "connectorConfig");
		allowFields(config, ["model", "thinkingLevel", "sessionDir"], "connectorConfig");
		for (const key of ["model", "sessionDir"]) optionalString(config[key], `connectorConfig.${key}`);
		if (config.thinkingLevel !== undefined && (typeof config.thinkingLevel !== "string" || !THINKING_LEVELS.includes(config.thinkingLevel as ThinkingLevel)))
			throw new Error("connectorConfig.thinkingLevel 无效");
	}
	if (transfer.piResources !== undefined && transfer.piResources !== null) {
		const resources = record(transfer.piResources, "piResources");
		allowFields(resources, ["systemPrompt", "skillPaths", "promptTemplatePaths", "enabledSkills", "enabledPrompts", "loadWorkspaceSkills", "loadWorkspacePrompts", "loadWorkspaceContext"], "piResources");
		optionalString(resources.systemPrompt, "piResources.systemPrompt");
		for (const key of ["skillPaths", "promptTemplatePaths", "enabledSkills", "enabledPrompts"])
			optionalStringList(resources[key], `piResources.${key}`);
		for (const key of ["loadWorkspaceSkills", "loadWorkspacePrompts", "loadWorkspaceContext"])
			optionalBoolean(resources[key], `piResources.${key}`);
	}
	return transfer as ConfigTransfer;
}

/** 将当前待保存草稿导出为与 Agent 身份、凭证无关的配置。 */
export function configTransferFromDraft(agent: AgentConfig, draft: ConfigDraft): ConfigTransfer {
	const body = buildConfigBody(agent, draft);
	return {
		description: body.description,
		responsibility: body.responsibility,
		...(body.manager ? { manager: body.manager as PiManagerSettings } : {}),
		...(body.codeSearch ? { codeSearch: body.codeSearch } : {}),
		...(body.connector ? { connectorConfig: body.connector.config } : {}),
		piResources: body.piResources,
	};
}

/** 导入只更新文件明确提供的分区；同一分区仍按完整替换语义。 */
export function draftWithConfigTransfer(draft: ConfigDraft, transfer: ConfigTransfer): ConfigDraft {
	const next = { ...draft };
	if (typeof transfer.description === "string") next.description = transfer.description;
	if (transfer.responsibility !== undefined) {
		const profile = transfer.responsibility;
		next.identity = profile?.identity ?? "";
		next.domain = profile?.domain ?? "";
		next.owns = (profile?.owns ?? []).join("\n");
		next.excludes = (profile?.excludes ?? []).join("\n");
		next.escalateWhen = (profile?.escalateWhen ?? []).join("\n");
	}
	if (transfer.manager) next.manager = { ...transfer.manager };
	if (transfer.codeSearch) next.codeSearch = transfer.codeSearch;
	if (transfer.connectorConfig) next.connectorConfig = { ...transfer.connectorConfig };
	if (transfer.piResources !== undefined) {
		const resources = transfer.piResources ?? {};
		next.systemPrompt = resources.systemPrompt ?? "";
		next.skillPaths = (resources.skillPaths ?? []).join("\n");
		next.promptTemplatePaths = (resources.promptTemplatePaths ?? []).join("\n");
		next.enabledSkills = [...(resources.enabledSkills ?? [])];
		next.enabledPrompts = [...(resources.enabledPrompts ?? [])];
		next.loadWorkspaceSkills = resources.loadWorkspaceSkills !== false;
		next.loadWorkspacePrompts = resources.loadWorkspacePrompts !== false;
		next.loadWorkspaceContext = resources.loadWorkspaceContext !== false;
	}
	return next;
}
