import { createMcpAdapter } from "pi-mcp-adapter";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpServerStore } from "../store/mcp-servers.js";

export const MANAGED_MCP_EXTENSION_NAME = "puddingteams-mcp-adapter";
export const MANAGED_MCP_ADAPTER_VERSION = "2.31.0";

/**
 * 平台持有 Server Catalog 与 Agent 选择，adapter 只负责协议执行。显式传入
 * 完整 config 可关闭它的 ambient 文件发现，避免 ~/.pi/.mcp.json 绕过平台
 * 作用域、Workspace 信任与前端事实源。
 */
export async function buildManagedMcpExtension(
	store: McpServerStore,
	serverIds: readonly string[],
): Promise<InlineExtension> {
	const mcpServers = await store.definitionsFor(serverIds);
	return {
		name: MANAGED_MCP_EXTENSION_NAME,
		factory: createMcpAdapter({
			config: {
				mcpServers,
				settings: {
					hostConfigDiscovery: "off",
					directTools: false,
					scriptMode: false,
					mcpFooterStatus: "off",
					notifyOnStartupConnect: false,
					sampling: false,
					elicitation: false,
					outputGuard: true,
					toolResultRendering: "compact",
					authRequiredMessage: "MCP Server「${server}」需要认证；请在 PuddingTeams 的扩展 > MCP 中更新配置或凭据。",
				},
			},
		}),
	};
}
