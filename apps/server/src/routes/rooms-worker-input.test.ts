import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TeamsStore, agentRunConfigRevision } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker, type AgentInvokeResult } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerRoomsRoutes, type RoomSummary } from "./rooms.js";
import { registerChatRoutes } from "./chat.js";
import { WorkerInputDispatcher, WorkerInputQueueStore } from "../agent-runtime/worker-input-queue.js";
import type { AgentDriver, AgentEvent, DriverCapabilities } from "../agent-runtime/types.js";
import type { ContinueInput, RunInput } from "../agent-runtime/types.js";

/**
 * Worker 执行 session 直接输入（步骤 4）与重命名/删除（步骤 5）：
 * 排队 FIFO、锁交接优先于后到委派、幂等防双投、启动 reconcile、
 * 重命名落 session_info、删除清 binding/查看指针且台账保留。
 */

interface FakeCall {
	mode: "run" | "continue";
	message: string;
	sessionHandle?: string;
	release: (content?: string) => void;
}

/** 可控假 driver：每次 run/continue 登记调用并挂起，release 后以 completed 收官。 */
function makeFakeDriver(): { driver: AgentDriver; calls: FakeCall[]; waitForCall: (count: number) => Promise<FakeCall> } {
	const calls: FakeCall[] = [];
	const driver: AgentDriver = {
		id: "alpha",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: [], progress: "none", transport: "spawn" };
		},
		run(input: RunInput): AsyncIterable<AgentEvent> {
			return generate("run", input.message, undefined);
		},
		continue(input: ContinueInput): AsyncIterable<AgentEvent> {
			return generate("continue", input.message, input.sessionHandle);
		},
		async *respond(): AsyncIterable<AgentEvent> {
			throw new Error("unused");
		},
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const, enabled: true,
				compatibility: "supported" as const,
				capabilities: { operations: ["run", "continue", "respond"], interactionKinds: [], progress: "none" as const, transport: "spawn" as const },
				issues: [],
			};
		},
	};
	function generate(mode: "run" | "continue", message: string, sessionHandle: string | undefined): AsyncIterable<AgentEvent> {
		return (async function* () {
			let release!: (content?: string) => void;
			const gate = new Promise<string>((resolve) => { release = (content) => resolve(content ?? `完成：${message}`); });
			calls.push({ mode, message, ...(sessionHandle ? { sessionHandle } : {}), release });
			const handle = sessionHandle ?? `fresh-session-${calls.length}`;
			yield { type: "started", sessionHandle: handle, runHandle: `run-${calls.length}` };
			const content = await gate;
			yield { type: "completed", result: { agentId: "alpha", status: "completed", content, sessionHandle: handle, runHandle: `run-${calls.length}` } };
		})();
	}
	const waitForCall = async (count: number): Promise<FakeCall> => {
		const deadline = Date.now() + 5000;
		while (calls.length < count) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for driver call #${count}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return calls[count - 1]!;
	};
	return { driver, calls, waitForCall };
}

async function makeStack() {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-worker-input-"));
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
	const fake = makeFakeDriver();
	drivers.register(fake.driver);
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const workerSessionDir = path.join(dir, "worker-sessions");
	const queueStore = new WorkerInputQueueStore(path.join(dir, "state", "worker-input-queue.json"));
	await queueStore.init();
	const dispatcher = new WorkerInputDispatcher({
		queue: queueStore, teams, sessions, invoker, runtime, delegations,
		log: () => undefined,
	});
	dispatcher.attach();
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, sessions, teams, undefined, undefined, invoker, undefined, undefined, undefined, undefined,
		{ delegations, sessionDir: workerSessionDir, inputQueue: dispatcher });
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		activityStatePath: path.join(dir, "state", "room-activity.json"),
		sessionCreationStatePath: path.join(dir, "state", "session-creation-operations.json"),
		delegations,
		workerSessionDir,
		workerInputQueue: dispatcher,
	});
	return { app, teams, sessions, delegations, invoker, runtime, dispatcher, queueStore, dir, workerSessionDir, fake };
}

async function makeDirectWindow(app: ReturnType<typeof Fastify>) {
	const res = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
	assert.equal(res.statusCode, 200, res.body);
	return res.json().room as RoomSummary;
}

async function soloSessionId(app: ReturnType<typeof Fastify>): Promise<string> {
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	return listed.json().rooms.find((room: { type: string }) => room.type === "solo").activeSession as string;
}

/** 最小合法 ExecutionReceipt（终态必须与 Receipt 原子封存）。 */
function testReceipt(delegationId: string, createdAt: string) {
	return {
		schemaVersion: 1 as const, id: `receipt:${delegationId}`, delegationId, operationId: delegationId,
		reportedOutcome: "completed" as const, upstream: {}, reportedEvidence: [], reportedArtifacts: [],
		requirementResults: [], artifactCapture: [], collectionStatus: "complete" as const, integrity: "clean" as const, issues: [],
		workerStarted: true,
		startedAt: createdAt, observedAt: createdAt, observer: { connectorId: "alpha", transport: "spawn" as const }, sealedAt: createdAt,
	};
}

/** 造一个落盘的执行 session 并在台账登记一条（直接置终态，不影响 canDelegate）。 */
async function makeWorkerSessionWithLedger(
	stack: Awaited<ReturnType<typeof makeStack>>,
	windowId: string,
	managerSessionId: string,
	userText = "查一下数据",
): Promise<string> {
	const sm = SessionManager.create(stack.dir, stack.workerSessionDir);
	sm.appendMessage({ role: "user", content: userText, timestamp: Date.now() } as never);
	// pi 懒落盘：只有 user 消息的 session 不写文件，补一条 assistant 才持久化。
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
	const handle = sm.getSessionId();
	const delegation = await stack.delegations.createDelegation({
		cwdSnapshot: stack.dir,
		windowId,
		managerSessionId,
		agentId: "alpha",
		agentRevision: 0,
		operation: "continue",
		sessionHandle: handle,
		task: userText,
	});
	await stack.delegations.transitionDelegation(delegation.id, ["admitted"], { executionState: "running", revision: 1 });
	await stack.delegations.transitionDelegation(delegation.id, ["running"], {
		executionState: "reported_completed",
		revision: 2,
		result: { agentId: "alpha", status: "completed", content: "done" },
		receipt: testReceipt(delegation.id, delegation.createdAt),
	});
	return handle;
}

/** 占用一个执行 session：发起 continue 委派并等 driver 接单（锁已持有）。 */
async function occupySession(
	stack: Awaited<ReturnType<typeof makeStack>>,
	windowId: string,
	containerSessionId: string,
	handle: string,
): Promise<{ done: Promise<AgentInvokeResult>; release: () => void }> {
	const agent = (await stack.teams.getAgent("alpha"))!;
	const done = stack.invoker.delegate({
		agent,
		windowId,
		managerSessionId: containerSessionId,
		message: "占位任务",
		mode: "continue",
		sessionHandle: handle,
	});
	const call = await stack.fake.waitForCall(stack.fake.calls.length + 1);
	return { done, release: () => call.release() };
}

async function containerCards(stack: Awaited<ReturnType<typeof makeStack>>, sessionId: string) {
	const session = await stack.sessions.open(sessionId);
	return session.sessionManager.getBranch()
		.filter((entry) => entry.type === "custom_message")
		.map((entry) => entry as { type: "custom_message"; customType: string; content: string; details?: Record<string, unknown> });
}

test("执行 session 直接输入：空闲直投、用户卡落容器、结果卡回收", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession);

		const res = await stack.app.inject({
			method: "POST",
			url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-idle-1" },
			payload: { content: "再补充一下背景" },
		});
		assert.equal(res.statusCode, 200, res.body);
		assert.deepEqual(res.json(), { accepted: true, queued: false, attachments: [] });
		const call = await stack.fake.waitForCall(1);
		assert.equal(call.mode, "continue");
		assert.equal(call.sessionHandle, handle);
		assert.equal(call.message, "再补充一下背景");
		call.release("补充完毕");
		// 等结果卡落盘。
		const deadline = Date.now() + 5000;
		for (;;) {
			const cards = await containerCards(stack, direct.activeSession);
			const user = cards.find((card) => card.customType === "pudding:user_message" && card.details?.operationId === "op-idle-1");
			const result = cards.find((card) => card.customType === "pudding:task_result" && card.details?.operationId === "op-idle-1");
			if (user && result) {
				assert.equal(user.details?.targetSessionHandle, handle);
				assert.equal(user.details?.queued, false);
				assert.equal(result.content, "补充完毕");
				assert.equal(result.details?.status, "completed");
				break;
			}
			if (Date.now() > deadline) assert.fail("结果卡未在等待期内落盘");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(stack.queueStore.list().length, 0, "直投成功后队列项已移除");
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("接单落账即出队：执行期间队列项不得再显示为排队中", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession);

		const res = await stack.app.inject({
			method: "POST",
			url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-inflight-1" },
			payload: { content: "这条已经在执行了" },
		});
		assert.equal(res.statusCode, 200, res.body);
		const call = await stack.fake.waitForCall(1);
		// 运行尚未结束（driver 闸门未放行），但队列项必须在接单落账时就移除——
		// 否则 web 轮询会在整个执行期间把它渲染成「排队中，将在当前任务结束后发送」。
		const listed = await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}/input-queue` });
		assert.equal(listed.statusCode, 200, listed.body);
		assert.deepEqual(listed.json().items, [], "执行中的输入不得再列为排队项");
		assert.equal(stack.queueStore.list().length, 0, "接单落账后队列项应立即移除");

		call.release("执行完毕");
		const deadline = Date.now() + 5000;
		for (;;) {
			const cards = await containerCards(stack, direct.activeSession);
			const result = cards.find((card) => card.customType === "pudding:task_result" && card.details?.operationId === "op-inflight-1");
			if (result) {
				assert.equal(result.content, "执行完毕");
				break;
			}
			if (Date.now() > deadline) assert.fail("结果卡未在等待期内落盘");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("忙碌入队 202 → settle 后 FIFO 自动派发，后到委派依旧 conflict", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession);
		const occupying = await occupySession(stack, direct.id, direct.activeSession, handle);

		const first = await stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-queued-1" }, payload: { content: "第一条排队输入" },
		});
		assert.equal(first.statusCode, 202, first.body);
		assert.equal(first.json().queued, true);
		const second = await stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-queued-2" }, payload: { content: "第二条排队输入" },
		});
		assert.equal(second.statusCode, 202, second.body);
		assert.notEqual(first.json().queueId, second.json().queueId);
		// 排队态用户卡已落容器 session。
		const queuedCards = await containerCards(stack, direct.activeSession);
		assert.equal(queuedCards.filter((card) => card.customType === "pudding:user_message" && card.details?.queued === true).length, 2);

		// settle 占锁任务：释放点同一临界区把锁交接给队首。
		occupying.release();
		await occupying.done;
		// 锁交接后后到的委派仍然 conflict（先到用户输入优先）。
		const agent = (await stack.teams.getAgent("alpha"))!;
		const competing = await stack.invoker.delegate({
			agent, windowId: direct.id, managerSessionId: direct.activeSession,
			message: "后到的委派", mode: "continue", sessionHandle: handle,
		});
		assert.equal(competing.conflict, true, "队首持有锁期间，后到委派必须 409");

		// FIFO：先释放第一条，再释放第二条。
		const call1 = await stack.fake.waitForCall(2);
		assert.equal(call1.mode, "continue");
		assert.equal(call1.message, "第一条排队输入");
		call1.release();
		const call2 = await stack.fake.waitForCall(3);
		assert.equal(call2.message, "第二条排队输入");
		call2.release();
		const deadline = Date.now() + 5000;
		while (stack.queueStore.list().length > 0) {
			if (Date.now() > deadline) assert.fail("队列未在等待期内排空");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("幂等：同一 Idempotency-Key 重试不双投", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession);
		const occupying = await occupySession(stack, direct.id, direct.activeSession, handle);

		const post = () => stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-idem-1" }, payload: { content: "别重复执行" },
		});
		const first = await post();
		const retry = await post();
		assert.equal(first.statusCode, 202);
		assert.equal(retry.statusCode, 202, retry.body);
		assert.equal(retry.json().queueId, first.json().queueId, "重试命中同一排队项");
		assert.equal(stack.queueStore.list().length, 1);

		occupying.release();
		await occupying.done;
		const call = await stack.fake.waitForCall(2);
		call.release();
		const deadline = Date.now() + 5000;
		while (stack.queueStore.list().length > 0) {
			if (Date.now() > deadline) assert.fail("队列未排空");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		// 台账去重：派发完成后同 key 再重试不再派发。
		const afterDispatch = await post();
		assert.equal(afterDispatch.statusCode, 200, afterDispatch.body);
		assert.equal(afterDispatch.json().queued, false);
		assert.equal(stack.fake.calls.filter((entry) => entry.message === "别重复执行").length, 1, "全文只派发了一次");
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("排队中取消：DELETE 移除且 settle 后不再派发", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession);
		const occupying = await occupySession(stack, direct.id, direct.activeSession, handle);

		const queued = await stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-cancel-1" }, payload: { content: "算了别做了" },
		});
		assert.equal(queued.statusCode, 202);
		const queueId = queued.json().queueId as string;
		const cancelled = await stack.app.inject({ method: "DELETE", url: `/api/rooms/${direct.id}/input-queue/${queueId}` });
		assert.equal(cancelled.statusCode, 204, cancelled.body);
		assert.equal(stack.queueStore.list().length, 0);
		// 别的窗口/不存在的项 404。
		const missing = await stack.app.inject({ method: "DELETE", url: `/api/rooms/${direct.id}/input-queue/no-such` });
		assert.equal(missing.statusCode, 404);

		occupying.release();
		await occupying.done;
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(stack.fake.calls.filter((entry) => entry.message === "算了别做了").length, 0, "已取消的排队输入不得派发");
		const cards = await containerCards(stack, direct.activeSession);
		assert.ok(cards.some((card) => card.customType === "pudding:task_result" && card.details?.operationId === "op-cancel-1" && card.details?.status === "cancelled"));
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("启动 reconcile：锁全空时补投排队项，窗口失效标失败", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession);
		const occupying = await occupySession(stack, direct.id, direct.activeSession, handle);
		const queued = await stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-reboot-1" }, payload: { content: "重启后要补投" },
		});
		assert.equal(queued.statusCode, 202);
		// 一个指向已消失窗口的孤儿排队项。
		await stack.queueStore.enqueue({
			id: "orphan-item", windowId: "missing-window", sessionHandle: "orphan-handle",
			text: "孤儿", displayText: "孤儿", operationId: "op-orphan", createdAt: new Date().toISOString(), status: "queued",
		});

		// 模拟重启：占锁委派由启动对账封印（台账转 cancelled）。不 release 旧
		// driver——旧 runtime 的锁随进程消失（新 runtime 锁全空），旧 dispatcher
		// 的钩子也不应再触发。
		const occupyingDelegation = (await stack.delegations.listDelegations(direct.id)).find((record) => record.executionState === "running")!;
		await stack.delegations.transitionDelegation(occupyingDelegation.id, ["running"], {
			executionState: "cancelled",
			revision: occupyingDelegation.revision + 1,
			result: { agentId: "alpha", status: "cancelled", errorCode: "cancelled", error: "server restart", recoverable: true },
			receipt: testReceipt(occupyingDelegation.id, occupyingDelegation.createdAt),
		});

		const runtime2 = new AgentRuntime(stack.delegations, new InteractionSecretStore(path.join(stack.dir, "secrets")), (id) => driversOf(stack).get(id), { ttlMs: 60_000 });
		const invoker2 = new AgentInvoker(stack.teams, runtime2, driversOf(stack), undefined, stack.dir);
		const queueStore2 = new WorkerInputQueueStore(path.join(stack.dir, "state", "worker-input-queue.json"));
		await queueStore2.init();
		const dispatcher2 = new WorkerInputDispatcher({
			queue: queueStore2, teams: stack.teams, sessions: stack.sessions, invoker: invoker2, runtime: runtime2, delegations: stack.delegations,
		});
		dispatcher2.attach();
		const reconciled = await dispatcher2.reconcileOnBoot();
		assert.equal(reconciled.failed, 1, "孤儿排队项标失败");
		assert.equal(reconciled.dispatched, 1, "有效排队项补投");
		assert.equal(queueStore2.get("orphan-item")?.status, "failed");

		const call = await stack.fake.waitForCall(2);
		assert.equal(call.mode, "continue");
		assert.equal(call.message, "重启后要补投");
		assert.equal(call.sessionHandle, handle);
		call.release();
		const deadline = Date.now() + 5000;
		while (queueStore2.list().some((item) => item.status === "queued")) {
			if (Date.now() > deadline) assert.fail("重启补投未排空");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

/** 测试栈里注册假 driver 的 registry（重启分身复用同一 driver 实例）。 */
function driversOf(stack: Awaited<ReturnType<typeof makeStack>>): DriverRegistry {
	const registry = new DriverRegistry();
	registry.register(stack.fake.driver);
	return registry;
}

test("重命名执行 session：落 session_info，枚举与读取视图一致", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const managerSession = await soloSessionId(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, managerSession);
		// 直派执行面不单列也不可管理：PATCH 返回 404。
		const directHandle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession, "直派任务");
		const directRename = await stack.app.inject({
			method: "PATCH", url: `/api/rooms/${direct.id}/sessions/${directHandle}`, payload: { name: "x" },
		});
		assert.equal(directRename.statusCode, 404, directRename.body);

		const renamed = await stack.app.inject({
			method: "PATCH", url: `/api/rooms/${direct.id}/sessions/${handle}`, payload: { name: "数据核查专线" },
		});
		assert.equal(renamed.statusCode, 200, renamed.body);
		assert.equal(renamed.json().workerSession?.name, "数据核查专线");
		const room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.equal(room.workerSessions.find((item) => item.id === handle)?.name, "数据核查专线");
		const onDisk = (await SessionManager.listAll(stack.workerSessionDir)).find((info) => info.id === handle);
		assert.equal(onDisk?.name, "数据核查专线", "session_info 已落盘");
		// 60 字上限与容器 session 一致。
		const tooLong = await stack.app.inject({
			method: "PATCH", url: `/api/rooms/${direct.id}/sessions/${handle}`, payload: { name: "长".repeat(61) },
		});
		assert.equal(tooLong.statusCode, 400);
		// 别的房间容器 session id / 未知 id 仍 404。
		const missing = await stack.app.inject({
			method: "PATCH", url: `/api/rooms/${direct.id}/sessions/no-such-handle`, payload: { name: "x" },
		});
		assert.equal(missing.statusCode, 404);
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("GET input-queue：列出窗口排队项、按 handle 过滤、他窗口隔离与 404", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, direct.activeSession);
		const occupying = await occupySession(stack, direct.id, direct.activeSession, handle);

		const first = await stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-list-1" }, payload: { content: "排队甲" },
		});
		const second = await stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-list-2" }, payload: { content: "排队乙" },
		});
		assert.equal(first.statusCode, 202);
		assert.equal(second.statusCode, 202);
		// 一个失败项（删除/失效路径的可见性）与一个他窗口的项。
		await stack.queueStore.enqueue({
			id: "failed-item", windowId: direct.id, sessionHandle: handle,
			text: "失败丙", displayText: "失败丙", operationId: "op-list-3", createdAt: new Date().toISOString(), status: "queued",
		});
		await stack.queueStore.markFailed("failed-item", "执行会话所属窗口或会话绑定已失效");
		await stack.queueStore.enqueue({
			id: "foreign-item", windowId: "other-window", sessionHandle: "other-handle",
			text: "别窗口的", displayText: "别窗口的", operationId: "op-foreign", createdAt: new Date().toISOString(), status: "queued",
		});

		const listed = await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}/input-queue` });
		assert.equal(listed.statusCode, 200, listed.body);
		const items = listed.json().items as Array<Record<string, unknown>>;
		assert.deepEqual(items.map((item) => item.operationId), ["op-list-1", "op-list-2", "op-list-3"], "FIFO 顺序且不含他窗口项");
		assert.equal(items[0]!.id, first.json().queueId);
		assert.equal(items[0]!.sessionHandle, handle);
		assert.equal(items[0]!.text, "排队甲");
		assert.equal(items[0]!.displayText, "排队甲");
		assert.equal(items[0]!.status, "queued");
		assert.equal(typeof items[0]!.createdAt, "string");
		assert.equal(items[2]!.status, "failed");
		assert.equal(items[2]!.failureReason, "执行会话所属窗口或会话绑定已失效");

		// 按 sessionHandle 过滤；未命中返回空列表。
		const filtered = await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}/input-queue?sessionHandle=${handle}` });
		assert.equal(filtered.json().items.length, 3);
		const empty = await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}/input-queue?sessionHandle=other-handle` });
		assert.equal(empty.statusCode, 200);
		assert.deepEqual(empty.json().items, [], "他窗口的 handle 在本窗口过滤后为空");

		// 未知窗口 404。
		const missing = await stack.app.inject({ method: "GET", url: "/api/rooms/no-such-window/input-queue" });
		assert.equal(missing.statusCode, 404);

		occupying.release();
		await occupying.done;
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});

test("删除执行 session：清 binding/查看指针、台账保留、运行中与排队中 409", async () => {
	const stack = await makeStack();
	try {
		const direct = await makeDirectWindow(stack.app);
		// 以大管家（solo）为来源的委派 session，才会列入 workerSessions 并可被查看指针选中。
		const managerSession = await soloSessionId(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, direct.id, managerSession);
		// 容器 binding 指向该 handle（删除时必须一并清除，否则下次 continue 先撞失效会话）。
		const agent = (await stack.teams.getAgent("alpha"))!;
		await stack.teams.rememberWorkerSession(
			direct.id, direct.activeSession, "alpha", handle, undefined,
			await stack.teams.workspaceFor(direct.id), agentRunConfigRevision(agent),
		);
		assert.ok((await stack.teams.getWindow(direct.id))!.workerBindings?.[direct.activeSession]?.alpha);
		// 查看指针先指向它。
		const activated = await stack.app.inject({ method: "POST", url: `/api/rooms/${direct.id}/sessions/${handle}/activate` });
		assert.equal(activated.statusCode, 200, activated.body);

		// 运行中 409。
		const occupying = await occupySession(stack, direct.id, direct.activeSession, handle);
		const busyDelete = await stack.app.inject({ method: "DELETE", url: `/api/rooms/${direct.id}/sessions/${handle}` });
		assert.equal(busyDelete.statusCode, 409, busyDelete.body);
		assert.equal(busyDelete.json().code, "worker_session_busy");
		// 排队中同样 409。
		const queued = await stack.app.inject({
			method: "POST", url: `/api/sessions/${handle}/messages`,
			headers: { "idempotency-key": "op-del-1" }, payload: { content: "先排着" },
		});
		assert.equal(queued.statusCode, 202);
		const queuedDelete = await stack.app.inject({ method: "DELETE", url: `/api/rooms/${direct.id}/sessions/${handle}` });
		assert.equal(queuedDelete.statusCode, 409);
		await stack.app.inject({ method: "DELETE", url: `/api/rooms/${direct.id}/input-queue/${queued.json().queueId}` });
		occupying.release();
		await occupying.done;

		const removed = await stack.app.inject({ method: "DELETE", url: `/api/rooms/${direct.id}/sessions/${handle}` });
		assert.equal(removed.statusCode, 204, removed.body);
		const room = (await stack.app.inject({ method: "GET", url: `/api/rooms/${direct.id}` })).json().room as RoomSummary;
		assert.equal(room.workerSessions.length, 0, "枚举跳过缺文件 handle");
		assert.equal(room.activeWorkerView, null, "查看指针已清空");
		const window = (await stack.teams.getWindow(direct.id))!;
		assert.equal(window.activeWorkerView, undefined, "存储层查看指针已清除");
		assert.equal(window.workerBindings?.[direct.activeSession]?.alpha, undefined, "binding 已清除");
		assert.equal((await SessionManager.listAll(stack.workerSessionDir)).some((info) => info.id === handle), false, "JSONL 已删除");
		// 台账保留审计事实。
		const ledger = await stack.delegations.listDelegations(direct.id);
		assert.ok(ledger.some((record) => record.sessionHandle === handle), "delegation 台账不动");
		// 删除后读取该 handle 404。
		const gone = await stack.app.inject({ method: "GET", url: `/api/sessions/${handle}/messages` });
		assert.equal(gone.statusCode, 404);
	} finally {
		await stack.sessions.disposeAll();
		await stack.app.close();
	}
});
