import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "./session-store.js";

/**
 * 会话模型持久化：composer 的模型选择经 setModel 落 model_change，重开
 * 会话（重启/空闲重建）必须恢复该记录，而不是被 manager 默认模型覆盖
 * （SDK 只在未传显式 model 时才从 JSONL 恢复，见 assembleSession 的
 * preferRecordedModel）。
 *
 * SDK 的持久化门槛是「首条 assistant 消息」（此前的 model_change 只留在
 * 内存），所以测试手工构造一份带 model_change + assistant 消息的 JSONL，
 * 模拟一个真实聊过且切换过模型的会话。
 *
 * PI_OFFLINE=1：SDK 的 availability refresh 会对所有内置 provider 做真实网络
 * 探测，测试不需要。
 */
process.env.PI_OFFLINE = "1";

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

async function makeStack() {
	process.env.PI_CODING_AGENT_DIR = freshDir("pt-model-agentdir-");
	const dir = freshDir("pt-model-");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "rt"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "sec"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (agentId) => drivers.get(agentId), {
		ttlMs: 24 * 60 * 60 * 1000,
	});
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	return { teams, sessions, dir };
}

/** 构造一份聊过且从 opus 切到 haiku 的会话 JSONL。 */
function writeSessionFile(sessionDir: string, id: string, cwd: string): string {
	const now = new Date().toISOString();
	const entries = [
		{ type: "session", version: 3, id, timestamp: now, cwd },
		{ type: "model_change", id: "mc1", parentId: null, timestamp: now, provider: "anthropic", modelId: "claude-opus-4-5" },
		{ type: "model_change", id: "mc2", parentId: "mc1", timestamp: now, provider: "anthropic", modelId: "claude-haiku-4-5" },
		{
			type: "message",
			id: "m1",
			parentId: "mc2",
			timestamp: now,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			},
		},
	];
	const file = path.join(sessionDir, `${now.replace(/[:.]/g, "-")}_${id}.jsonl`);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
}

test("模型选择随会话持久化：重开后恢复 model_change，不被 manager 默认覆盖", async () => {
	const { teams, sessions, dir } = await makeStack();
	// SDK 恢复记录的模型要求该 provider 有凭证，否则走 findInitialModel 回退。
	await sessions.setProviderKey("anthropic", "sk-test-key");
	await teams.updateManager({ manager: { model: "anthropic/claude-sonnet-4-5" } });

	const sessionId = "01a013aa-0000-7000-8000-000000000001";
	writeSessionFile(path.join(dir, "sessions"), sessionId, dir);
	// solo 窗口认领该会话（open 要求 Window 归属）。
	await teams.ensureSoloWindow(async () => ({ id: sessionId }), async () => false);

	const reopened = await sessions.open(sessionId);
	assert.equal(reopened.model?.id, "claude-haiku-4-5", "重开会话必须恢复最后选择的模型，不是 manager 默认的 sonnet");

	// 磁盘列表也要能从 JSONL 扫出模型（重启后无存活会话时的显示真值）。
	await sessions.disposeAll();
	const list = await sessions.list();
	assert.equal(list.find((s) => s.id === sessionId)?.model, "anthropic/claude-haiku-4-5", "磁盘会话的 model 取自最后一条 model_change");

	await sessions.disposeAll();
});
