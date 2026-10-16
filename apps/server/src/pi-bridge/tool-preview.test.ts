import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { TeamsStore } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import type { ExtensionCatalog } from "../agent-runtime/extensions.js";
import type { MemorySetupService } from "../knowledge/memory-setup.js";
import { buildAgentToolPreview, type ToolPreviewDeps, type ToolPreviewGroup } from "../pi-bridge/tool-preview.js";
import { registerToolPreviewRoutes } from "../routes/tool-preview.js";
import { CALENDAR_TOOL_NAMES, calendarTools } from "../calendar/tools.js";

async function makeTeams(): Promise<TeamsStore> {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-tool-preview-"));
	const credentials = new CredentialsStore(path.join(dir, "sec"));
	await credentials.init();
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
		900_000,
		credentials,
	);
	await teams.init();
	return teams;
}

function groupOf(preview: { groups: ToolPreviewGroup[] }, id: ToolPreviewGroup["id"]): ToolPreviewGroup | undefined {
	return preview.groups.find((group) => group.id === id);
}

function names(group: ToolPreviewGroup | undefined): string[] {
	return (group?.tools ?? []).map((tool) => tool.name);
}

function memorySetupStub(status: "pending" | "configured"): Pick<MemorySetupService, "status"> {
	return {
		status: async () =>
			status === "configured"
				? ({ status: "configured", binding: { id: "mem1" } } as unknown as Awaited<ReturnType<MemorySetupService["status"]>>)
				: { status: "pending" },
	};
}

test("manager：分组齐全，knowledge direct/deferred 拆分正确，tool_search 为 model-only", async () => {
	const teams = await makeTeams();
	const manager = await teams.getAgent("manager");
	assert.ok(manager);
	const preview = await buildAgentToolPreview({ teams }, manager);
	assert.equal(preview.role, "manager");
	const ids: string[] = preview.groups.map((group) => group.id);
	for (const id of ["native", "orchestration", "knowledge", "calendar", "web"]) assert.ok(ids.includes(id), `缺少分组 ${id}`);

	const orchestration = groupOf(preview, "orchestration");
	for (const name of ["delegation", "read_delegation_result", "search_agent_tools", "create_group_window", "invite_to_group"]) {
		assert.ok(names(orchestration).includes(name), `orchestration 缺少 ${name}`);
	}
	assert.ok(!names(orchestration).includes("create_session_goal"), "Manager 工具面不得有 Goal 创建入口");
	assert.ok(!names(orchestration).includes("supersede_session_goal"), "Manager 工具面不得有 Goal 更换入口");
	assert.equal(orchestration?.tools.find((tool) => tool.name === "create_group_window")?.condition, "仅 solo 会话");
	assert.equal(orchestration?.tools.find((tool) => tool.name === "invite_to_group")?.condition, "仅群聊会话");

	const knowledge = groupOf(preview, "knowledge");
	const search = knowledge?.tools.find((tool) => tool.name === "tool_search");
	assert.equal(search?.exposure, "model-only");
	const directNames = knowledge?.tools.filter((tool) => tool.exposure === "direct").map((tool) => tool.name);
	assert.deepEqual(directNames, ["knowledge_curation_status", "knowledge_update_interaction_status"]);
	const deferredNames = knowledge?.tools.filter((tool) => tool.exposure === "deferred").map((tool) => tool.name);
	assert.deepEqual(deferredNames, [
		"knowledge_context",
		"knowledge_search",
		"knowledge_glob",
		"knowledge_read",
		"knowledge_links",
		"knowledge_prepare_candidate",
		"knowledge_submit_candidate",
	]);

	const calendar = groupOf(preview, "calendar");
	assert.deepEqual(names(calendar), [...CALENDAR_TOOL_NAMES]);
	assert.ok(calendar?.tools.every((tool) => tool.exposure === "deferred"), "manager 日历工具应全部为 deferred");

	const web = groupOf(preview, "web");
	assert.ok(web?.tools.every((tool) => tool.exposure === "deferred"), "manager 联网工具应全部为 deferred");
});

test("manager：capability 组按 roster worker 绑定生成命名空间工具名与激活条件", async () => {
	const teams = await makeTeams();
	await teams.upsertAgent({
		name: "w1",
		description: "worker",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		capabilityExtensions: [
			{ id: "b1", extensionId: "ext1", capabilityId: "ext1", enabled: true, config: {} },
			{ id: "b2", extensionId: "ext2", capabilityId: "ext2", enabled: true, config: {}, activation: "always" },
		],
	});
	const catalog = {
		get: (extensionId: string) =>
			extensionId === "ext1"
				? { manifest: { id: "ext1", kind: "capability", name: "Ext1", version: "1.0.0", tools: [{ name: "check", activation: "searchable" as const }] } }
				: extensionId === "ext2"
					? { manifest: { id: "ext2", kind: "capability", name: "Ext2", version: "1.0.0", tools: [{ name: "scan", activation: "always" as const }] } }
					: undefined,
	} as unknown as ToolPreviewDeps["catalog"];
	const manager = (await teams.getAgent("manager"))!;
	const preview = await buildAgentToolPreview({ teams, catalog }, manager);
	const capability = groupOf(preview, "capability");
	assert.ok(capability);
	const check = capability.tools.find((tool) => tool.name === "agent_w1__ext1__check");
	assert.equal(check?.condition, "经 search_agent_tools 激活");
	const scan = capability.tools.find((tool) => tool.name === "agent_w1__ext2__scan");
	assert.equal(scan?.condition, "常驻");
});

test("普通 worker：只读 6 个知识工具 direct，memory_request_update 条件随 memorySetup 状态开关，read_later 在列", async () => {
	const teams = await makeTeams();
	await teams.upsertAgent({
		name: "w1",
		description: "worker",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
	});
	const worker = (await teams.getAgent("w1"))!;

	const pending = await buildAgentToolPreview({ teams, memorySetup: memorySetupStub("pending") }, worker);
	assert.equal(pending.role, "worker");
	const knowledge = groupOf(pending, "knowledge");
	assert.ok(knowledge);
	const readTools = knowledge.tools.filter((tool) => tool.exposure === "direct" && tool.name.startsWith("knowledge_"));
	assert.deepEqual(
		readTools.map((tool) => tool.name),
		["knowledge_context", "knowledge_search", "knowledge_glob", "knowledge_read", "knowledge_links", "knowledge_update_interaction_status"],
	);
	assert.ok(names(knowledge).includes("read_later_save_url"));
	const memoryPending = knowledge.tools.find((tool) => tool.name === "memory_request_update");
	assert.equal(memoryPending?.condition, "长期记忆未配置（当前不可用）");

	const configured = await buildAgentToolPreview({ teams, memorySetup: memorySetupStub("configured") }, worker);
	const memoryConfigured = groupOf(configured, "knowledge")?.tools.find((tool) => tool.name === "memory_request_update");
	assert.equal(memoryConfigured?.condition, "长期记忆已配置（当前可用）");

	// worker 无 orchestration 组；calendar 标注仅委派执行。
	assert.equal(groupOf(pending, "orchestration"), undefined);
	assert.equal(groupOf(pending, "calendar")?.note, "仅委派执行时装配");
});

test("wiki：无 native/orchestration/calendar/mcp 组，knowledge 9 个全 direct", async () => {
	const teams = await makeTeams();
	const wiki = await teams.getAgent("wiki");
	assert.ok(wiki);
	const preview = await buildAgentToolPreview({ teams }, wiki);
	assert.equal(preview.role, "wiki");
	const ids: string[] = preview.groups.map((group) => group.id);
	for (const id of ["native", "orchestration", "calendar", "mcp"]) assert.ok(!ids.includes(id), `wiki 不应有分组 ${id}`);
	const knowledge = groupOf(preview, "knowledge");
	assert.ok(knowledge);
	assert.deepEqual(
		names(knowledge),
		[
			"knowledge_context",
			"knowledge_search",
			"knowledge_glob",
			"knowledge_read",
			"knowledge_links",
			"knowledge_update_interaction_status",
			"knowledge_prepare_candidate",
			"knowledge_submit_candidate",
			"knowledge_curation_status",
		],
	);
	assert.ok(knowledge.tools.every((tool) => tool.exposure === "direct"));
});

test("路由：非 pi agent 400，未知 agent 404，pi worker 200", async () => {
	const teams = await makeTeams();
	await teams.upsertAgent({
		name: "cmdworker",
		description: "command worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
	});
	await teams.upsertAgent({
		name: "piworker",
		description: "pi worker",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
	});
	const app = Fastify();
	registerToolPreviewRoutes(app, teams, {});

	const notFound = await app.inject({ method: "GET", url: "/api/agents/nope/tool-preview" });
	assert.equal(notFound.statusCode, 404);

	const nonPi = await app.inject({ method: "GET", url: "/api/agents/cmdworker/tool-preview" });
	assert.equal(nonPi.statusCode, 400);
	assert.match(nonPi.json().error, /只有 pi Agent 支持工具预览/);

	const ok = await app.inject({ method: "GET", url: "/api/agents/piworker/tool-preview" });
	assert.equal(ok.statusCode, 200);
	assert.equal(ok.json().preview.role, "worker");
});

test("CALENDAR_TOOL_NAMES 与 calendarTools 实际注册名单一致", () => {
	const tools = calendarTools({} as never, (() => Promise.resolve({})) as never);
	assert.deepEqual(new Set(tools.map((tool) => tool.name)), new Set(CALENDAR_TOOL_NAMES));
});
