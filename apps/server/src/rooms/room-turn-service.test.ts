import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RoomEventStore, type RoomEventDraft } from "./room-event-store.js";
import { ParticipantTurnStore } from "./participant-turn-store.js";
import { InMemoryParticipantBindingRegistry } from "./participant-binding-registry.js";
import { RoomTurnService, RoomTurnServiceError } from "./room-turn-service.js";

const ROOM = "room-1111-2222";
const ROOM_ID = "room-id-1";

function draft(overrides: Partial<RoomEventDraft> = {}): RoomEventDraft {
	return {
		id: overrides.id ?? "event-user-1",
		kind: "message",
		actor: { kind: "user" },
		content: "请检查",
		mentions: ["worker-a"],
		createdAt: "2026-10-31T00:00:00.000Z",
		...overrides,
	};
}

async function makeService(bind = true) {
	const root = mkdtempSync(path.join(tmpdir(), "pt-room-turn-service-"));
	const events = new RoomEventStore(root);
	await events.create(ROOM);
	await events.append(ROOM, draft());
	const turns = new ParticipantTurnStore(root);
	const bindings = new InMemoryParticipantBindingRegistry();
	if (bind) {
		await bindings.ensure({
			roomId: ROOM_ID, roomSessionId: ROOM, agentId: "worker-a", role: "worker",
			agentSessionId: "agent-session-1", cwdSnapshot: "/workspace",
		});
	}
	const service = new RoomTurnService({ events, turns, bindings });
	return { root, events, turns, bindings, service };
}

const beginInput = {
	roomSessionId: ROOM,
	agentId: "worker-a",
	agentSessionId: "agent-session-1",
	sourceRoomEventId: "event-user-1",
	operationId: "op-1",
	inputHash: "a".repeat(64),
};

test("RoomTurnService: final 先落 Turn，再幂等投影 RoomEvent 并推进水位", async () => {
	const { events, turns, bindings, service } = await makeService();
	const { turn } = await service.begin(beginInput);
	await service.start(ROOM, turn.id);
	await service.markInputDurable(ROOM, turn.id, "op-1");
	await service.complete(ROOM, turn.id, "最终结论");
	const before = await turns.get(ROOM, turn.id);
	assert.equal(before?.status, "completed");
	assert.equal(before?.publicProjectionState, "pending");

	const projected = await service.project(ROOM, turn.id);
	assert.equal(projected.created, true);
	assert.equal(projected.event?.kind, "message");
	assert.equal(projected.event?.content, "最终结论");
	assert.equal(projected.event?.sourceParticipantTurnId, turn.id);
	assert.equal(projected.turn.publicProjectionState, "projected");
	assert.equal(projected.watermarkAdvanced, true);
	assert.equal((await bindings.get(ROOM, "worker-a"))?.lastRoomEntryId, projected.event?.id);

	const replay = await service.project(ROOM, turn.id);
	assert.equal(replay.created, false);
	assert.equal((await events.read(ROOM)).filter((event) => event.sourceParticipantTurnId === turn.id).length, 1);
});

test("RoomTurnService: 取消/失败没有 public final 时只写 terminal，且不推进水位", async () => {
	const { events, bindings, service } = await makeService();
	const first = await service.begin({ ...beginInput, operationId: "op-1" });
	await service.start(ROOM, first.turn.id);
	await service.cancel(ROOM, first.turn.id, "用户停止");
	const cancelled = await service.project(ROOM, first.turn.id);
	assert.equal(cancelled.event?.kind, "terminal");
	assert.match(cancelled.event?.content ?? "", /本次执行已取消：用户停止/);
	assert.equal(cancelled.watermarkAdvanced, false);
	assert.equal((await bindings.get(ROOM, "worker-a"))?.lastRoomEntryId, undefined);

	const second = await service.begin({ ...beginInput, operationId: "op-2", turnId: "turn-2" });
	const failed = await service.fail(ROOM, second.turn.id, "provider error");
	const projected = await service.project(ROOM, second.turn.id);
	assert.equal(projected.event?.kind, "terminal");
	assert.match(projected.event?.content ?? "", /本次执行失败：provider error/);
	assert.equal(projected.turn.status, "failed");
	assert.equal((await events.read(ROOM)).filter((event) => event.kind === "terminal").length, 2);
});

test("RoomTurnService: 未终态 Turn 不能投影", async () => {
	const { service } = await makeService();
	const { turn } = await service.begin(beginInput);
	await assert.rejects(() => service.project(ROOM, turn.id), (error: unknown) =>
		error instanceof RoomTurnServiceError && error.code === "turn_not_terminal");
});

test("RoomTurnService: begin 校验 binding、source 事件与 agentSession 身份", async () => {
	const { service } = await makeService(false);
	await assert.rejects(() => service.begin(beginInput), (error: unknown) =>
		error instanceof RoomTurnServiceError && error.code === "participant_binding_required");

	const withBinding = await makeService(true);
	await assert.rejects(() => withBinding.service.begin({ ...beginInput, agentSessionId: "other" }), RoomTurnServiceError);
	await assert.rejects(() => withBinding.service.begin({ ...beginInput, sourceRoomEventId: "missing" }), (error: unknown) =>
		error instanceof RoomTurnServiceError && error.code === "invalid_cutoff");
	await assert.rejects(() => withBinding.service.begin({ ...beginInput, contextFromAfterRoomEventId: "missing" }), (error: unknown) =>
		error instanceof RoomTurnServiceError && error.code === "invalid_cutoff");
});

test("RoomTurnService: 重启后 recoverPending 补齐未投影终态", async () => {
	const { root, service, bindings } = await makeService();
	const { turn } = await service.begin(beginInput);
	await service.start(ROOM, turn.id);
	await service.markInputDurable(ROOM, turn.id, "op-1");
	await service.complete(ROOM, turn.id, "崩溃前已持久");
	// 模拟进程重启：新的 store/service 实例读同一目录。
	const restartedEvents = new RoomEventStore(root);
	const restartedTurns = new ParticipantTurnStore(root);
	const restarted = new RoomTurnService({ events: restartedEvents, turns: restartedTurns, bindings });
	const recovered = await restarted.recoverPending(ROOM);
	assert.deepEqual(recovered, [{ turnId: turn.id, projected: true }]);
	assert.equal((await restartedEvents.read(ROOM)).filter((event) => event.sourceParticipantTurnId === turn.id).length, 1);
	assert.equal((await restartedTurns.get(ROOM, turn.id))?.publicProjectionState, "projected");
});

test("InMemoryParticipantBindingRegistry: active 唯一、CAS 水位与退役", async () => {
	const registry = new InMemoryParticipantBindingRegistry();
	const input = {
		roomId: ROOM_ID, roomSessionId: ROOM, agentId: "worker-a", role: "worker" as const,
		agentSessionId: "agent-session-1", cwdSnapshot: "/workspace",
	};
	const first = await registry.ensure(input);
	assert.equal(first.created, true);
	assert.equal(first.binding.revision, 1);
	const replay = await registry.ensure(input);
	assert.equal(replay.created, false);
	await assert.rejects(
		() => registry.ensure({ ...input, agentSessionId: "agent-session-2" }),
		/已有另一 active binding/,
	);

	const advanced = await registry.advanceWatermark(ROOM, "worker-a", 1, "event-1");
	assert.equal(advanced.revision, 2);
	assert.equal(advanced.lastRoomEntryId, "event-1");
	await assert.rejects(
		() => registry.advanceWatermark(ROOM, "worker-a", 1, "event-2"),
		/participant binding revision conflict/,
	);

	const retired = await registry.retire(ROOM, "worker-a", "configuration_changed");
	assert.equal(retired.state, "retired");
	assert.equal(await registry.get(ROOM, "worker-a"), undefined);
	assert.equal(await registry.findActiveBySession(ROOM, "agent-session-1"), undefined);
});
