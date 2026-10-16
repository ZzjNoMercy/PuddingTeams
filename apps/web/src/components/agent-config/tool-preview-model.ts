import type { ToolPreviewExposure, ToolPreviewGroup, ToolPreviewGroupId } from "@/lib/types";

export const TOOL_GROUP_LABELS: Record<ToolPreviewGroupId, string> = {
	native: "pi 原生", orchestration: "Agent 编排", knowledge: "知识库管理",
	calendar: "日历管理", web: "联网", mcp: "MCP", capability: "能力插件",
};

export const TOOL_EXPOSURE_LABELS: Record<ToolPreviewExposure, string> = {
	direct: "直接", deferred: "渐进声明", "model-only": "仅模型",
};

/** 仅检索展示副本；不能把条件或声明方式推断为可用性。 */
export function filterToolGroups(groups: ToolPreviewGroup[], query: string): ToolPreviewGroup[] {
	const search = query.trim().toLocaleLowerCase();
	if (!search) return groups;
	return groups.flatMap((group) => {
		if (`${TOOL_GROUP_LABELS[group.id]} ${group.note ?? ""}`.toLocaleLowerCase().includes(search)) return [group];
		const tools = group.tools.filter((tool) =>
			`${tool.name} ${tool.condition ?? ""} ${TOOL_EXPOSURE_LABELS[tool.exposure]}`.toLocaleLowerCase().includes(search),
		);
		return tools.length ? [{ ...group, tools }] : [];
	});
}

export function summarizeToolExposure(group: ToolPreviewGroup): string {
	return [...new Set(group.tools.map((tool) => TOOL_EXPOSURE_LABELS[tool.exposure]))].join(" · ");
}
