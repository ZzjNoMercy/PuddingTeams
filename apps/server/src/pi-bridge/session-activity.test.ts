import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { sessionActivity } from "./session-activity.js";

const event = (value: unknown) => value as AgentSessionEvent;

test("轮次：配对 turn_start 得到耗时，带上工具次数、stopReason 与模型", () => {
	const started = sessionActivity(event({ type: "turn_start" }), { sessionId: "s1", now: 1_000, state: {} });
	assert.equal(started.activity, undefined, "turn_start 只记录起点，不产生日志");
	assert.equal(started.state.turnStartedAt, 1_000);

	const ended = sessionActivity(event({ type: "turn_end", message: { stopReason: "toolUse", provider: "anthropic", model: "claude" }, toolResults: [{}, {}] }), {
		sessionId: "s1", now: 3_500, state: started.state,
	});
	assert.deepEqual(ended.activity, { sessionId: "s1", kind: "turn", phase: "end", durationMs: 2_500, toolCallCount: 2, stopReason: "toolUse", model: "anthropic/claude" });
	assert.equal(ended.state.turnStartedAt, undefined, "结束后清空起点，避免下一次轮次算出叠加耗时");
});

test("工具：直接用 SDK 的 durationMs，缺失时不编造", () => {
	const withDuration = sessionActivity(event({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false, durationMs: 42 }), { sessionId: "s1", now: 0, state: {} });
	assert.deepEqual(withDuration.activity, { sessionId: "s1", kind: "tool", phase: "end", toolName: "bash", isError: false, durationMs: 42 });
	const withoutDuration = sessionActivity(event({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: {}, isError: true }), { sessionId: "s1", now: 0, state: {} });
	assert.deepEqual(withoutDuration.activity, { sessionId: "s1", kind: "tool", phase: "end", toolName: "read", isError: true });
	assert.equal("durationMs" in (withoutDuration.activity ?? {}), false);
});

test("重试：开始与结束都记录，错误文本有上限", () => {
	const long = "x".repeat(500);
	const start = sessionActivity(event({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 1_500, errorMessage: long }), { sessionId: "s1", now: 0, state: {} });
	assert.equal(start.activity?.kind, "retry");
	assert.equal(start.activity?.attempt, 2);
	assert.equal(start.activity?.maxAttempts, 5);
	assert.equal(start.activity?.delayMs, 1_500);
	assert.equal(start.activity?.error?.length, 300, "错误文本要截断，避免日志被 HTML/堆栈淹没");

	const end = sessionActivity(event({ type: "auto_retry_end", success: false, attempt: 5, finalError: "上游 429" }), { sessionId: "s1", now: 0, state: {} });
	assert.deepEqual(end.activity, { sessionId: "s1", kind: "retry", phase: "end", attempt: 5, success: false, error: "上游 429" });

	const summarization = sessionActivity(event({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "context" }), { sessionId: "s1", now: 0, state: {} });
	assert.equal(summarization.activity?.reason, "summarization");
});

test("压缩：配对 start/end 得到耗时，aborted/willRetry 如实记录", () => {
	const started = sessionActivity(event({ type: "compaction_start", reason: "threshold" }), { sessionId: "s1", now: 10, state: {} });
	assert.equal(started.activity?.reason, "threshold");
	assert.equal(started.state.compactionStartedAt, 10);
	const ended = sessionActivity(event({ type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: true, errorMessage: "aborted by user" }), {
		sessionId: "s1", now: 4_010, state: started.state,
	});
	assert.deepEqual(ended.activity, { sessionId: "s1", kind: "compaction", phase: "end", reason: "threshold", success: false, willRetry: true, durationMs: 4_000, error: "aborted by user" });
});

test("无关事件不产生日志，也不改状态", () => {
	const state = { turnStartedAt: 5 };
	const result = sessionActivity(event({ type: "message_update", message: {}, assistantMessageEvent: {} }), { sessionId: "s1", now: 9, state });
	assert.equal(result.activity, undefined);
	assert.equal(result.state, state, "未变化时返回同一个状态对象，调用方据此避免无谓写入");
});
