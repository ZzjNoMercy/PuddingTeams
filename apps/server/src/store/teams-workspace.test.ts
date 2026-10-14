import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "./teams.js";

async function makeStore(): Promise<{ store: TeamsStore; dir: string }> {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-workspace-"));
	const store = new TeamsStore({ state: dir, assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
	await store.init();
	for (const name of ["alpha", "beta"]) await store.upsertAgent({ name, description: "fixture Worker", invoke: { type: "command", command: "echo", runArgs: [] }, enabled: true });
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
		members: ["codex"],
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
	await store.rememberWorkerSession(window.id, "plain-chat", "alpha", "plain-worker", undefined, defaultCwd, agent.extensionRevision ?? 0);
	assert.deepEqual((await store.getWindow(window.id))?.workerBindings?.["plain-chat"]?.alpha, {
		sessionHandle: "plain-worker",
		targetWindowId: window.id,
		workspaceId: undefined,
		cwdSnapshot: defaultCwd,
		agentRevision: agent.extensionRevision ?? 0,
		updatedAt: (await store.getWindow(window.id))!.workerBindings!["plain-chat"]!.alpha!.updatedAt,
	});
});

test("windows v1/v2 被拒绝，原文件和既有备份不变", async () => {
 for(const version of [1,2]) {
  const {store,dir}=await makeStore();await store.createWindow({type:"group",members:["alpha","beta"],sessionId:"session"});
  const file=path.join(dir,"windows.json"),data=JSON.parse(readFileSync(file,"utf8"));data.version=version;
  const bytes=JSON.stringify(data);writeFileSync(file,bytes);writeFileSync(`${file}.v1.bak`,"existing backup");
  const restarted=new TeamsStore({state:dir,assets:dir,managedWorkspaces:path.join(dir,"managed")},dir);
  await assert.rejects(()=>restarted.init(),/requires v3/);
  assert.equal(readFileSync(file,"utf8"),bytes);assert.equal(readFileSync(`${file}.v1.bak`,"utf8"),"existing backup");
 }
});

test("v3 会话负责人是单一持久身份，缺失/错配拒绝，不从成员猜测",async()=>{
 const {store,dir}=await makeStore();const room=await store.createWindow({type:"direct",members:["alpha"],sessionId:"session"});
 await store.addWindowSession(room.id,"second");assert.equal((await store.sessionRef("session"))?.ownerAgentId,"alpha");
 assert.equal((await store.sessionRef("second"))?.ownerAgentId,"alpha");
 const file=path.join(dir,"windows.json"),data=JSON.parse(readFileSync(file,"utf8"));delete data.sessionRefs.session;
 writeFileSync(file,JSON.stringify(data));const restarted=new TeamsStore({state:dir,assets:dir,managedWorkspaces:path.join(dir,"managed")},dir);
 await assert.rejects(()=>restarted.init(),/invalid native session owner/);
});

test("无项目 Window 的 cwdSnapshot 跨重启保持，新的默认 cwd 使用独立 direct 身份", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-default-cwd-restart-"));
	const teamsDir = path.join(root, "teams");
	const cwdA = path.join(root, "a");
	const cwdB = path.join(root, "b");
	mkdirSync(cwdA);
	mkdirSync(cwdB);

	const first = new TeamsStore({ state: teamsDir, assets: teamsDir, managedWorkspaces: path.join(teamsDir, "managed") }, cwdA);
	await first.init();
	const soloA = await first.ensureSoloWindow(async () => ({ id: "solo-a" }), async () => false);
	const directA = await first.ensureDirectWindow("alpha", undefined, async () => ({ id: "direct-a" }), {
		cwdSnapshot: realpathSync(cwdA),
	});
	assert.equal(soloA.cwdSnapshot, realpathSync(cwdA));
	assert.equal(directA.cwdSnapshot, realpathSync(cwdA));

	const restarted = new TeamsStore({ state: teamsDir, assets: teamsDir, managedWorkspaces: path.join(teamsDir, "managed") }, cwdB);
	await restarted.init();
	assert.equal(await restarted.workspaceFor(soloA.id), realpathSync(cwdA));
	assert.equal((await restarted.findDirectWindow("alpha", undefined, realpathSync(cwdA)))?.id, directA.id);
	assert.equal(await restarted.findDirectWindow("alpha"), undefined, "当前默认 cwd B 不得复用 cwd A 的 direct");

	const directB = await restarted.ensureDirectWindow("alpha", undefined, async () => ({ id: "direct-b" }));
	assert.notEqual(directB.id, directA.id);
	assert.equal(directB.cwdSnapshot, realpathSync(cwdB));
});

test("solo 重启时 active Session 未落盘也不覆盖同上下文内已持久化的历史", async () => {
	const { store } = await makeStore();
	const solo = await store.ensureSoloWindow(async () => ({ id: "persisted" }), async () => false);
	await store.addWindowSession(solo.id, "fresh-fileless");

	let created = false;
	const recovered = await store.ensureSoloWindow(
		async () => {
			created = true;
			return { id: "replacement" };
		},
		async (id) => id === "persisted",
	);
	assert.equal(created, false, "只要同上下文还有可恢复 Session，就不得整体换号");
	assert.deepEqual(recovered.sessions, ["fresh-fileless", "persisted"]);
	assert.equal(recovered.activeSession, "fresh-fileless", "存储层保留事实，由 rooms 生命周期选择可用 active Session");
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
	await store.rememberWorkerSession(wa.id, "sa", "alpha", "worker-a", a.id, a.canonicalPath, agent.extensionRevision ?? 0);
	assert.deepEqual((await store.getWindow(wa.id))?.workerBindings?.sa?.alpha, {
		sessionHandle: "worker-a",
		targetWindowId: wa.id,
		workspaceId: a.id,
		cwdSnapshot: a.canonicalPath,
		agentRevision: agent.extensionRevision ?? 0,
		updatedAt: (await store.getWindow(wa.id))!.workerBindings!.sa!.alpha!.updatedAt,
	});
});

test("solo 原地切换按 workspace 停放并恢复 sessions 与 worker bindings", async () => {
	const { store, dir } = await makeStore();
	const a = await store.workspaces.createManaged("A");
	const b = await store.workspaces.createManaged("B");
	const solo = await store.ensureSoloWindow(async () => ({ id: "default-1" }), async () => true);
	await store.replaceWindowWorkspace(solo.id, a.id, "a-1");
	await store.addWindowSession(solo.id, "a-2");
	const agent = await store.upsertAgent({
		name: "alpha",
		description: "alpha",
		invoke: { type: "command", command: "echo", runArgs: [] },
	});
	const directA = await store.ensureDirectWindow("alpha", a.id, async () => ({ id: "direct-a" }));
	const revision = agent.extensionRevision ?? 0;
	await store.rememberWorkerSession(directA.id, "a-2", "alpha", "worker-a", a.id, a.canonicalPath, revision);

	const switched = await store.replaceWindowWorkspace(solo.id, b.id, "b-1");
	assert.equal(switched.restored, false);
	assert.equal(switched.window.workspaceId, b.id);
	assert.deepEqual(switched.window.sessions, ["b-1"]);

	const restarted = new TeamsStore({ state: dir, assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
	await restarted.init();
	assert.equal((await restarted.contextForSession("a-2"))?.active, false, "重启后仍能定位停驻 Session 的项目上下文");
	assert.equal(await restarted.workspaceForSession("a-2"), a.canonicalPath);
	const restored = await restarted.replaceWindowWorkspace(solo.id, a.id, "unused-a");
	assert.equal(restored.restored, true);
	assert.deepEqual(restored.window.sessions, ["a-2", "a-1"]);
	assert.equal(restored.window.activeSession, "a-2");
	assert.equal(restored.window.workerBindings?.["a-2"]?.alpha?.sessionHandle, "worker-a");
});

test("direct identity 按 (worker, workspace) 唯一且拒绝原地切换", async () => {
	const { store } = await makeStore();
	for (const name of ["alpha", "beta"]) {
		await store.upsertAgent({ name, description: name, invoke: { type: "command", command: name, runArgs: [] } });
	}
	const a = await store.workspaces.createManaged("A");
	const b = await store.workspaces.createManaged("B");
	const alphaA = await store.createWindow({ type: "direct", members: ["alpha"], workspaceId: a.id, sessionId: "alpha-a" });
	const betaA = await store.createWindow({ type: "direct", members: ["beta"], workspaceId: a.id, sessionId: "beta-a" });
	const alphaB = await store.createWindow({ type: "direct", members: ["alpha"], workspaceId: b.id, sessionId: "alpha-b" });

	await assert.rejects(() => store.updateWindow(betaA.id, { members: ["alpha"] }), /已有单聊/);
	await assert.rejects(() => store.replaceWindowWorkspace(alphaB.id, a.id, "alpha-b-next", alphaB), /only the solo singleton/);
	assert.equal((await store.getWindow(alphaA.id))?.workspaceId, a.id);
	assert.equal((await store.getWindow(alphaB.id))?.workspaceId, b.id);
});


test("Direct 窗口拒绝自定义协作提示词（§5.2 固定 relay）；Group 不受影响", async () => {
	const { store } = await makeStore();
	await assert.rejects(
		() => store.createWindow({ type: "direct", members: ["alpha"], prompt: "规则", sessionId: "s-1" }),
		/单聊窗口不支持自定义协作提示词/,
	);
	const direct = await store.createWindow({ type: "direct", members: ["alpha"], sessionId: "s-2" });
	await assert.rejects(() => store.updateWindow(direct.id, { prompt: "规则" }), /单聊窗口不支持自定义协作提示词/);
	// 传 "" 允许：用于清掉历史遗留值。
	const cleared = await store.updateWindow(direct.id, { prompt: "" });
	assert.equal(cleared.prompt, undefined);

	const group = await store.createWindow({ type: "group", members: ["alpha", "beta"], prompt: "群规", sessionId: "s-3" });
	assert.equal(group.prompt, "群规");
	const updated = await store.updateWindow(group.id, { prompt: "新群规" });
	assert.equal(updated.prompt, "新群规");
});


test("P1 group 创建与更新去重后至少两位 Worker；可用范围不改变群聊类型", async () => {
	const { store } = await makeStore();
	for (const members of [[], ["alpha"], ["alpha", "alpha"]]) {
		await assert.rejects(() => store.createWindow({ type: "group", members, sessionId: "invalid" }), /至少需要 2 个/);
	}
	const group = await store.createWindow({ type: "group", members: ["alpha", "beta"], sessionId: "two" });
	for (const members of [[], ["alpha"], ["alpha", "alpha"]]) {
		await assert.rejects(() => store.updateWindow(group.id, { name: "invalid", members }), /至少需要 2 个/);
		assert.deepEqual((await store.getWindow(group.id))!.members, ["alpha", "beta"]);
		assert.equal((await store.getWindow(group.id))!.name, undefined);
	}
	await store.setEnabled("alpha", false);
	assert.deepEqual((await store.eligibleWorkersFor(group)).map((agent) => agent.name), ["beta"]);
	const solo = (await store.eligibleWorkersFor({ type: "solo", members: [] })).map((agent) => agent.name);
	assert.ok(solo.includes("beta"));
	assert.ok(!solo.includes("alpha") && !solo.includes("manager"));
	await store.setEnabled("beta", false);
	assert.deepEqual(await store.eligibleWorkersFor(group), []);
	assert.equal((await store.getWindow(group.id))!.type, "group");
	assert.deepEqual((await store.getWindow(group.id))!.members, ["alpha", "beta"]);
});
