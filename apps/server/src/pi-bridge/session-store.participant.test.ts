import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { PiSessionStore } from "./session-store.js";

/**
 * P0-A：group 内的 Participant 会话必须能显式指定 owner。
 * 不指定 owner 时当前仍按 ctx.type 回退（P0-B 改为 fail-closed），本测试只锁定
 * 显式 owner 的装配结果：Worker 工具面、无 Manager roster/delegate。
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
	await teams.upsertAgent({
		name: "worker-a",
		description: "worker a instructions",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		enabled: true,
	});
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams);
	return { dir, teams, sessions };
}

test("PiSessionStore.create: 显式 owner 装配为 Worker，不注入 Manager roster/delegate", async () => {
	const { dir, sessions } = await makeStack();
	try {
		const summary = await sessions.create(undefined, { type: "group", members: ["worker-a"], cwd: dir }, undefined, { ownerAgentId: "worker-a" });
		const internals = sessions as unknown as AssemblyInternals;
		const workers = internals.assembledWorkers.get(summary.id);
		const managed = internals.assembledManaged.get(summary.id);
		assert.deepEqual([...(workers ?? [])], ["worker-a"], "Worker 会话只装配自己的 Agent identity");
		assert.equal(managed?.size ?? 0, 0, "Worker 会话不能拿到 Manager 工具面");
		assert.ok((await sessions.list()).some((item) => item.id === summary.id));
	} finally {
		await sessions.disposeAll();
	}
});

test("PiSessionStore.create: owner 不存在或已停用时明确失败，不静默回退 Manager", async () => {
	const { dir, sessions, teams } = await makeStack();
	try {
		await assert.rejects(
			() => sessions.create(undefined, { type: "group", members: ["worker-a"], cwd: dir }, undefined, { ownerAgentId: "missing" }),
			/owner not found/,
		);
		await teams.upsertAgent({
			name: "worker-a",
			description: "worker a instructions",
			connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
			enabled: false,
		});
		await assert.rejects(
			() => sessions.create(undefined, { type: "group", members: ["worker-a"], cwd: dir }, undefined, { ownerAgentId: "worker-a" }),
			/session_owner_unavailable/,
		);
	} finally {
		await sessions.disposeAll();
	}
});
