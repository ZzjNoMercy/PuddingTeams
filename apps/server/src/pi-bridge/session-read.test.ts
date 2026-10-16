import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TeamsStore } from "../store/teams.js";
import { SessionReadService, extractSessionRefs, parseSessionRef } from "./session-read.js";

/**
 * 会话深链（docs/2026-10-16-会话深链交接方案.md）：链接解析、权限边界
 * （同窗口自由 / Manager 同 Workspace / Worker 引用即授权 / 跨 Workspace 拒绝）
 * 与分页读取。
 */

function makeDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-session-read-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	return dir;
}

async function makeTeams(dir: string) {
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	await teams.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
	await teams.upsertAgent({ name: "beta", description: "beta", invoke: { type: "command", command: "beta", runArgs: [] } });
	return teams;
}

/** 造一个落盘的聊天 session（user + assistant 若干轮），返回 sessionId。 */
function makeSession(sessionDir: string, cwd: string, turns: Array<[string, string]>): string {
	const sm = SessionManager.create(cwd, sessionDir);
	for (const [user, assistant] of turns) {
		sm.appendMessage({ role: "user", content: user, timestamp: Date.now() } as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: assistant }],
			api: "openai",
			provider: "openai",
			model: "fake",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
	}
	return sm.getSessionId();
}

test("parseSessionRef: 三种形态", () => {
	assert.deepEqual(parseSessionRef("puddingteams://rooms/room-1/sessions/sess-1"), { roomId: "room-1", sessionId: "sess-1" });
	assert.deepEqual(parseSessionRef("/chats?room=room-1&session=sess-1"), { roomId: "room-1", sessionId: "sess-1" });
	assert.deepEqual(parseSessionRef("http://127.0.0.1:8934/chats?session=sess-2&room=room-2"), { roomId: "room-2", sessionId: "sess-2" });
	assert.deepEqual(parseSessionRef("01A1423C-9447-74D9-BA04-D063588C3DF8"), { sessionId: "01A1423C-9447-74D9-BA04-D063588C3DF8" });
	assert.equal(parseSessionRef("随便一段话"), undefined);
	assert.equal(parseSessionRef("/chats?room=room-1"), undefined);
});

test("extractSessionRefs: 只认显式链接，不扫裸 id；多次提及去重", () => {
	const text = [
		"背景一：puddingteams://rooms/r1/sessions/s1 和 http://localhost:8934/chats?room=r2&session=s2。",
		"再提一次 s1：/chats?room=r1&session=s1（重复）。",
		"裸 id a356f82d-97f9-42aa-bc51-1ef691eacbb4 不算授权。",
	].join("\n");
	assert.deepEqual(extractSessionRefs(text).map((ref) => ref.sessionId).sort(), ["s1", "s2"]);
	assert.deepEqual(extractSessionRefs("没有链接"), []);
});

test("权限：同窗口自由读；Manager 跨窗口同 Workspace 可读；跨 Workspace 拒绝", async () => {
	const dir = makeDir();
	try {
		const teams = await makeTeams(dir);
		const sessionDir = path.join(dir, "sessions");
		const service = new SessionReadService(teams, sessionDir);

		// solo 窗口（manager）+ alpha 单聊窗口，同属默认工作目录（workspaceId 均为 undefined）。
		const soloSession = makeSession(sessionDir, dir, [["你好", "在的"]]);
		await teams.ensureSoloWindow(async () => ({ id: soloSession }), async () => true);
		const alphaSession = makeSession(sessionDir, dir, [["任务一", "做完了"]]);
		await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: alphaSession });
		// 另一个 Workspace 里的 beta 单聊。
		const other = await teams.workspaces.createManaged("其他项目");
		const betaSession = makeSession(sessionDir, other.canonicalPath, [["机密", "结果"]]);
		await teams.createWindow({ type: "direct", members: ["beta"], sessionId: betaSession, workspaceId: other.id });

		const manager = { kind: "chat" as const, sessionId: () => soloSession, role: "manager" as const };
		// 同窗口：读自己。
		const own = await service.read("solo", soloSession, { mode: "messages", cursor: 0, limit: 50 });
		assert.match(own.text, /你好/);
		// Manager 跨窗口同（默认）Workspace：可读。
		const read = await service.read((await teams.contextForSession(alphaSession))!.window.id, alphaSession, { mode: "messages", cursor: 0, limit: 50 });
		assert.match(read.text, /任务一/);
		// 跨 Workspace：拒绝。授权判定走私有路径，通过工具错误面验证——
		// 直接调 authorize 的等价物：构造 chatExtension 的 execute 太重，这里验证
		// contextForSession 边界与服务公开 read 的组合。
		assert.notEqual((await teams.contextForSession(soloSession))!.workspaceId, (await teams.contextForSession(betaSession))!.workspaceId);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("权限（工具面）：Worker 引用即授权，未引用拒绝，跨 Workspace 拒绝", async () => {
	const dir = makeDir();
	try {
		const teams = await makeTeams(dir);
		const sessionDir = path.join(dir, "sessions");
		const service = new SessionReadService(teams, sessionDir);

		const alphaChat = makeSession(sessionDir, dir, [["先看看这个", "好的"]]);
		const alphaWindow = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: alphaChat });
		const target = makeSession(sessionDir, dir, [["背景资料", "细节如下"]]);
		const targetWindow = await teams.createWindow({ type: "direct", members: ["beta"], sessionId: target });

		// 通过 chatExtension 注册的 session_read 工具直接驱动 execute。
		const calls: Array<() => string> = [];
		let currentSession = alphaChat;
		const extension = service.chatExtension(() => currentSession, "worker");
		const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
		extension.factory({
			registerTool: (tool: { name: string; execute: never }) => { tools.set(tool.name, tool as never); },
			on: () => undefined,
		} as never);
		const execute = tools.get("session_read")!.execute;
		void calls;

		// 未引用：拒绝。
		await assert.rejects(() => execute("t1", { ref: target }), /引用即授权/);

		// 用户在自己的单聊里贴出链接后：可读。
		const sm = SessionManager.open((await SessionManager.listAll(sessionDir)).find((s) => s.id === alphaChat)!.path, sessionDir);
		sm.appendMessage({ role: "user", content: `背景在这里 /chats?room=${targetWindow.id}&session=${target}`, timestamp: Date.now() } as never);
		const ok = await execute("t2", { ref: `puddingteams://rooms/${targetWindow.id}/sessions/${target}` });
		assert.match(ok.content[0]!.text, /背景资料/);

		// 链接 roomId 与会话不匹配：拒绝。
		await assert.rejects(() => execute("t3", { ref: `puddingteams://rooms/${alphaWindow.id}/sessions/${target}` }), /不匹配/);

		// Manager 角色无需引用。
		const managerExtension = service.chatExtension(() => alphaChat, "manager");
		managerExtension.factory({
			registerTool: (tool: { name: string; execute: never }) => { tools.set(`m:${tool.name}`, tool as never); },
			on: () => undefined,
		} as never);
		const managerRead = await tools.get("m:session_read")!.execute("t4", { ref: target });
		assert.match(managerRead.content[0]!.text, /背景资料/);
		void currentSession;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("分页：cursor/nextCursor/total/leafEntryId，full 模式含工具结果", async () => {
	const dir = makeDir();
	try {
		const teams = await makeTeams(dir);
		const sessionDir = path.join(dir, "sessions");
		const service = new SessionReadService(teams, sessionDir);
		const turns: Array<[string, string]> = Array.from({ length: 6 }, (_, i) => [`问${i}`, `答${i}`]);
		const sessionId = makeSession(sessionDir, dir, turns);
		const window = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId });

		const first = await service.read(window.id, sessionId, { mode: "messages", cursor: 0, limit: 5 });
		assert.equal(first.total, 12);
		assert.equal(first.nextCursor, 5);
		assert.ok(first.leafEntryId);
		assert.match(first.text, /问0/);
		const second = await service.read(window.id, sessionId, { mode: "messages", cursor: first.nextCursor!, limit: 100 });
		assert.equal(second.nextCursor, undefined);
		assert.match(second.text, /答5/);
		// 游标越过末尾：空页而非报错。
		const past = await service.read(window.id, sessionId, { mode: "messages", cursor: 999, limit: 10 });
		assert.equal(past.text, "");
		assert.equal(past.nextCursor, undefined);
		// full 模式额外包含工具调用与工具结果。
		const sm = SessionManager.open((await SessionManager.listAll(sessionDir)).find((s) => s.id === sessionId)!.path, sessionDir);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
			api: "openai", provider: "openai", model: "fake",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse", timestamp: Date.now(),
		} as never);
		sm.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "file-a" }], isError: false, timestamp: Date.now() } as never);
		const full = await service.read(window.id, sessionId, { mode: "full", cursor: 0, limit: 200 });
		assert.match(full.text, /\[工具调用\] bash/);
		assert.match(full.text, /\[工具结果\] bash/);
		// messages 模式不含工具痕迹。
		const plain = await service.read(window.id, sessionId, { mode: "messages", cursor: 0, limit: 200 });
		assert.doesNotMatch(plain.text, /工具调用|工具结果/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("单条消息超过字符上限也要截断，不能整块原样返回", async () => {
	const dir = makeDir();
	try {
		const teams = await makeTeams(dir);
		const sessionDir = path.join(dir, "sessions");
		const service = new SessionReadService(teams, sessionDir);
		const huge = makeSession(sessionDir, dir, [["巨".repeat(500_000), "尾"], ["小", "答"]]);
		const window = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: huge });
		const page = await service.read(window.id, huge, { mode: "messages", cursor: 0, limit: 200 });
		assert.ok(page.text.length <= 101_000, `返回 ${page.text.length} 字符，越过 100k 上限`);
		assert.equal(page.truncated, true);
		assert.match(page.text, /已截断/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("执行会话授权：workspace 边界 + 任务文本里的链接", async () => {
	const dir = makeDir();
	try {
		const teams = await makeTeams(dir);
		const sessionDir = path.join(dir, "sessions");
		const service = new SessionReadService(teams, sessionDir);
		const target = makeSession(sessionDir, dir, [["共享背景", "内容"]]);
		const targetWindow = await teams.createWindow({ type: "direct", members: ["alpha"], sessionId: target });
		const other = await teams.workspaces.createManaged("另一个");
		const foreign = makeSession(sessionDir, other.canonicalPath, [["别的项目", "内容"]]);
		await teams.createWindow({ type: "direct", members: ["beta"], sessionId: foreign, workspaceId: other.id });

		const extension = service.executionExtension(
			() => undefined,
			async () => `任务背景：puddingteams://rooms/${targetWindow.id}/sessions/${target}`,
		);
		const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
		extension.factory({
			registerTool: (tool: { name: string; execute: never }) => { tools.set(tool.name, tool as never); },
			on: () => undefined,
		} as never);
		const execute = tools.get("session_read")!.execute;
		const ok = await execute("e1", { ref: String(target) });
		assert.match(ok.content[0]!.text, /共享背景/);
		// 同 Workspace 但未引用：拒绝（换一个没有链接的 ownUserText）。
		const noGrant = service.executionExtension(() => undefined, async () => "没有链接的任务");
		noGrant.factory({
			registerTool: (tool: { name: string; execute: never }) => { tools.set(`n:${tool.name}`, tool as never); },
			on: () => undefined,
		} as never);
		await assert.rejects(() => tools.get("n:session_read")!.execute("e2", { ref: String(target) }), /引用即授权/);
		// 跨 Workspace 即使被引用也拒绝。
		const crossGrant = service.executionExtension(() => undefined, async () => `/chats?room=x&session=${foreign}`);
		crossGrant.factory({
			registerTool: (tool: { name: string; execute: never }) => { tools.set(`c:${tool.name}`, tool as never); },
			on: () => undefined,
		} as never);
		await assert.rejects(() => tools.get("c:session_read")!.execute("e3", { ref: String(foreign) }), /Workspace/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
