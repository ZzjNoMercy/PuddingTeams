import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomEventStore } from "./room-event-store.js";
import { ParticipantTurnStore } from "./participant-turn-store.js";
import { InMemoryParticipantBindingRegistry } from "./participant-binding-registry.js";
import { RoomTurnService } from "./room-turn-service.js";
import {
	RoomMessageError,
	RoomMessageRouter,
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
		return this.result;
	}
}

async function makeRouter(opts: { maxContextChars?: number; bindings?: "all" | "worker" | "none" } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-router-"));
	const events = new RoomEventStore(root);
	await events.create(ROOM);
	const turns = new ParticipantTurnStore(root);
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
		events, turns, bindings, turnService, runner,
		managerAgentId: "manager",
		agentNames: { manager: "Manager", "worker-a": "WorkerA" },
		...(opts.maxContextChars ? { maxContextChars: opts.maxContextChars } : {}),
	});
	return { root, events, turns, bindings, turnService, runner, router };
}

test("RoomMessageRouter: @Worker 只运行 Worker，final 进入公共历史且 Manager 不被调用", async () => {
	const { events, turns, bindings, runner, router } = await makeRouter({ bindings: "all" });
	const result = await router.send({ roomSessionId: ROOM, content: "请检查方案", mentions: ["worker-a"], operationId: "op-1" });
	assert.equal(result.status, "completed");
	assert.equal(result.finalContent, "WorkerA 的结论");
	assert.equal(runner.calls.length, 1);
	assert.equal(runner.calls[0]!.binding.agentId, "worker-a");
	assert.match(runner.calls[0]!.prompt, /\[当前用户消息｜用户 → @WorkerA｜event=/);
	const stored = await events.read(ROOM);
	assert.equal(stored.length, 2);
	assert.equal(stored[0]!.actor.kind, "user");
	assert.equal(stored[1]!.kind, "message");
	assert.equal(stored[1]!.actor.kind, "agent");
	assert.equal((stored[1]!.actor as { agentId: string }).agentId, "worker-a");
	assert.equal(stored[1]!.sourceParticipantTurnId, result.turnId);
	const turn = await turns.get(ROOM, result.turnId);
	assert.equal(turn?.status, "completed");
	assert.equal(turn?.publicProjectionState, "projected");
	assert.equal((await bindings.get(ROOM, "worker-a"))?.lastRoomEntryId, stored[1]!.id);
});

test("RoomMessageRouter: 无 mentions 路由 Manager，并能读到之前的 Worker 公共 final", async () => {
	const { runner, router } = await makeRouter({ bindings: "all" });
	await router.send({ roomSessionId: ROOM, content: "先问 Worker", mentions: ["worker-a"], operationId: "op-1" });
	const before = runner.calls.length;
	const result = await router.send({ roomSessionId: ROOM, content: "再问 Manager", mentions: [], operationId: "op-2" });
	assert.equal(runner.calls.length, before + 1);
	assert.equal(runner.calls.at(-1)!.binding.agentId, "manager");
	assert.match(runner.calls.at(-1)!.prompt, /WorkerA 的结论/, "Manager 应看到 Worker 的公共 final");
	assert.equal(result.status, "completed");
});

test("RoomMessageRouter: 同一房间串行，活动回合时拒绝新 normal 消息", async () => {
	const { runner, router } = await makeRouter({ bindings: "all" });
	let release!: (result: RoomParticipantRunnerResult) => void;
	const pending = new Promise<RoomParticipantRunnerResult>((resolve) => { release = resolve; });
	runner.run = async (input) => {
		runner.calls.push(input);
		return pending;
	};
	const first = router.send({ roomSessionId: ROOM, content: "第一条", mentions: ["worker-a"], operationId: "op-1" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "第二条", mentions: [], operationId: "op-2" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "room_turn_active",
	);
	release({ status: "completed", finalContent: "完成" });
	await first;
});

test("RoomMessageRouter: 上下文超预算时不写用户事件", async () => {
	const { events, router } = await makeRouter({ bindings: "all", maxContextChars: 10 });
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "这条消息会让上下文超限", mentions: ["worker-a"], operationId: "op-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "context_too_large",
	);
	assert.equal((await events.read(ROOM)).length, 0);
});

test("RoomMessageRouter: runner 失败落 failed + terminal，不伪装 completed", async () => {
	const { events, runner, router } = await makeRouter({ bindings: "all" });
	runner.run = async () => { throw new Error("provider down"); };
	const result = await router.send({ roomSessionId: ROOM, content: "执行", mentions: ["worker-a"], operationId: "op-1" });
	assert.equal(result.status, "failed");
	assert.match(result.finalContent ?? "", /^$/);
	const stored = await events.read(ROOM);
	assert.equal(stored.length, 2);
	assert.equal(stored[1]!.kind, "terminal");
	assert.match(stored[1]!.content, /provider down/);
});

test("RoomMessageRouter: mentions 非法/多目标不路由，也不写事件", async () => {
	const { events, router } = await makeRouter({ bindings: "all" });
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "x", mentions: ["worker-a", "worker-a"], operationId: "op-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "invalid_mentions",
	);
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "x", mentions: ["worker-a", "worker-b"], operationId: "op-2" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "invalid_mentions",
	);
	assert.equal((await events.read(ROOM)).length, 0);
});

test("RoomMessageRouter: 缺少 binding 且没有 ensureParticipant 时明确拒绝", async () => {
	const { router } = await makeRouter({ bindings: "none" });
	await assert.rejects(
		() => router.send({ roomSessionId: ROOM, content: "x", mentions: ["worker-a"], operationId: "op-1" }),
		(error: unknown) => error instanceof RoomMessageError && error.code === "participant_binding_required",
	);
});

test("RoomMessageRouter: ensureParticipant 懒创建 binding 后再路由", async () => {
	const { events, turns, bindings, turnService } = await makeRouter({ bindings: "none" });
	const ensured: string[] = [];
	const routerWithEnsure = new RoomMessageRouter({
		events, turns, bindings, turnService,
		runner: new RecordingRunner({ status: "completed", finalContent: "懒创建后完成" }),
		managerAgentId: "manager",
		ensureParticipant: async (roomSessionId, agentId) => {
			ensured.push(agentId);
			const created = await bindings.ensure({
				roomId: ROOM_ID, roomSessionId, agentId, role: "worker",
				agentSessionId: `agent-${agentId}`, cwdSnapshot: "/workspace",
			});
			return created.binding;
		},
	});
	const result = await routerWithEnsure.send({ roomSessionId: ROOM, content: "请检查", mentions: ["worker-b"], operationId: "op-1" });
	assert.deepEqual(ensured, ["worker-b"]);
	assert.equal(result.status, "completed");
});
