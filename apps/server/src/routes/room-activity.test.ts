import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile, readFile, rename, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RoomActivityProjector, activityFromEntry, compareRoomActivity } from "./room-activity.js";

const at = (s: number) => `2026-09-23T00:00:${String(s).padStart(2, "0")}.000Z`;
const msg = (id: string, s: number, role: string, text: string) => ({ type: "message", id, timestamp: at(s), message: { role, content: [{ type: "text", text }] } });
const custom = (id: string, s: number, type: string, content: string, details?: Record<string, unknown>, display = true) => ({ type: "custom_message", id, timestamp: at(s), customType: type, content, details, display });
const lines = (...entries: object[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

test("only durable business entries advance activity", () => {
	assert.equal(activityFromEntry("s", msg("u", 1, "user", "  发起  工作 "))?.preview, "发起 工作");
	assert.equal(activityFromEntry("s", msg("a", 2, "assistant", "已完成"))?.eventId, "s:a");
	assert.equal(activityFromEntry("s", custom("i", 3, "pudding:interaction_required", "请审批"))?.preview, "请审批");
	assert.equal(activityFromEntry("s", custom("x", 4, "pudding:late_audit", "审计")), null);
	assert.equal(activityFromEntry("s", custom("plan", 4, "pudding:work_plan_update", "内部状态同步")), null);
	assert.equal(activityFromEntry("s", custom("decision", 4, "pudding:decision_answered", "已确认"))?.preview, "已确认");
	assert.equal(activityFromEntry("s", custom("hidden", 5, "pudding:task_assign", "恢复投影", { taskId: "task-1" }, false)), null);
	assert.equal(activityFromEntry("s", msg("tool", 5, "toolResult", "工具结果")), null);
	assert.equal(activityFromEntry("s", { type: "session_info", id: "title", timestamp: at(6), name: "新标题" }), null);
	assert.equal(activityFromEntry("s", { type: "model_change", id: "model", timestamp: at(7) }), null);
	assert.equal(activityFromEntry("s", { ...msg("bad", 8, "user", "内容"), timestamp: "bad" }), null);
});

test("hidden recovery projections and task assignment enrichment do not create new activity", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-hidden-projection-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(custom("assign", 10, "pudding:task_assign", "发起委派", { taskId: "task-1" })));
		const projector = new RoomActivityProjector(path.join(dir, "state.json"));
		const first = await projector.project("room", sessions);
		await appendFile(sessionFile, lines(
			custom("hidden", 20, "pudding:task_assign", "Manager 恢复投影", { taskId: "task-2" }, false),
			custom("enriched", 30, "pudding:task_assign", "发起委派", { taskId: "task-1", delegationId: "run-1" }),
		));
		assert.deepEqual(await projector.project("room", sessions), first);
		assert.deepEqual(await new RoomActivityProjector(path.join(dir, "state.json")).project("room", sessions), first);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("replay, duplicate, out-of-order and restart preserve cross-Session activity", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-activity-"));
	try {
		const oldFile = path.join(dir, "old.jsonl");
		const currentFile = path.join(dir, "current.jsonl");
		await writeFile(oldFile, lines(msg("old", 20, "user", "旧会话的新活动"), msg("old", 20, "user", "重复不得覆盖")));
		await writeFile(currentFile, lines(msg("current", 10, "assistant", "当前会话内容")));
		const sessions = [{ id: "old", sessionFile: oldFile }, { id: "current", sessionFile: currentFile }];
		const statePath = path.join(dir, "state", "room-activity.json");
		const projector = new RoomActivityProjector(statePath);
		const first = await projector.project("room", sessions);
		assert.deepEqual(first, { lastActivityAt: at(20), lastMessagePreview: "旧会话的新活动", activitySessionId: "old", activityRevision: 1 });
		assert.deepEqual(await projector.project("room", sessions), first);
		await appendFile(currentFile, lines({ type: "session_info", id: "rename", timestamp: at(30), name: "新标题" }, { type: "model_change", id: "model", timestamp: at(31) }, msg("late-old", 15, "user", "迟到的旧事件")));
		assert.deepEqual(await projector.project("room", sessions), { ...first, activityRevision: 2 }, "delayed content is unread without moving the room backwards");
		await appendFile(currentFile, lines(custom("approval", 25, "pudding:interaction_required", "等待审批")));
		const final = await projector.project("room", sessions);
		assert.deepEqual(final, { lastActivityAt: at(25), lastMessagePreview: "等待审批", activitySessionId: "current", activityRevision: 3 });
		assert.deepEqual(await new RoomActivityProjector(statePath).project("room", sessions), final);
		await writeFile(currentFile, lines(msg("current", 10, "assistant", "当前会话内容")));
		const removed = await new RoomActivityProjector(statePath).project("room", sessions);
		assert.equal(removed.activityRevision, 4, "removing visible source advances durable revision");
		assert.equal(removed.activitySessionId, "old");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("two rooms restart from JSONL without token or metadata reordering", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-two-room-replay-"));
	try {
		const aOld = path.join(dir, "a-old.jsonl");
		const aCurrent = path.join(dir, "a-current.jsonl");
		const bCurrent = path.join(dir, "b-current.jsonl");
		const statePath = path.join(dir, "room-activity.json");
		await writeFile(aOld, lines(msg("a-old", 20, "assistant", "A 旧会话进展")));
		await writeFile(aCurrent, lines(msg("a-current", 10, "user", "A 当前会话")));
		await writeFile(bCurrent, lines(msg("b-current", 30, "assistant", "B 最新进展")));
		const aSessions = [{ id: "a-old", sessionFile: aOld }, { id: "a-current", sessionFile: aCurrent }];
		const bSessions = [{ id: "b-current", sessionFile: bCurrent }];
		const first = new RoomActivityProjector(statePath);
		const a = await first.project("room-a", aSessions);
		const b = await first.project("room-b", bSessions);
		assert.deepEqual(["room-a", "room-b"].sort((left, right) => compareRoomActivity(
			{ id: left, lastActivityAt: left === "room-a" ? a.lastActivityAt : b.lastActivityAt, createdAt: at(1) },
			{ id: right, lastActivityAt: right === "room-a" ? a.lastActivityAt : b.lastActivityAt, createdAt: at(1) },
		)), ["room-b", "room-a"]);
		const before = JSON.parse(await readFile(statePath, "utf8")) as Record<string, { eventDigest: string; activityRevision: number }>;
		await appendFile(aOld, lines(msg("a-old", 20, "assistant", "重复事件不应改变首次内容")));
		await appendFile(bCurrent, lines(
			{ type: "model_change", id: "model", timestamp: at(40) },
			{ type: "custom_message", id: "token", timestamp: at(41), customType: "pudding:stream_token", content: "生成中" },
			{ type: "session_info", id: "rename", timestamp: at(42), name: "B 改名" },
		));
		const restarted = new RoomActivityProjector(statePath);
		assert.deepEqual(await restarted.project("room-a", aSessions), a);
		assert.deepEqual(await restarted.project("room-b", bSessions), b);
		const unchanged = JSON.parse(await readFile(statePath, "utf8")) as typeof before;
		assert.deepEqual(unchanged, before, "重复、token 和元数据不改任一 Room 的修订或摘要");
		await appendFile(aCurrent, lines(msg("a-late", 25, "assistant", "A 新进展")));
		const nextA = await restarted.project("room-a", aSessions);
		assert.equal(nextA.activityRevision, a.activityRevision + 1);
		assert.equal(nextA.activitySessionId, "a-current");
		assert.equal((await restarted.project("room-b", bSessions)).activityRevision, b.activityRevision);
		const after = JSON.parse(await readFile(statePath, "utf8")) as typeof before;
		assert.notEqual(after["room-a"]?.eventDigest, before["room-a"]?.eventDigest);
		assert.equal(after["room-b"]?.eventDigest, before["room-b"]?.eventDigest);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("late visible event advances unread watermark once, even when latest timestamp and ID stay unchanged", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-late-read-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const statePath = path.join(dir, "state.json");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(msg("z-latest", 20, "assistant", "最新消息")));
		const projector = new RoomActivityProjector(statePath);
		const first = await projector.project("room", sessions);
		assert.equal(await projector.markRead("room", "viewer", "s", first.activityRevision), 1);
		await appendFile(sessionFile, lines(msg("a-delayed", 15, "assistant", "延迟落盘的进展")));
		const second = await projector.project("room", sessions);
		assert.equal(second.lastActivityAt, first.lastActivityAt);
		assert.equal(second.activitySessionId, first.activitySessionId);
		assert.equal(second.activityRevision, 2);
		assert.deepEqual(await projector.readStatus("room", "viewer"), {
			readRevision: 1,
			hasUnreadActivity: true,
			unreadSessionId: "s",
			unreadPreview: "延迟落盘的进展",
		});
		await appendFile(sessionFile, lines(msg("a-delayed", 15, "assistant", "重复不得增加修订")));
		assert.deepEqual(await projector.project("room", sessions), second);
		assert.deepEqual(await new RoomActivityProjector(statePath).project("room", sessions), second);
		assert.equal((await new RoomActivityProjector(statePath).readStatus("room", "viewer")).unreadPreview, "延迟落盘的进展");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("sort by business activity, then id; invalid fallback last", () => {
	const rooms = [
		{ id: "b", lastActivityAt: at(10), createdAt: at(1) },
		{ id: "a", lastActivityAt: at(10), createdAt: at(2) },
		{ id: "new", lastActivityAt: null, createdAt: at(20) },
		{ id: "invalid", lastActivityAt: null, createdAt: "invalid" },
	];
	assert.deepEqual(rooms.sort(compareRoomActivity).map((r) => r.id), ["new", "a", "b", "invalid"]);
});

test("read watermark acknowledges only the presented revision across a new event and restart", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-read-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const statePath = path.join(dir, "state.json");
		await writeFile(sessionFile, lines(msg("first", 1, "assistant", "首条进展")));
		const projector = new RoomActivityProjector(statePath);
		const sessions = [{ id: "s", sessionFile }];
		const first = await projector.project("room", sessions);
		assert.equal(first.activityRevision, 1);
		await appendFile(sessionFile, lines(msg("second", 2, "assistant", "后台新进展")));
		const second = await projector.project("room", sessions);
		assert.equal(second.activityRevision, 2);
		assert.equal(await projector.markRead("room", "viewer", "s", first.activityRevision), 1);
		assert.equal((await projector.readStatus("room", "viewer")).readRevision, 1);
		await assert.rejects(projector.markRead("room", "viewer", "s", 3));
		const restarted = new RoomActivityProjector(statePath);
		assert.equal((await restarted.project("room", sessions)).activityRevision, 2);
		assert.equal((await restarted.readStatus("room", "viewer")).readRevision, 1);
		assert.equal(await restarted.markRead("room", "viewer", "s", 2), 2);
		assert.equal((await restarted.readStatus("room", "other-viewer")).readRevision, 0);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("reading one Session never clears another Session's unread activity", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-session-read-"));
	try {
		const oldFile = path.join(dir, "old.jsonl");
		const currentFile = path.join(dir, "current.jsonl");
		const statePath = path.join(dir, "state.json");
		await writeFile(oldFile, lines(msg("old", 10, "assistant", "旧会话进展")));
		await writeFile(currentFile, lines(msg("current", 20, "assistant", "当前会话进展")));
		const sessions = [{ id: "old", sessionFile: oldFile }, { id: "current", sessionFile: currentFile }];
		const projector = new RoomActivityProjector(statePath);
		const first = await projector.project("room", sessions);
		assert.equal(first.activitySessionId, "current");
		await projector.markRead("room", "viewer", "current", first.activityRevision);
		assert.deepEqual(await projector.readStatus("room", "viewer"), {
			readRevision: 1, hasUnreadActivity: true, unreadSessionId: "old", unreadPreview: "旧会话进展",
		});
		await projector.markRead("room", "viewer", "old", first.activityRevision);
		assert.deepEqual(await projector.readStatus("room", "viewer"), {
			readRevision: 1, hasUnreadActivity: false, unreadSessionId: null, unreadPreview: null,
		});
		await appendFile(oldFile, lines(msg("delayed", 15, "assistant", "旧会话迟到进展")));
		const second = await projector.project("room", sessions);
		assert.equal(second.lastActivityAt, at(20));
		assert.equal(second.activityRevision, 2);
		assert.equal((await projector.readStatus("room", "viewer")).unreadSessionId, "old");
		assert.equal((await projector.readStatus("room", "viewer")).unreadPreview, "旧会话迟到进展");
		assert.equal((await new RoomActivityProjector(statePath).readStatus("room", "viewer")).unreadSessionId, "old");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("room summary reads activity and unread from one queue turn", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-summary-snapshot-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(msg("answer", 1, "assistant", "待读回复")));
		const projector = new RoomActivityProjector(path.join(dir, "state.json"));
		const pendingSummary = projector.projectWithReadStatus("room", sessions, "viewer");
		const pendingRead = projector.markRead("room", "viewer", "s", 1);
		const summary = await pendingSummary;
		assert.equal(summary.activity.activityRevision, 1);
		assert.deepEqual(summary.read, {
			readRevision: 0, hasUnreadActivity: true, unreadSessionId: "s", unreadPreview: "待读回复",
		});
		await pendingRead;
		assert.equal((await projector.readStatus("room", "viewer")).hasUnreadActivity, false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("read acknowledgement returns one revision-consistent status", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-read-response-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(msg("first", 1, "assistant", "第一条回复")));
		const projector = new RoomActivityProjector(path.join(dir, "state.json"));
		assert.equal((await projector.project("room", sessions)).activityRevision, 1);
		await appendFile(sessionFile, lines(msg("second", 2, "assistant", "第二条回复")));
		const pendingProject = projector.project("room", sessions);
		const pendingRead = projector.markReadWithStatus("room", "viewer", "s", 1);
		assert.equal((await pendingProject).activityRevision, 2);
		assert.deepEqual(await pendingRead, {
			activityRevision: 2,
			read: { readRevision: 1, hasUnreadActivity: true, unreadSessionId: "s", unreadPreview: "第二条回复" },
		});
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("own user message updates room activity without marking it unread", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-own-message-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(msg("outgoing", 1, "user", "我的新消息")));
		const projector = new RoomActivityProjector(path.join(dir, "state.json"));
		const first = await projector.project("room", sessions);
		assert.equal(first.lastMessagePreview, "我的新消息");
		assert.equal(first.activityRevision, 1);
		assert.equal((await projector.readStatus("room", "viewer")).hasUnreadActivity, false);
		await appendFile(sessionFile, lines(msg("incoming", 2, "assistant", "Worker 回复")));
		const second = await projector.project("room", sessions);
		assert.equal(second.activityRevision, 2);
		assert.equal((await projector.readStatus("room", "viewer")).unreadSessionId, "s");
		await projector.markRead("room", "viewer", "s", second.activityRevision);
		await appendFile(sessionFile, lines(msg("outgoing-again", 3, "user", "继续追问")));
		const third = await projector.project("room", sessions);
		assert.equal(third.activityRevision, 3);
		assert.equal(third.lastMessagePreview, "继续追问");
		assert.equal((await projector.readStatus("room", "viewer")).hasUnreadActivity, false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("human decision and approval outcomes update activity without self-unread; later worker result remains unread", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-human-outcome-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(custom("question", 1, "pudding:interaction_required", "请确认")));
		const projector = new RoomActivityProjector(path.join(dir, "state.json"));
		const first = await projector.project("room", sessions);
		await projector.markRead("room", "viewer", "s", first.activityRevision);
		await appendFile(sessionFile, lines(
			custom("answer", 2, "pudding:decision_answered", "Human 已回答业务决策"),
			custom("approved", 3, "pudding:interaction_resolved", "用户已批准 Worker 继续", { status: "approved", source: "worker" }),
		));
		const ownActions = await projector.project("room", sessions);
		assert.equal(ownActions.activityRevision, first.activityRevision + 1);
		assert.equal(ownActions.lastMessagePreview, "用户已批准 Worker 继续");
		assert.equal((await projector.readStatus("room", "viewer")).hasUnreadActivity, false);
		await appendFile(sessionFile, lines(custom("result", 4, "pudding:task_result", "Worker 已完成")));
		await projector.project("room", sessions);
		assert.deepEqual(await new RoomActivityProjector(path.join(dir, "state.json")).readStatus("room", "viewer"), {
			readRevision: first.activityRevision,
			hasUnreadActivity: true,
			unreadSessionId: "s",
			unreadPreview: "Worker 已完成",
		});
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid durable activity state is not replaced or treated as an unread reset", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-invalid-state-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const statePath = path.join(dir, "state.json");
		await writeFile(sessionFile, lines(msg("reply", 1, "assistant", "待读回复")));
		const sessions = [{ id: "s", sessionFile }];
		const original = new RoomActivityProjector(statePath);
		await original.project("room", sessions);
		await original.markRead("room", "viewer", "s", 1);
		const validState = await readFile(statePath, "utf8");
		const invalidState = '{"room":{"activityRevision":1}}';
		await writeFile(statePath, invalidState);
		const restarted = new RoomActivityProjector(statePath);
		await assert.rejects(restarted.project("room", sessions), /活动状态文件无效/);
		assert.equal(await readFile(statePath, "utf8"), invalidState, "a failed load must never overwrite the only durable read watermark");
		await writeFile(statePath, validState);
		assert.equal((await restarted.project("room", sessions)).activityRevision, 1, "a repaired state can be loaded by the same projector");
		assert.equal((await restarted.readStatus("room", "viewer")).hasUnreadActivity, false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("activity state rename failure removes temp file and preserves last durable revision", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-rename-failure-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const statePath = path.join(dir, "state.json");
		const previousPath = path.join(dir, "state.previous.json");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(msg("first", 1, "assistant", "第一条")));
		const projector = new RoomActivityProjector(statePath);
		const first = await projector.project("room", sessions);
		const durable = await readFile(statePath, "utf8");
		assert.equal((await stat(statePath)).mode & 0o777, 0o600);
		await rename(statePath, previousPath);
		await mkdir(statePath);
		await appendFile(sessionFile, lines(msg("second", 2, "assistant", "第二条")));
		await assert.rejects(projector.project("room", sessions));
		assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith(".tmp")), []);
		assert.equal(await readFile(previousPath, "utf8"), durable);
		await rm(statePath, { recursive: true });
		await rename(previousPath, statePath);
		assert.equal((await projector.project("room", sessions)).activityRevision, first.activityRevision + 1);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("directory sync failure after rename freezes current projector until restart replay", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-sync-failure-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const statePath = path.join(dir, "state.json");
		const sessions = [{ id: "s", sessionFile }];
		await writeFile(sessionFile, lines(msg("first", 1, "assistant", "第一条")));
		const projector = new RoomActivityProjector(statePath);
		const first = await projector.project("room", sessions);
		await appendFile(sessionFile, lines(msg("second", 2, "assistant", "第二条")));
		const storage = projector as unknown as { syncDirectory: () => Promise<void> };
		const original = storage.syncDirectory.bind(projector);
		storage.syncDirectory = async () => { throw new Error("injected directory sync failure"); };
		try {
			await assert.rejects(projector.project("room", sessions), /injected directory sync failure/);
			await assert.rejects(projector.project("room", sessions), /持久化结果不确定/);
			await assert.rejects(projector.readStatus("room", "viewer"), /持久化结果不确定/);
		} finally { storage.syncDirectory = original; }
		assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith(".tmp")), []);
		const restarted = new RoomActivityProjector(statePath);
		assert.equal((await restarted.project("room", sessions)).activityRevision, first.activityRevision + 1);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a referenced Session history read failure cannot masquerade as deleted activity", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-history-gap-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const parkedFile = path.join(dir, "temporarily-moved.jsonl");
		const statePath = path.join(dir, "state.json");
		await writeFile(sessionFile, lines(msg("reply", 1, "assistant", "尚未阅读")));
		const projector = new RoomActivityProjector(statePath);
		const sessions = [{ id: "s", sessionFile }];
		const first = await projector.project("room", sessions);
		const durable = await readFile(statePath, "utf8");
		await rename(sessionFile, parkedFile);
		await assert.rejects(projector.project("room", sessions));
		await assert.rejects(projector.project("room", [{ id: "s", sessionFile: "" }]), /历史文件不可读/);
		assert.equal(await readFile(statePath, "utf8"), durable);
		await rename(parkedFile, sessionFile);
		assert.deepEqual(await projector.project("room", sessions), first);
		assert.equal((await projector.readStatus("room", "viewer")).hasUnreadActivity, true);
		assert.equal((await projector.project("room", [])).activityRevision, first.activityRevision + 1, "only removing the Session from the room treats its content as deleted");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a malformed complete JSONL line fails closed while an unfinished final append is retried", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "teams-room-jsonl-corrupt-"));
	try {
		const sessionFile = path.join(dir, "s.jsonl");
		const statePath = path.join(dir, "state.json");
		const sessions = [{ id: "s", sessionFile }];
		const firstLine = lines(msg("first", 1, "assistant", "第一条"));
		await writeFile(sessionFile, firstLine);
		const projector = new RoomActivityProjector(statePath);
		const first = await projector.project("room", sessions);
		const durable = await readFile(statePath, "utf8");
		await appendFile(sessionFile, '{"type":\n');
		await assert.rejects(projector.project("room", sessions), /第 2 行损坏/);
		assert.equal(await readFile(statePath, "utf8"), durable);
		const nextLine = JSON.stringify(msg("second", 2, "assistant", "第二条"));
		await writeFile(sessionFile, firstLine + nextLine.slice(0, 20));
		assert.deepEqual(await projector.project("room", sessions), first, "an unfinished final append must not clear existing activity");
		await appendFile(sessionFile, nextLine.slice(20) + "\n");
		const repaired = await projector.project("room", sessions);
		assert.equal(repaired.activityRevision, first.activityRevision + 1);
		assert.equal(repaired.lastMessagePreview, "第二条");
	} finally { await rm(dir, { recursive: true, force: true }); }
});
