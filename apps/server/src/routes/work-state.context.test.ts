import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { TeamsStore } from "../store/teams.js";
import { WorkStateStore } from "../store/work-state.js";
import { registerWorkStateRoutes } from "./work-state.js";

async function makeStack() {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-work-state-context-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const workStates = new WorkStateStore(path.join(dir, "work-state"));
	await workStates.init();
	const app = Fastify({ logger: false });
	registerWorkStateRoutes(app, workStates, teams, sessions);
	const solo = await teams.ensureSoloWindow(
		async (workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
		async () => false,
	);
	return { app, teams, sessions, invoker, workStates, solo };
}

async function parkSolo(
	stack: Awaited<ReturnType<typeof makeStack>>,
): Promise<void> {
	const workspace = await stack.teams.workspaces.createManaged("park-target");
	await stack.invoker.switchWorkspaceInPlace(
		stack.solo.id,
		workspace.id,
		async (source, cwd) => stack.sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd }),
		(id) => stack.sessions.prepareForParking(id),
		(id) => stack.sessions.validateStoredContext(id),
		(id) => stack.sessions.suspend(id),
		(id) => stack.sessions.remove(id),
	);
}

test("parked Session 不能恢复 Goal，且不会改变 durable work-state", async () => {
	const stack = await makeStack();
	const created = await stack.workStates.create({
		sessionId: stack.solo.activeSession,
		goal: "恢复测试",
		completionBoundary: "完成",
	});
	const interrupted = await stack.workStates.interruptGoal(
		stack.solo.activeSession,
		created.revision,
		{ kind: "user", fingerprint: "parked-resume", delegationIds: [] },
		"interrupt-before-park",
		created.goalId,
	);
	await parkSolo(stack);
	const response = await stack.app.inject({
		method: "POST",
		url: `/api/sessions/${stack.solo.activeSession}/goal/resume`,
		headers: { "idempotency-key": "resume-while-parked" },
		payload: { expectedGoalId: created.goalId, expectedRevision: interrupted.revision },
	});
	assert.equal(response.statusCode, 409, response.body);
	assert.deepEqual(response.json(), { error: "session_context_inactive" });
	assert.equal((await stack.workStates.getGoal(stack.solo.activeSession, created.goalId))?.execution.status, "interrupted");
	await stack.sessions.disposeAll();
	await stack.app.close();
});

test("parked Session 的 Decision 不能被回答，也不会提前消费恢复事件", async () => {
	const stack = await makeStack();
	const goal = await stack.workStates.create({
		sessionId: stack.solo.activeSession,
		goal: "决策测试",
		completionBoundary: "完成",
	});
	const decision = await stack.workStates.createDecision({
		sessionId: stack.solo.activeSession,
		requestedBy: "manager",
		question: "是否继续？",
		context: "测试",
		blockedAction: "继续执行",
		resumeHint: "按答案继续",
	}, "create-decision", goal.revision, goal.goalId);
	await parkSolo(stack);
	const response = await stack.app.inject({
		method: "POST",
		url: `/api/decision-requests/${decision.id}/answer`,
		headers: { "idempotency-key": "answer-while-parked" },
		payload: { answer: "继续" },
	});
	assert.equal(response.statusCode, 409, response.body);
	assert.deepEqual(response.json(), { error: "session_context_inactive" });
	assert.equal((await stack.workStates.getDecision(decision.id))?.status, "pending");
	assert.equal((await stack.workStates.pendingOutbox()).some((event) => event.id === `decision-answered:${goal.goalId}:${decision.id}`), false);
	await stack.sessions.disposeAll();
	await stack.app.close();
});
