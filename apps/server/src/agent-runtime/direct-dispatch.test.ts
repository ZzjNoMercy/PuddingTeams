import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentInvokeParams, AgentInvokeResult } from "./invoker.js";
import type { AgentConfig, WindowConfig } from "../store/teams.js";
import { directWorkerFor, dispatchDirectMessage, type DirectDispatchDeps } from "./direct-dispatch.js";

const worker: AgentConfig = { name: "puddingclaw", description: "数据分析 worker", enabled: true };
const manager: AgentConfig = { name: "pi", description: "内置 manager", invoke: { type: "pi" }, pinned: true, enabled: true };

function directWindow(overrides: Partial<WindowConfig> = {}): WindowConfig {
	return {
		id: "w-direct",
		type: "direct",
		members: [worker.name],
		sessions: ["s-direct"],
		activeSession: "s-direct",
		cwdSnapshot: "/tmp",
		createdAt: new Date(0).toISOString(),
		...overrides,
	};
}

interface SentMessage {
	sessionId: string;
	customType: string;
	content: string;
	details?: Record<string, unknown>;
}

function makeDeps(overrides: {
	window?: WindowConfig;
	agents?: Map<string, AgentConfig>;
	delegate?: (params: AgentInvokeParams) => Promise<AgentInvokeResult>;
}) {
	const sent: SentMessage[] = [];
	const errors: string[] = [];
	const delegateCalls: AgentInvokeParams[] = [];
	const window = overrides.window ?? directWindow();
	const agents = overrides.agents ?? new Map([[worker.name, worker]]);
	const deps: DirectDispatchDeps = {
		teams: {
			windowForSession: async () => window,
			getAgent: async (name) => agents.get(name),
		},
		sessions: {
			sendCustomMessage: async (sessionId, message) => {
				sent.push({ sessionId, customType: message.customType, content: message.content, details: message.details });
			},
			ensureSessionFile: async () => {},
		},
		invoker: {
			requireAgent: async (name) => {
				const agent = agents.get(name);
				if (!agent || agent.enabled === false) throw new Error(`agent「${name}」已被禁用，委托被拒绝`);
				return agent;
			},
			delegate: async (params) => {
				delegateCalls.push(params);
				return (overrides.delegate ?? (async () => ({
					status: "completed",
					content: "worker 结果",
					details: {},
					delegationId: "d-1",
					waitingInput: false,
				})))(params);
			},
		},
		onError: (_sessionId, message) => errors.push(message),
	};
	/** 等后台 delegate 链跑完（void 派生的 microtask 链）。 */
	const settle = async () => {
		for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	return { deps, sent, errors, delegateCalls, settle };
}

test("非 direct 窗口不拦截，返回 false 交回调用方走 manager 回合", async () => {
	const { deps, sent } = makeDeps({ window: directWindow({ type: "group", members: [worker.name, "codex"] }) });
	const handled = await dispatchDirectMessage(deps, "s-direct", "你好");
	assert.equal(handled, false);
	assert.equal(sent.length, 0);
});

test("direct 窗口命中：先写用户消息与 running 指派卡，后台 delegate 完成后写结果卡", async () => {
	const { deps, sent, delegateCalls, settle } = makeDeps({});
	const handled = await dispatchDirectMessage(deps, "s-direct", "查一下千线激光雷达车型");
	assert.equal(handled, true);

	// 同步段：用户消息 + running 指派卡（都在返回前落进消息流）。
	assert.deepEqual(sent.map((m) => m.customType), ["pudding:user_message", "pudding:task_assign"]);
	assert.equal(sent[0]!.content, "查一下千线激光雷达车型");
	assert.equal(sent[1]!.details?.status, "running");
	assert.equal(sent[1]!.details?.from, "direct");

	await settle();
	assert.equal(delegateCalls.length, 1);
	const call = delegateCalls[0]!;
	// managerSessionId 就是 direct 窗口自己的 session：审批卡与结果对账都落回本窗口。
	assert.equal(call.windowId, "w-direct");
	assert.equal(call.managerSessionId, "s-direct");
	assert.equal(call.mode, "continue");
	assert.equal(call.message, "查一下千线激光雷达车型");

	assert.equal(sent.length, 3);
	assert.equal(sent[2]!.customType, "pudding:task_result");
	assert.equal(sent[2]!.content, "worker 结果");
	assert.equal(sent[2]!.details?.status, "completed");
	assert.equal(sent[2]!.details?.taskId, sent[1]!.details?.taskId);
});

test("needs_input 不补结果卡（审批卡由 invoker 自己写进本窗口）", async () => {
	const { deps, sent, settle } = makeDeps({
		delegate: async () => ({
			status: "needs_input",
			content: "需要人工审批",
			details: {},
			delegationId: "d-2",
			interactionId: "i-2",
			waitingInput: true,
		}),
	});
	await dispatchDirectMessage(deps, "s-direct", "跑个分析");
	await settle();
	assert.deepEqual(sent.map((m) => m.customType), ["pudding:user_message", "pudding:task_assign"]);
});

test("worker 被禁用：delegate 抛错写失败卡并经 onError 透出", async () => {
	const { deps, sent, errors, settle } = makeDeps({
		agents: new Map([[worker.name, { ...worker, enabled: false }]]),
	});
	const handled = await dispatchDirectMessage(deps, "s-direct", "你好");
	assert.equal(handled, true);
	await settle();
	assert.equal(errors.length, 1);
	const last = sent.at(-1);
	assert.equal(last?.customType, "pudding:task_result");
	assert.equal(last?.details?.status, "failed");
	assert.match(last?.content ?? "", /已被禁用/);
});

test("directWorkerFor：内置 manager 成员不作为可直派 worker", async () => {
	const window = directWindow({ members: [manager.name] });
	const agents = new Map([[manager.name, manager]]);
	const target = await directWorkerFor(
		{ windowForSession: async () => window, getAgent: async (name) => agents.get(name) },
		"s-direct",
	);
	assert.equal(target, undefined);
});

test("附件场景：气泡用展示文本（正文+附件名），委托消息保留完整冻结路径块", async () => {
	const { deps, sent, delegateCalls, settle } = makeDeps({});
	const promptText = "这个pdf讲了什么\n\n用户附件（平台冻结路径，可按需读取并在委托任务中原样传递）：\n- PRD.pdf (application/pdf, 100 bytes): /home/uploads/x/PRD.pdf";
	const displayText = "这个pdf讲了什么\n\n附件：PRD.pdf";
	await dispatchDirectMessage(deps, "s-direct", promptText, displayText);
	await settle();
	assert.equal(sent[0]!.content, displayText, "用户气泡不含路径块");
	assert.equal(sent[1]!.content, displayText, "running 卡同样用展示文本");
	assert.equal(delegateCalls[0]!.message, promptText, "worker 委托保留完整路径块");
});
