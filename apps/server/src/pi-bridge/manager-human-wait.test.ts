import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import type { AgentDriver, AgentEvent } from "../agent-runtime/types.js";
import { PiSessionStore } from "./session-store.js";

test("真实 pi 循环：HITL 工具结果落盘后结束本轮，聊天继续不绕过卡片，回答恢复原 Run", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-human-wait-loop-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "pi");
	let sessions: PiSessionStore | undefined;
	try {
		const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "assets"), managedWorkspaces: path.join(dir, "managed") }, dir);
		await teams.init();
		for (const name of ["alpha", "beta"]) await teams.upsertAgent({ name, description: name, invoke: { type: "command", command: name, runArgs: [] }, enabled: true });
		const delegations = new DelegationStore(path.join(dir, "runtime"));
		await delegations.init();
		const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
		await secrets.init();
		let starts = 0;
		let resumes = 0;
		const driver: AgentDriver = {
			id: "alpha",
			async capabilities() { return { operations: ["run", "continue", "respond"], interactionKinds: ["permission"], progress: "none", transport: "spawn" }; },
			async *run(): AsyncIterable<AgentEvent> {
				starts++;
				yield { type: "started", sessionHandle: "original-session", runHandle: "original-run" };
				yield { type: "input_required", result: { agentId: "alpha", status: "needs_input", sessionHandle: "original-session", runHandle: "original-run", interaction: { id: "ask", kind: "permission", requests: [{ requestId: "permit", prompt: "允许继续？", options: ["once", "reject"] }] } } };
			},
			async *continue(input, ctx) { yield* this.run(input, ctx); },
			async *respond(input): AsyncIterable<AgentEvent> {
				assert.equal(input.runHandle, "original-run");
				resumes++;
				yield { type: "completed", result: { agentId: "alpha", status: "completed", content: "done", runHandle: "original-run", sessionHandle: "original-session" } };
			},
			async probe() { throw new Error("probe not needed"); },
		};
		const registry = new DriverRegistry();
		registry.register(driver);
		const runtime = new AgentRuntime(delegations, secrets, (id) => registry.get(id), { ttlMs: 60_000 });
		const invoker = new AgentInvoker(teams, runtime, registry, undefined, dir);
		sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
		const summary = await sessions.create(undefined, { type: "group", members: ["alpha", "beta"] });
		await teams.createWindow({ type: "group", members: ["alpha", "beta"], sessionId: summary.id });
		const session = await sessions.open(summary.id);
		let modelCalls = 0;
		session.agent.getApiKey = () => "test-only";
		session.agent.streamFunction = (model) => {
			modelCalls++;
			assert.ok(modelCalls <= 3, "HITL 后不应再发起模型续轮");
			const message = {
				role: "assistant" as const,
				content: modelCalls < 3
					? [{ type: "toolCall" as const, id: `call-${modelCalls}`, name: modelCalls === 1 ? "agent_alpha__delegate" : "agent_beta__delegate", arguments: { task: "检查交付文件" } }]
					: [{ type: "text" as const, text: "已完成" }],
				api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: modelCalls < 3 ? "toolUse" as const : "stop" as const,
				timestamp: Date.now(),
			};
			return {
				async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; },
				async result() { return message; },
			} as unknown as Awaited<ReturnType<typeof session.agent.streamFunction>>;
		};
		await session.agent.prompt("执行任务");
		assert.equal(modelCalls, 1);
		assert.equal(starts, 1);
		const [pending] = await invoker.delegationsForManagerSession(summary.id);
		assert.equal(pending?.executionState, "waiting_input");
		const [interaction] = await runtime.listInteractions();
		assert.equal(interaction?.status, "pending");
		assert.equal(session.isStreaming, false);
		const transcript = await readFile(session.sessionManager.getSessionFile()!, "utf8");
		assert.match(transcript, /"role":"toolResult"/);
		assert.match(transcript, /needs_input/);
		await session.agent.prompt("继续上一任务");
		assert.equal(modelCalls, 2);
		assert.equal((await invoker.delegationsForManagerSession(summary.id)).length, 1, "不能改派 beta");
		assert.equal((await runtime.getInteraction(interaction!.id))?.status, "pending");
		await runtime.respond(interaction!.id, { requestId: "user-approve", revision: interaction!.revision, responses: [{ requestId: "permit", action: "approve", scope: "once" }] }, { cwd: pending!.cwdSnapshot, env: {} }, driver);
		assert.equal(resumes, 1);
		assert.equal(starts, 1, "审批恢复原 Run，不重新启动任务");
		assert.equal((await invoker.delegationsForManagerSession(summary.id))[0]?.executionState, "reported_completed");
		await session.agent.prompt("汇总结果");
		assert.equal(modelCalls, 3);
	} finally {
		await sessions?.disposeAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
});
