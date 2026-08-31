import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerRoomsRoutes } from "./rooms.js";
import { registerWorkspacesRoutes } from "./workspaces.js";

async function makeStack(
	nativePicker?: (initialPath: string) => Promise<string | undefined>,
	fileOpener?: (targetPath: string) => Promise<void>,
	attachmentRoot?: string,
) {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-workspace-routes-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	await teams.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const app = Fastify({ logger: false });
	registerWorkspacesRoutes(app, teams.workspaces, nativePicker);
	registerRoomsRoutes(app, sessions, teams, invoker, undefined, {
		open: fileOpener,
		attachmentRoot,
	});
	return { app, teams, sessions, delegations, invoker, dir };
}

test("消息附件从房间 cwd 解析并仅打开允许目录内的文件", async () => {
	const opened: string[] = [];
	const attachmentRoot = mkdtempSync(path.join(tmpdir(), "pt-upload-file-"));
	const { app, sessions, dir } = await makeStack(
		undefined,
		async (targetPath) => {
			opened.push(targetPath);
		},
		attachmentRoot,
	);
	const created = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "direct", members: ["alpha"] },
	});
	const roomId = created.json().room.id as string;
	const activeSession = created.json().room.activeSession as string;
	const localFile = path.join(dir, "add.py");
	writeFileSync(localFile, "print('ok')\n");

	const openedResponse = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: "add.py" },
	});
	assert.equal(openedResponse.statusCode, 200, openedResponse.body);
	assert.deepEqual(opened, [realpathSync(localFile)]);
	const localDirectory = path.join(dir, "reports");
	mkdirSync(localDirectory);
	const openedDirectoryResponse = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: "reports" },
	});
	assert.equal(openedDirectoryResponse.statusCode, 200, openedDirectoryResponse.body);
	assert.deepEqual(opened, [realpathSync(localFile), realpathSync(localDirectory)]);
	const activeAttachmentDir = path.join(attachmentRoot, activeSession);
	mkdirSync(activeAttachmentDir);
	const uploadedFile = path.join(activeAttachmentDir, "frozen.pdf");
	writeFileSync(uploadedFile, "pdf\n");
	const uploadedResponse = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: uploadedFile },
	});
	assert.equal(uploadedResponse.statusCode, 200, uploadedResponse.body);
	assert.deepEqual(opened, [realpathSync(localFile), realpathSync(localDirectory), realpathSync(uploadedFile)]);

	const nextSession = await app.inject({ method: "POST", url: `/api/rooms/${roomId}/sessions`, payload: {} });
	assert.equal(nextSession.statusCode, 200, nextSession.body);
	const historicalRejected = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: uploadedFile },
	});
	assert.equal(historicalRejected.statusCode, 400, historicalRejected.body);

	const outsideDir = mkdtempSync(path.join(tmpdir(), "pt-outside-file-"));
	const outsideFile = path.join(outsideDir, "secret.txt");
	writeFileSync(outsideFile, "secret\n");
	const rejected = await app.inject({
		method: "POST",
		url: `/api/rooms/${roomId}/open-file`,
		payload: { path: outsideFile },
	});
	assert.equal(rejected.statusCode, 400, rejected.body);
	assert.deepEqual(opened, [realpathSync(localFile), realpathSync(localDirectory), realpathSync(uploadedFile)]);

	await sessions.disposeAll();
	await app.close();
});

test("未选择 Workspace 时保持默认 cwd，且与显式项目的 direct Session 隔离", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const createWithoutWorkspace = () =>
		app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
	const first = await createWithoutWorkspace();
	assert.equal(first.statusCode, 200, first.body);
	assert.equal(first.json().room.workspace, null);
	assert.equal(first.json().existed, false);
	const windowId = first.json().room.id as string;
	assert.equal((await teams.getWindow(windowId))?.workspaceId, undefined);
	assert.equal(await teams.workspaceFor(windowId), realpathSync(dir));

	const again = await createWithoutWorkspace();
	assert.equal(again.statusCode, 200, again.body);
	assert.equal(again.json().room.id, windowId);
	assert.equal(again.json().existed, true);

	const project = await teams.workspaces.createManaged("A");
	const explicit = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "direct", members: ["alpha"], workspaceId: project.id },
	});
	assert.equal(explicit.statusCode, 200, explicit.body);
	assert.notEqual(explicit.json().room.id, windowId);
	assert.equal(explicit.json().room.workspace.id, project.id);

	await sessions.disposeAll();
	await app.close();
});

test("产品验收冻结: 首启未落盘的 solo Session 不会被连续房间读取换号", async () => {
	const { app, sessions } = await makeStack();
	const first = await app.inject({ method: "GET", url: "/api/rooms" });
	assert.equal(first.statusCode, 200, first.body);
	const firstSolo = first.json().rooms.find((room: { type: string }) => room.type === "solo") as { activeSession: string };
	assert.ok(sessions.isOpen(firstSolo.activeSession));

	const second = await app.inject({ method: "GET", url: "/api/rooms" });
	assert.equal(second.statusCode, 200, second.body);
	const secondSolo = second.json().rooms.find((room: { type: string }) => room.type === "solo") as { activeSession: string };
	assert.equal(secondSolo.activeSession, firstSolo.activeSession);
	await sessions.disposeAll();
	await app.close();
});

test("窗口内 Session 可重命名，且只接受所属 Session 与非空名称", async () => {
	const { app, sessions } = await makeStack();
	const created = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "direct", members: ["alpha"] },
	});
	assert.equal(created.statusCode, 200, created.body);
	const room = created.json().room as { id: string; activeSession: string };

	const renamed = await app.inject({
		method: "PATCH",
		url: `/api/rooms/${room.id}/sessions/${room.activeSession}`,
		payload: { name: "新的会话名称" },
	});
	assert.equal(renamed.statusCode, 200, renamed.body);
	assert.equal(renamed.json().session.name, "新的会话名称");

	const fetched = await app.inject({ method: "GET", url: `/api/rooms/${room.id}` });
	assert.equal(fetched.json().room.sessions[0].name, "新的会话名称");

	const empty = await app.inject({
		method: "PATCH",
		url: `/api/rooms/${room.id}/sessions/${room.activeSession}`,
		payload: { name: "   " },
	});
	assert.equal(empty.statusCode, 400);

	const outsider = await app.inject({
		method: "PATCH",
		url: `/api/rooms/${room.id}/sessions/not-owned`,
		payload: { name: "x" },
	});
	assert.equal(outsider.statusCode, 404);

	await sessions.disposeAll();
	await app.close();
});

test("项目目录浏览只返回可进入的服务端文件夹", async () => {
	const { app, sessions, dir } = await makeStack();
	mkdirSync(path.join(dir, "project-a"));
	writeFileSync(path.join(dir, "not-a-folder.txt"), "x");
	const response = await app.inject({
		method: "GET",
		url: `/api/workspaces/browse?path=${encodeURIComponent(dir)}`,
	});
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(response.json().path, realpathSync(dir));
	assert.deepEqual(
		response.json().directories.filter((entry: { name: string }) => entry.name === "project-a"),
		[{ name: "project-a", path: path.join(realpathSync(dir), "project-a") }],
	);
	assert.equal(response.json().directories.some((entry: { name: string }) => entry.name === "not-a-folder.txt"), false);
	await sessions.disposeAll();
	await app.close();
});

test("系统目录选择 API 回传原生选择结果，取消不报错", async () => {
	const selectedDir = mkdtempSync(path.join(tmpdir(), "pt-native-selected-"));
	const selectedStack = await makeStack(async () => selectedDir);
	const selected = await selectedStack.app.inject({
		method: "POST",
		url: "/api/workspaces/pick-directory",
		payload: { initialPath: selectedStack.dir },
	});
	assert.equal(selected.statusCode, 200, selected.body);
	assert.deepEqual(selected.json(), { path: realpathSync(selectedDir), cancelled: false });
	await selectedStack.sessions.disposeAll();
	await selectedStack.app.close();

	const cancelledStack = await makeStack(async () => undefined);
	const cancelled = await cancelledStack.app.inject({
		method: "POST",
		url: "/api/workspaces/pick-directory",
		payload: { initialPath: cancelledStack.dir },
	});
	assert.equal(cancelled.statusCode, 200, cancelled.body);
	assert.deepEqual(cancelled.json(), { cancelled: true });
	await cancelledStack.sessions.disposeAll();
	await cancelledStack.app.close();
});

test("历史 cwd 失效不阻断启动，且只有可读目录才标记为可用", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const created = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"] } });
	assert.equal(created.statusCode, 200, created.body);
	const roomId = created.json().room.id as string;
	await sessions.disposeAll();
	await app.close();

	const moved = `${dir}-moved`;
	renameSync(dir, moved);
	writeFileSync(dir, "not a directory");
	const restarted = new TeamsStore({ state: path.join(moved, "teams"), assets: path.join(moved, "teams"), managedWorkspaces: path.join(moved, "managed") }, moved);
	await restarted.init();
	const restartedSessions = new PiSessionStore(moved, path.join(moved, "sessions"), restarted);
	const restartedApp = Fastify({ logger: false });
	registerRoomsRoutes(restartedApp, restartedSessions, restarted);
	const rooms = await restartedApp.inject({ method: "GET", url: "/api/rooms" });
	assert.equal(rooms.statusCode, 200, rooms.body);
	assert.equal(rooms.json().rooms.find((room: { id: string }) => room.id === roomId).contextAvailable, false);
	await restartedSessions.disposeAll();
	await restartedApp.close();
});

test("P3-1 API: 项目创建/最近列表与 direct Window 按 (worker, workspaceId) 隔离", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const projectA = mkdtempSync(path.join(tmpdir(), "pt-route-a-"));
	const projectB = mkdtempSync(path.join(tmpdir(), "pt-route-b-"));
	const create = async (root: string) => {
		const res = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
		assert.equal(res.statusCode, 200, res.body);
		return res.json().workspace as { id: string; canonicalPath: string };
	};
	const a = await create(projectA);
	const b = await create(projectB);
	assert.equal(a.canonicalPath, realpathSync(projectA));

	const room = async (workspaceId: string) => {
		const res = await app.inject({ method: "POST", url: "/api/rooms", payload: { type: "direct", members: ["alpha"], workspaceId } });
		assert.equal(res.statusCode, 200, res.body);
		return res.json() as { room: { id: string; activeSession: string; workspace: { id: string } }; existed: boolean };
	};
	const firstA = await room(a.id);
	const againA = await room(a.id);
	const firstB = await room(b.id);
	assert.equal(againA.room.id, firstA.room.id);
	assert.equal(againA.existed, true);
	assert.notEqual(firstB.room.id, firstA.room.id, "同一 worker 在不同项目必须得到不同 Window/manager Session");

	const switched = await app.inject({
		method: "POST",
		url: `/api/rooms/${firstA.room.id}/switch-workspace`,
		payload: { workspaceId: b.id },
	});
	assert.equal(switched.statusCode, 200, switched.body);
	assert.equal(switched.json().room.id, firstB.room.id, "默认切换应打开已有的项目窗口，不污染原窗口");
	assert.equal(switched.json().existed, true);
	await sessions.ensureSessionFile(firstA.room.activeSession);
	const directInPlace = await app.inject({
		method: "POST",
		url: `/api/rooms/${firstA.room.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(directInPlace.statusCode, 400, directInPlace.body);
	assert.equal((await teams.getWindow(firstA.room.id))?.workspaceId, a.id);
	const directInfo = (await sessions.list()).find((session) => session.id === firstA.room.activeSession);
	assert.ok(directInfo && existsSync(directInfo.sessionFile), "拒绝 direct 原地切换不得删除原 JSONL");

	await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
	const groupCreated = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "group", members: ["alpha", "beta"], workspaceId: a.id },
	});
	assert.equal(groupCreated.statusCode, 200, groupCreated.body);
	const group = groupCreated.json().room as { id: string; activeSession: string };
	await sessions.ensureSessionFile(group.activeSession);
	const groupInPlace = await app.inject({
		method: "POST",
		url: `/api/rooms/${group.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(groupInPlace.statusCode, 400, groupInPlace.body);
	assert.equal((await teams.getWindow(group.id))?.workspaceId, a.id);
	const groupInfo = (await sessions.list()).find((session) => session.id === group.activeSession);
	assert.ok(groupInfo && existsSync(groupInfo.sessionFile), "拒绝 group 原地切换不得删除原 JSONL");

	const list = await app.inject({ method: "GET", url: "/api/workspaces" });
	assert.equal(list.statusCode, 200);
	assert.ok(list.json().workspaces.length >= 2);
	await sessions.disposeAll();
	await app.close();
	void dir;
});

test("P3-1 API: solo 切换项目会恢复该项目 Session，并可恢复未选项目", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const a = await teams.workspaces.createManaged("A");
	const b = await teams.workspaces.createManaged("B");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };

	const enteredA = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	assert.equal(enteredA.statusCode, 200, enteredA.body);
	assert.equal(enteredA.json().restored, false);
	const sessionA = enteredA.json().room.activeSession as string;

	const enteredB = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(enteredB.statusCode, 200, enteredB.body);
	assert.notEqual(enteredB.json().room.activeSession, sessionA);
	const persistedA = (await sessions.list()).find((session) => session.id === sessionA);
	assert.ok(persistedA && existsSync(persistedA.sessionFile), "切走项目不得删除原 Session JSONL");
	assert.equal((await teams.contextForSession(sessionA))?.active, false, "切走后原 Session 必须进入停驻上下文");

	const restoredA = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	assert.equal(restoredA.statusCode, 200, restoredA.body);
	assert.equal(restoredA.json().restored, true);
	assert.equal(restoredA.json().room.activeSession, sessionA);

	const detached = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: null, mode: "in_place" },
	});
	assert.equal(detached.statusCode, 200, detached.body);
	const plain = detached.json().room as { workspace: null; cwdSnapshot: string; activeSession: string };
	assert.equal(plain.workspace, null);
	assert.equal(plain.cwdSnapshot, realpathSync(dir));
	assert.equal(plain.activeSession, solo.activeSession);
	await sessions.disposeAll();
	await app.close();
});

test("solo 恢复在提交前校验目标 JSONL cwd，损坏时保留当前项目", async () => {
	const { app, teams, sessions, dir } = await makeStack();
	const a = await teams.workspaces.createManaged("guard-A");
	const b = await teams.workspaces.createManaged("guard-B");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string };
	const enteredA = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	const sessionA = enteredA.json().room.activeSession as string;
	const enteredB = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(enteredB.statusCode, 200, enteredB.body);
	const sessionB = enteredB.json().room.activeSession as string;
	const infoA = (await sessions.list()).find((session) => session.id === sessionA)!;
	await sessions.open(sessionA);
	assert.equal(sessions.isOpen(sessionA), true, "测试必须覆盖驻留缓存不能绕过 JSONL 强校验");
	const lines = readFileSync(infoA.sessionFile, "utf8").trimEnd().split("\n");
	const header = JSON.parse(lines[0]!) as { cwd: string };
	header.cwd = realpathSync(dir);
	lines[0] = JSON.stringify(header);
	writeFileSync(infoA.sessionFile, `${lines.join("\n")}\n`, "utf8");

	const rejected = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: a.id, mode: "in_place" },
	});
	assert.equal(rejected.statusCode, 400, rejected.body);
	assert.match(rejected.body, /Session cwd does not match its Window context/);
	const current = (await teams.getWindow(solo.id))!;
	assert.equal(current.workspaceId, b.id, "校验失败不得先提交目标上下文");
	assert.equal(current.activeSession, sessionB);
	assert.equal((await teams.contextForSession(sessionA))?.active, false);
	await sessions.disposeAll();
	await app.close();
});

test("solo 切换与消息接纳共享生命周期闸，提交后旧 Session 无法再次接纳", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("barrier-target");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	let markEntered!: () => void;
	const entered = new Promise<void>((resolve) => { markEntered = resolve; });
	let admitted = false;
	const admission = invoker.withActiveSessionLifecycle(solo.activeSession, async () => {
		markEntered();
		await hold;
		admitted = true;
	});
	await entered;
	let switched = false;
	const switching = app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: workspace.id, mode: "in_place" },
	}).then((response) => {
		switched = true;
		return response;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(switched, false, "切换必须等待已进入闸门的消息完成接纳");
	release();
	await admission;
	const response = await switching;
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(admitted, true);
	await assert.rejects(
		() => invoker.withActiveSessionLifecycle(solo.activeSession, async () => undefined),
		/所属项目未激活/,
		"切换提交后旧 Session 不得重新进入消息接纳闸门",
	);
	await sessions.disposeAll();
	await app.close();
});

test("solo 切换在 parking 准备失败时清理新 Session，并保持源 context active", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("prepare-failure");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let createdId: string | undefined;
	let removedId: string | undefined;
	await assert.rejects(
		() => invoker.switchWorkspaceInPlace(
			solo.id,
			workspace.id,
			async (source, cwd) => {
				const created = await sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd });
				createdId = created.id;
				return created;
			},
			async () => { throw new Error("prepare failed"); },
			(id) => sessions.validateStoredContext(id),
			(id) => sessions.suspend(id),
			async (id) => { removedId = id; return sessions.remove(id); },
		),
		/prepare failed/,
	);
	assert.ok(createdId);
	assert.equal(removedId, createdId, "create 之后任一提交前失败都必须清理 orphan Session");
	assert.equal(sessions.isOpen(createdId!), false);
	const current = (await teams.getWindow(solo.id))!;
	assert.equal(current.workspaceId, undefined);
	assert.equal(current.activeSession, solo.activeSession);
	assert.equal((await teams.contextForSession(solo.activeSession))?.active, true);
	await sessions.disposeAll();
	await app.close();
});

test("内部 triggerTurn 投递输掉切换竞态后只写 parked 审计，不唤醒旧 Session", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("internal-delivery-race");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let continueCreate!: () => void;
	let markSwitchInsideGate!: () => void;
	const createHold = new Promise<void>((resolve) => { continueCreate = resolve; });
	const switchInsideGate = new Promise<void>((resolve) => { markSwitchInsideGate = resolve; });
	const switching = invoker.switchWorkspaceInPlace(
		solo.id,
		workspace.id,
		async (source, cwd) => {
			const created = await sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd });
			markSwitchInsideGate();
			await createHold;
			return created;
		},
		(id) => sessions.prepareForParking(id),
		(id) => sessions.validateStoredContext(id),
		(id) => sessions.suspend(id),
		(id) => sessions.remove(id),
	);
	await switchInsideGate;
	const delivery = sessions.sendCustomMessage(
		solo.activeSession,
		{ customType: "pudding:race_audit", content: "切换后的迟到终态" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	continueCreate();
	const switched = await switching;
	assert.equal(switched.window.workspaceId, workspace.id);
	await delivery;
	assert.equal((await teams.contextForSession(solo.activeSession))?.active, false);
	assert.equal(sessions.isOpen(solo.activeSession), false, "迟到审计写完必须卸载 parked Session");
	const oldInfo = (await sessions.list()).find((session) => session.id === solo.activeSession)!;
	assert.match(readFileSync(oldInfo.sessionFile, "utf8"), /pudding:race_audit/);
	await sessions.disposeAll();
	await app.close();
});

test("durable triggerTurn 输掉切换竞态时不消费真实 eventId，等待项目恢复后重试", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const workspace = await teams.workspaces.createManaged("durable-delivery-race");
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { id: string; activeSession: string };
	let continueCreate!: () => void;
	let markSwitchInsideGate!: () => void;
	const createHold = new Promise<void>((resolve) => { continueCreate = resolve; });
	const switchInsideGate = new Promise<void>((resolve) => { markSwitchInsideGate = resolve; });
	const switching = invoker.switchWorkspaceInPlace(
		solo.id,
		workspace.id,
		async (source, cwd) => {
			const created = await sessions.create(undefined, { type: source.type, members: source.members, workspaceId: workspace.id, cwd });
			markSwitchInsideGate();
			await createHold;
			return created;
		},
		(id) => sessions.prepareForParking(id),
		(id) => sessions.validateStoredContext(id),
		(id) => sessions.suspend(id),
		(id) => sessions.remove(id),
	);
	await switchInsideGate;
	const delivery = sessions.appendCustomMessageIfAbsent(
		solo.activeSession,
		"durable-race",
		{ customType: "pudding:goal_recovery", content: "恢复执行" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	continueCreate();
	await switching;
	assert.equal(await delivery, "deferred");
	const oldInfo = (await sessions.list()).find((session) => session.id === solo.activeSession)!;
	const persisted = readFileSync(oldInfo.sessionFile, "utf8");
	assert.match(persisted, /durable-race:deferred-audit/);
	assert.doesNotMatch(persisted, /"eventId":"durable-race"/,
		"审计记录不得占用真实 eventId，否则恢复项目后无法重试唤醒");
	assert.equal(sessions.isOpen(solo.activeSession), false);
	await sessions.disposeAll();
	await app.close();
});

test("durable triggerTurn 只在入队边界持有 Window 生命周期锁", async () => {
	const { app, teams, sessions, invoker } = await makeStack();
	const listed = await app.inject({ method: "GET", url: "/api/rooms" });
	const solo = listed.json().rooms.find((room: { type: string }) => room.type === "solo") as { activeSession: string };
	const session = await sessions.open(solo.activeSession);
	let markStarted!: () => void;
	let finishTurn!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const heldTurn = new Promise<void>((resolve) => { finishTurn = resolve; });
	const originalSend = session.sendCustomMessage.bind(session);
	session.sendCustomMessage = async () => {
		markStarted();
		await heldTurn;
	};

	const delivery = sessions.appendCustomMessageIfAbsent(
		solo.activeSession,
		"durable-long-turn",
		{ customType: "pudding:goal_recovery", content: "恢复执行" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	await started;
	const lifecycleProbe = invoker.withActiveSessionLifecycle(solo.activeSession, async () => "available");
	const probeResult = await Promise.race([
		lifecycleProbe,
		new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
	]);
	assert.equal(probeResult, "available", "模型回合运行期间读取/切换所需的 Window 生命周期锁必须已经释放");

	finishTurn();
	assert.equal(await delivery, "delivered");
	session.sendCustomMessage = originalSend;
	await sessions.disposeAll();
	await app.close();
});

test("P3-1 API: solo 原地切换会取消由 solo 路由到 direct 的 Delegation", async () => {
	const { app, teams, sessions, delegations } = await makeStack();
	const b = await teams.workspaces.createManaged("B");
	const solo = await teams.ensureSoloWindow(
		async () => sessions.create(undefined, { type: "solo", members: [] }),
		async () => false,
	);
	const sourceCwd = await teams.workspaceFor(solo.id);
	const directSession = await sessions.create(undefined, { type: "direct", members: ["alpha"], cwd: sourceCwd });
	const direct = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: directSession.id });
	const delegation = await delegations.createDelegation({
		windowId: direct.id,
		cwdSnapshot: sourceCwd,
		managerSessionId: solo.activeSession,
		agentId: "alpha",
		agentRevision: (await teams.getAgent("alpha"))?.extensionRevision ?? 0,
		operation: "run",
	});
	await delegations.transitionDelegation(delegation.id, ["admitted"], { executionState: "running" });

	const switched = await app.inject({
		method: "POST",
		url: `/api/rooms/${solo.id}/switch-workspace`,
		payload: { workspaceId: b.id, mode: "in_place" },
	});
	assert.equal(switched.statusCode, 200, switched.body);
	assert.equal((await delegations.getDelegation(delegation.id))?.executionState, "observation_lost");
	await sessions.disposeAll();
	await app.close();
});
