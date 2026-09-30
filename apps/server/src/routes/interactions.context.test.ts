import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { AgentRuntime } from "../agent-runtime/runtime.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import type { TeamsStore } from "../store/teams.js";
import { registerInteractionsRoutes } from "./interactions.js";

test("stale approval in a parked Manager workspace is a conflict, not a server error", async () => {
	const app = Fastify();
	const runtime = {
		getDelegationById: async () => ({ windowId: "worker-window" }),
	} as unknown as AgentRuntime;
	const invoker = {
		respond: async () => { throw new Error("该审批所属项目未激活，请先切换回对应项目"); },
	} as unknown as AgentInvoker;
	registerInteractionsRoutes(app, runtime, invoker, {} as TeamsStore);
	try {
		const response = await app.inject({
			method: "POST",
			url: "/api/interactions/parked-approval/responses",
			payload: {
				requestId: "late-approval-1",
				revision: 0,
				windowId: "worker-window",
				responses: [{ requestId: "worker-request", action: "approve", scope: "once" }],
			},
		});
		assert.equal(response.statusCode, 409, response.body);
		assert.equal(response.json().code, "interaction_context_inactive");
	} finally {
		await app.close();
	}
});

test("single interaction response exposes only card fields, not Worker handles or internal decision state", async () => {
	const app = Fastify();
	const runtime = {
		getInteraction: async () => ({
			id: "interaction-1", delegationId: "delegation-1", source: "worker", kind: "permission",
			requests: [{ requestId: "permission-1", prompt: "允许执行？", options: ["once", "reject"] }],
			status: "pending", revision: 2, providerStateRef: "secret-ref", consumedRequestId: "private-operation",
			policyContext: { reasonCode: "cwd_not_honored", allowedActions: ["cancel"], workerStarted: false, capabilityFingerprint: "private-fingerprint" },
			decision: { chosenAction: "cancel", actorId: "private-actor", requestId: "private-request" },
			application: { status: "failed", failureCode: "fixture", operationId: "private-application" },
		}),
		getDelegationById: async () => ({
			id: "delegation-1", goalId: "goal-1", workerStarted: true,
			windowId: "worker-window", managerSessionId: "manager-session", cwdSnapshot: "/private/workspace",
			sessionHandle: "private-session-handle", runHandle: "private-run-handle",
			options: { apiKey: "private-key" }, receipt: { secret: "private-receipt" },
		}),
	} as unknown as AgentRuntime;
	const invoker = { replacementCandidates: async () => [] } as unknown as AgentInvoker;
	registerInteractionsRoutes(app, runtime, invoker, {} as TeamsStore);
	try {
		const response = await app.inject({ method: "GET", url: "/api/interactions/interaction-1" });
		assert.equal(response.statusCode, 200, response.body);
		assert.deepEqual(response.json(), {
			interaction: {
				id: "interaction-1", delegationId: "delegation-1", source: "worker", kind: "permission",
				requests: [{ requestId: "permission-1", prompt: "允许执行？", options: ["once", "reject"] }],
				status: "pending", revision: 2, replacementCandidates: [],
				policySummary: { reasonCode: "cwd_not_honored", allowedActions: ["cancel"], workerStarted: false },
				decision: { chosenAction: "cancel" },
				application: { status: "failed", failureCode: "fixture" },
			},
			delegation: { goalId: "goal-1", workerStarted: true },
		});
		for (const secret of ["private-session-handle", "private-run-handle", "private-key", "private-receipt", "private-fingerprint", "private-actor", "private-operation", "private-application"]) {
			assert.equal(response.body.includes(secret), false, secret);
		}
	} finally {
		await app.close();
	}
});

test("approval submission projects both success and failure without Worker handles or arbitrary meta", async () => {
	for (const status of ["completed", "failed"] as const) {
		const app = Fastify();
		const runtime = { getDelegationById: async () => ({ windowId: "worker-window" }) } as unknown as AgentRuntime;
		const invoker = {
			respond: async () => ({
				status,
				content: "Authorization: Bearer private-test-token",
				details: { privateWorkerMeta: "private-meta" },
				delegationId: "delegation-1",
				interactionId: "interaction-1",
				waitingInput: false,
				runHandle: "private-run-handle",
				sessionHandle: "private-session-handle",
			}),
		} as unknown as AgentInvoker;
		registerInteractionsRoutes(app, runtime, invoker, {} as TeamsStore);
		try {
			const response = await app.inject({
				method: "POST", url: "/api/interactions/interaction-1/responses",
				payload: { requestId: "approval-1", revision: 0, windowId: "worker-window", responses: [{ requestId: "permission-1", action: "approve", scope: "once" }] },
			});
			assert.equal(response.statusCode, status === "failed" ? 502 : 200, response.body);
			assert.deepEqual(response.json().outcome, {
				status, delegationId: "delegation-1", interactionId: "interaction-1", waitingInput: false,
			});
			for (const secret of ["private-test-token", "private-meta", "private-run-handle", "private-session-handle"]) {
				assert.equal(response.body.includes(secret), false, secret);
			}
		} finally {
			await app.close();
		}
	}
});

test("unexpected approval errors redact credential-shaped text", async () => {
	const app = Fastify();
	const runtime = { getDelegationById: async () => ({ windowId: "worker-window" }) } as unknown as AgentRuntime;
	const invoker = { respond: async () => { throw new Error("Authorization: Bearer private-test-token"); } } as unknown as AgentInvoker;
	registerInteractionsRoutes(app, runtime, invoker, {} as TeamsStore);
	try {
		const response = await app.inject({
			method: "POST", url: "/api/interactions/interaction-1/responses",
			payload: { requestId: "approval-1", revision: 0, windowId: "worker-window", responses: [{ requestId: "permission-1", action: "approve", scope: "once" }] },
		});
		assert.equal(response.statusCode, 500, response.body);
		assert.equal(response.body.includes("private-test-token"), false);
	} finally {
		await app.close();
	}
});
