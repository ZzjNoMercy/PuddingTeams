import assert from "node:assert/strict";
import test from "node:test";
import { reducePiEvent, renderHistory } from "./events";
import type { PiMessage } from "./types";

test("历史回放保留 running 投影里的 Delegation 与执行过程入口", () => {
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "agent_pi-b__delegate", arguments: { task: "检查前端" } }],
			timestamp: 1,
		},
		{
			role: "custom",
			customType: "pudding:task_assign",
			content: "检查前端",
			display: false,
			details: { taskId: "call-1", delegationId: "D1", goalId: "G1", workItemId: "W2", processView: true, status: "running" },
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "agent_pi-b__delegate",
			content: [{ type: "text", text: "上游限流" }],
			isError: true,
			timestamp: 3,
		},
	] as unknown as PiMessage[];
	const rendered = renderHistory(messages);
	const call = rendered.find((message) => message.role === "assistant")?.toolCalls[0];
	assert.equal(call?.status, "error");
	assert.deepEqual(call?.details, {
		taskId: "call-1", delegationId: "D1", goalId: "G1", workItemId: "W2", processView: true, status: "failed",
	});
});

test("实时 tool 终态不会抹掉先到的执行过程元数据", () => {
	let rendered = renderHistory([{
		role: "assistant",
		content: [{ type: "toolCall", id: "call-live", name: "agent_pi-b__delegate", arguments: { task: "检查前端" } }],
		timestamp: 1,
	}] as unknown as PiMessage[]);
	rendered = reducePiEvent(rendered, { type: "tool_execution_start", toolCallId: "call-live", toolName: "agent_pi-b__delegate", args: { task: "检查前端" } });
	rendered = reducePiEvent(rendered, {
		type: "tool_execution_update", toolCallId: "call-live", toolName: "agent_pi-b__delegate",
		partialResult: { content: [{ type: "text", text: "运行中" }], details: { delegationId: "D-live", processView: true, status: "running" } },
	});
	rendered = reducePiEvent(rendered, { type: "tool_execution_end", toolCallId: "call-live", toolName: "agent_pi-b__delegate", isError: true, result: "429" });
	const call = rendered[0]?.toolCalls[0];
	assert.equal(call?.status, "error");
	assert.deepEqual(call?.details, { delegationId: "D-live", processView: true, status: "failed" });
});

test("结果先到、富化指派后到时仍补齐执行过程入口", () => {
	let rendered = renderHistory([{
		role: "assistant",
		content: [{ type: "toolCall", id: "call-race", name: "agent_pi-b__delegate", arguments: { task: "检查前端" } }],
		timestamp: 1,
	}] as unknown as PiMessage[]);
	rendered = reducePiEvent(rendered, {
		type: "message_start",
		message: { role: "custom", customType: "pudding:task_result", content: "检查完成", details: { taskId: "call-race", status: "completed" }, timestamp: 2 },
	});
	rendered = reducePiEvent(rendered, {
		type: "message_start",
		message: { role: "custom", customType: "pudding:task_assign", content: "检查前端", display: false, details: { taskId: "call-race", delegationId: "D-race", processView: true, status: "running" }, timestamp: 3 },
	});
	const result = rendered.find((message) => message.customType === "pudding:task_result");
	assert.deepEqual(result?.details, { taskId: "call-race", delegationId: "D-race", processView: true, status: "completed" });
	const call = rendered.find((message) => message.role === "assistant")?.toolCalls[0];
	assert.deepEqual(call?.details, { taskId: "call-race", delegationId: "D-race", processView: true, status: "completed" });
});

test("历史重对齐后的实时 thinking 保留 assistant turn 起点", () => {
	let rendered = renderHistory([{
		role: "assistant",
		content: [{ type: "thinking", thinking: "开始分析" }],
		timestamp: 1_000,
	}] as unknown as PiMessage[]);
	assert.equal(rendered[0]?.streaming, false);

	rendered = reducePiEvent(rendered, {
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "继续分析" }],
			timestamp: 1_000,
		},
	});

	assert.equal(rendered[0]?.streaming, true);
	assert.equal(rendered[0]?.timestamp, 1_000, "计时必须继续使用原 turn 起点，不能改成重挂载时间");
});
