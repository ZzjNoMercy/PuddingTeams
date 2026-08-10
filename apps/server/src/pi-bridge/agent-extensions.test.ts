import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TeamsStore, type AgentConfig } from "../store/teams.js";
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
	const store = new TeamsStore(dir, dir);
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

test("Phase4: 激活策略——group/solo 默认只激活 core，委托工具预注册但 inactive", async () => {
	const teams = await makeTeams([agentConfig("alpha"), agentConfig("beta")]);
	const catalog = new ExtensionCatalog();

	const group = await planManagerTools(teams, catalog, { type: "group", members: ["alpha", "beta"] });
	assert.ok(group.managed.has(delegateToolName("alpha")) && group.managed.has(delegateToolName("beta")));
	const core = [CORE_TOOL_SEARCH, CORE_TOOL_UPDATE_WORK_STATE, CORE_TOOL_REQUEST_DECISION];
	assert.deepEqual([...group.active], core, "group 默认只激活 core 工具");

	// solo（无窗口上下文）：roster 为全部启用 Agent，激活集同样只有 core。
	const solo = await planManagerTools(teams, catalog, undefined);
	assert.ok(solo.managed.has(delegateToolName("alpha")) && solo.managed.has(delegateToolName("beta")));
	assert.deepEqual([...solo.active], core);

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
