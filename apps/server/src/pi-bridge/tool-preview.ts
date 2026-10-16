import type { AgentConfig, TeamsStore } from "../store/teams.js";
import { eligibleWorkers } from "../store/teams.js";
import { extensionToolName, type ExtensionCatalog } from "../agent-runtime/extensions.js";
import type { McpServerStore } from "../store/mcp-servers.js";
import type { MemorySetupService } from "../knowledge/memory-setup.js";
import { webResearchTarget, type WebResearchSettings } from "../network/web-research.js";
import { localViewerIdentity } from "../routes/identity.js";
import { CALENDAR_TOOL_NAMES } from "../calendar/tools.js";
import {
	CORE_TOOL_DELEGATION,
	CORE_TOOL_READ_DELEGATION_RESULT,
	CORE_TOOL_SEARCH,
	CORE_TOOL_CREATE_GROUP,
	CORE_TOOL_INVITE,
	GOAL_ACTIVE_TOOLS,
} from "./agent-extensions.js";

/**
 * Agent 配置页「工具」分区的只读预览（静态装配事实 + 少量 live 状态）。
 * 不创建会话、不写 knowledge context 文件；工具名全部来自既有装配代码的
 * 静态清单，live 状态只读 memorySetup / webResearch / mcpServers。
 */

export type ToolPreviewExposure = "direct" | "deferred" | "model-only";

export interface ToolPreviewItem {
	name: string;
	exposure: ToolPreviewExposure;
	condition?: string;
}

export type ToolPreviewGroupId = "native" | "orchestration" | "knowledge" | "calendar" | "web" | "mcp" | "capability";

export interface ToolPreviewGroup {
	id: ToolPreviewGroupId;
	tools: ToolPreviewItem[];
	note?: string;
}

export interface AgentToolPreview {
	role: "manager" | "worker" | "wiki";
	groups: ToolPreviewGroup[];
}

export interface ToolPreviewDeps {
	teams: TeamsStore;
	memorySetup?: Pick<MemorySetupService, "status">;
	webResearch?: Pick<WebResearchSettings, "accessFingerprint">;
	mcpServers?: Pick<McpServerStore, "list">;
	catalog?: Pick<ExtensionCatalog, "get">;
}

/** 只读知识检索面（runtime-service.ts mount() 的静态工具名）。 */
const KNOWLEDGE_READ_TOOLS = ["knowledge_context", "knowledge_search", "knowledge_glob", "knowledge_read", "knowledge_links"] as const;

function direct(name: string, condition?: string): ToolPreviewItem {
	return { name, exposure: "direct", ...(condition ? { condition } : {}) };
}

/** pi 原生工具组：read/ls/bash/edit/write 恒列；grep/find 随 codeSearch 策略标注。 */
function nativeGroup(agent: AgentConfig, role: "manager" | "worker"): ToolPreviewGroup {
	const builtinTools = role === "manager"
		? agent.manager?.builtinTools !== false
		: agent.connector?.config.builtinTools !== false;
	const codeSearch = role === "manager"
		? (agent.manager?.codeSearch ?? "builtin")
		: (!agent.codeSearch || agent.codeSearch === "inherit" ? "builtin" : agent.codeSearch);
	const searchCondition = codeSearch === "off" ? "已排除（codeSearch=off）" : codeSearch === "fff" ? "需 Workspace 已信任" : undefined;
	return {
		id: "native",
		...(builtinTools ? {} : { note: "原生工具整组已关闭（builtinTools=false）" }),
		tools: [
			...["read", "ls", "bash", "edit", "write"].map((name) => direct(name)),
			direct("grep", searchCondition),
			direct("find", searchCondition),
		],
	};
}

/** Manager 编排工具组（agent-extensions.ts planManagerTools 的受管面）。 */
function orchestrationGroup(): ToolPreviewGroup {
	return {
		id: "orchestration",
		tools: [
			direct(CORE_TOOL_DELEGATION),
			direct(CORE_TOOL_READ_DELEGATION_RESULT),
			direct(CORE_TOOL_SEARCH),
			...GOAL_ACTIVE_TOOLS.map((name) => direct(name, "常驻激活")),
			direct(CORE_TOOL_CREATE_GROUP, "仅 solo 会话"),
			direct(CORE_TOOL_INVITE, "仅群聊会话"),
		],
	};
}

async function knowledgeGroup(deps: ToolPreviewDeps, role: AgentToolPreview["role"]): Promise<ToolPreviewGroup> {
	if (role === "manager") {
		return {
			id: "knowledge",
			note: "需会话挂载知识库；tool_search 是 deferred 工具的发现入口",
			tools: [
				{ name: "tool_search", exposure: "model-only" },
				direct("knowledge_curation_status"),
				direct("knowledge_update_interaction_status"),
				...KNOWLEDGE_READ_TOOLS.map((name) => ({ name, exposure: "deferred" as const })),
				{ name: "knowledge_prepare_candidate", exposure: "deferred" },
				{ name: "knowledge_submit_candidate", exposure: "deferred" },
			],
		};
	}
	if (role === "wiki") {
		return {
			id: "knowledge",
			note: "需会话挂载知识库",
			tools: [
				...KNOWLEDGE_READ_TOOLS.map((name) => direct(name)),
				direct("knowledge_update_interaction_status"),
				direct("knowledge_prepare_candidate"),
				direct("knowledge_submit_candidate"),
				direct("knowledge_curation_status"),
			],
		};
	}
	const memory = deps.memorySetup ? await deps.memorySetup.status(localViewerIdentity().user.id) : undefined;
	return {
		id: "knowledge",
		note: "知识工具需会话挂载知识库后可用",
		tools: [
			...KNOWLEDGE_READ_TOOLS.map((name) => direct(name)),
			direct("knowledge_update_interaction_status"),
			direct(
				"memory_request_update",
				memory
					? memory.status === "configured"
						? "长期记忆已配置（当前可用）"
						: "长期记忆未配置（当前不可用）"
					: "需配置默认长期记忆",
			),
			direct("read_later_save_url"),
		],
	};
}

function calendarGroup(role: "manager" | "worker"): ToolPreviewGroup {
	return {
		id: "calendar",
		note: role === "manager" ? "仅 solo/group 会话装配；经 tool_search 渐进声明" : "仅委派执行时装配",
		tools: CALENDAR_TOOL_NAMES.map((name) =>
			role === "manager" ? { name, exposure: "deferred" as const } : direct(name),
		),
	};
}

async function webGroup(deps: ToolPreviewDeps, agent: AgentConfig, role: AgentToolPreview["role"]): Promise<ToolPreviewGroup> {
	let access: { search?: boolean; fetch?: boolean } | undefined;
	if (deps.webResearch) {
		try {
			access = JSON.parse(await deps.webResearch.accessFingerprint(webResearchTarget(agent).id)) as { search?: boolean; fetch?: boolean };
		} catch {
			access = undefined;
		}
	}
	const grant = (key: "search" | "fetch") => (access ? (access[key] ? "已授权" : "未授权") : "授权状态未知");
	const condition = (key: "search" | "fetch") =>
		[role === "manager" ? "仅 solo 会话" : undefined, grant(key)].filter(Boolean).join("；");
	const exposure = role === "manager" ? "deferred" as const : "direct" as const;
	return {
		id: "web",
		...(role === "manager" ? { note: "授权后经 tool_search 渐进声明" } : {}),
		tools: [
			{ name: "web_search", exposure, condition: condition("search") },
			{ name: "fetch_url", exposure, condition: condition("fetch") },
		],
	};
}

async function mcpGroup(deps: ToolPreviewDeps, agent: AgentConfig): Promise<ToolPreviewGroup | undefined> {
	const ids = agent.mcpServerIds ?? [];
	if (ids.length === 0) return undefined;
	const available = new Map((deps.mcpServers ? await deps.mcpServers.list() : []).map((server) => [server.id, server]));
	const tools = ids
		.filter((id) => available.has(id))
		.map((id) => {
			const server = available.get(id)!;
			return direct(server.id, server.displayName && server.displayName !== server.id ? server.displayName : undefined);
		});
	if (tools.length === 0) return undefined;
	return {
		id: "mcp",
		note: "连接后按 Server 实际声明注册其工具；定义读取失败降级为空",
		tools,
	};
}

/**
 * Capability 绑定工具（静态读 manifest；不加载模块）。Manager 列出 solo
 * roster（与 planManagerTools 的 ctx=undefined 同口径）各 worker 的绑定；
 * worker 列自身绑定。禁用绑定与未安装扩展不进清单，与装配行为一致。
 */
async function capabilityGroup(deps: ToolPreviewDeps, agent: AgentConfig, role: AgentToolPreview["role"]): Promise<ToolPreviewGroup | undefined> {
	if (!deps.catalog) return undefined;
	const owners = role === "manager" ? eligibleWorkers(await deps.teams.listAgents(), undefined) : [agent];
	const tools: ToolPreviewItem[] = [];
	for (const owner of owners) {
		for (const binding of owner.capabilityExtensions ?? []) {
			if (!binding.enabled) continue;
			const module = deps.catalog.get(binding.extensionId);
			if (!module) continue;
			for (const tool of module.manifest.tools) {
				const activation = binding.activation ?? tool.activation;
				tools.push(direct(
					extensionToolName(owner.name, module.manifest.id, tool.name),
					activation === "always" ? "常驻" : "经 search_agent_tools 激活",
				));
			}
		}
	}
	if (tools.length === 0) return undefined;
	return { id: "capability", tools };
}

/**
 * 按角色产出工具分组清单。wiki 是受限面（builtinId="wiki"）：无 native /
 * orchestration / calendar / mcp 组，原生工具整组关闭。
 */
export async function buildAgentToolPreview(deps: ToolPreviewDeps, agent: AgentConfig): Promise<AgentToolPreview> {
	const role: AgentToolPreview["role"] = agent.pinned ? "manager" : agent.builtinId === "wiki" ? "wiki" : "worker";
	const groups: ToolPreviewGroup[] = [];
	if (role !== "wiki") groups.push(nativeGroup(agent, role));
	if (role === "manager") groups.push(orchestrationGroup());
	groups.push(await knowledgeGroup(deps, role));
	if (role !== "wiki") groups.push(calendarGroup(role));
	groups.push(await webGroup(deps, agent, role));
	if (role !== "wiki") {
		const mcp = await mcpGroup(deps, agent);
		if (mcp) groups.push(mcp);
	}
	const capability = await capabilityGroup(deps, agent, role);
	if (capability) groups.push(capability);
	return { role, groups };
}
