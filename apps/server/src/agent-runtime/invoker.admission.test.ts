import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { DriverRegistry } from "./driver-registry.js";
import { AgentInvoker } from "./invoker.js";
import { WorkspaceExecutionCoordinator, type WorkspaceExecutionPolicy } from "./workspace-execution.js";
import type { AgentDriver } from "./types.js";

async function stack() {
	const temp = () => mkdtempSync(path.join(tmpdir(), "pt-invoker-readonly-"));
	const root = temp(), state = temp();
	const teams = new TeamsStore({ state, assets: state, managedWorkspaces: path.join(state, "managed") }, root);
	await teams.init();
	const drivers = new DriverRegistry();
	const starts: string[] = [];
	let safeEnforcement: "sandbox" | "none" = "sandbox";
	for (const name of ["ordinary", "safe"]) {
		await teams.upsertAgent({ name, description: "inspector", invoke: { type: "command", command: name, runArgs: ["run"] }, enabled: true });
		const driver: AgentDriver = {
			id: name,
			async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: name === "safe" ? safeEnforcement : "none", mutationObservation: [] } }; },
			async *run(input) { starts.push(name); assert.match(input.message ?? "", /Do not modify Workspace files/); yield { type: "completed", result: { agentId: name, status: "completed", content: "inspected" } }; },
			async *continue() {}, async *respond() {}, async probe() { throw new Error("unused"); },
		};
		drivers.register(driver);
	}
	const window = await teams.createWindow({ type: "group", members: ["ordinary", "safe"], sessionId: "s" });
	const delegations = new DelegationStore(state); await delegations.init();
	const secrets = new InteractionSecretStore(state); await secrets.init();
	const scopes = new WorkspaceExecutionCoordinator(state); await scopes.init();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 }, undefined, undefined, scopes);
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, root);
	const delegate = async (name: string, policy: WorkspaceExecutionPolicy) => invoker.delegate({ windowId: window.id, managerSessionId: "s", agent: (await teams.getAgent(name))!, message: "inspect", mode: "run", workspaceExecutionPolicy: policy });
	return { runtime, delegate, starts, drift: () => { safeEnforcement = "none"; } };
}

const inspection: WorkspaceExecutionPolicy = { mode: "read_only_shared", source: "manager_derived", reason: "inspect", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false };

test("Manager 普通查阅委托一次完成，不产生用户准入或审批恢复回合", async () => {
	const s = await stack();
	const result = await s.delegate("ordinary", inspection);
	assert.equal(result.status, "completed", result.content);
	assert.equal(result.waitingInput, false);
	assert.equal(result.interactionId, undefined);
	assert.deepEqual(s.starts, ["ordinary"]);
	const record = await s.runtime.getDelegation(result.delegationId!);
	assert.equal(record?.readOnlyAssessment, "unverified_observed");
});

test("强制只读先报告能力缺口，再由 Manager 改派；全过程不要求用户放行且约束不变", async () => {
	const s = await stack();
	const policy: WorkspaceExecutionPolicy = { ...inspection, readOnlyRequirement: "enforced" };
	const blocked = await s.delegate("ordinary", policy);
	assert.equal(blocked.status, "failed");
	assert.equal(blocked.waitingInput, false);
	assert.equal(blocked.interactionId, undefined);
	assert.match(blocked.content, /强制只读/);
	assert.deepEqual(s.starts, []);
	const done = await s.delegate("safe", policy);
	assert.equal(done.status, "completed", done.content);
	assert.equal(done.waitingInput, false);
	assert.deepEqual(s.starts, ["safe"]);
	const record = await s.runtime.getDelegation(done.delegationId!);
	assert.deepEqual(record?.workspaceExecutionPolicy, policy);
	assert.equal(record?.readOnlyAssessment, "verified");
});

test("改派候选能力发生变化时重新检查，不能沿用旧保障或自动降低强制只读", async () => {
	const s = await stack();
	s.drift();
	const blocked = await s.delegate("safe", { ...inspection, readOnlyRequirement: "enforced" });
	assert.equal(blocked.status, "failed");
	assert.equal(blocked.waitingInput, false);
	assert.deepEqual(s.starts, []);
});
