import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { delegateToolName } from "../agent-runtime/extensions.js";
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

async function makeStack() {
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
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
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
