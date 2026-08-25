import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TeamsStore } from "../store/teams.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { ExtensionCatalog, delegateToolName, extensionToolName, type CapabilityExtensionModule } from "../agent-runtime/extensions.js";
import { PiSessionStore } from "./session-store.js";
import type { AgentDriver, AgentEvent, InvocationContext } from "../agent-runtime/types.js";

/**
 * Phase 5（§10.5）：pinned manager 配置驱动会话装配——Window collaboration
 * 分层（solo 无协作段；direct 固定 relay 不可编辑；group 可自定义协作提示词）、
 * thinking level 新建即生效且运行中即改、受影响会话统计。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

async function makeStack(catalog?: ExtensionCatalog) {
	process.env.PI_CODING_AGENT_DIR = freshDir("pt-mgr-agentdir-");
	const dir = freshDir("pt-mgr-");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "rt"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "sec"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (agentId) => drivers.get(agentId), {
		ttlMs: 24 * 60 * 60 * 1000,
	});
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker, catalog);
	return { teams, sessions, invoker, drivers, dir };
}

test("P3-R: Agent 运行指令与 Window collaboration 分层；Direct 固定 relay 不可覆盖", async () => {
	// solo 不注入 collaboration guidance；Agent 运行指令由 ResourceLoader 独立追加。
	assert.equal(PiSessionStore.resolveGuidance(undefined, undefined), undefined);
	// direct（§5.2）：平台固定 relay，ctx.prompt 一律不生效（防御历史数据）。
	const ctx = { type: "direct" as const, members: ["alpha"], prompt: "窗口规则" };
	const direct = PiSessionStore.resolveGuidance(ctx);
	assert.ok(direct!.includes("单聊窗口"), "direct 必须用内置固定 relay");
	assert.ok(!direct!.includes("窗口规则"), "direct 不接受自定义协作提示词");
	// group（§5.3）：window.prompt 覆盖内置 collaboration guidance。
	const groupCustom = PiSessionStore.resolveGuidance({ type: "group", members: ["a", "b"], prompt: "群规" }, undefined);
	assert.equal(groupCustom, "群规");
	const group = PiSessionStore.resolveGuidance({ type: "group", members: ["a", "b"] }, undefined);
	assert.ok(group!.includes("群聊窗口"));
});

test("Phase5: thinking level 新建会话即生效，运行中会话即时 setThinkingLevel", async () => {
	const { teams, sessions } = await makeStack();
	await teams.updateManager({ manager: { thinkingLevel: "high" } });
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	assert.equal(session.thinkingLevel, "high", "manager 配置的 thinking level 必须应用到新会话");

	// 运行中即改（§10.5 即时项）：变更后活跃会话立即 setThinkingLevel。
	// 注意 SDK 会把 level 钳制到模型支持范围（本环境默认模型支持 off/high/max）。
	await teams.updateManager({ manager: { thinkingLevel: "max" } });
	await sessions.syncAgentConfigChange();
	assert.equal(session.thinkingLevel, "max");

	// 新会话同样应用最新配置。
	const s2 = await sessions.create();
	assert.equal((await sessions.open(s2.id)).thinkingLevel, "max");
	await sessions.disposeAll();
});

test("Phase5: 受影响 manager Session 统计（active_now / reload_pending）", async () => {
	const { teams, sessions } = await makeStack();
	// solo 会话：roster 含启用的 puddingclaw（pinned manager 不进 roster）。
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	const tools = session.getAllTools().map((t) => t.name);
	assert.ok(tools.includes(delegateToolName("puddingclaw")));
	assert.ok(!tools.includes(delegateToolName("manager")), "pinned manager 不得成为可委托 worker");

	// 配置变更前：无受影响标记。
	let stats = sessions.agentSessionStats("puddingclaw");
	assert.equal(stats.affectedSessions, 1);
	assert.equal(stats.reloadPending, 0);

	// 禁用 + 同步后：active_now 立即撤权、reload_pending 标记重建。
	await teams.setEnabled("puddingclaw", false);
	await sessions.syncAgentConfigChange();
	stats = sessions.agentSessionStats("puddingclaw");
	assert.equal(stats.affectedSessions, 1);
	assert.equal(stats.activeNow, 1);
	assert.equal(stats.reloadPending, 1);
	assert.ok(!session.getActiveToolNames().includes(delegateToolName("puddingclaw")), "撤权后工具立即从 active 移除");

	// 无关 Agent 的统计为零。
	assert.equal(sessions.agentSessionStats("nonexistent").affectedSessions, 0);
	await sessions.disposeAll();
});

test("Phase5: pinned manager 不能被委托（Invoker 入口拒绝）", async () => {
	const { invoker } = await makeStack();
	await assert.rejects(() => invoker.requireAgent("manager"), /内置 manager/);
});

test("P3-1: manager 与 worker 在显式 Workspace 和未选项目模式都使用同一 cwd", async () => {
	const { teams, sessions, invoker, drivers, dir } = await makeStack();
	const project = await teams.workspaces.createManaged("项目 A");
	await teams.upsertAgent({
		name: "alpha",
		description: "alpha",
		invoke: { type: "command", command: "alpha", runArgs: [] },
	});
	let workerCwd = "";
	const driver: AgentDriver = {
		id: "alpha",
		async capabilities() {
			return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" };
		},
		async *run(_input, ctx: InvocationContext): AsyncIterable<AgentEvent> {
			workerCwd = ctx.cwd;
			yield { type: "completed", result: { agentId: "alpha", status: "completed", sessionHandle: "alpha-a", content: "ok" } };
		},
		async *continue(): AsyncIterable<AgentEvent> { throw new Error("unused"); },
		async *respond(): AsyncIterable<AgentEvent> { throw new Error("unused"); },
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const,
				enabled: true, compatibility: "supported" as const,
				capabilities: { operations: ["run"] as const, interactionKinds: [] as const, progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	drivers.register(driver);

	const manager = await sessions.create(undefined, {
		type: "direct",
		members: ["alpha"],
		workspaceId: project.id,
		cwd: project.canonicalPath,
	});
	const window = await teams.createWindow({
		type: "direct",
		members: ["alpha"],
		workspaceId: project.id,
		sessionId: manager.id,
	});
	const managerSession = await sessions.open(manager.id);
	const managerCwd = (managerSession.sessionManager as unknown as { cwd: string }).cwd;
	assert.equal(managerCwd, project.canonicalPath);
	assert.notEqual(managerCwd, dir, "测试必须证明 manager 未落回 server cwd");

	await invoker.delegate({
		windowId: window.id,
		managerSessionId: manager.id,
		agent: (await teams.getAgent("alpha"))!,
		message: "run",
		mode: "run",
	});
	assert.equal(workerCwd, project.canonicalPath);

	workerCwd = "";
	const defaultCwd = realpathSync(dir);
	const plainManager = await sessions.create(undefined, { type: "direct", members: ["alpha"], cwd: defaultCwd });
	const plainWindow = await teams.createWindow({
		type: "direct",
		members: ["alpha"],
		sessionId: plainManager.id,
	});
	const plainManagerSession = await sessions.open(plainManager.id);
	assert.equal((plainManagerSession.sessionManager as unknown as { cwd: string }).cwd, defaultCwd);
	await invoker.delegate({
		windowId: plainWindow.id,
		managerSessionId: plainManager.id,
		agent: (await teams.getAgent("alpha"))!,
		message: "plain run",
		mode: "run",
	});
	assert.equal(workerCwd, defaultCwd);
	await sessions.disposeAll();
});

test("产品验收冻结: 共享 sessionDir 可发现并恢复不同 Workspace 的 manager Session", async () => {
	const { teams, sessions, dir } = await makeStack();
	const workspaceA = await teams.workspaces.createManaged("A");
	const workspaceB = await teams.workspaces.createManaged("B");
	const sessionDir = path.join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const persisted = [
		{ id: "acceptance-workspace-a", cwd: workspaceA.canonicalPath },
		{ id: "acceptance-workspace-b", cwd: workspaceB.canonicalPath },
	];
	for (const [index, entry] of persisted.entries()) {
		writeFileSync(
			path.join(sessionDir, `2026-08-10T00-00-0${index}-000Z_${entry.id}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: entry.id,
				timestamp: `2026-08-10T00:00:0${index}.000Z`,
				cwd: entry.cwd,
			})}\n`,
		);
	}
	await teams.createWindow({
		type: "direct",
		members: ["alpha"],
		workspaceId: workspaceA.id,
		sessionId: persisted[0]!.id,
	});
	await teams.createWindow({
		type: "direct",
		members: ["beta"],
		workspaceId: workspaceB.id,
		sessionId: persisted[1]!.id,
	});

	const listed = await sessions.list();
	assert.deepEqual(
		new Set(listed.map((session) => session.id)),
		new Set(persisted.map((session) => session.id)),
		"共享目录的发现不能按默认 cwd 丢掉其他 Workspace",
	);
	assert.equal((await sessions.open(persisted[0]!.id)).sessionManager.getCwd(), workspaceA.canonicalPath);
	assert.equal((await sessions.open(persisted[1]!.id)).sessionManager.getCwd(), workspaceB.canonicalPath);
	await sessions.disposeAll();
});

test("P3-1: worker Session 只在相同 Workspace 与 Agent 配置修订下续接", async () => {
	const { teams, invoker } = await makeStack();
	const project = await teams.workspaces.createManaged("项目 A");
	const agent = await teams.upsertAgent({
		name: "alpha",
		description: "v1",
		invoke: { type: "command", command: "alpha", runArgs: [] },
	});
	const window = await teams.createWindow({
		type: "direct",
		members: ["alpha"],
		workspaceId: project.id,
		sessionId: "manager-a",
	});
	await teams.rememberWorkerSession(window.id, agent.name, "worker-a", project.id, project.canonicalPath, agent.extensionRevision ?? 0);
	assert.equal(await invoker.sessionHandleFor(window.id, agent), "worker-a");

	const revised = await teams.upsertAgent({ ...agent, description: "v2" });
	assert.equal(await invoker.sessionHandleFor(window.id, revised), undefined, "Agent 配置变化必须新建 worker Session");
	await teams.rememberWorkerSession(window.id, agent.name, "stale-project", "another-workspace", project.canonicalPath, revised.extensionRevision ?? 0);
	assert.equal(await invoker.sessionHandleFor(window.id, revised), undefined, "其他项目的 Session handle 不得续接");
});

test("P3-1: 无项目 Window 的 cwdSnapshot 变化后拒绝恢复旧 Interaction", async () => {
	const { teams, invoker, drivers, dir } = await makeStack();
	const agent = await teams.upsertAgent({
		name: "alpha",
		description: "alpha",
		invoke: { type: "command", command: "alpha", runArgs: [] },
	});
	const driver: AgentDriver = {
		id: "alpha",
		async capabilities() {
			return { operations: ["run", "respond"], interactionKinds: ["permission"], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: "worker-a", runHandle: "run-a" };
			yield {
				type: "input_required",
				result: {
					agentId: "alpha",
					status: "needs_input",
					sessionHandle: "worker-a",
					runHandle: "run-a",
					interaction: {
						id: "provider-interaction",
						kind: "permission",
						requests: [{ requestId: "perm-1", prompt: "允许？", options: ["once", "reject"] }],
					},
				},
			};
		},
		async *continue(): AsyncIterable<AgentEvent> { throw new Error("unused"); },
		async *respond(): AsyncIterable<AgentEvent> { throw new Error("must not reach driver"); },
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const,
				enabled: true, compatibility: "supported" as const,
				capabilities: { operations: ["run", "respond"] as const, interactionKinds: ["permission"] as const, progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	drivers.register(driver);
	const manager = await teams.ensureSoloWindow(async () => ({ id: "manager-a" }), async () => true);
	const direct = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: "direct-manager" });
	const outcome = await invoker.delegate({
		windowId: direct.id,
		managerSessionId: manager.activeSession,
		agent,
		message: "run",
		mode: "run",
	});
	assert.equal(outcome.status, "needs_input");

	const other = path.join(dir, "other-cwd");
	mkdirSync(other);
	const mutable = (await teams.getWindow(direct.id))!;
	mutable.cwdSnapshot = other;
	await assert.rejects(
		() => invoker.respond(outcome.interactionId!, {
			requestId: "response-1",
			revision: 0,
			responses: [{ requestId: "perm-1", action: "approve" }],
		}),
		/窗口项目已变化/,
	);
});

test("§3.3.7: 重启/重建从 JSONL 历史回放已激活的受管工具", async () => {
	// searchable capability 工具是唯一「受管但默认 inactive」的类别（委托工具
	// 已全窗口默认激活），回放语义用它验证。
	const module: CapabilityExtensionModule = {
		manifest: {
			id: "test-ext",
			kind: "capability",
			name: "测试扩展",
			version: "1",
			tools: [{ name: "deep_query", activation: "searchable", description: "深度查询" }],
		},
		register(ctx) {
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
	const { teams, sessions } = await makeStack(catalog);
	const summary = await sessions.create();
	await teams.ensureSoloWindow(async () => ({ id: summary.id }), async () => true);
	const name = delegateToolName("puddingclaw");
	const seeded = (await teams.getAgent("puddingclaw"))!;
	await teams.upsertAgent({
		...seeded,
		capabilityExtensions: [{ id: "b1", extensionId: "test-ext", capabilityId: "test-ext", enabled: true, config: {} }],
	});
	const extTool = extensionToolName("puddingclaw", "test-ext", "deep_query");

	const session = await sessions.open(summary.id);
	assert.ok(session.getActiveToolNames().includes(name), "委托工具默认激活，无需 search");
	assert.ok(!session.getActiveToolNames().includes(extTool), "searchable 扩展工具默认保持 inactive");

	// SDK 落盘门槛：文件要出现过 assistant 消息才开始持久化，先补一条。
	session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "好的" }],
		api: "openai",
		provider: "openai",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	// 模拟上一轮 search_agent_tools 激活：SDK 会给"激活了新工具"的
	// toolResult 标注 addedToolNames 并落盘（SDK 只写不读，回放由平台负责）。
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call_replay",
		toolName: "search_agent_tools",
		content: [{ type: "text", text: "已激活" }],
		details: { matches: [extTool, "agent_ghost__delegate"], added: [extTool, "agent_ghost__delegate"] },
		addedToolNames: [extTool, "agent_ghost__delegate"],
		isError: false,
		timestamp: Date.now(),
	} as never);

	// 模拟重启：释放内存会话，从 JSONL 重新物化。
	await sessions.disposeAll();
	const rebuilt = await sessions.open(summary.id);
	assert.ok(rebuilt.getActiveToolNames().includes(extTool), "重建后必须恢复历史里已激活的扩展工具");
	assert.ok(
		!rebuilt.getActiveToolNames().includes("agent_ghost__delegate"),
		"不在当前装配计划（plan.managed）里的工具不得被回放激活",
	);
	await sessions.disposeAll();
});

test("store 级事件订阅跨 runtimeDirty 重建存活（WS 推送不断流）", async () => {
	const { teams, sessions } = await makeStack();
	const summary = await sessions.create();
	await teams.ensureSoloWindow(async () => ({ id: summary.id }), async () => true);
	const seen: string[] = [];
	const unsubscribe = sessions.subscribe(summary.id, (event) => {
		if (event.type === "message_start") {
			const m = event.message as { customType?: string };
			if (m.customType === "pudding:probe") seen.push(event.type);
		}
	});

	const probe = () =>
		sessions.sendCustomMessage(
			summary.id,
			{ customType: "pudding:probe", content: "ping" },
			{ triggerTurn: false },
		);
	await probe();
	assert.equal(seen.length, 1, "订阅基线：实例正常时必须收到事件");

	// 触发空闲重建（§3.3.6）：配置变更标记 runtimeDirty，下次 open 换实例。
	await sessions.ensureSessionFile(summary.id);
	const before = await sessions.open(summary.id);
	await teams.updateManager({ manager: { thinkingLevel: "high" } });
	await sessions.syncAgentConfigChange();
	const after = await sessions.open(summary.id);
	assert.notEqual(after, before, "重建必须产生新的 AgentSession 实例");

	// 重建前订阅的 listener 必须继续收到新实例的事件（不断流、不重复）。
	await probe();
	assert.equal(seen.length, 2, "runtimeDirty 重建后订阅必须接力到新实例");
	unsubscribe();
	await sessions.disposeAll();
});

test("group running 投影直接追加为隐藏 custom entry，不进入展示消息流", async () => {
	const { teams, sessions } = await makeStack();
	const summary = await sessions.create();
	await teams.createWindow({ type: "group", members: ["puddingclaw"], sessionId: summary.id });
	const liveEvents: AgentSessionEvent[] = [];
	const unsubscribe = sessions.subscribe(summary.id, (event) => liveEvents.push(event));

	await sessions.appendCustomMessageProjection(summary.id, {
		customType: "pudding:task_assign",
		content: "生成页面",
		details: {
			taskId: "call-1",
			delegationId: "delegation-1",
			worker: "puddingclaw",
			from: "group",
			status: "running",
		},
	});

	const session = await sessions.open(summary.id);
	const projection = session.sessionManager.getBranch().find((entry) =>
		entry.type === "custom_message" && entry.customType === "pudding:task_assign",
	);
	assert.ok(projection && projection.type === "custom_message");
	assert.equal(projection.display, false);
	assert.equal((projection.details as { delegationId?: string }).delegationId, "delegation-1");
	const displayProjection = session.messages.find((message) =>
		message.role === "custom" && message.customType === "pudding:task_assign",
	);
	assert.ok(displayProjection && displayProjection.role === "custom");
	assert.equal(displayProjection.display, false);
	assert.equal((displayProjection.details as { delegationId?: string }).delegationId, "delegation-1");
	assert.ok(session.sessionFile, "隐藏投影也必须立即刷出 manager Session JSONL");
	const liveProjection = liveEvents.find((event) => event.type === "message_start") as
		| { type: "message_start"; message: { role?: string; customType?: string; display?: boolean; details?: unknown } }
		| undefined;
	assert.ok(liveProjection, "隐藏投影必须通过 store 订阅实时广播给已打开的 manager 页面");
	assert.equal(liveProjection.message.role, "custom");
	assert.equal(liveProjection.message.customType, "pudding:task_assign");
	assert.equal(liveProjection.message.display, false);
	assert.equal((liveProjection.message.details as { delegationId?: string }).delegationId, "delegation-1");
	unsubscribe();
	await sessions.disposeAll();
});
