import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DelegationStore } from "./delegation-store.js";
import { InteractionBroker, InteractionError } from "./interaction-broker.js";

test("Interaction requestId 只对相同 payload 幂等，不同回答返回 conflict", async () => {
	const store = new DelegationStore(mkdtempSync(path.join(tmpdir(), "pt-interaction-idem-")));
	await store.init();
	const interaction = await store.createInteraction({
		delegationId: "D1",
		kind: "permission",
		requests: [{ requestId: "permission-1", prompt: "允许？", options: ["once", "session"] }],
		providerStateRef: "secret",
	});
	const broker = new InteractionBroker(store);
	const input = { requestId: "submit-1", revision: 0, responses: [{ requestId: "permission-1", action: "approve" as const, scope: "once" as const }] };
	const first = await broker.submit(interaction.id, input);
	assert.equal(first.replayed, false);
	const replay = await broker.submit(interaction.id, input);
	assert.equal(replay.replayed, true);
	await assert.rejects(
		() => broker.submit(interaction.id, { ...input, responses: [{ requestId: "permission-1", action: "approve", scope: "session" }] }),
		(error: unknown) => error instanceof InteractionError && error.code === "idempotency_conflict",
	);
});

test("Interaction 回答必须无重复 requestId 且 action 合法", async () => {
	const store = new DelegationStore(mkdtempSync(path.join(tmpdir(), "pt-interaction-cover-")));
	await store.init();
	const broker = new InteractionBroker(store);
	const duplicate = await store.createInteraction({
		delegationId: "D2", kind: "permission",
		requests: [{ requestId: "permission-2", prompt: "允许？", options: ["once"] }], providerStateRef: "secret",
	});
	await assert.rejects(() => broker.submit(duplicate.id, {
		requestId: "submit-dup", revision: 0,
		responses: [
			{ requestId: "permission-2", action: "approve", scope: "once" },
			{ requestId: "permission-2", action: "reject" },
		],
	}), (error: unknown) => error instanceof InteractionError && error.code === "incomplete_responses");
	await assert.rejects(() => broker.submit(duplicate.id, {
		requestId: "submit-invalid", revision: 0,
		responses: [{ requestId: "permission-2", action: "unknown" as "approve" }],
	}), (error: unknown) => error instanceof InteractionError && error.code === "incomplete_responses");
});
