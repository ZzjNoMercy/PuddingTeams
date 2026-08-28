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
	await registerChatRoutes(app, sessions, teams);
	return { app, dir, sessions, teams };
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
