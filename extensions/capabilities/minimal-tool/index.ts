const Params = {
	type: "object",
	required: ["goal", "acceptance"],
	properties: {
		goal: { type: "string", description: "要完成的目标。" },
		acceptance: { type: "array", items: { type: "string" }, description: "可验证的验收项。" },
	},
} as const;

interface RegistrationContext {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: typeof Params;
		execute(toolCallId: string, params: { goal: string; acceptance: string[] }): Promise<unknown>;
	}): void;
}

export const extension = {
	manifest: {
		id: "minimal-tool",
		kind: "capability" as const,
		name: "Minimal Tool",
		version: "1.0.0",
		description: "无副作用的 Capability Extension 最小样例。",
		tools: [{ name: "build_checklist", activation: "searchable" as const }],
	},
	register(ctx: RegistrationContext) {
		ctx.registerTool({
			name: "build_checklist",
			label: "Build Checklist",
			description: "把目标与验收项整理为确定性 checklist；不访问网络、文件或密钥。",
			parameters: Params,
			async execute(_toolCallId, params) {
				const items = params.acceptance.map((item, index) => `${index + 1}. [ ] ${item.trim()}`).join("\n");
				const text = `目标：${params.goal.trim()}\n\n${items || "（没有验收项）"}`;
				return { content: [{ type: "text", text }], details: { count: params.acceptance.length } };
			},
		});
	},
};

export default extension;
