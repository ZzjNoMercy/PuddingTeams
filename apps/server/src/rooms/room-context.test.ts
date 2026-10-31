import { test } from "node:test";
import assert from "node:assert";
import {
	RoomContextRangeError,
	RoomContextTooLargeError,
	buildRoomContext,
	renderRoomHistory,
} from "./room-context.js";
import type { RoomEvent } from "./room-event-store.js";

const ROOM = "room-1111-2222";
const SHA = "a".repeat(64);

function ev(seq: number, overrides: Partial<RoomEvent> = {}): RoomEvent {
	return {
		id: `event-${seq}`,
		roomSessionId: ROOM,
		seq,
		kind: "message",
		actor: { kind: "user" },
		content: `消息 ${seq}`,
		mentions: [],
		createdAt: `2026-10-31T00:00:0${seq}.000Z`,
		...overrides,
	};
}

const agentNames = { manager: "Manager", "worker-a": "WorkerA", "worker-b": "WorkerB" };

test("RoomContext: 历史 + 当前消息合成一条输入，保留作者/mentions/附件", () => {
	const events = [
		ev(1, {
			mentions: ["worker-a"],
			content: "请检查当前方案。",
			attachments: [{ name: "方案.pdf", path: "/rooms/plan.pdf", mediaType: "application/pdf", size: 9, sha256: SHA, kind: "file" }],
		}),
		ev(2, { actor: { kind: "agent", agentId: "manager" }, content: "已形成综合方案。" }),
		ev(3, { actor: { kind: "agent", agentId: "worker-b" }, content: "风险主要有两点。" }),
	];
	const built = buildRoomContext({
		events,
		through: "event-3",
		current: { eventId: "event-4", content: "请继续检查", mentions: ["worker-b"], targetAgentName: "WorkerB" },
		agentNames,
	});
	assert.match(built.text, /^\[房间公共历史｜roomSessionId=room-1111-2222｜through=event-3\/3\]/);
	assert.match(built.text, /\[房间消息｜用户 → @WorkerA｜event=event-1\]/);
	assert.match(built.text, /附件：方案\.pdf（application\/pdf，sha256=a{64}）：\/rooms\/plan\.pdf/);
	assert.match(built.text, /\[房间消息｜Manager｜event=event-2\]/);
	assert.match(built.text, /\[房间消息｜WorkerB｜event=event-3\]/);
	assert.match(built.text, /\[当前用户消息｜用户 → @WorkerB｜event=event-4\]\n请继续检查$/);
	assert.equal(built.historyCount, 3);
	assert.equal(built.throughSeq, 3);
});

test("RoomContext: terminal/artifact 只投影终态与公开产物", () => {
	const events = [
		ev(1, { kind: "terminal", actor: { kind: "agent", agentId: "worker-a" }, content: "本次执行已取消；未发布最终回复。" }),
		ev(2, {
			kind: "artifact",
			actor: { kind: "agent", agentId: "worker-a" },
			content: "",
			artifactRefs: [{ name: "报告.md", path: "/rooms/report.md", kind: "markdown" }],
		}),
	];
	const built = buildRoomContext({
		events, through: "event-2",
		current: { eventId: "event-3", content: "继续", mentions: ["worker-a"], targetAgentName: "WorkerA" },
		agentNames,
	});
	assert.match(built.text, /\[房间终态｜WorkerA｜event=event-1\]/);
	assert.match(built.text, /\[房间产物｜WorkerA｜event=event-2\]\n产物：报告\.md（markdown）：\/rooms\/report\.md/);
});

test("RoomContext: 只注入水位之后的公共历史", () => {
	const events = [ev(1, { content: "旧消息" }), ev(2, { content: "新消息" })];
	const built = buildRoomContext({
		events,
		after: "event-1",
		through: "event-2",
		current: { eventId: "event-3", content: "当前", mentions: [] },
		agentNames,
	});
	assert.doesNotMatch(built.text, /旧消息/);
	assert.match(built.text, /新消息/);
	assert.equal(built.afterSeq, 1);
	assert.equal(built.historyCount, 1);
});

test("RoomContext: 当前事件已落盘时不会在历史里重复", () => {
	const events = [ev(1, { content: "前一条" }), ev(2, { id: "event-current", content: "当前这一条", mentions: ["worker-a"] })];
	const built = buildRoomContext({
		events,
		through: "event-current",
		current: { eventId: "event-current", content: "当前这一条", mentions: ["worker-a"], targetAgentName: "WorkerA" },
		agentNames,
	});
	assert.equal(built.historyCount, 1);
	assert.equal(built.text.match(/当前这一条/g)?.length, 1, "当前消息只应出现一次");
});

test("RoomContext: 水位/截止点不存在或倒置时明确失败", () => {
	const events = [ev(1)];
	assert.throws(() => buildRoomContext({
		events, through: "missing", current: { eventId: "event-x", content: "x", mentions: [] },
	}), RoomContextRangeError);
	assert.throws(() => buildRoomContext({
		events, after: "missing", through: "event-1", current: { eventId: "event-x", content: "x", mentions: [] },
	}), RoomContextRangeError);
	assert.throws(() => buildRoomContext({
		events: [ev(1), ev(2)], after: "event-2", through: "event-1",
		current: { eventId: "event-x", content: "x", mentions: [] },
	}), RoomContextRangeError);
});

test("RoomContext: 超出预算时抛类型化错误且不返回截断文本", () => {
	const events = [ev(1)];
	assert.throws(
		() => buildRoomContext({
			events, through: "event-1",
			current: { eventId: "event-2", content: "当前", mentions: [] },
			maxChars: 10,
		}),
		(error: unknown) => error instanceof RoomContextTooLargeError && error.chars > 10,
	);
});

test("RoomContext: 空历史仍保留范围标题，当前消息独立成段", () => {
	const built = buildRoomContext({
		events: [ev(1)],
		after: "event-1",
		through: "event-1",
		current: { eventId: "event-2", content: "第一条", mentions: ["worker-a"], targetAgentName: "WorkerA" },
	});
	assert.equal(built.historyCount, 0);
	assert.match(built.text, /^\[房间公共历史｜roomSessionId=room-1111-2222｜through=event-1\/1\]/);
	assert.match(built.text, /\[当前用户消息｜用户 → @WorkerA｜event=event-2\]/);
});

test("RoomContext: 写入前预算可使用尚未落盘的 prospective 当前事件", () => {
	const empty = buildRoomContext({
		events: [],
		current: { eventId: "event-1", content: "第一条", mentions: ["worker-a"], targetAgentName: "WorkerA" },
	});
	assert.equal(empty.historyCount, 0);
	assert.equal(empty.throughSeq, 0);
	assert.equal(empty.throughEventId, undefined);
	assert.match(empty.text, /through=initial\/0/);
	assert.match(empty.text, /\[当前用户消息｜用户 → @WorkerA｜event=event-1\]/);

	const withHistory = buildRoomContext({
		events: [ev(1, { content: "旧消息" }), ev(2, { content: "较新消息" })],
		after: "event-1",
		current: { eventId: "event-3", content: "当前", mentions: [] },
	});
	assert.equal(withHistory.historyCount, 1);
	assert.match(withHistory.text, /较新消息/);
	assert.doesNotMatch(withHistory.text, /旧消息/);
	assert.equal(withHistory.throughSeq, 2);
});

test("renderRoomHistory: 不追加当前用户消息", () => {
	const text = renderRoomHistory([ev(1), ev(2, { actor: { kind: "agent", agentId: "manager" } })], { agentNames });
	assert.match(text, /\[房间消息｜用户｜event=event-1\]/);
	assert.match(text, /\[房间消息｜Manager｜event=event-2\]/);
	assert.doesNotMatch(text, /当前用户消息/);
});
