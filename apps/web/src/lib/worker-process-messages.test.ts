import assert from "node:assert/strict";
import test from "node:test";
import { reducePiEvent, renderHistory } from "./events";
import { reconcileWorkerProcessMessages } from "./worker-process-messages";
import type { PiMessage } from "./types";

const user = { role: "user", content: "fixture task", timestamp: 100 } as PiMessage;
const turn = { role: "assistant", content: [], timestamp: 101 } as unknown as PiMessage;

test("ready HTTP 只有 user 时，保留 WS 已显示的 Worker 头像及流式轮次", () => {
	const history = renderHistory([user]);
	const visible = reducePiEvent(history, { type: "message_start", message: turn });
	const refreshed = reconcileWorkerProcessMessages(visible, history, []);
	assert.equal(refreshed.length, 2);
	assert.equal(refreshed[1]?.role, "assistant");
	assert.equal(refreshed[1]?.streaming, true);
});

test("重连快照缺少正在生成的消息时，保留正文并接续增量，不重复回复", () => {
	const history = renderHistory([user]);
	const update = { ...turn, content: [{ type: "text", text: "已显示正文" }] };
	const visible = reducePiEvent(history, { type: "message_update", message: update });
	const next = reconcileWorkerProcessMessages(visible, history, [{ type: "message_update", message: { ...turn, content: [{ type: "text", text: "已显示正文，继续生成" }] } }]);
	assert.equal(next.length, 2);
	assert.equal(next[1]?.content, "已显示正文，继续生成");
	assert.equal(next[1]?.streaming, true);
});

test("终态快照替换同轮流式内容，迟到的前缀不能覆盖最终回复", () => {
	const visible = reducePiEvent(renderHistory([user]), { type: "message_start", message: turn });
	const final = { ...turn, content: [{ type: "text", text: "最终回复" }], stopReason: "stop" } as unknown as PiMessage;
	const next = reconcileWorkerProcessMessages(visible, renderHistory([user, final]), [{ type: "message_start", message: turn }]);
	assert.equal(next.length, 2);
	assert.equal(next[1]?.content, "最终回复");
	assert.equal(next[1]?.streaming, false);
});

test("离线时 HTTP 尚未包含尾部，重放 message_end 后仍显示完整结果", () => {
	const visible = reducePiEvent(renderHistory([user]), { type: "message_start", message: turn });
	const final = { ...turn, content: [{ type: "text", text: "最终回复" }], stopReason: "stop" };
	const next = reconcileWorkerProcessMessages(visible, renderHistory([user]), [{ type: "message_end", message: final }]);
	assert.equal(next[1]?.content, "最终回复");
	assert.equal(next[1]?.streaming, false);
});

test("已结束的旧历史不因刷新被重新追加", () => {
	const old = { ...turn, content: [{ type: "text", text: "旧历史" }], stopReason: "stop" } as unknown as PiMessage;
	const next = reconcileWorkerProcessMessages(renderHistory([user, old]), renderHistory([user]), []);
	assert.equal(next.length, 1);
});
