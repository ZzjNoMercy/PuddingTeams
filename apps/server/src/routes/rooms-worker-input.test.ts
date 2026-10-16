import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
import type { AgentDriver, AgentEvent, DriverCapabilities } from "../agent-runtime/types.js";
import type { ContinueInput, RunInput } from "../agent-runtime/types.js";

/** Removed delegation input endpoints and retained Connector direct continuity. */

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
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, sessions, teams, undefined, undefined, invoker, undefined, undefined, undefined, undefined,
		{ delegations });
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		activityStatePath: path.join(dir, "state", "room-activity.json"),
		sessionCreationStatePath: path.join(dir, "state", "session-creation-operations.json"),
	});
	return { app, teams, sessions, delegations, invoker, runtime, dir, workerSessionDir, fake };
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

test("P2 执行 handle 输入与队列端点关闭，不创建新 Run、不消耗旧队列", async () => {
	const stack = await makeStack();
	try {
		const room = await makeDirectWindow(stack.app);
		const manager = await soloSessionId(stack.app);
		const handle = await makeWorkerSessionWithLedger(stack, room.id, manager);
		const before = await stack.delegations.listDelegations();
		for (const operation of [
			{ method: "POST" as const, url: `/api/sessions/${handle}/messages`, payload: { content: "不得续写" } },
			{ method: "GET" as const, url: `/api/rooms/${room.id}/input-queue` },
			{ method: "DELETE" as const, url: `/api/rooms/${room.id}/input-queue/old` },
		]) {
			const result = await stack.app.inject(operation);
			assert.equal(result.statusCode, operation.url.includes("input-queue") ? 404 : 410, result.body);
		}
		assert.equal(stack.fake.calls.length, 0);
		assert.deepEqual(await stack.delegations.listDelegations(), before);
	} finally { await stack.app.close(); await stack.sessions.disposeAll(); rmSync(stack.dir, { recursive: true, force: true }); }
});

test("P2 direct 正常聊天保留多轮 continue，不受 Manager fresh 规则影响", async () => {
	const stack = await makeStack();
	try {
		const room = await makeDirectWindow(stack.app);
		const agent = (await stack.teams.getAgent("alpha"))!;
		for (const message of ["first", "second"]) {
			const pending = stack.invoker.delegate({ windowId: room.id, managerSessionId: room.activeSession, agent, message, mode: "continue", invocationKind: "direct_chat" });
			const call = await stack.fake.waitForCall(stack.fake.calls.length + 1);
			call.release(); await pending;
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		assert.deepEqual(stack.fake.calls.map(call => call.mode), ["run", "continue"]);
		assert.equal(stack.fake.calls[1]!.sessionHandle, "fresh-session-1");
	} finally { await stack.app.close(); await stack.sessions.disposeAll(); rmSync(stack.dir, { recursive: true, force: true }); }
});
