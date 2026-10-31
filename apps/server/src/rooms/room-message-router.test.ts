import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomEventStore } from "./room-event-store.js";
import { ParticipantTurnStore } from "./participant-turn-store.js";
import { InMemoryParticipantBindingRegistry } from "./participant-binding-registry.js";
import { RoomTurnService } from "./room-turn-service.js";
import { RoomOperationStore } from "./room-operation-store.js";
import {
	RoomMessageError,
	RoomMessageRouter,
	type RoomContextBudget,
	type RoomParticipantRunner,
	type RoomParticipantRunnerInput,
	type RoomParticipantRunnerResult,
} from "./room-message-router.js";
import { PiParticipantRunner } from "./participant-runners.js";

const ROOM = "room-1111-2222";
const ROOM_ID = "room-id-1";

class RecordingRunner implements RoomParticipantRunner {
	readonly calls: RoomParticipantRunnerInput[] = [];
	constructor(private result: RoomParticipantRunnerResult = { status: "completed", finalContent: "最终结论" }) {}
	async run(input: RoomParticipantRunnerInput): Promise<RoomParticipantRunnerResult> {
		this.calls.push(input);
		await input.markInputDurable();
		return this.result;
	}
}

async function makeRouter(opts: { budget?: RoomContextBudget; bindings?: "all" | "worker" | "none" } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-router-"));
	const events = new RoomEventStore(root);
	await events.create(ROOM);
	const turns = new ParticipantTurnStore(root);
	const operations = new RoomOperationStore(root);
	const bindings = new InMemoryParticipantBindingRegistry();
	if (opts.bindings !== "none") {
		await bindings.ensure({
			roomId: ROOM_ID, roomSessionId: ROOM, agentId: "manager", role: "manager",
			agentSessionId: "agent-manager", cwdSnapshot: "/workspace",
		});
	}
	if (opts.bindings === "all" || opts.bindings === "worker") {
		await bindings.ensure({
			roomId: ROOM_ID, roomSessionId: ROOM, agentId: "worker-a", role: "worker",
			agentSessionId: "agent-worker-a", cwdSnapshot: "/workspace",
		});
	}
	const turnService = new RoomTurnService({ events, turns, bindings });
	const runner = new RecordingRunner({ status: "completed", finalContent: "WorkerA 的结论", execution: { kind: "native_pi" } });
	const router = new RoomMessageRouter({
		events, turns, bindings, turnService, operations, runner,
		managerAgentId: "manager",
		agentNames: { manager: "Manager", "worker-a": "WorkerA" },
		budget: opts.budget ?? { maxChars: 100_000 },
	});
	return { root, events, turns, operations, bindings, turnService, runner, router };
}

async function wait(router: RoomMessageRouter, turnId: string) {
	return router.waitForTurn(ROOM, turnId);
}

test("RoomMessageRouter: @Worker 只运行 Worker，final 进入公共历史且 Manager 不被调用", async () => {
	const { events, turns, bindings, runner, router } = await makeRouter({ bindings: "all" });
	const accepted = await router.send({ roomSessionId: ROOM, content: "请检查方案", mentions: ["worker-a"], operationId: "op-message-1" });
	assert.equal(accepted.replayed, false);
	assert.equal(accepted.status, "running");
	const turn = await wait(router, accepted.turnId);
	assert.equal(turn?.status, "completed");
	assert.equal(turn?.publicProjectionState, "projected");
	assert.equal(runner.calls.length, 1);
	assert.equal(runner.calls[0]!.binding.agentId, "worker-a");
	assert.match(runner.calls[0]!.prompt, /\[当前用户消息｜用户 → @WorkerA｜event=/);
	const stored = await events.read(ROOM);
	assert.equal(stored.length, 2);
	assert.equal(stored[0]!.actor.kind, "user");
	assert.equal(stored[1]!.kind, "message");
	assert.equal((stored[1]!.actor as { agentId: string }).agentId, "worker-a");
	assert.equal(stored[1]!.sourceParticipantTurnId, accepted.turnId);
	assert.equal((await bindings.get(ROOM, "worker-a"))?.lastRoomEntryId, stored[1]!.id);
	assert.ok((await turns.get(ROOM, accepted.turnId))?.inputs.every((input) => input.persistence === "durable"));
});

test("RoomMessageRouter: 无 mentions 路由 Manager，并能读到之前的 Worker 公共 final", async () => {
	const { runner, router } = await makeRouter({ bindings: "all" });
	const first = await router.send({ roomSessionId: ROOM, content: "先问 Worker", mentions: ["worker-a"], operationId: "op-message-1" });
	await wait(router, first.turnId);
	const before = runner.calls.length;
	const second = await router.send({ roomSessionId: ROOM, content: "再问 Manager", mentions: [], operationId: "op-message-2" });
	await wait(router, second.turnId);
	assert.equal(runner.calls.length, before + 1);
	assert.equal(runner.calls.at(-1)!.binding.agentId, "manager");
	assert.match(runner.calls.at(-1)!.prompt, /WorkerA 的结论/, "Manager 应看到 Worker 的公共 final");
});

test("RoomMessageRouter: 同一房间串行，活动回合时拒绝新 normal 消息", async () => {
	const { runner, router } = await makeRouter({ bindings: "all" });
	let release!: (result: RoomParticipantRunnerResult) => void;
	const pending = new Promise<RoomParticipantRunnerResult>((resolve) => { release = resolve; });
	runner.run = async (input) => {
		runner.calls.push(input);
		await input.markInputDurable();
		return pending;
	};
	const first = await router.send({ roomSessionId: ROOM, content: "第一条", mentions: ["worker-a"], operationId: "op-message-1" });
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "第二条", mentions: [], operationId: "op-message-2" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "room_turn_active",
	);
	release({ status: "completed", finalContent: "完成" });
	await wait(router, first.turnId);
});

test("RoomMessageRouter: 同 operationId 重玩不写第二条用户事件（完成前后都成立）", async () => {
	const { events, router } = await makeRouter({ bindings: "all" });
	const first = await router.send({ roomSessionId: ROOM, content: "幂等消息", mentions: ["worker-a"], operationId: "op-message-1" });
	await wait(router, first.turnId);
	const replay = await router.send({ roomSessionId: ROOM, content: "幂等消息", mentions: ["worker-a"], operationId: "op-message-1" });
	assert.equal(replay.replayed, true);
	assert.equal(replay.roomEventId, first.roomEventId);
	assert.equal(replay.turnId, first.turnId);
	assert.equal((await events.read(ROOM)).filter((event) => event.actor.kind === "user").length, 1);
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "改了正文", mentions: ["worker-a"], operationId: "op-message-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "message_operation_conflict",
	);
});

test("RoomMessageRouter: 同键并发只有一个准入，两个请求得到同一事件", async () => {
	const { events, router } = await makeRouter({ bindings: "all" });
	const [a, b] = await Promise.all([
		router.send({ roomSessionId: ROOM, content: "并发", mentions: ["worker-a"], operationId: "op-message-1" }),
		router.send({ roomSessionId: ROOM, content: "并发", mentions: ["worker-a"], operationId: "op-message-1" }),
	]);
	assert.equal(a.roomEventId, b.roomEventId);
	assert.equal(a.turnId, b.turnId);
	assert.equal((await events.read(ROOM)).filter((event) => event.actor.kind === "user").length, 1);
	await wait(router, a.turnId);
});

test("RoomMessageRouter: 不同键并发只有首个 Turn，第二个排队", async () => {
	const { turns, runner, router } = await makeRouter({ bindings: "all" });
	let calls = 0;
	let release!: (result: RoomParticipantRunnerResult) => void;
	runner.run = async (input) => {
		await input.markInputDurable();
		calls += 1;
		if (calls === 1) return new Promise<RoomParticipantRunnerResult>((resolve) => { release = resolve; });
		return { status: "completed", finalContent: "排队完成" };
	};
	const results = await Promise.allSettled([
		router.send({ roomSessionId: ROOM, content: "A", mentions: ["worker-a"], operationId: "op-message-1" }),
		router.send({ roomSessionId: ROOM, content: "B", mentions: ["worker-a"], operationId: "op-message-2" }),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
	const accepted = (results[0] as PromiseFulfilledResult<{ turnId: string; persistence?: string }>).value;
	const queued = (results[1] as PromiseFulfilledResult<{ turnId: string; persistence?: string }>).value;
	assert.ok(accepted.persistence === undefined || accepted.persistence === "durable");
	assert.equal(queued.persistence, "pending");
	assert.equal(queued.turnId, accepted.turnId);
	release({ status: "completed", finalContent: "done" });
	await wait(router, accepted.turnId);
	assert.equal((await turns.get(ROOM, accepted.turnId))?.inputs.length, 2);
});

test("RoomMessageRouter: 上下文超预算时不写用户事件", async () => {
	const { events, router } = await makeRouter({ bindings: "all", budget: { maxChars: 10 } });
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "这条消息会让上下文超限", mentions: ["worker-a"], operationId: "op-message-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "context_too_large",
	);
	assert.equal((await events.read(ROOM)).length, 0);
});

test("RoomMessageRouter: runner 未确认输入就失败→不返回 accepted，Turn 进入 unknown", async () => {
	const { events, turns, router } = await makeRouter({ bindings: "all" });
	const realRunner = router as unknown as { deps: { runner: RoomParticipantRunner } };
	realRunner.deps.runner = { run: async () => { throw new Error("provider down"); } };
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "执行", mentions: ["worker-a"], operationId: "op-message-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "message_delivery_unconfirmed",
	);
	const stored = await events.read(ROOM);
	assert.equal(stored.length, 1, "用户事件已经公开，不能假装未发送");
	const turn = (await turns.list(ROOM))[0]!;
	assert.equal(turn.status, "unknown");
	assert.equal((await events.read(ROOM)).length, 1, "不确定结果不能投影成终态");
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "新消息", mentions: [], operationId: "op-message-2" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "room_turn_active",
	);
	await router.closeUnknown(ROOM, turn.id, "用户确认远端无活动 Run");
	assert.equal((await events.read(ROOM))[1]!.kind, "terminal");
});

test("RoomMessageRouter: mentions 非法/多目标不路由，也不写事件", async () => {
	const { events, router } = await makeRouter({ bindings: "all" });
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "x", mentions: ["worker-a", "worker-a"], operationId: "op-message-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "invalid_mentions",
	);
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "x", mentions: ["worker-a", "worker-b"], operationId: "op-message-2" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "invalid_mentions",
	);
	assert.equal((await events.read(ROOM)).length, 0);
});

test("RoomMessageRouter: 缺少 binding 且没有 ensureParticipant 时明确拒绝", async () => {
	const { router } = await makeRouter({ bindings: "none" });
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "x", mentions: ["worker-a"], operationId: "op-message-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "participant_binding_required",
	);
});

test("RoomMessageRouter: ensureParticipant 懒创建 binding 后再路由", async () => {
	const { events, turns, bindings, turnService, operations } = await makeRouter({ bindings: "none" });
	const ensured: string[] = [];
	const routerWithEnsure = new RoomMessageRouter({
		events, turns, bindings, turnService, operations,
		runner: new RecordingRunner({ status: "completed", finalContent: "懒创建后完成" }),
		managerAgentId: "manager",
		budget: { maxChars: 100_000 },
		ensureParticipant: async (roomSessionId, agentId) => {
			ensured.push(agentId);
			const created = await bindings.ensure({
				roomId: ROOM_ID, roomSessionId, agentId, role: "worker",
				agentSessionId: `agent-${agentId}`, cwdSnapshot: "/workspace",
			});
			return created.binding;
		},
	});
	const accepted = await routerWithEnsure.send({ roomSessionId: ROOM, content: "请检查", mentions: ["worker-b"], operationId: "op-message-1" });
	await routerWithEnsure.waitForTurn(ROOM, accepted.turnId);
	assert.deepEqual(ensured, ["worker-b"]);
	assert.equal((await turns.get(ROOM, accepted.turnId))?.status, "completed");
});

test("RoomMessageRouter: 真实 Pi runner 走 SDK preflight 后 durable 并投影 final", async () => {
	const { events, router } = await makeRouter({ bindings: "all" });
	const messages: Array<{ role: string; content: string; stopReason?: string; timestamp: number }> = [];
	const piRunner = new PiParticipantRunner({
		sessions: {
			open: async () => ({
				messages,
				prompt: async (text: string, options?: { preflightResult?: (disposition: unknown) => void }) => {
					options?.preflightResult?.("started");
					messages.push({ role: "user", content: text, timestamp: Date.now() });
					messages.push({ role: "assistant", content: "Pi 结论", stopReason: "stop", timestamp: Date.now() });
				},
			}),
		} as never,
	});
	(router as unknown as { deps: { runner: RoomParticipantRunner } }).deps.runner = piRunner;
	const accepted = await router.send({ roomSessionId: ROOM, content: "执行", mentions: ["worker-a"], operationId: "op-pi-real-1" });
	await wait(router, accepted.turnId);
	const stored = await events.read(ROOM);
	assert.equal(stored.at(-1)?.content, "Pi 结论");
	assert.equal(stored.at(-1)?.kind, "message");
});

test("RoomMessageRouter: 真实 Pi runner 的 prompt 被拒绝时不返回 accepted", async () => {
	const { router } = await makeRouter({ bindings: "all" });
	const piRunner = new PiParticipantRunner({
		sessions: {
			open: async () => ({
				messages: [],
				prompt: async () => { throw new Error("no api key"); },
			}),
		} as never,
	});
	(router as unknown as { deps: { runner: RoomParticipantRunner } }).deps.runner = piRunner;
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "执行", mentions: ["worker-a"], operationId: "op-pi-real-2" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "message_delivery_unconfirmed",
	);
});

test("RoomMessageRouter: 原生 followUp 追加输入、不另起 runner，完成后只投影一次 final", async () => {
	const { events, turns, router } = await makeRouter({ bindings: "all" });
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	let runCalls = 0;
	let followText = "";
	const runner: RoomParticipantRunner = {
		run: async (input) => {
			runCalls += 1;
			await input.markInputDurable("initial-entry");
			await pending;
			return { status: "completed", finalContent: "最终结论" };
		},
		followUp: async (input) => { followText = input.text; await input.markInputDurable("followup-entry"); return "durable" as const; },
	};
	(router as unknown as { deps: { runner: RoomParticipantRunner } }).deps.runner = runner;
	const first = await router.send({ roomSessionId: ROOM, content: "开始", mentions: ["worker-a"], operationId: "op-follow-1" });
	const follow = await router.send({
		roomSessionId: ROOM, content: "补充", mentions: ["worker-a"], operationId: "op-follow-2",
		delivery: "followUp", expectedParticipantTurnId: first.turnId,
	});
	assert.equal(follow.turnId, first.turnId);
	assert.equal(runCalls, 1, "followUp 不能起第二个 runner");
	assert.match(followText, /补充/);
	assert.match(followText, /event=/);
	const active = await turns.get(ROOM, first.turnId);
	assert.equal(active?.inputs.length, 2);
	assert.equal(active?.inputs[1]?.persistence, "durable");
	release();
	await wait(router, first.turnId);
	const stored = await events.read(ROOM);
	assert.equal(stored.filter((event) => event.kind === "message").length, 3, "两个用户输入 + 一次 final");
	assert.equal(stored.filter((event) => event.kind === "terminal").length, 0);
});

test("RoomMessageRouter: queued followUp 先返回 pending，watcher durable 后再完成 final", async () => {
	const { events, turns, router } = await makeRouter({ bindings: "all" });
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const runner: RoomParticipantRunner = {
		run: async (input) => {
			await input.markInputDurable("initial");
			await pending;
			return { status: "completed", finalContent: "最终" };
		},
		followUp: async (input) => {
			setTimeout(() => { void input.markInputDurable("later"); }, 50);
			return "queued";
		},
	};
	(router as unknown as { deps: { runner: RoomParticipantRunner } }).deps.runner = runner;
	const first = await router.send({ roomSessionId: ROOM, content: "开始", mentions: ["worker-a"], operationId: "op-queued-1" });
	const follow = await router.send({
		roomSessionId: ROOM, content: "排队", mentions: ["worker-a"], operationId: "op-queued-2",
		delivery: "followUp", expectedParticipantTurnId: first.turnId,
	});
	assert.equal(follow.persistence, "pending");
	assert.equal((await turns.get(ROOM, first.turnId))?.inputs[1]?.persistence, "pending");
	release();
	await wait(router, first.turnId);
	const stored = await events.read(ROOM);
	assert.equal(stored.filter((event) => event.kind === "message").length, 3, "watcher durable 后 final 才能投影");
	assert.equal((await turns.get(ROOM, first.turnId))?.status, "completed");
});

test("RoomMessageRouter: 不支持 followUp 时在写 RoomEvent 之前拒绝", async () => {
	const { events, turns, router } = await makeRouter({ bindings: "all" });
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const runner: RoomParticipantRunner = {
		run: async (input) => { await input.markInputDurable("initial"); await pending; return { status: "completed", finalContent: "完成" }; },
		supportsFollowUp: async () => false,
	};
	(router as unknown as { deps: { runner: RoomParticipantRunner } }).deps.runner = runner;
	const first = await router.send({ roomSessionId: ROOM, content: "开始", mentions: ["worker-a"], operationId: "op-unsupported-1" });
	await assert.rejects(
		() => router.send({
			roomSessionId: ROOM, content: "追问", mentions: ["worker-a"], operationId: "op-unsupported-2",
			delivery: "followUp", expectedParticipantTurnId: first.turnId,
		}),
		(error: unknown) => error instanceof RoomMessageError && error.code === "participant_delivery_unsupported",
	);
	const stored = await events.read(ROOM);
	assert.equal(stored.length, 1, "被拒绝的 followUp 不得写公共事件");
	assert.equal((await turns.get(ROOM, first.turnId))?.inputs.length, 1, "不得残留 pending 输入");
	release();
	await wait(router, first.turnId);
});

test("RoomMessageRouter: 非 Pi 活动回合的 normal 输入排队，首个 run 结束后顺序执行", async () => {
	const { events, turns, router } = await makeRouter({ bindings: "all" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let runs = 0;
	const runner: RoomParticipantRunner = {
		run: async (input) => {
			runs += 1;
			if (runs === 1) {
				await input.markInputDurable("entry-1");
				await gate;
				return { status: "completed", finalContent: "第一段" };
			}
			await input.markInputDurable("entry-2");
			return { status: "completed", finalContent: "排队后的最终结论" };
		},
	};
	(router as unknown as { deps: { runner: RoomParticipantRunner } }).deps.runner = runner;
	const first = await router.send({ roomSessionId: ROOM, content: "第一问", mentions: ["worker-a"], operationId: "op-next-1" });
	const queued = await router.send({ roomSessionId: ROOM, content: "排队追问", mentions: ["worker-a"], operationId: "op-next-2" });
	assert.equal(queued.persistence, "pending");
	assert.equal(queued.turnId, first.turnId);
	assert.equal((await turns.get(ROOM, first.turnId))?.inputs.length, 2);
	release();
	await wait(router, first.turnId);
	const stored = await events.read(ROOM);
	assert.equal(stored.filter((event) => event.actor.kind === "user").length, 2);
	assert.equal(stored.at(-1)?.content, "排队后的最终结论");
	assert.equal(runs, 2);
});

test("RoomMessageRouter: 用户事件写入知识来源 id 与 room origin", async () => {
	const { events, router } = await makeRouter({ bindings: "all" });
	let origin: Record<string, unknown> | undefined;
	(router as unknown as { deps: { knowledge?: unknown } }).deps.knowledge = {
		ownerId: "owner-1",
		sources: {
			createText: async (_owner: string, _text: string, value?: Record<string, unknown>) => {
				origin = value;
				return { id: "knowledge-source-1" };
			},
		},
	};
	await router.send({ roomSessionId: ROOM, content: "来源测试", mentions: ["worker-a"], operationId: "op-knowledge-1" });
	const [event] = await events.read(ROOM);
	assert.deepEqual(event?.knowledgeSourceIds, ["knowledge-source-1"]);
	assert.equal(origin?.roomSessionId, ROOM);
	assert.equal(origin?.sourceRoomEventId, event?.id);
	assert.equal(origin?.sessionId, "agent-worker-a");
	assert.equal(origin?.windowId, ROOM_ID);
});
