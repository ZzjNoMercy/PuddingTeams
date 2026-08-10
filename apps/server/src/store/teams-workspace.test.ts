import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "./teams.js";

async function makeStore(): Promise<{ store: TeamsStore; dir: string }> {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-workspace-"));
	const store = new TeamsStore(dir, dir);
	await store.init();
	return { store, dir };
}

test("WorkspaceStore：canonical path 去重，Window 只引用 workspaceId", async () => {
	const { store, dir } = await makeStore();
	const project = mkdtempSync(path.join(tmpdir(), "pt-project-"));
	const alias = path.join(dir, "project-alias");
	symlinkSync(project, alias);

	const first = await store.workspaces.createFromPath({ path: project });
	const duplicate = await store.workspaces.createFromPath({ path: alias });
	assert.equal(duplicate.id, first.id, "symlink 别名不能制造重复项目");
	assert.equal(first.canonicalPath, realpathSync(project));

	const window = await store.createWindow({
		type: "direct",
		members: ["puddingclaw"],
		workspaceId: first.id,
		sessionId: "sess-1",
	});
	assert.equal(window.workspaceId, first.id);
	assert.equal(await store.workspaceFor(window.id), first.canonicalPath);
	assert.ok(existsSync(path.join(project, "AGENTS.md")));
	assert.ok(readFileSync(path.join(project, "AGENTS.md"), "utf-8").includes("pudding:handoff-begin"));
});

test("Window 不选项目时使用默认 cwd，worker binding 仍冻结该上下文", async () => {
	const { store, dir } = await makeStore();
	const window = await store.createWindow({ type: "direct", members: ["alpha"], sessionId: "plain-chat" });
	const agent = await store.upsertAgent({
		name: "alpha",
		description: "alpha",
		invoke: { type: "command", command: "echo", runArgs: [] },
	});
	const defaultCwd = realpathSync(dir);
	assert.equal(window.workspaceId, undefined);
	assert.equal(await store.workspaceFor(window.id), defaultCwd);
	await store.rememberWorkerSession(window.id, "alpha", "plain-worker", undefined, defaultCwd, agent.extensionRevision ?? 0);
	assert.deepEqual((await store.getWindow(window.id))?.workerBindings?.alpha, {
		sessionHandle: "plain-worker",
		workspaceId: undefined,
		cwdSnapshot: defaultCwd,
		agentRevision: agent.extensionRevision ?? 0,
		updatedAt: (await store.getWindow(window.id))!.workerBindings!.alpha!.updatedAt,
	});
});

test("无项目 Window 的 cwdSnapshot 跨重启保持，新的默认 cwd 使用独立 direct 身份", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-default-cwd-restart-"));
	const teamsDir = path.join(root, "teams");
	const cwdA = path.join(root, "a");
	const cwdB = path.join(root, "b");
	mkdirSync(cwdA);
	mkdirSync(cwdB);

	const first = new TeamsStore(teamsDir, cwdA);
	await first.init();
	const soloA = await first.ensureSoloWindow(async () => ({ id: "solo-a" }), async () => false);
	const directA = await first.ensureDirectWindow("alpha", undefined, async () => ({ id: "direct-a" }), {
		cwdSnapshot: realpathSync(cwdA),
	});
	assert.equal(soloA.cwdSnapshot, realpathSync(cwdA));
	assert.equal(directA.cwdSnapshot, realpathSync(cwdA));

	const restarted = new TeamsStore(teamsDir, cwdB);
	await restarted.init();
	assert.equal(await restarted.workspaceFor(soloA.id), realpathSync(cwdA));
	assert.equal((await restarted.findDirectWindow("alpha", undefined, realpathSync(cwdA)))?.id, directA.id);
	assert.equal(await restarted.findDirectWindow("alpha"), undefined, "当前默认 cwd B 不得复用 cwd A 的 direct");

	const directB = await restarted.ensureDirectWindow("alpha", undefined, async () => ({ id: "direct-b" }));
	assert.notEqual(directB.id, directA.id);
	assert.equal(directB.cwdSnapshot, realpathSync(cwdB));
});

test("direct Window 去重包含 workspaceId，worker binding 记录项目与 Agent 修订", async () => {
	const { store } = await makeStore();
	const a = await store.workspaces.createManaged("A");
	const b = await store.workspaces.createManaged("B");
	const wa = await store.createWindow({ type: "direct", members: ["alpha"], workspaceId: a.id, sessionId: "sa" });
	const wb = await store.createWindow({ type: "direct", members: ["alpha"], workspaceId: b.id, sessionId: "sb" });
	const agent = await store.upsertAgent({
		name: "alpha",
		description: "alpha",
		invoke: { type: "command", command: "echo", runArgs: [] },
	});

	assert.equal((await store.findDirectWindow("alpha", a.id))?.id, wa.id);
	assert.equal((await store.findDirectWindow("alpha", b.id))?.id, wb.id);
	await store.rememberWorkerSession(wa.id, "alpha", "worker-a", a.id, a.canonicalPath, agent.extensionRevision ?? 0);
	assert.deepEqual((await store.getWindow(wa.id))?.workerBindings?.alpha, {
		sessionHandle: "worker-a",
		workspaceId: a.id,
		cwdSnapshot: a.canonicalPath,
		agentRevision: agent.extensionRevision ?? 0,
		updatedAt: (await store.getWindow(wa.id))!.workerBindings!.alpha!.updatedAt,
	});
});

test("显式原地切换原子替换 workspace/manager sessions 并清空 worker bindings", async () => {
	const { store } = await makeStore();
	const a = await store.workspaces.createManaged("A");
	const b = await store.workspaces.createManaged("B");
	const window = await store.createWindow({ type: "group", members: ["alpha", "beta"], workspaceId: a.id, sessionId: "old-1" });
	await store.addWindowSession(window.id, "old-2");
	await store.rememberWorkerSession(window.id, "alpha", "worker-a", a.id, a.canonicalPath, 1);

	const switched = await store.replaceWindowWorkspace(window.id, b.id, "new-1");
	assert.deepEqual(switched.previousSessionIds, ["old-2", "old-1"]);
	assert.equal(switched.window.workspaceId, b.id);
	assert.deepEqual(switched.window.sessions, ["new-1"]);
	assert.deepEqual(switched.window.workerBindings, {});
});

test("direct identity 在 PATCH 与原地切换 commit 中都保持 (worker, workspace) 唯一", async () => {
	const { store } = await makeStore();
	const a = await store.workspaces.createManaged("A");
	const b = await store.workspaces.createManaged("B");
	const alphaA = await store.createWindow({ type: "direct", members: ["alpha"], workspaceId: a.id, sessionId: "alpha-a" });
	const betaA = await store.createWindow({ type: "direct", members: ["beta"], workspaceId: a.id, sessionId: "beta-a" });
	const alphaB = await store.createWindow({ type: "direct", members: ["alpha"], workspaceId: b.id, sessionId: "alpha-b" });

	await assert.rejects(() => store.updateWindow(betaA.id, { members: ["alpha"] }), /已有单聊/);
	await assert.rejects(
		() => store.replaceWindowWorkspace(alphaB.id, a.id, "alpha-b-next", alphaB),
		/目标项目已有单聊/,
	);
	assert.equal((await store.getWindow(alphaA.id))?.workspaceId, a.id);
	assert.equal((await store.getWindow(alphaB.id))?.workspaceId, b.id);
});
