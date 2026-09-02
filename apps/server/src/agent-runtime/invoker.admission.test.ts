import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore, type AgentConfig } from "../store/teams.js";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { DriverRegistry } from "./driver-registry.js";
import { AgentInvoker } from "./invoker.js";
import { WorkspaceExecutionCoordinator } from "./workspace-execution.js";
import type { AgentDriver } from "./types.js";
import { WorkStateStore, workItemContractHash } from "../store/work-state.js";

function temp(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

test("Worker 无法保证只读时，AgentInvoker 立即返回 Teams 准入请求且不启动 Driver", async () => {
	const root = temp("pt-invoker-admission-root-");
	const state = temp("pt-invoker-admission-state-");
	const teams = new TeamsStore(
		{ state, assets: state, managedWorkspaces: path.join(state, "managed") },
		root,
	);
	await teams.init();
	const agent: AgentConfig = {
		name: "worker",
		description: "cannot guarantee cwd",
		invoke: { type: "command", command: "worker", runArgs: ["run"] },
		enabled: true,
	};
	await teams.upsertAgent(agent);
	const saved = (await teams.getAgent(agent.name))!;
	const window = await teams.createWindow({
		type: "direct",
		members: [agent.name],
		sessionId: "manager-session",
	});

	let driverStarted = false;
	const driver: AgentDriver = {
		id: agent.name,
		async capabilities() {
			return { operations: ["run"], interactionKinds: [], progress: "stream", transport: "spawn" };
		},
		async *run() { driverStarted = true; },
		async *continue() {},
		async *respond() {},
		async probe() {
			return {
				extensionInstalled: true,
				detected: true,
				configured: true,
				authenticated: "unknown" as const,
				enabled: true,
				compatibility: "supported" as const,
				capabilities: await this.capabilities(),
				issues: [],
			};
		},
	};
	const delegations = new DelegationStore(state);
	await delegations.init();
	const secrets = new InteractionSecretStore(state);
	await secrets.init();
	const coordinator = new WorkspaceExecutionCoordinator(state, {
		worktreeRoot: temp("pt-invoker-admission-worktrees-"),
	});
	await coordinator.init();
	const drivers = new DriverRegistry();
	drivers.register(driver);
	const runtime = new AgentRuntime(
		delegations,
		secrets,
		() => driver,
		{ ttlMs: 60_000 },
		undefined,
		undefined,
		coordinator,
	);
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, root);

	const outcome = await Promise.race([
		invoker.delegate({
			windowId: window.id,
			managerSessionId: "manager-session",
			managerToolCallId: "call-preflight",
			agent: saved,
			message: "inspect only",
			mode: "run",
			workspaceExecutionPolicy: {
				mode: "read_only_shared",
				source: "manager_derived",
				reason: "read-only inspection",
				baselineStrategy: "filesystem_manifest",
				promoteOnAcceptance: false,
			},
		}),
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error("AgentInvoker admission barrier did not settle")), 500),
		),
	]);

	assert.equal(outcome.status, "needs_input");
	assert.equal(outcome.details.source, "platform_policy");
	assert.equal(outcome.details.workerStarted, false);
	assert.match(outcome.content, /Worker 尚未启动/);
	assert.equal(driverStarted, false, "等待 Teams 准入不得启动 Driver");
	const [record] = await runtime.listDelegations(window.id, "manager-session");
	assert.equal(record?.managerToolCallId, "call-preflight");
	assert.equal(record?.executionState, "waiting_admission");
	assert.equal(record?.workerStarted, false);
	assert.equal(record?.receipt, undefined);
});

test("Teams 准入卡只列出能补足只读缺口的 Worker，并以新 Delegation 完成改派", async () => {
	const root = temp("pt-invoker-replacement-root-");
	const state = temp("pt-invoker-replacement-state-");
	const teams = new TeamsStore({ state, assets: state, managedWorkspaces: path.join(state, "managed") }, root);
	await teams.init();
	for (const agent of [
		{ name: "unsafe", description: "no read-only boundary", invoke: { type: "command" as const, command: "unsafe", runArgs: ["run"] }, enabled: true },
		{ name: "safe", description: "read-only sandbox", invoke: { type: "command" as const, command: "safe", runArgs: ["run"] }, enabled: true },
		{ name: "also-unsafe", description: "still no boundary", invoke: { type: "command" as const, command: "also-unsafe", runArgs: ["run"] }, enabled: true },
	]) await teams.upsertAgent(agent);
	const window = await teams.createWindow({ type: "group", members: ["unsafe", "safe", "also-unsafe"], sessionId: "manager-session" });
	let unsafeStarted = false;
	let safeStarted = false;
	const unsafeDriver = (id: string): AgentDriver => ({
		id,
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "stream", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: [] } }; },
		async *run() { unsafeStarted = true; }, async *continue() {}, async *respond() {},
		async probe() { throw new Error("unused"); },
	});
	const safeDriver: AgentDriver = {
		id: "safe",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "stream", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "sandbox", mutationObservation: [] } }; },
		async *run() {
			safeStarted = true;
			yield { type: "started", sessionHandle: "safe-session", runHandle: "safe-run" };
			yield { type: "completed", result: { agentId: "safe", status: "completed", content: "done" } };
		},
		async *continue() {}, async *respond() {}, async probe() { throw new Error("unused"); },
	};
	const drivers = new DriverRegistry();
	drivers.register(unsafeDriver("unsafe"));
	drivers.register(unsafeDriver("also-unsafe"));
	drivers.register(safeDriver);
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, root);
	const workStates = new WorkStateStore(path.join(state, "work-states")); await workStates.init();
	const goal = await workStates.create({ sessionId: "manager-session", goal: "inspect", completionBoundary: "done", operationId: "goal" });
	const planned = await workStates.updatePlan("manager-session", goal.revision, {
		upsertItems: [{ id: "W1", title: "inspect", assignedAgentId: "unsafe", dependsOn: [], acceptanceCriteria: ["done"], sourceGoalCriteria: ["goal:1:1"] }], reason: "plan",
	}, "plan", goal.execution.epoch, goal.goalId);
	const workItem = planned.plan!.items.W1!;
	invoker.setDelegationStateObserver(async () => { await workStates.reconcileDelegations(await runtime.listDelegations()); });
	invoker.setReplacementStateGuard(async (original, replacement) => {
		await workStates.reserveReplacementDelegation({
			sessionId: original.managerSessionId, goalId: original.goalId!, workItemId: original.workItemId!, goalEpoch: original.goalEpoch!,
			goalRevision: original.goalRevision, workItemRevision: original.workItemRevision,
			originalDelegationId: original.id, replacementDelegationId: replacement.id,
		});
	});
	const pending = await invoker.delegate({
		windowId: window.id,
		managerSessionId: "manager-session",
		managerToolCallId: "call-replace",
		agent: (await teams.getAgent("unsafe"))!,
		message: "inspect only",
		mode: "run",
		goalId: goal.goalId,
		workPlanId: planned.plan!.id,
		workItemId: workItem.id,
		goalEpoch: goal.execution.epoch,
		goalRevision: goal.goalRevision,
		workItemRevision: workItem.revision,
		contractHash: workItemContractHash(planned, planned.plan!, workItem),
		workspaceExecutionPolicy: workItem.workspaceExecutionPolicy,
	});
	await workStates.reconcileDelegations(await runtime.listDelegations());
	assert.equal(pending.status, "needs_input");
	const candidates = await invoker.replacementCandidates(pending.interactionId!);
	assert.deepEqual(candidates.map((item) => item.agentId), ["safe"]);
	await assert.rejects(() => invoker.respond(pending.interactionId!, {
		requestId: "tampered-replacement",
		revision: Number(pending.details.revision),
		responses: [{ requestId: (pending.details.requests as Array<{ requestId: string }>)[0]!.requestId, action: "approve", scope: "select_another_worker", value: "also-unsafe" }],
	}), /不可用或不能补足/);
	assert.equal((await runtime.getDelegation(pending.delegationId!))?.executionState, "waiting_admission");
	const replaced = await invoker.respond(pending.interactionId!, {
		requestId: "valid-replacement",
		revision: Number(pending.details.revision),
		responses: [{ requestId: (pending.details.requests as Array<{ requestId: string }>)[0]!.requestId, action: "approve", scope: "select_another_worker", value: "safe" }],
	});
	assert.equal(replaced.status, "replaced");
	assert.equal(unsafeStarted, false);
	assert.ok(replaced.delegationId, "改派响应必须返回 replacement Delegation id");
	const terminalDeadline = Date.now() + 5_000;
	let completedReplacement = await runtime.getDelegation(replaced.delegationId);
	while (completedReplacement?.executionState !== "reported_completed" && Date.now() < terminalDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		completedReplacement = await runtime.getDelegation(replaced.delegationId);
	}
	assert.equal(completedReplacement?.executionState, "reported_completed", "replacement 必须在超时前进入 reported_completed");
	assert.ok(completedReplacement.receipt, "replacement 终态必须原子封存 ExecutionReceipt");
	assert.equal(safeStarted, true);
	const all = await runtime.listDelegations(window.id, "manager-session");
	const original = all.find((item) => item.agentId === "unsafe")!;
	const replacement = all.find((item) => item.id === replaced.delegationId)!;
	assert.equal(original.executionState, "cancelled");
	assert.equal(original.workerStarted, false);
	assert.equal(original.result && "errorCode" in original.result ? original.result.errorCode : undefined, "admission_replaced");
	assert.equal(replacement.parentDelegationId, original.id);
	assert.equal(replacement.managerToolCallId, undefined, "已闭合的旧 delegate toolCallId 不得复用");
	assert.equal(replacement.sessionHandle, "safe-session");
	const interaction = await runtime.getInteraction(pending.interactionId!);
	assert.equal(interaction?.decision?.chosenAction, "select_another_worker");
	assert.equal(interaction?.decision?.replacementAgentId, "safe");
	assert.equal(interaction?.application?.status, "applied");
	assert.equal(interaction?.application?.replacementDelegationId, replacement.id);
	const beforeBoundary = (await workStates.getActive("manager-session"))!;
	assert.equal(replacement.receipt?.taskContractHash, workItemContractHash(beforeBoundary, beforeBoundary.plan!, beforeBoundary.plan!.items.W1!), "replacement 必须继承同一 WorkItem 契约");
	await workStates.reconcileDelegations(await runtime.listDelegations());
	assert.equal((await workStates.getActive("manager-session"))?.plan?.items.W1?.status, "submitted", "旧 cancelled 终态不得把已完成 replacement 回退成 revision");
	await delegations.updateInteraction(pending.interactionId!, {
		application: { operationId: `admission-replacement:${original.id}`, status: "applying", replacementAgentId: "safe", updatedAt: new Date().toISOString() },
	});
	assert.equal(await runtime.reconcileAdmissionApplications(), 1, "重启对账应按 operationId 找回已创建的 replacement");
	assert.equal((await runtime.getInteraction(pending.interactionId!))?.application?.replacementDelegationId, replacement.id);
	await runtime.failAdmissionReplacement(pending.interactionId!, "late_projection_failure", replacement.id);
	assert.equal((await runtime.getInteraction(pending.interactionId!))?.application?.status, "applied", "applied 终态不得被迟到的投影失败反写");
	const replay = await invoker.respond(pending.interactionId!, {
		requestId: "valid-replacement",
		revision: Number(pending.details.revision),
		responses: [{ requestId: (pending.details.requests as Array<{ requestId: string }>)[0]!.requestId, action: "approve", scope: "select_another_worker", value: "safe" }],
	});
	assert.equal(replay.status, "replaced");
	assert.equal(replay.details.replayed, true);
	assert.equal((await runtime.listDelegations(window.id, "manager-session")).length, 2, "改派请求重放不得创建第二个 replacement Delegation");
});

test("替代 Worker 能力在选择后漂移时 fail-closed，不留下嵌套准入或伪 applied", async () => {
	const root = temp("pt-invoker-replacement-drift-root-");
	const state = temp("pt-invoker-replacement-drift-state-");
	const teams = new TeamsStore({ state, assets: state, managedWorkspaces: path.join(state, "managed") }, root);
	await teams.init();
	for (const agent of [
		{ name: "unsafe", description: "unsafe", invoke: { type: "command" as const, command: "unsafe", runArgs: ["run"] }, enabled: true },
		{ name: "candidate", description: "drifting", invoke: { type: "command" as const, command: "candidate", runArgs: ["run"] }, enabled: true },
	]) await teams.upsertAgent(agent);
	const window = await teams.createWindow({ type: "group", members: ["unsafe", "candidate"], sessionId: "manager-session" });
	let candidateCapabilityReads = 0;
	let candidateStarted = false;
	const unsafeDriver: AgentDriver = {
		id: "unsafe",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "stream", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: [] } }; },
		async *run() {}, async *continue() {}, async *respond() {}, async probe() { throw new Error("unused"); },
	};
	const candidateDriver: AgentDriver = {
		id: "candidate",
		async capabilities() {
			candidateCapabilityReads += 1;
			return { operations: ["run"], interactionKinds: [], progress: "stream", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: candidateCapabilityReads === 1 ? "sandbox" : "none", mutationObservation: [] } };
		},
		async *run() { candidateStarted = true; }, async *continue() {}, async *respond() {}, async probe() { throw new Error("unused"); },
	};
	const drivers = new DriverRegistry(); drivers.register(unsafeDriver); drivers.register(candidateDriver);
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, root);
	invoker.setReplacementStateGuard(async () => undefined);
	const pending = await invoker.delegate({
		windowId: window.id,
		managerSessionId: "manager-session",
		managerToolCallId: "call-drift",
		agent: (await teams.getAgent("unsafe"))!,
		message: "inspect only",
		mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "manager_derived", reason: "inspect", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
	});
	const driftResponse = {
		requestId: "replace-drift",
		revision: Number(pending.details.revision),
		responses: [{ requestId: (pending.details.requests as Array<{ requestId: string }>)[0]!.requestId, action: "approve", scope: "select_another_worker", value: "candidate" }],
	};
	await assert.rejects(() => invoker.respond(pending.interactionId!, driftResponse), /能力或执行上下文在启动前发生变化/);
	assert.equal(candidateStarted, false);
	const all = await runtime.listDelegations(window.id, "manager-session");
	const original = all.find((item) => item.agentId === "unsafe")!;
	const child = all.find((item) => item.agentId === "candidate")!;
	assert.equal(original.executionState, "cancelled");
	assert.equal(child.executionState, "cancelled");
	assert.equal(child.workerStarted, false);
	const interaction = await runtime.getInteraction(pending.interactionId!);
	assert.equal(interaction?.application?.status, "failed");
	assert.equal(interaction?.application?.replacementDelegationId, child.id);
	assert.notEqual(interaction?.application?.status, "applied");
	await delegations.updateInteraction(pending.interactionId!, {
		application: { operationId: `admission-replacement:${original.id}`, status: "applying", replacementAgentId: "candidate", updatedAt: new Date().toISOString() },
	});
	assert.equal(await runtime.reconcileAdmissionApplications(), 1);
	const recovered = await runtime.getInteraction(pending.interactionId!);
	assert.equal(recovered?.application?.status, "failed", "恢复不能仅凭 child 存在就声称改派成功");
	assert.equal(recovered?.application?.failureCode, "replacement_start_unconfirmed");
	await assert.rejects(() => invoker.respond(pending.interactionId!, driftResponse), /改派请求已失败.*replacement_start_unconfirmed/, "失败请求重放不得伪报 replaced");
});
