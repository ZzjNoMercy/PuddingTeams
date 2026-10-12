import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerRoomsRoutes, type RoomSummary } from "./rooms.js";
import { registerChatRoutes } from "./chat.js";
import type { LiveWorkerSessionLookup } from "../agent-runtime/worker-sessions.js";

/** Worker 执行 session 升为一等会话的数据面：枚举投影、查看指针、session 路由分流。 */

async function makeStack(liveLookup?: LiveWorkerSessionLookup) {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-worker-sessions-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	await teams.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const workerSessionDir = path.join(dir, "worker-sessions");
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, sessions, teams, undefined, undefined, invoker, undefined, undefined, undefined, undefined,
		{ delegations, sessionDir: workerSessionDir, ...(liveLookup ? { liveLookup } : {}) });
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		activityStatePath: path.join(dir, "state", "room-activity.json"),
		sessionCreationStatePath: path.join(dir, "state", "session-creation-operations.json"),
		delegations,
		workerSessionDir,
	});
	return { app, teams, sessions, delegations, invoker, dir, workerSessionDir };
}

/** 造一个落盘的 worker 执行 session（user + assistant），返回 sessionHandle。 */
function makeWorkerSession(workerSessionDir: string, cwd: string, userText = "查一下数据", name?: string): string {
	const sm = SessionManager.create(cwd, workerSessionDir);
	sm.appendMessage({ role: "user", content: userText, timestamp: Date.now() } as never);
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "查完了" }],
		api: "openai",
		provider: "openai",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never);
	if (name) sm.appendSessionInfo(name);
	return sm.getSessionId();
}

async function makeDirectWindow(app: ReturnType<typeof Fastify>, member = "alpha") {
	const res = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: [member] } });
	assert.equal(res.statusCode, 200, res.body);
	return res.json().room as RoomSummary;
}

async function soloSessionId(app: ReturnType<typeof Fastify>): Promise<string> {
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	return listed.json().rooms.find((room: { type: string }) => room.type === "solo").activeSession as string;
}

function addDelegation(
	stack: Awaited<ReturnType<typeof makeStack>>,
	input: { windowId: string; managerSessionId: string; sessionHandle: string; task?: string },
) {
	return stack.delegations.createDelegation({
		cwdSnapshot: stack.dir,
		windowId: input.windowId,
		managerSessionId: input.managerSessionId,
		agentId: "alpha",
		agentRevision: 0,
		operation: "run",
		sessionHandle: input.sessionHandle,
		...(input.task ? { task: input.task } : {}),
	});
}

test("workerSessions 枚举：多来源聚合去重、来源名、running 标记", async () => {
	const stack = await makeStack();
	try {
		await stack.teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const direct = await makeDirectWindow(stack.app);
		const managerSession = await soloSessionId(stack.app);
		const group = await stack.app.inject({
			method: "POST", url: "/api/rooms",
			headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" },
			payload: { type: "group", members: ["alpha", "beta"], name: "攻坚组" },
		});
		assert.equal(group.statusCode, 200, group.body);
		const groupSession = group.json().room.activeSession as string;

		const handleA = makeWorkerSession(stack.workerSessionDir, stack.dir);
		const handleB = makeWorkerSession(stack.workerSessionDir, stack.dir, "直派任务正文");
		const task = "分析销售数据并给出结论，包括区域对比、环比增长、异常波动归因、渠道贡献拆解和下一步行动建议";
		assert.ok(task.length > 40, "测试需要超长任务文本来验证 40 字截断");
		const first = await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: handleA, task });
		await new Promise((resolve) => setTimeout(resolve, 20));
		// 同 handle 的第二次委派（来自群聊 manager session）：去重为一条。
		const second = await addDelegation(stack, { windowId: direct.id, managerSessionId: groupSession, sessionHandle: handleA });
		const directRun = await addDelegation(stack, { windowId: direct.id, managerSessionId: direct.activeSession, sessionHandle: handleB, task: "直接对话的任务" });
		await stack.delegations.transitionDelegation(directRun.id, ["admitted"], { executionState: "running" });

		const room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.equal(room.workerSessions.length, 1, "同 sessionHandle 的两次委派去重为一条；本窗口直派的执行面不列入");
		const a = room.workerSessions.find((item) => item.id === handleA)!;
		assert.equal(a.origin, "delegation");
		assert.equal(a.name, task.replace(/\s+/g, " ").trim().slice(0, 40));
		assert.equal(a.firstMessage, "查一下数据");
		assert.equal(a.sourceManagerSessionId, managerSession);
		assert.equal(a.sourceWindowId, "solo");
		assert.equal(a.sourceWindowName, "大管家");
		assert.equal(a.lastDelegationId, second.id, "lastDelegationId 指向该 handle 最近一次委派");
		assert.notEqual(a.lastDelegationId, first.id);
		assert.equal(a.running, false, "admitted 终态前/后均不在活动集");
		assert.equal(room.workerSessions.some((item) => item.id === handleB), false,
			"直派执行面与「直接对话」容器会话是同一段对话，重复列出会让用户困惑");
		const activateDirect = await stack.app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${handleB}/activate` });
		assert.equal(activateDirect.statusCode, 400, "直派执行面不在查看指针的合法集合内");
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("workerSessions 枚举：session_info 命名优先，文件已删除的 handle 跳过", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const managerSession = await soloSessionId(stack.app);
		const named = makeWorkerSession(stack.workerSessionDir, stack.dir, "查一下数据", "用户改过的名字");
		await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: named, task: "任务文本不应盖过命名" });
		// 台账存在但文件从未落盘的 handle：跳过。
		await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: "ghost-handle" });

		let room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.deepEqual(room.workerSessions.map((item) => item.id), [named]);
		assert.equal(room.workerSessions[0]!.name, "用户改过的名字");

		// 文件被删除（步骤 5 的删除路径）后，台账记录仍在但不再列出。
		const file = (await SessionManager.listAll(stack.workerSessionDir)).find((info) => info.id === named)!.path;
		rmSync(file);
		room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.deepEqual(room.workerSessions, []);
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("activate 扩展：worker session 置查看指针，容器切换清指针，跨窗口拒绝", async () => {
	const stack = await makeStack();
	try {
		await stack.teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const direct = await makeDirectWindow(stack.app);
		const otherDirect = await makeDirectWindow(stack.app, "beta");
		const managerSession = await soloSessionId(stack.app);
		const handleA = makeWorkerSession(stack.workerSessionDir, stack.dir);
		const handleForeign = makeWorkerSession(stack.workerSessionDir, stack.dir);
		await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: handleA });
		await addDelegation(stack, { windowId: otherDirect.id, managerSessionId: managerSession, sessionHandle: handleForeign });

		const activated = await stack.app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${handleA}/activate` });
		assert.equal(activated.statusCode, 200, activated.body);
		let room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.equal(room.activeWorkerView, handleA);
		assert.equal(room.activeSession, direct.activeSession, "容器 activeSession 不动");
		assert.equal((await stack.teams.getWindow(direct.id))!.activeWorkerView, handleA, "查看指针持久化到 windows.json");

		const foreign = await stack.app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${handleForeign}/activate` });
		assert.equal(foreign.statusCode, 400, "别的窗口的执行 session 不能在本窗口激活");
		room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.equal(room.activeWorkerView, handleA);

		const backToContainer = await stack.app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${direct.activeSession}/activate` });
		assert.equal(backToContainer.statusCode, 200, backToContainer.body);
		room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.equal(room.activeWorkerView, null, "切回容器 session 清掉执行面查看指针");

		const unknown = await stack.app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/no-such-handle/activate` });
		assert.equal(unknown.statusCode, 400);

		// 查看指针指向的执行 session 被删后，摘要投影回退 null（存储值留给删除任务清理）。
		await stack.app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${handleA}/activate` });
		const file = (await SessionManager.listAll(stack.workerSessionDir)).find((info) => info.id === handleA)!.path;
		rmSync(file);
		room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.equal(room.activeWorkerView, null, "已消失的执行 session 不再作为查看指针投影");
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("GET messages：worker session 历史回放、live 优先、群聊专属 handle 404", async () => {
	const liveHandle = "live-handle";
	const liveSession = {
		isStreaming: true,
		messages: [
			{ role: "user", content: [{ type: "text", text: "实时任务" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: {} }], timestamp: 2 },
		],
		sessionManager: { getBranch: () => [] },
		subscribe: () => () => undefined,
	} as unknown as AgentSession;
	const liveLookup: LiveWorkerSessionLookup = (handle) => (handle === liveHandle ? liveSession : undefined);
	const stack = await makeStack(liveLookup);
	try {
		await stack.teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
		const direct = await makeDirectWindow(stack.app);
		const managerSession = await soloSessionId(stack.app);
		const handleA = makeWorkerSession(stack.workerSessionDir, stack.dir);
		await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: handleA });
		await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: liveHandle });

		const history = await stack.app.inject({ method: "GET", url: `/api/sessions/${handleA}/messages` });
		assert.equal(history.statusCode, 200, history.body);
		const body = history.json();
		assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ["user", "assistant"]);
		assert.equal(body.messages[0].content, "查一下数据");
		assert.equal(body.running, false);
		assert.ok(body.messages.every((message: { puddingMessageId?: string }) => typeof message.puddingMessageId === "string"));

		const live = await stack.app.inject({ method: "GET", url: `/api/sessions/${liveHandle}/messages` });
		assert.equal(live.statusCode, 200, live.body);
		assert.equal(live.json().running, true, "live 流式中的执行 session 标 running");
		assert.deepEqual(live.json().runningToolCallIds, ["tc-1"]);
		assert.equal(live.json().messages.length, 2);

		// 只属于群聊窗口的执行 session：群聊维持 manager session 单一事实源，不可按 id 直读。
		const group = await stack.app.inject({
			method: "POST", url: "/api/rooms",
			headers: { "idempotency-key": "22222222-2222-4222-8222-222222222222" },
			payload: { type: "group", members: ["alpha", "beta"] },
		});
		const groupOnly = makeWorkerSession(stack.workerSessionDir, stack.dir);
		await addDelegation(stack, { windowId: group.json().room.id, managerSessionId: group.json().room.activeSession, sessionHandle: groupOnly });
		const groupView = await stack.app.inject({ method: "GET", url: `/api/sessions/${groupOnly}/messages` });
		assert.equal(groupView.statusCode, 404);

		const missing = await stack.app.inject({ method: "GET", url: "/api/sessions/no-such-session/messages" });
		assert.equal(missing.statusCode, 404);

		// 直接输入尚未开放（后续排队任务接入），明确拒绝而不是误报 Session not found。
		const post = await stack.app.inject({ method: "POST", url: `/api/sessions/${handleA}/messages`, payload: { content: "你好" } });
		assert.equal(post.statusCode, 400);
		assert.equal(post.json().code, "worker_session_input_unavailable");
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("WS：worker session 非 live 发快照后保持空闲，live 桥接事件流", async () => {
	const liveHandle = "live-ws-handle";
	let liveListener: ((event: AgentSessionEvent) => void) | undefined;
	const liveSession = {
		isStreaming: true,
		messages: [],
		sessionManager: { getBranch: () => [] },
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			liveListener = listener;
			return () => { liveListener = undefined; };
		},
	} as unknown as AgentSession;
	const liveLookup: LiveWorkerSessionLookup = (handle) => (handle === liveHandle ? liveSession : undefined);
	const stack = await makeStack(liveLookup);
	try {
		const direct = await makeDirectWindow(stack.app);
		const managerSession = await soloSessionId(stack.app);
		const handleA = makeWorkerSession(stack.workerSessionDir, stack.dir);
		await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: handleA });
		await addDelegation(stack, { windowId: direct.id, managerSessionId: managerSession, sessionHandle: liveHandle });
		await stack.app.listen({ port: 0, host: "127.0.0.1" });
		const address = stack.app.server.address();
		assert(address && typeof address === "object");
		const url = (handle: string) => `ws://127.0.0.1:${address.port}/api/sessions/${handle}/ws`;

		// 非 live：session_ready 后不再有任何事件，连接保持空闲。
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(url(handleA));
			const timer = setTimeout(() => { ws.close(); reject(new Error("timed out waiting for worker snapshot")); }, 5000);
			ws.onmessage = (frame) => {
				const event = JSON.parse(String(frame.data)) as { type?: string };
				if (event.type !== "session_ready") {
					clearTimeout(timer);
					ws.close();
					reject(new Error(`非 live 执行 session 不得重放伪装 live：${event.type}`));
					return;
				}
				// 快照后确认空闲：300ms 内无第二条消息。
				setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 300);
			};
			ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
		});

		// live：桥接执行事件流（与 manager 会话同一序列化通道）。
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(url(liveHandle));
			const timer = setTimeout(() => { ws.close(); reject(new Error("timed out waiting for live bridge")); }, 5000);
			let ready = false;
			ws.onmessage = (frame) => {
				try {
					const event = JSON.parse(String(frame.data)) as { type?: string; message?: { role?: string }; sessionId?: string };
					if (event.type === "session_ready") {
						assert.equal(event.sessionId, liveHandle);
						ready = true;
						assert.ok(liveListener, "live 执行 session 必须已订阅");
						liveListener!({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as AgentSessionEvent);
						return;
					}
					assert.equal(ready, true);
					assert.equal(event.type, "message_start");
					clearTimeout(timer);
					ws.onclose = () => resolve();
					ws.close();
				} catch (error) { clearTimeout(timer); ws.close(); reject(error); }
			};
			ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
		});
		// 客户端 close 帧发出后服务端清理是异步的，轮询确认退订生效。
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 2000;
			const poll = () => {
				if (liveListener === undefined) { resolve(); return; }
				if (Date.now() > deadline) { reject(new Error("socket 关闭后未退订 live 订阅")); return; }
				setTimeout(poll, 10);
			};
			poll();
		});

		// 未知 id 仍然 4404（前端据此停止重连）。
		const closeCode = await new Promise<number>((resolve, reject) => {
			const ws = new WebSocket(url("no-such-session"));
			ws.onclose = (event) => resolve(event.code);
			ws.onerror = () => reject(new Error("ws error before close"));
			setTimeout(() => reject(new Error("timed out waiting for ws close")), 5000);
		});
		assert.equal(closeCode, 4404);
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});
