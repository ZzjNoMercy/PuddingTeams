import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TeamsStore, type AgentConfig } from "../store/teams.js";
import { WorkStateStore } from "../store/work-state.js";
import { PiSessionStore } from "./session-store.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import {
	ExtensionCatalog,
	ScopedAgentInvoker,
	delegateToolName,
	extensionToolName,
	type CapabilityExtensionModule,
} from "../agent-runtime/extensions.js";
import type { AgentDriver, AgentEvent, DriverCapabilities } from "../agent-runtime/types.js";
import {
	planManagerTools,
	buildManagerExtensionFactories,
	rosterPromptSection,
	CORE_TOOL_SEARCH,
	CORE_TOOL_UPDATE_WORK_STATE,
	CORE_TOOL_REQUEST_DECISION,
	CORE_TOOL_CREATE_GROUP,
	CORE_TOOL_INVITE,
	type ManagerExtensionDeps,
	type ManagerWindowContext,
} from "./agent-extensions.js";

/**
 * Phase 4 验收（§12.3 / 方案 §11 Phase 4）：
 * - 窗口内只有成员的工具可见（非成员 Agent 的工具不在该窗口的工具集里）；
 * - 禁用立即阻断（禁用后调用该工具被 Invoker 拒绝）；
 * - search_agent_tools 纯加法激活，且被撤权的工具不会被重新激活。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function agentConfig(name: string, extra?: Partial<AgentConfig>): AgentConfig {
	return {
		name,
		description: `${name} worker`,
		invoke: { type: "command", command: "echo", runArgs: ["run"] },
		enabled: true,
		...extra,
	};
}

async function makeTeams(agents: AgentConfig[]): Promise<TeamsStore> {
	const dir = freshDir("pt-ext-teams-");
	const store = new TeamsStore({ state: dir, assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
	await store.init();
	for (const agent of agents) await store.upsertAgent(agent);
	return store;
}

/** 立即完成的 mock driver。 */
function makeDriver(id: string): AgentDriver {
	return {
		id,
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue"], interactionKinds: [], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: `${id}-sess`, runHandle: `${id}-run` };
			yield {
				type: "completed",
				result: { agentId: id, status: "completed", sessionHandle: `${id}-sess`, runHandle: `${id}-run`, content: "done" },
			};
		},
		async *continue(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: `${id}-sess`, runHandle: `${id}-run` };
			yield {
				type: "completed",
				result: { agentId: id, status: "completed", sessionHandle: `${id}-sess`, runHandle: `${id}-run`, content: "done" },
			};
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: id, status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const, enabled: true,
				compatibility: "supported" as const,
				capabilities: { operations: ["run", "continue"], interactionKinds: [], progress: "none" as const, transport: "spawn" as const },
				issues: [],
			};
		},
	};
}

async function makeInvoker(teams: TeamsStore, ...driverIds: string[]): Promise<AgentInvoker> {
	const dir = freshDir("pt-ext-rt-");
	const delegations = new DelegationStore(dir);
	await delegations.init();
	const secrets = new InteractionSecretStore(freshDir("pt-ext-sec-"));
	await secrets.init();
	const drivers = new DriverRegistry();
	for (const id of driverIds) drivers.register(makeDriver(id));
	const runtime = new AgentRuntime(delegations, secrets, (agentId) => drivers.get(agentId), {
		ttlMs: 24 * 60 * 60 * 1000,
	});
	return new AgentInvoker(teams, runtime, drivers, undefined, dir);
}

/** 捕获 registerTool/getActiveTools/setActiveTools/on 的 mock ExtensionAPI。 */
function mockPi() {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let active: string[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(def: ToolDefinition) {
			tools.set(def.name, def);
		},
		getActiveTools: () => [...active],
		getAllTools: () =>
			[...tools.values()].map((d) => ({
				name: d.name,
				description: d.description,
				parameters: d.parameters,
				promptGuidelines: [],
				sourceInfo: { path: "<test>", source: "extension", scope: "temporary", origin: "top-level" },
			})),
		setActiveTools: (names: string[]) => {
			active = names.filter((n) => tools.has(n));
		},
		events: { emit() {}, on: () => () => {} },
	} as unknown as ExtensionAPI;
	return {
		pi,
		tools,
		handlers,
		getActive: () => [...active],
		setActive: (names: string[]) => {
			active = [...names];
		},
	};
}

function makeDeps(
	teams: TeamsStore,
	invoker: AgentInvoker,
	catalog: ExtensionCatalog,
	ctx: ManagerWindowContext | undefined,
): ManagerExtensionDeps {
	return {
		store: teams,
		// delegate 工具在本组测试中不触发 solo 同步，PiSessionStore 只用类型。
		sessions: undefined as never,
		invoker,
		catalog,
		getSessionId: () => "sess-test",
		ctx,
		resolveContext: async () => ctx,
	};
}

test("Phase4: 窗口内只有成员的工具可见（direct 非成员 Agent 不注册、不激活）", async () => {
	const teams = await makeTeams([agentConfig("alpha"), agentConfig("beta")]);
	const catalog = new ExtensionCatalog();
	const invoker = await makeInvoker(teams, "alpha", "beta");

	// direct 窗口：成员只有 alpha。
	const directCtx: ManagerWindowContext = { type: "direct", members: ["alpha"] };
	const plan = await planManagerTools(teams, catalog, directCtx);
	assert.ok(plan.managed.has(delegateToolName("alpha")), "成员的委托工具必须在工具集中");
	assert.ok(!plan.managed.has(delegateToolName("beta")), "非成员 Agent 的工具不得出现在该窗口工具集");
	assert.ok(plan.active.has(delegateToolName("alpha")), "direct 默认激活该 Agent 的基础委托工具");
	assert.deepEqual(
		[...plan.active].filter((n) => !n.startsWith("agent_")),
		[CORE_TOOL_SEARCH, CORE_TOOL_UPDATE_WORK_STATE, CORE_TOOL_REQUEST_DECISION],
		"Session Goal 的三个 core 工具始终可见",
	);

	// factories 实际注册的工具名与 plan 一致。
	const { pi, tools } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, makeDeps(teams, invoker, catalog, directCtx))) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	assert.ok(tools.has(delegateToolName("alpha")));
	assert.ok(tools.has(CORE_TOOL_SEARCH));
	assert.ok(!tools.has("list_agents"), "roster 不做成工具（由 prompt 注入取代）");
	assert.ok(!tools.has(delegateToolName("beta")), "非成员 Agent 的工具不得注册进 manager Session");
	assert.deepEqual([...tools.keys()].sort(), [...plan.managed].sort());
});

test("Phase4: 激活策略——委托工具全窗口默认激活，capability 扩展工具仍按需激活", async () => {
	const teams = await makeTeams([agentConfig("alpha"), agentConfig("beta")]);
	const catalog = new ExtensionCatalog();

	const group = await planManagerTools(teams, catalog, { type: "group", members: ["alpha", "beta"] });
	assert.ok(group.managed.has(delegateToolName("alpha")) && group.managed.has(delegateToolName("beta")));
	const core = [CORE_TOOL_SEARCH, CORE_TOOL_UPDATE_WORK_STATE, CORE_TOOL_REQUEST_DECISION];
	assert.deepEqual(
		[...group.active],
		[...core, CORE_TOOL_INVITE, delegateToolName("alpha"), delegateToolName("beta")],
		"group 默认激活 core + 拉人工具 + 成员委托工具（省掉 search 轮次）",
	);

	// solo（无窗口上下文）：roster 为全部启用 Agent（含内置 puddingclaw），
	// 激活集为 core + 建房工具 + 全部委托工具。
	const solo = await planManagerTools(teams, catalog, undefined);
	assert.ok(solo.managed.has(delegateToolName("alpha")) && solo.managed.has(delegateToolName("beta")));
	assert.deepEqual(
		[...solo.active],
		[...core, CORE_TOOL_CREATE_GROUP, delegateToolName("alpha"), delegateToolName("beta"), delegateToolName("puddingclaw")],
	);

	// 禁用 beta 后掉出 roster（装配期即不可见）。
	await teams.setEnabled("beta", false);
	const after = await planManagerTools(teams, catalog, { type: "group", members: ["alpha", "beta"] });
	assert.ok(!after.managed.has(delegateToolName("beta")), "禁用的 Agent 工具不得出现在工具集中");
});

test("Phase4: 专属 Capability Extension 按绑定装配并使用命名空间", async () => {
	const module: CapabilityExtensionModule = {
		manifest: {
			id: "test-ext",
			kind: "capability",
			name: "测试扩展",
			version: "1",
			tools: [
				{ name: "do_thing", activation: "always", description: "做一件事" },
				{ name: "deep_query", activation: "searchable", description: "深度查询" },
			],
		},
		register(ctx) {
			ctx.registerTool({
				name: "do_thing",
				label: "Do Thing",
				description: "做一件事",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: `agent=${ctx.agent.id}` }], details: {} };
				},
			});
			ctx.registerTool({
				name: "deep_query",
				label: "Deep Query",
				description: "深度查询",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "q" }], details: {} };
				},
			});
		},
	};
	const catalog = new ExtensionCatalog();
	catalog.register(module);
	const binding = { id: "b1", extensionId: "test-ext", capabilityId: "test-ext", enabled: true, config: {} };
	const teams = await makeTeams([
		agentConfig("alpha", { capabilityExtensions: [binding] }),
		agentConfig("beta", { capabilityExtensions: [binding] }),
	]);
	const invoker = await makeInvoker(teams, "alpha");

	const ctx: ManagerWindowContext = { type: "direct", members: ["alpha"] };
	const plan = await planManagerTools(teams, catalog, ctx);
	const alwaysTool = extensionToolName("alpha", "test-ext", "do_thing");
	const searchableTool = extensionToolName("alpha", "test-ext", "deep_query");
	assert.ok(plan.managed.has(alwaysTool) && plan.managed.has(searchableTool), "绑定工具必须带 agent_<id>__<extId>__ 命名空间");
	assert.ok(plan.active.has(alwaysTool), "direct 默认激活 always 工具");
	assert.ok(!plan.active.has(searchableTool), "searchable 工具预注册但 inactive");
	assert.ok(!plan.managed.has(extensionToolName("beta", "test-ext", "do_thing")), "非成员 Agent 的绑定工具不可见");

	const { pi, tools } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, makeDeps(teams, invoker, catalog, ctx))) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	assert.ok(tools.has(alwaysTool) && tools.has(searchableTool), "模块注册的裸工具名必须被平台加上命名空间前缀");
	assert.ok(!tools.has("do_thing"), "裸工具名不得泄漏到会话工具集");
});

test("Phase4: 禁用立即阻断——禁用后调用委托被 Invoker 拒绝", async () => {
	const teams = await makeTeams([agentConfig("alpha"), agentConfig("beta")]);
	const invoker = await makeInvoker(teams, "alpha", "beta");
	// alpha 的单聊窗口（member 校验用）。
	const workspace = await teams.workspaces.createManaged("test");
	const window = await teams.createWindow({ type: "direct", members: ["alpha"], workspaceId: workspace.id, sessionId: "sess-alpha" });

	const scoped = new ScopedAgentInvoker("alpha", invoker);
	const ok = await scoped.delegate({
		windowId: window.id,
		managerSessionId: "sess-alpha",
		message: "统计上月销售",
		mode: "continue",
	});
	assert.equal(ok.status, "completed", "启用状态下委托必须可用");

	// 禁用：即使旧 Session 仍持有旧 tool schema，入口也拒绝新委托。
	await teams.setEnabled("alpha", false);
	await assert.rejects(
		() =>
			scoped.delegate({
				windowId: window.id,
				managerSessionId: "sess-alpha",
				message: "再来一次",
				mode: "continue",
			}),
		(err: Error) => /已被禁用，委托被拒绝/.test(err.message),
	);

	// extensionRevision 随配置变化递增（§3.3.5）。
	const alpha = await teams.getAgent("alpha");
	assert.ok((alpha?.extensionRevision ?? 0) >= 2, "upsert + setEnabled 后 extensionRevision 必须递增");
});

test("Phase4: 非成员窗口的委托被 Invoker 成员校验拒绝", async () => {
	const teams = await makeTeams([agentConfig("alpha"), agentConfig("beta")]);
	const invoker = await makeInvoker(teams, "alpha", "beta");
	// beta 的单聊窗口里不允许委托 alpha。
	const workspace = await teams.workspaces.createManaged("test");
	const betaWindow = await teams.createWindow({ type: "direct", members: ["beta"], workspaceId: workspace.id, sessionId: "sess-beta" });
	const scoped = new ScopedAgentInvoker("alpha", invoker);
	await assert.rejects(
		() =>
			scoped.delegate({
				windowId: betaWindow.id,
				managerSessionId: "sess-beta",
				message: "越权调用",
				mode: "continue",
			}),
		(err: Error) => /不是当前窗口的成员，委托被拒绝/.test(err.message),
	);
});

test("委托结果正文携带 delegationId，followup 凭它接力成功", async () => {
	const teams = await makeTeams([agentConfig("alpha")]);
	const invoker = await makeInvoker(teams, "alpha");
	const catalog = new ExtensionCatalog();
	const ctx: ManagerWindowContext = { type: "direct", members: ["alpha"] };
	await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: "sess-test" });
	const plan = await planManagerTools(teams, catalog, ctx);
	const { pi, tools, setActive } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, makeDeps(teams, invoker, catalog, ctx))) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	setActive([...plan.active]);

	const tool = tools.get(delegateToolName("alpha"))!;
	const first = await tool.execute("call-1", { task: "第一步" }, undefined, undefined, {} as ExtensionContext);
	const firstText = (first.content[0] as { text?: string }).text ?? "";
	// details 里的 delegationId 模型看不到，正文必须带一份，否则 followup 只能瞎填。
	const m = /delegationId：([0-9a-f-]+)/.exec(firstText);
	assert.ok(m, `委托结果正文必须携带 delegationId：${firstText}`);
	assert.equal((first.details as { delegationId?: string }).delegationId, m![1]);

	const second = await tool.execute(
		"call-2",
		{ task: "接力继续", handoffKind: "followup", parentDelegationId: m![1] },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const secondText = (second.content[0] as { text?: string }).text ?? "";
	assert.ok(secondText.includes("done"), `followup 必须被接受并完成：${secondText}`);
});

test("群聊委托: 立即持久化 running 投影，且 session:new 真正新开 worker 会话", async () => {
	const teams = await makeTeams([agentConfig("alpha")]);
	const invoker = await makeInvoker(teams, "alpha");
	const catalog = new ExtensionCatalog();
	const ctx: ManagerWindowContext = { type: "group", members: ["alpha"] };
	await teams.createWindow({ type: "group", members: ["alpha"], sessionId: "sess-test" });
	const projections: Array<{
		sessionId: string;
		message: { customType: string; content: string; details?: Record<string, unknown> };
	}> = [];
	const sessions = {
		appendCustomMessageProjection: async (
			sessionId: string,
			message: { customType: string; content: string; details?: Record<string, unknown> },
		) => {
			projections.push({ sessionId, message });
		},
		ensureSessionFile: async () => undefined,
	};
	const deps: ManagerExtensionDeps = {
		store: teams,
		sessions: sessions as never,
		invoker,
		catalog,
		getSessionId: () => "sess-test",
		ctx,
		resolveContext: async () => ctx,
	};
	const plan = await planManagerTools(teams, catalog, ctx);
	const { pi, tools } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, deps)) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}

	const result = await tools.get(delegateToolName("alpha"))!.execute(
		"call-group-1",
		{ task: "绘制完整页面", session: "new" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal((result.details as { status?: string }).status, "completed");
	const delegationId = (result.details as { delegationId?: string }).delegationId;
	assert.ok(delegationId);
	const records = await invoker.delegationsForManagerSession("sess-test");
	assert.equal(records.at(-1)?.operation, "run", "group 的 session:new 不能再被强制改成 continue");
	assert.ok(projections.length >= 1, "worker 接单后必须立即向 group manager Session 写 running 投影");
	const enriched = projections.at(-1)!;
	assert.equal(enriched.sessionId, "sess-test");
	assert.equal(enriched.message.customType, "pudding:task_assign");
	assert.equal(enriched.message.details?.taskId, "call-group-1");
	assert.equal(enriched.message.details?.delegationId, delegationId);
	assert.equal(enriched.message.details?.from, "group");
	assert.equal(enriched.message.details?.processView, true);
	assert.equal(enriched.message.details?.sessionHandle, "alpha-sess");
});

test("Phase4: search_agent_tools 纯加法激活，撤权工具不会被重新激活", async () => {
	const teams = await makeTeams([agentConfig("alpha"), agentConfig("beta")]);
	const catalog = new ExtensionCatalog();
	const invoker = await makeInvoker(teams, "alpha", "beta");
	const ctx: ManagerWindowContext = { type: "group", members: ["alpha", "beta"] };
	const plan = await planManagerTools(teams, catalog, ctx);
	const { pi, tools, getActive, setActive } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, makeDeps(teams, invoker, catalog, ctx))) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	const baseline = [CORE_TOOL_SEARCH];
	setActive(baseline);

	const search = tools.get(CORE_TOOL_SEARCH)!;
	const first = await search.execute("call-1", { query: "alpha" }, undefined, undefined, {} as ExtensionContext);
	const added = (first.details as { added: string[] }).added;
	assert.deepEqual(added, [delegateToolName("alpha")], "按 worker 名搜索应激活其委托工具");
	const activeNow = getActive();
	for (const name of baseline) assert.ok(activeNow.includes(name), "纯加法：原有工具不得被移除");
	assert.ok(activeNow.includes(delegateToolName("alpha")));
	assert.ok(!activeNow.includes(delegateToolName("beta")), "未匹配的工具保持 inactive");

	// 撤权：禁用 alpha 后搜索不再激活它的工具（成员/启用状态每次重读）。
	await teams.setEnabled("alpha", false);
	setActive(baseline); // 模拟立即撤权后的 active tools
	const second = await search.execute("call-2", { query: "alpha" }, undefined, undefined, {} as ExtensionContext);
	assert.deepEqual((second.details as { matches: string[] }).matches, [], "禁用后工具不得再被搜索激活");
	assert.ok(!getActive().includes(delegateToolName("alpha")));
});

test("Phase4: search_agent_tools 空格分词 AND，worker 名 + 职责关键词可组合命中", async () => {
	const teams = await makeTeams([
		agentConfig("alpha", {
			responsibility: { identity: "检索员", domain: "联网检索", owns: ["联网检索", "资料汇总"], excludes: [] },
		}),
		agentConfig("beta"),
	]);
	const catalog = new ExtensionCatalog();
	const invoker = await makeInvoker(teams, "alpha", "beta");
	const ctx: ManagerWindowContext = { type: "group", members: ["alpha", "beta"] };
	const plan = await planManagerTools(teams, catalog, ctx);
	const { pi, tools, setActive } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, makeDeps(teams, invoker, catalog, ctx))) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	setActive([CORE_TOOL_SEARCH]);

	const search = tools.get(CORE_TOOL_SEARCH)!;
	// 回归：整串 "alpha 联网检索" 既不是工具名子串也不是描述子串，
	// 旧实现必然落空；分词后两词分别命中工具名与责任边界描述。
	const combo = await search.execute("call-1", { query: "alpha 联网检索" }, undefined, undefined, {} as ExtensionContext);
	assert.deepEqual(
		(combo.details as { matches: string[] }).matches,
		[delegateToolName("alpha")],
		"worker 名 + 职责关键词应组合命中其委托工具",
	);

	// 单个职责关键词也能命中（描述含责任边界）。
	const byDuty = await search.execute("call-2", { query: "联网检索" }, undefined, undefined, {} as ExtensionContext);
	assert.deepEqual((byDuty.details as { matches: string[] }).matches, [delegateToolName("alpha")]);

	// AND 语义：任一词不命中则整体不匹配，不会误激活无关工具。
	const miss = await search.execute("call-3", { query: "alpha 写代码" }, undefined, undefined, {} as ExtensionContext);
	assert.deepEqual((miss.details as { matches: string[] }).matches, []);
});

test("Phase4: 搜索已激活的工具返回可直接调用，而不是没有匹配", async () => {
	const teams = await makeTeams([agentConfig("alpha")]);
	const catalog = new ExtensionCatalog();
	const invoker = await makeInvoker(teams, "alpha");
	// direct 窗口：delegate 默认已激活——模型搜它的名字时必须得到"已激活"的明确答复。
	const ctx: ManagerWindowContext = { type: "direct", members: ["alpha"] };
	const plan = await planManagerTools(teams, catalog, ctx);
	const { pi, tools, setActive } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, makeDeps(teams, invoker, catalog, ctx))) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	setActive([...plan.active]);

	const search = tools.get(CORE_TOOL_SEARCH)!;
	const result = await search.execute("call-1", { query: delegateToolName("alpha") }, undefined, undefined, {} as ExtensionContext);
	const details = result.details as { matches: string[]; added: string[] };
	assert.deepEqual(details.matches, [delegateToolName("alpha")], "已激活的工具也要能搜到");
	assert.deepEqual(details.added, [], "已激活的工具不重复激活");
	const text = (result.content[0] as { text: string }).text;
	assert.ok(text.includes("可直接调用"), `应明确提示可直接调用，实际：${text}`);

	// roster prompt 要标注已激活工具，避免模型无谓搜索。
	const prompt = rosterPromptSection(plan, ctx);
	assert.ok(prompt.includes(`${delegateToolName("alpha")}（已激活）`), "roster 必须标注已激活工具");
});

test("Phase4: roster 渲染显示名（displayName），工具名仍用内部 id", async () => {
	const teams = await makeTeams([{ ...agentConfig("alpha"), displayName: "阿尔法" }]);
	const catalog = new ExtensionCatalog();
	const ctx: ManagerWindowContext = { type: "direct", members: ["alpha"], displayNames: { alpha: "阿尔法" } };
	const plan = await planManagerTools(teams, catalog, ctx);
	const prompt = rosterPromptSection(plan, ctx);
	assert.ok(prompt.includes("- 阿尔法"), "roster 行首必须是显示名");
	assert.ok(prompt.includes(delegateToolName("alpha")), "工具名仍用内部 id");
	// 单聊 guidance 同样渲染显示名。
	const guidance = PiSessionStore.resolveGuidance(ctx);
	assert.ok(guidance?.includes("worker「阿尔法」"), `guidance 必须渲染显示名，实际：${guidance}`);
	assert.ok(guidance?.includes(delegateToolName("alpha")), "guidance 工具名仍用内部 id");
});

test("Phase4: roster 由 before_agent_start 注入 system prompt 且每轮刷新", async () => {
	const teams = await makeTeams([agentConfig("alpha"), agentConfig("beta")]);
	const catalog = new ExtensionCatalog();
	const invoker = await makeInvoker(teams, "alpha", "beta");
	const ctx: ManagerWindowContext = { type: "group", members: ["alpha", "beta"] };
	const plan = await planManagerTools(teams, catalog, ctx);
	const { pi, handlers } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, makeDeps(teams, invoker, catalog, ctx))) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	const beforeStart = handlers.get("before_agent_start") ?? [];
	assert.equal(beforeStart.length, 1, "core Extension 必须注册 before_agent_start 注入 roster");

	const fire = async () => {
		const result = (await beforeStart[0]!(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			{},
		)) as { systemPrompt: string };
		return result.systemPrompt;
	};

	const first = await fire();
	assert.ok(first.startsWith("base\n\n"), "roster 段落追加在原 system prompt 之后");
	assert.ok(first.includes("alpha") && first.includes("beta"), "成员必须出现在 prompt 中");
	assert.ok(first.includes(delegateToolName("alpha")), "prompt 必须给出委托工具名");

	// 禁用 beta 后下一轮 prompt 即不再包含它（无需等会话重建）。
	await teams.setEnabled("beta", false);
	const second = await fire();
	assert.ok(second.includes("alpha") && !second.includes("beta"), "成员变化必须在下一轮 prompt 生效");
});

test("Phase4: rosterPromptSection 空 roster 时明确提示没有 worker", async () => {
	const empty = rosterPromptSection(
		{ managed: new Set([CORE_TOOL_SEARCH]), active: new Set([CORE_TOOL_SEARCH]), agents: [] },
		{ type: "group", members: [] },
	);
	assert.ok(empty.includes("没有可委托的 worker"));
});

test("产品验收冻结: Goal 上下文在 custom-message turn 前按最新状态刷新", async () => {
	const teams = await makeTeams([agentConfig("alpha")]);
	const catalog = new ExtensionCatalog();
	const invoker = await makeInvoker(teams, "alpha");
	const workStates = new WorkStateStore(freshDir("pt-goal-context-"));
	await workStates.init();
	const deps = { ...makeDeps(teams, invoker, catalog, undefined), workStates };
	const plan = await planManagerTools(teams, catalog, undefined);
	const { pi, handlers } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, deps)) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	const context = handlers.get("context")?.[0];
	assert.ok(context, "core extension 必须注册逐请求 context handler");
	const textOf = async () => {
		const result = await context!({ messages: [] }, {}) as { messages: Array<{ content?: unknown }> };
		return String(result.messages.at(-1)?.content);
	};
	assert.match(await textOf(), /尚未设置 Goal/);
	await workStates.create({
		sessionId: "sess-test",
		goal: "冻结验收",
		completionBoundary: "全部核心路径通过",
		participantAgentIds: ["alpha"],
	});
	assert.match(await textOf(), /目标：冻结验收/);
	assert.doesNotMatch(await textOf(), /尚未设置 Goal/);
});

test("P3-G: independent Goal 的 resolved 提交先走隔离 reviewer 再原子完成", async () => {
	const teams = await makeTeams([]);
	const catalog = new ExtensionCatalog();
	const invoker = await makeInvoker(teams);
	const states = new WorkStateStore(freshDir("pt-review-state-"));
	await states.init();
	await states.create({ sessionId: "sess-test", goal: "交付页面", completionBoundary: "页面验证通过" });
	let reviewCalls = 0;
	const sessions = {
		async reviewGoalCompletion() {
			reviewCalls++;
			return {
				id: "review-1",
				goalRevision: 0,
				mode: "independent" as const,
				verdict: "satisfied" as const,
				criteria: [{ criterion: "页面验证通过", status: "satisfied" as const, evidenceRefs: ["tool-1"], explanation: "验证成功" }],
				gaps: [],
				reviewerModel: "provider/reviewer",
				reviewerSessionId: "review-session",
				reviewedAt: new Date().toISOString(),
			};
		},
	} as unknown as PiSessionStore;
	const ctx: ManagerWindowContext = { type: "solo", members: [] };
	const plan = await planManagerTools(teams, catalog, ctx);
	const deps = { ...makeDeps(teams, invoker, catalog, ctx), sessions, workStates: states };
	const { pi, tools } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, deps)) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}
	const update = tools.get(CORE_TOOL_UPDATE_WORK_STATE)!;
	const result = await update.execute(
		"call-resolve",
		{ revision: 0, status: "resolved", currentBrief: "页面已生成并验证" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	assert.equal(reviewCalls, 1);
	assert.equal((result.details as { workState: { status: string } }).workState.status, "resolved");
	assert.equal((await states.get("sess-test"))?.completionReviews.at(-1)?.id, "review-1");
});


// ---- manager 建房与拉人（房间即群聊：solo 建房开跑 + group 拉人进组） ----

/** 需要真实 cwd（createWindow 会校验 cwdSnapshot 与默认目录一致）的 TeamsStore。 */
async function makeTeamsWithCwd(agents: AgentConfig[]): Promise<{ store: TeamsStore; cwd: string }> {
	const dir = freshDir("pt-ext-teams-");
	const store = new TeamsStore({ state: dir, assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
	await store.init();
	for (const agent of agents) await store.upsertAgent(agent);
	return { store, cwd: realpathSync(dir) };
}

function makeRoomDeps(
	store: TeamsStore,
	ctx: ManagerWindowContext,
	sessions?: unknown,
): ManagerExtensionDeps {
	return {
		store,
		sessions: sessions as never,
		invoker: undefined as never,
		catalog: new ExtensionCatalog(),
		getSessionId: () => "sess-test",
		ctx,
		resolveContext: async () => ctx,
	};
}

/** 只注册 core factory（roster/search/建房/拉人），避开需要 invoker 的 delegate factory。 */
async function registerCoreTools(deps: ManagerExtensionDeps) {
	const plan = await planManagerTools(deps.store, deps.catalog, deps.ctx);
	const { pi, tools } = mockPi();
	const core = buildManagerExtensionFactories(plan, deps)[0]!;
	const factory = typeof core === "function" ? core : core.factory;
	await factory(pi);
	return tools;
}

test("manager 建房: solo create_group_window 建成群聊并 fire-and-forget 下达首条任务", async () => {
	const { store, cwd } = await makeTeamsWithCwd([agentConfig("alpha"), agentConfig("beta")]);
	const prompted: string[] = [];
	const mockSessions = {
		create: async () => ({ id: "group-session-1" }),
		open: async (id: string) => ({
			prompt: async (text: string) => {
				prompted.push(`${id}::${text}`);
			},
		}),
		generateSessionTitle: async () => undefined,
	};
	const ctx: ManagerWindowContext = { type: "solo", members: [], cwd };
	const tools = await registerCoreTools(makeRoomDeps(store, ctx, mockSessions));
	const create = tools.get(CORE_TOOL_CREATE_GROUP)!;

	const result = await create.execute(
		"call-1",
		{ members: ["alpha", "beta"], task: "做一份对比报告", name: "报告组", prompt: "先分工再汇总" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const details = result.details as { windowId: string; members: string[]; name?: string };
	const window = (await store.getWindow(details.windowId))!;
	assert.ok(window, "建房后必须能通过 windowId 取到窗口");
	assert.equal(window.type, "group");
	assert.deepEqual(window.members, ["alpha", "beta"]);
	assert.equal(window.name, "报告组");
	assert.equal(window.prompt, "先分工再汇总", "群聊协作提示词落库（只给该房间 manager）");
	assert.deepEqual(window.sessions, ["group-session-1"]);

	// fire-and-forget 首发任务：等 promise 链跑完后新 session 收到首条消息。
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(prompted, ["group-session-1::做一份对比报告"]);

	// 校验：<2 成员 / 未知 worker / 禁用 worker / pinned manager 分别拒绝。
	await assert.rejects(
		() => create.execute("call-2", { members: ["alpha"], task: "t" }, undefined, undefined, {} as ExtensionContext),
		/至少需要 2 个 worker/,
	);
	await assert.rejects(
		() => create.execute("call-3", { members: ["alpha", "ghost"], task: "t" }, undefined, undefined, {} as ExtensionContext),
		/ghost.*不能入群/,
	);
	await store.setEnabled("beta", false);
	await assert.rejects(
		() => create.execute("call-4", { members: ["alpha", "beta"], task: "t" }, undefined, undefined, {} as ExtensionContext),
		/beta.*不能入群/,
	);
});

test("manager 建房: members 接受显示名并解析为内部 id（name/id 解耦）", async () => {
	const { store, cwd } = await makeTeamsWithCwd([
		agentConfig("alpha", { displayName: "阿尔法" }),
		agentConfig("pi-b", { displayName: "Designer" }),
	]);
	const mockSessions = {
		create: async () => ({ id: "group-session-1" }),
		open: async () => ({ prompt: async () => {} }),
		generateSessionTitle: async () => undefined,
	};
	const ctx: ManagerWindowContext = { type: "solo", members: [], cwd };
	const tools = await registerCoreTools(makeRoomDeps(store, ctx, mockSessions));
	const create = tools.get(CORE_TOOL_CREATE_GROUP)!;

	const result = await create.execute(
		"call-1",
		{ members: ["阿尔法", "Designer"], task: "做一份报告" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const details = result.details as { windowId: string; members: string[] };
	assert.deepEqual(details.members, ["alpha", "pi-b"], "显示名必须解析为内部 id 落库");
	assert.deepEqual((await store.getWindow(details.windowId))!.members, ["alpha", "pi-b"]);

	// roster 里显示名与 id 不同时必须标注 id，manager 才能完成映射。
	const plan = await planManagerTools(store, new ExtensionCatalog(), ctx);
	const roster = rosterPromptSection(plan, ctx);
	assert.ok(roster.includes("阿尔法（id：alpha）"), "roster 行必须标注内部 id");
	assert.ok(roster.includes("Designer（id：pi-b）"), "roster 行必须标注内部 id");
});

test("manager 建房: create_group_window 在 direct/group 被拒绝；invite_to_group 在 solo 被拒绝", async () => {
	const { store, cwd } = await makeTeamsWithCwd([agentConfig("alpha"), agentConfig("beta")]);
	const directTools = await registerCoreTools(
		makeRoomDeps(store, { type: "direct", members: ["alpha"], cwd }, undefined),
	);
	await assert.rejects(
		() =>
			directTools.get(CORE_TOOL_CREATE_GROUP)!.execute(
				"call-1",
				{ members: ["alpha", "beta"], task: "t" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		/仅 solo 对话可用/,
	);
	const soloTools = await registerCoreTools(makeRoomDeps(store, { type: "solo", members: [], cwd }, undefined));
	await assert.rejects(
		() =>
			soloTools.get(CORE_TOOL_INVITE)!.execute(
				"call-2",
				{ members: ["beta"] },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		/仅在群聊窗口可用/,
	);
});

test("manager 拉人: group invite_to_group 加入新成员，roster 重算后可见；重复拉人跳过", async () => {
	const { store, cwd } = await makeTeamsWithCwd([agentConfig("alpha"), agentConfig("beta"), agentConfig("gamma")]);
	const window = await store.createWindow({
		type: "group",
		members: ["alpha", "beta"],
		cwdSnapshot: cwd,
		sessionId: "sess-test",
	});
	const ctx: ManagerWindowContext = { type: "group", members: ["alpha", "beta"], cwd };
	const tools = await registerCoreTools(makeRoomDeps(store, ctx, undefined));
	const invite = tools.get(CORE_TOOL_INVITE)!;

	const result = await invite.execute(
		"call-1",
		{ members: ["gamma", "alpha"] },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const details = result.details as { members: string[]; added: string[]; skipped: string[] };
	assert.deepEqual(details.added, ["gamma"]);
	assert.deepEqual(details.skipped, ["alpha"], "已在群内的跳过并注明");
	assert.deepEqual((await store.getWindow(window.id))!.members, ["alpha", "beta", "gamma"]);

	// roster 下一轮可见：plan 重算后新成员的委托工具进入 managed。
	const plan = await planManagerTools(
		store,
		new ExtensionCatalog(),
		{ type: "group", members: (await store.getWindow(window.id))!.members },
	);
	assert.ok(plan.managed.has(delegateToolName("gamma")), "新成员下一轮必须进入 roster 工具集");

	const again = await invite.execute("call-2", { members: ["gamma"] }, undefined, undefined, {} as ExtensionContext);
	assert.ok((again.content[0] as { text: string }).text.includes("无需重复拉人"));
	assert.deepEqual((await store.getWindow(window.id))!.members, ["alpha", "beta", "gamma"], "重复拉人不改动成员");
});

test("solo 派活: worker 单聊绑在其他项目时复用并原地切换到 solo 当前项目", async () => {
	const { store, cwd } = await makeTeamsWithCwd([agentConfig("alpha")]);
	const invoker = await makeInvoker(store, "alpha");
	// solo 单例（无项目，默认 cwd）；alpha 的单聊绑在项目 A。
	await store.ensureSoloWindow(async () => ({ id: "sess-solo" }), async () => true);
	const wsA = await store.workspaces.createManaged("proj-a");
	const direct = await store.createWindow({ type: "direct", members: ["alpha"], workspaceId: wsA.id, sessionId: "sess-alpha" });

	const createdIds: string[] = [];
	const removedIds: string[] = [];
	const sessions = {
		create: async () => {
			const id = `sess-new-${createdIds.length + 1}`;
			createdIds.push(id);
			return { id };
		},
		remove: async (id: string) => {
			removedIds.push(id);
			return true;
		},
		list: async () => [],
		sendCustomMessage: async () => undefined,
		ensureSessionFile: async () => undefined,
		open: async () => ({ isIdle: true, waitForIdle: async () => {}, sendCustomMessage: async () => ({}) }),
	};
	const ctx: ManagerWindowContext = { type: "solo", members: [], cwd };
	const deps: ManagerExtensionDeps = {
		store,
		sessions: sessions as never,
		invoker,
		catalog: new ExtensionCatalog(),
		getSessionId: () => "sess-solo",
		ctx,
		resolveContext: async () => ctx,
	};
	const plan = await planManagerTools(store, deps.catalog, ctx);
	const { pi, tools } = mockPi();
	for (const ext of buildManagerExtensionFactories(plan, deps)) {
		const factory = typeof ext === "function" ? ext : ext.factory;
		await factory(pi);
	}

	const result = await tools.get(delegateToolName("alpha"))!.execute(
		"call-1",
		{ task: "做个报告" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const details = result.details as { windowId?: string };
	assert.equal(details.windowId, direct.id, "必须复用既有单聊，不得按项目另开窗口");
	const after = (await store.getWindow(direct.id))!;
	assert.equal(after.workspaceId, undefined, "复用后窗口必须已原地切到 solo 当前上下文（无项目）");
	assert.deepEqual(createdIds, ["sess-new-1"], "只发生原地切换的一次会话重建，不得走 ensureDirectWindow 新建窗口");
	assert.deepEqual(removedIds, ["sess-alpha"], "原地切换后旧会话被清理，新会话成为窗口活跃会话");
	assert.equal((await store.listWindows()).filter((w) => w.type === "direct" && w.members[0] === "alpha").length, 1, "同一 worker 仍然只有一个单聊");
});
