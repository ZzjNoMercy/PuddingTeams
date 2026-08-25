import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
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
	return { app, dir, sessions };
}

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
