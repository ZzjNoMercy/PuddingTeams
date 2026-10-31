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

test("RoomMessageRouter: 不同键并发只有一个接单", async () => {
	const { runner, router } = await makeRouter({ bindings: "all" });
	let release!: (result: RoomParticipantRunnerResult) => void;
	runner.run = async (input) => { await input.markInputDurable(); return new Promise<RoomParticipantRunnerResult>((resolve) => { release = resolve; }); };
	const results = await Promise.allSettled([
		router.send({ roomSessionId: ROOM, content: "A", mentions: ["worker-a"], operationId: "op-message-1" }),
		router.send({ roomSessionId: ROOM, content: "B", mentions: ["worker-a"], operationId: "op-message-2" }),
	]);
	const fulfilled = results.filter((result) => result.status === "fulfilled");
	const rejected = results.filter((result) => result.status === "rejected");
	assert.equal(fulfilled.length, 1);
	assert.equal(rejected.length, 1);
	assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof RoomMessageError);
	release({ status: "completed", finalContent: "done" });
	const accepted = (fulfilled[0] as PromiseFulfilledResult<{ turnId: string }>).value;
	await wait(router, accepted.turnId);
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
