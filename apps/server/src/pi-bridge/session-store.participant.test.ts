import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "./session-store.js";

/**
 * P0-A：group 内的 Participant 会话必须显式指定 owner，且装配使用同一
 * owner 快照——Worker 不能拿到 Manager 的 roster/delegate/Goal 工具面。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

interface AssemblyInternals {
	assembledWorkers: Map<string, Set<string>>;
	assembledManaged: Map<string, Set<string>>;
}

async function makeStack() {
	process.env.PI_CODING_AGENT_DIR = freshDir("pt-participant-agentdir-");
	const dir = freshDir("pt-participant-");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	for (const name of ["worker-a", "worker-b"]) {
		await teams.upsertAgent({
			name,
			description: `${name} instructions`,
			connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
			enabled: true,
		});
	}
	// 只用到 planManagerTools/buildManagerExtensionFactories 的装配期路径；
	// 工具 execute 不会在本测试里触发。
	const invoker = {} as unknown as AgentInvoker;
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	return { dir, teams, sessions };
}

const groupContext = (dir: string) => ({ type: "group" as const, members: ["worker-a", "worker-b"], cwd: dir });

test("PiSessionStore.create: 显式 owner 使用同一快照装配，Worker 没有 Manager 工具面", async () => {
	const { dir, sessions } = await makeStack();
	try {
		const manager = await sessions.create(undefined, groupContext(dir), undefined, { ownerAgentId: "manager" });
		const internals = sessions as unknown as AssemblyInternals;
		assert.ok(internals.assembledManaged.get(manager.id)?.has("delegation"), "Manager 应装配 delegate");
		assert.ok(internals.assembledWorkers.get(manager.id)?.has("worker-a"), "Manager roster 应包含成员");

		const worker = await sessions.create(undefined, groupContext(dir), undefined, { ownerAgentId: "worker-a" });
		const managed = internals.assembledManaged.get(worker.id) ?? new Set();
		assert.equal(managed.size, 0, "Worker 不能拿到任何 Manager 工具");
		assert.deepEqual([...(internals.assembledWorkers.get(worker.id) ?? [])], ["worker-a"]);
	} finally {
		await sessions.disposeAll();
	}
});

test("PiSessionStore.create: group 缺少 owner 或 owner 与既有 ref 不一致时 fail-closed", async () => {
	const { dir, teams, sessions } = await makeStack();
	try {
		await assert.rejects(
			() => sessions.create(undefined, groupContext(dir)),
			/session_owner_required/,
		);
		const group = await teams.createWindow({
			type: "group",
			members: ["worker-a", "worker-b"],
			createSession: async () => ({ id: "reserved-session-1" }),
		});
		assert.ok(group);
		await assert.rejects(
			() => sessions.create(undefined, groupContext(dir), "reserved-session-1", { ownerAgentId: "worker-a" }),
			/session_owner_mismatch/,
		);
	} finally {
		await sessions.disposeAll();
	}
});
