import assert from "node:assert/strict";
import test from "node:test";
import { applyRecoveredToolResults, friendlyModelError, groupConsecutiveModelErrors, markRunningToolCalls, reducePiEvent, renderHistory, replayPiEvents } from "./events";
import type { PiMessage } from "./types";

test("知识上下文变化指向会话菜单的新建入口，不误报模型故障或建议切模型重试", () => {
	const error = friendlyModelError("知识库上下文已变化，请新建工作会话后继续");
	assert.equal(error.presentation.title, "知识库上下文已更新");
	assert.match(error.presentation.action, /顶部会话菜单/);
	assert.match(error.presentation.action, /新建会话/);
	assert.doesNotMatch(error.content, /模型服务没有成功|切换模型|再次发送上一条/);
});

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

test("隐藏的 interaction_required 审计投影仍渲染审批卡，历史与实时一致", () => {
	const interaction = {
		role: "custom",
		customType: "pudding:interaction_required",
		content: "等待准入",
		display: false,
		details: { interactionId: "I1", delegationId: "D1", worker: "codex", status: "pending" },
		timestamp: 2,
	} as unknown as PiMessage;
	const history = renderHistory([interaction]);
	assert.equal(history.length, 1);
	assert.equal(history[0]?.customType, "pudding:interaction_required");
	assert.equal((history[0]?.details as { interactionId?: string })?.interactionId, "I1");

	const live = reducePiEvent([], { type: "message_start", message: interaction });
	assert.equal(live.length, 1);
	assert.equal(live[0]?.customType, "pudding:interaction_required");
});

test("模型接纳后 401 失败在历史与实时消息中保持可见错误", () => {
	const failed = {
		role: "assistant", content: [], stopReason: "error",
		errorMessage: '401: {"message":"fixture upstream rejected credential","type":"authentication_error"}',
		timestamp: 3,
	} as unknown as PiMessage;
	const history = renderHistory([failed]);
	const live = reducePiEvent(reducePiEvent([], { type: "message_start", message: failed }), { type: "message_end", message: failed });
	for (const item of [history[0], live[0]]) {
		assert.equal(item?.role, "assistant");
		assert.equal(item?.error, true);
		assert.ok(item?.modelError?.title);
		assert.match(item?.errorDetail ?? "", /fixture upstream rejected credential/);
		assert.equal(item?.streaming, false);
	}
});

test("错过本轮 message_start 时结束事件不覆盖上一轮回复", () => {
	const old = { role: "assistant", content: [{ type: "text", text: "上一轮正常回复" }], stopReason: "stop", timestamp: 1 } as unknown as PiMessage;
	const user = { role: "user", content: "新一轮请求", timestamp: 2 } as unknown as PiMessage;
	const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "401: credential rejected", timestamp: 3 } as unknown as PiMessage;
	const snapshot = renderHistory([old, user]);
	const settled = reducePiEvent(snapshot, { type: "message_end", message: failed });
	assert.equal(settled.length, 3);
	assert.equal(settled[0]?.content, "上一轮正常回复");
	assert.equal(settled[2]?.error, true);
	assert.equal(settled[2]?.streaming, false);
	const update = { role: "assistant", content: [{ type: "text", text: "正在处理" }], timestamp: 3 } as unknown as PiMessage;
	const resumed = reducePiEvent(snapshot, { type: "message_update", message: update });
	assert.equal(resumed.length, 3);
	assert.equal(resumed[0]?.content, "上一轮正常回复");
	assert.equal(resumed[2]?.content, "正在处理");
	assert.equal(reducePiEvent(resumed, { type: "message_end", message: failed })[2]?.error, true);
	const replayed = reducePiEvent(renderHistory([old, user, failed]), { type: "message_end", message: failed });
	assert.equal(replayed.length, 3, "历史已包含同一条失败时不重复追加");
	const withStart = replayPiEvents(renderHistory([old, user, failed]), [
		{ type: "message_start", message: failed }, { type: "message_end", message: failed },
	]);
	assert.equal(withStart.length, 3, "快照已含完整回复时缓冲区里的 start/end 不重复追加");
	const later = { role: "assistant", content: [{ type: "text", text: "更新一轮回复" }], stopReason: "stop", timestamp: 4 } as unknown as PiMessage;
	const olderEvent = { role: "assistant", content: [{ type: "text", text: "过期事件内容" }], timestamp: 1 } as unknown as PiMessage;
	const newerSnapshot = renderHistory([old, user, failed, later]);
	const afterStale = reducePiEvent(newerSnapshot, { type: "message_end", message: olderEvent });
	assert.equal(afterStale.length, 4);
	assert.equal(afterStale[0]?.content, "上一轮正常回复", "较早结束事件不能改写快照里的终态");
	assert.equal(afterStale[3]?.content, "更新一轮回复");
	const sameMillisecond = { role: "assistant", content: [{ type: "text", text: "同毫秒新回合" }], timestamp: 1 } as unknown as PiMessage;
	const started = reducePiEvent(renderHistory([old, user]), { type: "message_start", message: sameMillisecond });
	assert.equal(started.length, 3, "有新 user 分隔时同毫秒 start 不能被误去重");
	assert.equal(started[2]?.content, "同毫秒新回合");
});

test("历史与实时按消息 ID 对账，保留同毫秒同正文的不同 user", () => {
	const first = { role: "user", content: "重复请求", timestamp: 100, puddingMessageId: "user-1" } as unknown as PiMessage;
	const second = { role: "user", content: "重复请求", timestamp: 100, puddingMessageId: "user-2" } as unknown as PiMessage;
	const snapshot = renderHistory([first]);
	assert.equal(reducePiEvent(snapshot, { type: "message_start", message: first }).length, 1);
	const separate = reducePiEvent(snapshot, { type: "message_start", message: second });
	assert.equal(separate.length, 2);
	assert.deepEqual(separate.map((item) => item.puddingMessageId), ["user-1", "user-2"]);
	const reply = { role: "assistant", content: [{ type: "text", text: "第二轮回复" }], timestamp: 100, puddingMessageId: "assistant-2" } as unknown as PiMessage;
	const withReply = reducePiEvent(separate, { type: "message_start", message: reply });
	assert.equal(withReply.length, 3);
	assert.equal(reducePiEvent(withReply, { type: "message_end", message: { ...reply, stopReason: "stop" } }).at(-1)?.content, "第二轮回复");
});

test("延迟 toolResult 按 toolCallId 回填原 assistant，不误绑到最新一轮", () => {
	const rendered = renderHistory([
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-old", name: "bash", arguments: { command: "false" } }],
			timestamp: 1,
		},
		{ role: "assistant", content: [{ type: "text", text: "后续一轮" }], timestamp: 2 },
		{
			role: "toolResult", toolCallId: "call-old", toolName: "bash",
			content: [{ type: "text", text: "exit 1" }], details: { exitCode: 1 }, isError: true, timestamp: 3,
		},
	] as unknown as PiMessage[]);
	assert.equal(rendered[0]?.toolCalls[0]?.status, "error");
	assert.equal(rendered[0]?.toolCalls[0]?.result, "exit 1");
	assert.equal(rendered[1]?.toolCalls.length, 0);
});

test("刷新 overlay 分别恢复并行工具的 terminal 与 running 状态", () => {
	let rendered = renderHistory([{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call-failed", name: "bash", arguments: { command: "false" } },
			{ type: "toolCall", id: "call-running", name: "bash", arguments: { command: "long-running" } },
		],
		timestamp: 1,
	}] as unknown as PiMessage[]);
	rendered = applyRecoveredToolResults(rendered, [{
		toolCallId: "call-failed", toolName: "bash", text: "exit 1",
		details: { exitCode: 1, errorCode: "command_failed" }, isError: true,
	}]);
	rendered = markRunningToolCalls(rendered, ["call-running"]);
	assert.equal(rendered[0]?.toolCalls[0]?.status, "error");
	assert.equal(rendered[0]?.toolCalls[0]?.result, "exit 1");
	assert.equal((rendered[0]?.toolCalls[0]?.details as { errorCode?: string })?.errorCode, "command_failed");
	assert.equal(rendered[0]?.toolCalls[1]?.status, "running");
});

test("延迟 HTTP 历史响应重放请求期间的 WS 失败事件，不覆盖较新错误", () => {
	const staleSnapshot = renderHistory([{
		role: "assistant",
		content: [{ type: "toolCall", id: "call-race", name: "bash", arguments: { command: "false" } }],
		timestamp: 1,
	}] as unknown as PiMessage[]);
	const merged = replayPiEvents(staleSnapshot, [{
		type: "tool_execution_end",
		toolCallId: "call-race",
		toolName: "bash",
		result: { content: [{ type: "text", text: "fatal from WS" }], details: { exitCode: 128 } },
		isError: true,
	}]);
	assert.equal(merged[0]?.toolCalls[0]?.status, "error");
	assert.equal(merged[0]?.toolCalls[0]?.result, "fatal from WS");
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

test("同一 assistant turn 的流快照换对象和 wire ID 时不重复渲染 thinking", () => {
	const assistant = (id: string, thinking: string) => ({
		role: "assistant" as const,
		puddingMessageId: id,
		content: [{ type: "thinking" as const, thinking }],
		timestamp: 1_000,
	});
	let rendered = reducePiEvent([], { type: "message_start", message: assistant("start", "开始") });
	rendered = reducePiEvent(rendered, { type: "message_update", message: assistant("update-1", "开始分析") });
	rendered = reducePiEvent(rendered, { type: "message_update", message: assistant("update-2", "开始分析并核对") });
	rendered = reducePiEvent(rendered, { type: "message_end", message: assistant("end", "分析完毕") });
	assert.equal(rendered.length, 1);
	assert.equal(rendered[0]?.thinking, "分析完毕");
	assert.equal(rendered[0]?.streaming, false);
});

test("迟到的旧流快照不能撤回已显示的 assistant 正文或 thinking", () => {
	const assistant = (id: string, text: string, thinking: string) => ({
		role: "assistant" as const,
		puddingMessageId: id,
		content: [{ type: "thinking" as const, thinking }, { type: "text" as const, text }],
		timestamp: 1_000,
	});
	let rendered = reducePiEvent([], { type: "message_start", message: assistant("start", "", "思考") });
	rendered = reducePiEvent(rendered, { type: "message_update", message: assistant("latest", "完整回复", "思考完成") });
	rendered = reducePiEvent(rendered, { type: "message_update", message: assistant("late-old", "完整", "思考") });
	assert.equal(rendered.length, 1);
	assert.equal(rendered[0]?.content, "完整回复");
	assert.equal(rendered[0]?.thinking, "思考完成");
});

test("pi SDK 连续自动重试错误合并为一个渲染组", () => {
	const attempts = Array.from({ length: 4 }, (_, index) => ({
		id: `error-${index}`,
		role: "assistant" as const,
		content: "暂时无法连接模型服务",
		toolCalls: [],
		timestamp: index,
		streaming: false,
		error: true,
		modelError: {
			title: "暂时无法连接模型服务",
			explanation: "请求在传输过程中超时或连接中断。",
			action: "请检查网络后重试。",
		},
		errorDetail: `attempt ${index + 1}`,
	}));
	const recovered = {
		id: "success",
		role: "assistant" as const,
		content: "连接恢复",
		toolCalls: [],
		timestamp: 5,
		streaming: false,
	};

	const groups = groupConsecutiveModelErrors([...attempts, recovered]);
	assert.equal(groups.length, 2);
	assert.equal(groups[0]?.length, 4);
	assert.equal(groups[1]?.[0]?.id, "success");
});
