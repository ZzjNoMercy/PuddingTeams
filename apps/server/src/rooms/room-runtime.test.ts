import { test } from "node:test";
import assert from "node:assert";
import { ConnectorParticipantRunner } from "./room-runtime.js";
import { RoomMessageError } from "./room-message-router.js";
import type { ParticipantBinding } from "./participant-binding-registry.js";

const binding: ParticipantBinding = {
	agentSessionId: "session-1", roomId: "room-id-1", roomSessionId: "room-1111-2222",
	agentId: "worker-a", role: "worker", state: "active", cwdSnapshot: "/workspace",
	revision: 1, createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z",
};
const input = { roomSessionId: binding.roomSessionId, turn: {} as never, binding, text: "补充", markInputDurable: async () => undefined };

test("ConnectorParticipantRunner: native Pi 委派 followUp，非 Pi 409", async () => {
	let followed = 0;
	const pi = { run: async () => ({ status: "completed" as const }), followUp: async () => { followed += 1; return "durable" as const; } };
	const connector = new ConnectorParticipantRunner({
		teams: { getAgent: async () => ({ name: "worker-a", description: "", invoke: { type: "pi" } }) } as never,
		pi: pi as never,
		direct: undefined,
	});
	assert.equal(await connector.followUp!(input), "durable");
	assert.equal(followed, 1);
	const nonPi = new ConnectorParticipantRunner({
		teams: { getAgent: async () => ({ name: "worker-a", description: "", invoke: { type: "command", command: "x", runArgs: [] } }) } as never,
		pi: pi as never,
		direct: undefined,
	});
	await assert.rejects(() => nonPi.followUp!(input), (error: unknown) => error instanceof RoomMessageError && error.code === "participant_delivery_unsupported");
	assert.equal(followed, 1);
});
