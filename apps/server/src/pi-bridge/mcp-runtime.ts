import { createMcpAdapter, type ServerEntry } from "pi-mcp-adapter";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpServerStore } from "../store/mcp-servers.js";

export const MANAGED_MCP_EXTENSION_NAME = "puddingteams-mcp-adapter";
export const MANAGED_MCP_ADAPTER_VERSION = "2.31.0";

export const MANAGED_MCP_SETTINGS = {
	hostConfigDiscovery: "off",
	// 当前阶段每个 Agent 勾选的 Server/工具数量有限：直接把远端工具注册成
	// 一等 Pi tool，避免模型必须先经过 mcp search/describe 网关。
	directTools: true,
	scriptMode: false,
	mcpFooterStatus: "off",
	notifyOnStartupConnect: false,
	sampling: false,
	elicitation: false,
	outputGuard: true,
	toolResultRendering: "compact",
	// MCP 是可降级能力；单次握手/工具调用有界失败，不能让首轮长期卡在
	// 一个失联 Server 上。Server definition 仍可用 requestTimeoutMs 覆盖。
	requestTimeoutMs: 10_000,
	authRequiredMessage: "MCP Server「${server}」需要认证；请在 PuddingTeams 的扩展 > MCP 中更新配置或凭据。",
} as const;

/** 已被 Agent 勾选的 Server 在会话启动期完成连接与 tools/list。 */
export function applyManagedMcpStartupPolicy(
	definitions: Readonly<Record<string, ServerEntry>>,
): Record<string, ServerEntry> {
	return Object.fromEntries(Object.entries(definitions).map(([id, definition]) => [
		id,
		{
			...structuredClone(definition),
			// keep-alive 本身也会启动连接；其余模式在当前阶段统一提升为 eager。
			lifecycle: definition.lifecycle === "keep-alive" ? "keep-alive" : "eager",
		},
	]));
}

function mcpErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function unavailableMcpExtension(error: unknown): InlineExtension {
	const message = mcpErrorMessage(error);
	return {
		name: MANAGED_MCP_EXTENSION_NAME,
		factory: () => {
			console.error(`MCP: managed extension unavailable; Agent will continue without MCP tools: ${message}`);
		},
	};
}

/**
 * 平台持有 Server Catalog 与 Agent 选择，adapter 只负责协议执行。显式传入
 * 完整 config 可关闭它的 ambient 文件发现，避免 ~/.pi/.mcp.json 绕过平台
 * 作用域、Workspace 信任与前端事实源。
 */
export async function buildManagedMcpExtension(
	store: Pick<McpServerStore, "definitionsFor">,
	serverIds: readonly string[],
): Promise<InlineExtension> {
	try {
		const mcpServers = applyManagedMcpStartupPolicy(await store.definitionsFor(serverIds));
		const adapterFactory = createMcpAdapter({
			config: {
				mcpServers,
				settings: MANAGED_MCP_SETTINGS,
			},
		});
		return {
			name: MANAGED_MCP_EXTENSION_NAME,
			factory: (pi) => {
				try {
					adapterFactory(pi);
				} catch (error) {
					// Extension 装载异常也不得传播到 AgentSession/Worker 创建边界。
					console.error(`MCP: adapter setup failed; Agent will continue without MCP tools: ${mcpErrorMessage(error)}`);
				}
			},
		};
	} catch (error) {
		// Catalog/密钥解析失败只降级 MCP，不得阻止 Manager 或 Worker 启动。
		return unavailableMcpExtension(error);
	}
}
