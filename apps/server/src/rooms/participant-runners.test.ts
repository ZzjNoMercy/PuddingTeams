import { test } from "node:test";
import assert from "node:assert";
import type { AgentInvokeParams, AgentInvokeResult } from "../agent-runtime/invoker.js";
import type { ParticipantBinding } from "./participant-binding-registry.js";
import type { ParticipantTurn } from "./participant-turn-store.js";
import { DirectChatParticipantRunner, PiParticipantRunner, finalAssistantFrom } from "./participant-runners.js";

const binding: ParticipantBinding = {
	agentSessionId: "agent-session-1",
	roomId: "room-id-1",
	roomSessionId: "room-1111-2222",
	agentId: "worker-a",
	role: "worker",
	state: "active",
	cwdSnapshot: "/workspace",
	revision: 1,
	createdAt: "2026-10-31T00:00:00.000Z",
	updatedAt: "2026-10-31T00:00:00.000Z",
};

const turn = {
	id: "turn-1",
	agentSessionId: binding.agentSessionId,
	roomSessionId: binding.roomSessionId,
	sourceRoomEventId: "event-1",
	contextThroughRoomEventId: "event-1",
	inputHash: "a".repeat(64),
	operationId: "op-message-1",
	bindingRevision: 1,
	inputs: [],
	delegationIds: [],
	status: "running" as const,
	publicProjectionState: "pending" as const,
	createdAt: "2026-10-31T00:00:00.000Z",
	updatedAt: "2026-10-31T00:00:00.000Z",
} satisfies ParticipantTurn;

const runnerInput = {
	roomSessionId: binding.roomSessionId,
	turn,
	binding,
	prompt: "请检查",
	context: { text: "请检查", chars: 3, historyCount: 0, throughSeq: 0 },
	markInputDurable: async () => undefined,
};

test("PiParticipantRunner: 取最后一条非空 assistant 文本，忽略工具间旁白", async () => {
	const messages: Array<{ role: string; content: unknown; stopReason?: string }> = [];
	const session = {
		messages,
		async prompt(text: string) {
			messages.push({ role: "user", content: text });
			messages.push({ role: "assistant", content: [{ type: "text", text: "先查一下" }], stopReason: "toolUse" });
			messages.push({ role: "assistant", content: [{ type: "text", text: "最终结论" }], stopReason: "stop" });
		},
	};
	const runner = new PiParticipantRunner({ sessions: { open: async () => session as never } });
	const result = await runner.run(runnerInput);
	assert.equal(result.status, "completed");
	assert.equal(result.finalContent, "最终结论");
	assert.deepEqual(result.execution, { kind: "native_pi" });
});

test("PiParticipantRunner: error/aborted/空文本不伪装 completed", async () => {
	const make = (stopReason: string, text: string) => ({
		messages: [] as Array<{ role: string; content: unknown; stopReason?: string }>,
		async prompt(value: string) {
			this.messages.push({ role: "user", content: value });
			this.messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason });
		},
	});
	for (const [stopReason, expected] of [["error", "failed"], ["aborted", "cancelled"]] as const) {
		const session = make(stopReason, "部分输出");
		const runner = new PiParticipantRunner({ sessions: { open: async () => session as never } });
		const result = await runner.run(runnerInput);
		assert.equal(result.status, expected);
	}
	const empty = make("stop", "   ");
	const runner = new PiParticipantRunner({ sessions: { open: async () => empty as never } });
	assert.equal((await runner.run(runnerInput)).status, "failed");
});

test("finalAssistantFrom: 只取本轮、最后一条 assistant", () => {
	const messages = [
		{ role: "assistant", content: "旧回合" },
		{ role: "user", content: "新回合" },
		{ role: "assistant", content: [{ type: "text", text: "中间" }], stopReason: "toolUse" },
		{ role: "assistant", content: [{ type: "text", text: "最后" }], stopReason: "stop" },
	];
	assert.deepEqual(finalAssistantFrom(messages, 2), { text: "最后", stopReason: "stop" });
	assert.deepEqual(finalAssistantFrom(messages, 4), {});
});

test("DirectChatParticipantRunner: 复用 direct_chat Delegation 并映射终态", async () => {
	const calls: AgentInvokeParams[] = [];
	const results: AgentInvokeResult[] = [
		{ status: "completed", content: "Worker 结论", details: {}, delegationId: "delegation-1", waitingInput: false },
		{ status: "needs_input", content: "需要审批", details: {}, delegationId: "delegation-1", interactionId: "interaction-1", waitingInput: true },
		{ status: "cancelled", content: "", details: {}, delegationId: "delegation-1", waitingInput: false },
		{ status: "observation_lost", content: "丢失", details: {}, delegationId: "delegation-1", waitingInput: false },
	];
	const invoker = {
		requireAgent: async (name: string) => ({ name, description: "", invoke: { type: "command", command: "x", runArgs: [] } }),
		delegate: async (params: AgentInvokeParams) => {
			calls.push(params);
			return results.shift()!;
		},
	};
	const runner = new DirectChatParticipantRunner({ invoker: invoker as never });
	const completed = await runner.run(runnerInput);
	assert.equal(completed.status, "completed");
	assert.equal(completed.finalContent, "Worker 结论");
	assert.deepEqual(completed.execution, { kind: "direct_chat", delegationId: "delegation-1" });
	const sent = calls[0]!;
	assert.equal(sent.invocationKind, "direct_chat");
	assert.equal(sent.managerSessionId, "agent-session-1");
	assert.equal(sent.windowId, "room-id-1");
	assert.equal(sent.operationId, "op-message-1");
	assert.equal(sent.message, "请检查");
	assert.equal((await runner.run(runnerInput)).status, "waiting_input");
	assert.equal((await runner.run(runnerInput)).status, "cancelled");
	assert.equal((await runner.run(runnerInput)).status, "unknown");
});

test("DirectChatParticipantRunner: provider handle 续接与持久", async () => {
	const calls: AgentInvokeParams[] = [];
	let persisted: string | undefined;
	const results: AgentInvokeResult[] = [
		{ status: "completed", content: "一", details: {}, delegationId: "d-1", sessionHandle: "handle-1", waitingInput: false },
		{ status: "completed", content: "二", details: {}, delegationId: "d-2", waitingInput: false },
	];
	const runner = new DirectChatParticipantRunner({
		invoker: {
			requireAgent: async (name: string) => ({ name, description: "", connector: { extensionId: "puddingclaw", connectorId: "puddingclaw", transport: "spawn", config: {} } }),
			delegate: async (params: AgentInvokeParams) => { calls.push(params); return results.shift()!; },
		} as never,
		handleFor: async () => persisted,
		rememberHandle: async (_binding, _agent, handle) => { persisted = handle; },
	});
	await runner.run(runnerInput);
	assert.equal(persisted, "handle-1");
	await runner.run(runnerInput);
	assert.equal(calls[1]!.sessionHandle, "handle-1");
});

test("Pi/Direct runner 在真实发送边界调用 markInputDurable", async () => {
	let piDurable = 0;
	const pi = new PiParticipantRunner({
		sessions: {
			open: async () => ({
				messages: [] as Array<{ role: string; content: string; stopReason?: string }>,
				prompt: async function (this: { messages: Array<{ role: string; content: string; stopReason?: string }> }, text: string) {
					this.messages.push({ role: "user", content: text });
					this.messages.push({ role: "assistant", content: "ok", stopReason: "stop" });
				},
			}),
		} as never,
	});
	const piInput = { ...runnerInput, markInputDurable: async () => { piDurable += 1; } };
	await pi.run(piInput);
	assert.equal(piDurable, 1);

	let directDurable = 0;
	const direct = new DirectChatParticipantRunner({
		invoker: {
			requireAgent: async (name: string) => ({ name }),
			delegate: async () => ({ status: "completed", content: "done", details: {}, delegationId: "d-1", waitingInput: false }),
		} as never,
	});
	const directInput = { ...runnerInput, markInputDurable: async () => { directDurable += 1; } };
	await direct.run(directInput);
	assert.equal(directDurable, 1);
});

test("PiParticipantRunner: SDK 拒绝 prompt 时不推进 durability", async () => {
	let durable = 0;
	const runner = new PiParticipantRunner({
		sessions: {
			open: async () => ({
				messages: [],
				prompt: async () => { throw new Error("no api key"); },
			}),
		} as never,
	});
	const result = await runner.run({ ...runnerInput, markInputDurable: async () => { durable += 1; } });
	assert.equal(result.status, "failed");
	assert.equal(durable, 0);
});

test("PiParticipantRunner: preflight 后必须等 user entry 落盘才 durable", async () => {
	let entryPushed = false;
	let durableSawEntry: boolean | undefined;
	const messages: Array<{ role: string; content: string; stopReason?: string }> = [];
	const runner = new PiParticipantRunner({
		sessions: {
			open: async () => ({
				messages,
				prompt: async (text: string, options?: { preflightResult?: (disposition: unknown) => void }) => {
					options?.preflightResult?.("started");
					await new Promise((resolve) => setTimeout(resolve, 20));
					entryPushed = true;
					messages.push({ role: "user", content: text });
					messages.push({ role: "assistant", content: "完成", stopReason: "stop" });
				},
			}),
		} as never,
	});
	await runner.run({
		...runnerInput,
		markInputDurable: async () => { durableSawEntry = entryPushed; },
	});
	assert.equal(durableSawEntry, true, "preflight 时 entry 尚未落盘，durable 必须后移");
});
