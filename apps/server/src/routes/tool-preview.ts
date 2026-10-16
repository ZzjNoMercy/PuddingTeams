import type { FastifyInstance } from "fastify";
import type { TeamsStore } from "../store/teams.js";
import type { MemorySetupService } from "../knowledge/memory-setup.js";
import type { WebResearchSettings } from "../network/web-research.js";
import type { McpServerStore } from "../store/mcp-servers.js";
import type { ExtensionCatalog } from "../agent-runtime/extensions.js";
import { buildAgentToolPreview } from "../pi-bridge/tool-preview.js";

export interface ToolPreviewRouteDeps {
	memorySetup?: MemorySetupService;
	webResearch?: WebResearchSettings;
	mcpServers?: McpServerStore;
	catalog?: ExtensionCatalog;
}

/** 只读工具面预览（配置页「工具」分区）：静态装配清单，不实例化会话。 */
export function registerToolPreviewRoutes(app: FastifyInstance, teams: TeamsStore, deps: ToolPreviewRouteDeps = {}): void {
	app.get<{ Params: { name: string } }>("/api/agents/:name/tool-preview", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		if (!agent.pinned && agent.connector?.connectorId !== "pi") {
			return reply.code(400).send({ error: "只有 pi Agent 支持工具预览" });
		}
		try {
			return { preview: await buildAgentToolPreview({ teams, ...deps }, agent) };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});
}
