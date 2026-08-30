import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerChatRoutes } from "./chat.js";
import { UploadStore } from "../store/uploads.js";
import type { AgentDriver } from "../agent-runtime/types.js";

async function makeStack() {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-chat-routes-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, sessions, teams, undefined, undefined, invoker);
	return { app, dir, sessions, teams, delegations, drivers, runtime, invoker };
}

function writeSkill(agentDir: string, name: string, description: string): void {
	const dir = path.join(agentDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf-8");
}

test("GET /api/sessions/:id/commands 返回 manager 当前真实启用的 Skill 命令", async () => {
	const { app, sessions, teams } = await makeStack();
	writeSkill(process.env.PI_CODING_AGENT_DIR!, "release-check", "检查发布风险");
	await teams.updateManager({ piResources: { enabledSkills: ["release-check"] } });
	const summary = await sessions.create();
	const res = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/commands` });
	assert.equal(res.statusCode, 200, res.body);
	assert.deepEqual(res.json(), {
		commands: [{ name: "skill:release-check", description: "检查发布风险", source: "skill" }],
	});
	await app.close();
});

test("GET /api/sessions/:id/commands 在 direct 窗口使用目标 pi worker 的 Skill 范围", async () => {
	const { app, sessions, teams } = await makeStack();
	writeSkill(process.env.PI_CODING_AGENT_DIR!, "data-check", "核对数据口径");
	await teams.upsertAgent({
		name: "piworker",
		description: "pi worker",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		piResources: { enabledSkills: ["data-check"] },
	});
	const summary = await sessions.create(undefined, { type: "direct", members: ["piworker"], cwd: teams.defaultContextCwd() });
	await teams.createWindow({ type: "direct", members: ["piworker"], sessionId: summary.id });
	const res = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/commands` });
	assert.equal(res.statusCode, 200, res.body);
	assert.deepEqual(res.json(), {
		commands: [{ name: "skill:data-check", description: "核对数据口径", source: "skill" }],
	});
	await app.close();
});

test("GET /api/sessions/:id/messages 包含运行中隐藏投影", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	await sessions.appendCustomMessageProjection(summary.id, {
		customType: "pudding:task_assign",
		content: "生成页面",
		details: {
			taskId: "call-1",
			delegationId: "delegation-1",
			worker: "designer",
			from: "solo",
			status: "running",
			processView: true,
		},
	});

	const res = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(res.statusCode, 200, res.body);
	const projection = (res.json() as { messages: Array<{ role?: string; customType?: string; display?: boolean; details?: Record<string, unknown> }> })
		.messages.find((message) => message.role === "custom" && message.customType === "pudding:task_assign");
	assert.ok(projection, "驻留 AgentSession 的展示消息必须与 SessionManager 隐藏投影同步");
	assert.equal(projection.display, false);
	assert.equal(projection.details?.delegationId, "delegation-1");
	assert.equal(projection.details?.processView, true);
	await app.close();
});

test("GET /api/sessions/:id/messages 对不存在的 Session 返回 404", async () => {
	const { app } = await makeStack();
	const res = await app.inject({ method: "GET", url: "/api/sessions/does-not-exist/messages" });
	assert.equal(res.statusCode, 404, res.body);
	assert.deepEqual(res.json(), { error: "session not found" });
	await app.close();
});

test("停驻项目的 Session 拒绝消息写入，切回前不会误用当前项目 cwd", async () => {
	const { app, sessions, teams } = await makeStack();
	const solo = await teams.ensureSoloWindow(
		(workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
		async (id) => (await sessions.list()).some((session) => session.id === id),
	);
	const workspace = await teams.workspaces.createManaged("parked-chat");
	const target = await teams.contextForWorkspace(workspace.id);
	const targetSession = await sessions.create(undefined, {
		type: "solo",
		members: [],
		workspaceId: workspace.id,
		cwd: target.cwdSnapshot,
	});
	await teams.replaceWindowWorkspace(solo.id, workspace.id, targetSession.id, solo);

	const res = await app.inject({
		method: "POST",
		url: `/api/sessions/${solo.activeSession}/messages`,
		payload: { content: "不应写入未激活项目" },
	});
	assert.equal(res.statusCode, 409, res.body);
	assert.deepEqual(res.json(), { error: "session_context_inactive" });
	await sessions.sendCustomMessage(
		solo.activeSession,
		{ customType: "pudding:late_audit", content: "迟到终态只记审计" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	assert.equal(sessions.isOpen(solo.activeSession), false, "parked 审计写入后必须卸载，不能驻留或唤醒模型");
	const persisted = (await sessions.list()).find((session) => session.id === solo.activeSession)!;
	assert.match(readFileSync(persisted.sessionFile, "utf8"), /pudding:late_audit/);
	await sessions.disposeAll();
	await app.close();
});

test("POST /abort 在服务端未确认运行时返回可见失败而非假成功", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const res = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(res.statusCode, 409, res.body);
	assert.deepEqual(res.json(), { aborted: false, reconciledToolResults: 0, error: "当前会话没有正在运行的任务" });
	await app.close();
});

test("Manager abort 不响应时停止有服务端截止时间，随后刷新不被 repair queue 锁死", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
	Object.defineProperty(session, "isIdle", { configurable: true, get: () => false });
	Object.defineProperty(session, "abort", { configurable: true, value: () => new Promise<void>(() => undefined) });
	const startedAt = Date.now();
	const stop = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(stop.statusCode, 500, stop.body);
	assert.match((stop.json() as { error: string }).error, /停止 Manager 超时/);
	assert.ok(Date.now() - startedAt < 7_000, "服务端停止必须在 deadline 后返回");
	const refreshStartedAt = Date.now();
	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	assert.ok(Date.now() - refreshStartedAt < 1_000, "刷新不得等待已经超时的 abort promise");
	await app.close();
});

test("waiting_admission 刷新补回 needs_input，停止只取消 Teams 准入且不启动 Worker", async () => {
	const { app, sessions, runtime, dir } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	const assistant = {
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: "call-admission", name: "agent_claude-code__delegate", arguments: { task: "只读查询" } }],
		api: "openai", provider: "openai", model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(assistant as never);
	session.state.messages.push(assistant as never);
	await sessions.ensureSessionFile(summary.id);
	let driverStarted = false;
	const driver: AgentDriver = {
		id: "claude-code",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: [] } }; },
		async *run() { driverStarted = true; }, async *continue() {}, async *respond() {},
		async probe() { throw new Error("unused"); },
	};
	const pending = await runtime.delegate({
		cwdSnapshot: dir, windowId: "manager-window", managerSessionId: summary.id, managerToolCallId: "call-admission",
		agentId: driver.id, agentRevision: 0, message: "只读查询", mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "manager_derived", reason: "只读", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
		driver,
	}, { cwd: dir, env: {} });
	assert.equal(pending.status, "needs_input");
	assert.equal(driverStarted, false);

	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	const recovered = (refreshed.json() as { messages: Array<{ role?: string; toolCallId?: string; details?: Record<string, unknown> }> }).messages
		.find((message) => message.role === "toolResult" && message.toolCallId === "call-admission");
	assert.equal(recovered?.details?.status, "needs_input");
	assert.equal(recovered?.details?.source, "platform_policy");
	assert.equal(recovered?.details?.workerStarted, false);

	const stopped = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(stopped.statusCode, 200, stopped.body);
	assert.equal(stopped.json().aborted, true);
	assert.equal((await runtime.getDelegation(pending.delegation.id))?.executionState, "cancelled");
	assert.equal((await runtime.getDelegation(pending.delegation.id))?.receipt?.workerStarted, false);
	assert.equal(driverStarted, false);
	await app.close();
});

test("并行工具一项失败后停止并刷新：原错误与 Delegation 终态都只持久化一次", async () => {
	const { app, sessions, teams, drivers, runtime, dir } = await makeStack();
	const summary = await sessions.create();
	await teams.ensureSoloWindow(async () => ({ id: summary.id }), async () => true);
	const session = await sessions.open(summary.id);
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "toolCall" as const, id: "call-bash", name: "bash", arguments: { command: "git branch --show-current" } },
			{ type: "toolCall" as const, id: "call-delegate", name: "agent_claude-code__delegate", arguments: { task: "查询分支" } },
		],
		api: "openai",
		provider: "openai",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(assistant as never);
	session.state.messages.push(assistant as never);
	await sessions.ensureSessionFile(summary.id);

	const driver: AgentDriver = {
		id: "claude-code",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" }; },
		async *run() {
			yield { type: "failed", result: { agentId: "claude-code", status: "failed", errorCode: "workspace_policy_blocked", error: "workspace policy denied", recoverable: true } };
		},
		async *continue() {},
		async *respond() {},
		async probe() { throw new Error("unused"); },
	};
	drivers.register(driver);
	await runtime.delegate({
		cwdSnapshot: dir,
		windowId: "manager-window",
		managerSessionId: summary.id,
		managerToolCallId: "call-delegate",
		agentId: driver.id,
		agentRevision: 0,
		message: "查询分支",
		mode: "run",
	}, { cwd: dir, env: {} });

	const emit = (sessions as unknown as { forwardEvent: (id: string, event: Record<string, unknown>) => void }).forwardEvent.bind(sessions);
	emit(summary.id, { type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "git branch --show-current" } });
	emit(summary.id, {
		type: "tool_execution_end",
		toolCallId: "call-bash",
		toolName: "bash",
		result: { content: [{ type: "text", text: "fatal: not a git repository" }], details: { exitCode: 128 } },
		isError: true,
	});

	let live = true;
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => live });
	Object.defineProperty(session, "isIdle", { configurable: true, get: () => !live });
	Object.defineProperty(session, "abort", { configurable: true, value: async () => { live = false; } });
	const stop = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(stop.statusCode, 200, stop.body);
	assert.deepEqual(stop.json(), { aborted: true, reconciledToolResults: 2 });
	assert.equal(await sessions.appendToolResultIfPending(summary.id, {
		toolCallId: "call-bash", toolName: "bash", text: "duplicate must not be appended", details: { exitCode: 999 },
	}), true);
	assert.equal(await sessions.appendToolResultIfPending(summary.id, {
		toolCallId: "call-bash", toolName: "bash", text: "duplicate must not be appended", details: { exitCode: 999 },
	}), true);

	await sessions.dispose(summary.id);
	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	const body = refreshed.json() as { messages: Array<{ role?: string; toolCallId?: string; content?: Array<{ text?: string }>; details?: Record<string, unknown> }> };
	const results = body.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.filter((message) => message.toolCallId === "call-bash").length, 1);
	assert.equal(results.filter((message) => message.toolCallId === "call-delegate").length, 1);
	assert.equal(results.find((message) => message.toolCallId === "call-bash")?.content?.[0]?.text, "fatal: not a git repository");
	assert.equal(results.find((message) => message.toolCallId === "call-delegate")?.details?.errorCode, "workspace_policy_blocked");
	await app.close();
});

test("并行普通工具刷新：已结束项回放原错误，未结束项保持 running", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "toolCall" as const, id: "call-failed", name: "bash", arguments: { command: "false" } },
			{ type: "toolCall" as const, id: "call-running", name: "bash", arguments: { command: "long-running" } },
		],
		api: "openai", provider: "openai", model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(assistant as never);
	session.state.messages.push(assistant as never);
	const emit = (sessions as unknown as { forwardEvent: (id: string, event: Record<string, unknown>) => void }).forwardEvent.bind(sessions);
	emit(summary.id, { type: "tool_execution_start", toolCallId: "call-failed", toolName: "bash", args: { command: "false" } });
	emit(summary.id, { type: "tool_execution_start", toolCallId: "call-running", toolName: "bash", args: { command: "long-running" } });
	emit(summary.id, {
		type: "tool_execution_end", toolCallId: "call-failed", toolName: "bash", isError: true,
		result: { content: [{ type: "text", text: "exit 1" }], details: { exitCode: 1 } },
	});
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	const body = refreshed.json() as {
		messages: Array<{ role?: string; toolCallId?: string }>;
		runningToolCallIds: string[];
		recoveredToolResults: Array<{ toolCallId: string; text: string; isError: boolean }>;
	};
	assert.deepEqual(body.runningToolCallIds, ["call-running"]);
	assert.deepEqual(body.recoveredToolResults, [{ toolCallId: "call-failed", toolName: "bash", text: "exit 1", details: { exitCode: 1 }, isError: true }]);
	assert.equal(body.messages.some((message) => message.role === "toolResult"), false, "streaming 时不得抢先写原生 toolResult");
	await app.close();
});

test("GET /api/sessions/:id/messages 对非「不存在」错误保持 500 穿透", async () => {
	const app = Fastify({ logger: false });
	await app.register(websocket);
	const broken = {
		open: async () => {
			throw new Error("disk exploded");
		},
	} as unknown as PiSessionStore;
	await registerChatRoutes(app, broken);
	const res = await app.inject({ method: "GET", url: "/api/sessions/x/messages" });
	assert.equal(res.statusCode, 500, res.body);
	await app.close();
});

test("消息入口把 Workspace 外绝对文件冻结为会话附件，外部目录拒绝隐式挂载", async () => {
	const { teams, dir } = await makeStack();
	const sessionId = "freeze-session";
	await teams.createWindow({ type: "direct", members: ["puddingclaw"], sessionId });
	const sourceRoot = mkdtempSync(path.join(tmpdir(), "pt-chat-external-"));
	const source = path.join(sourceRoot, "notes.txt");
	writeFileSync(source, "frozen-content", "utf-8");
	let received = "";
	const fakeSession = {
		messages: [],
		prompt: async (text: string) => { received = text; },
	};
	const fakeStore = {
		open: async () => fakeSession,
		generateSessionTitle: async () => undefined,
	} as unknown as PiSessionStore;
	const uploads = new UploadStore(path.join(dir, "uploads"));
	await uploads.init();
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, fakeStore, teams, undefined, uploads);
	const fileResponse = await app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/messages`,
		payload: { content: `读取 \`${source}\`` },
	});
	assert.equal(fileResponse.statusCode, 200, fileResponse.body);
	assert.ok(!received.includes(source), "模型输入不得继续引用可变的 Workspace 外源文件");
	assert.match(received, /uploads\/freeze-session\//);
	const frozenPath = (fileResponse.json() as { attachments: Array<{ path: string }> }).attachments[0]!.path;
	assert.equal(readFileSync(frozenPath, "utf-8"), "frozen-content");

	const directoryResponse = await app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/messages`,
		payload: { content: `读取目录 \`${sourceRoot}\`` },
	});
	assert.equal(directoryResponse.statusCode, 400, directoryResponse.body);
	assert.match(directoryResponse.body, /登记为 Workspace|临时挂载/);
	const missingResponse = await app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/messages`,
		payload: { content: "读取 `/definitely/not/a/real/puddingteams-file.txt`" },
	});
	assert.equal(missingResponse.statusCode, 400, missingResponse.body);
	assert.match(missingResponse.body, /不存在或不可访问/);
	await app.close();
});

test("WS 连接不存在的 Session 以 4404 关闭（前端据此停止重连）", async () => {
	const { app } = await makeStack();
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	assert(address && typeof address === "object");
	const closeCode = await new Promise<number>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/sessions/does-not-exist/ws`);
		ws.onclose = (ev) => resolve(ev.code);
		ws.onerror = () => reject(new Error("ws error before close"));
		setTimeout(() => reject(new Error("timed out waiting for ws close")), 5000);
	});
	assert.equal(closeCode, 4404);
	await app.close();
});
