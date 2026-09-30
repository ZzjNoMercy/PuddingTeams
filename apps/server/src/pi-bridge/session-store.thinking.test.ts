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
 * 会话级 thinking level（§10.6 thinking binding）：与模型同构的两层。
 * manager.thinkingLevel 只是新建/重开会话的默认；用户在 composer 选定的
 * 档位由 setThinkingLevel 写进 JSONL，重开时以落盘为准（preferRecordedThinkingLevel），
 * 且后续 manager 配置变更不得广播覆盖（revokeChangedTools 跳过 thinkingOverrides）。
 */
process.env.PI_OFFLINE = "1";

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

async function makeStack() {
	process.env.PI_CODING_AGENT_DIR = freshDir("pt-think-agentdir-");
	const dir = freshDir("pt-think-");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "rt"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "sec"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (agentId) => drivers.get(agentId), { ttlMs: 24 * 60 * 60 * 1000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	return { teams, sessions, dir };
}

/** 构造一份聊过且留有 thinking_level_change 记录的会话 JSONL。 */
function writeSessionFile(sessionDir: string, id: string, cwd: string, level: string): string {
	const now = new Date().toISOString();
	const entries = [
		{ type: "session", version: 3, id, timestamp: now, cwd },
		{ type: "thinking_level_change", id: "tl1", parentId: null, timestamp: now, thinkingLevel: level },
		{
			id: "m1",
			parentId: "tl1",
			timestamp: now,
			type: "message",
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

test("会话级 thinking level：重开以落盘档位为准，不被 manager 默认覆盖", async () => {
	const { teams, sessions, dir } = await makeStack();
	await sessions.setProviderKey("anthropic", "sk-test-key");
	await teams.updateManager({ manager: { thinkingLevel: "high" } });

	const sessionId = "01a013aa-0000-7000-8000-00000000000f";
	writeSessionFile(path.join(dir, "sessions"), sessionId, dir, "low");
	await teams.ensureSoloWindow(async () => ({ id: sessionId }), async () => false);

	const reopened = await sessions.open(sessionId);
	assert.equal(reopened.thinkingLevel, "low", "重开会话必须恢复最后选择的档位，不是 manager 默认的 high");

	// 磁盘列表也要能从 JSONL 扫出档位（重启后无存活会话时的显示真值）。
	await sessions.disposeAll();
	const list = await sessions.list();
	assert.equal(list.find((s) => s.id === sessionId)?.thinkingLevel, "low", "磁盘会话的 thinkingLevel 取自最后一条 thinking_level_change");
	await sessions.disposeAll();
});

test("会话级选择不被 manager 配置变更广播覆盖", async () => {
	const { teams, sessions, dir } = await makeStack();
	await sessions.setProviderKey("anthropic", "sk-test-key");
	await teams.updateManager({ manager: { thinkingLevel: "medium" } });

	const sessionId = "01a013aa-0000-7000-8000-000000000010";
	writeSessionFile(path.join(dir, "sessions"), sessionId, dir, "medium");
	await teams.ensureSoloWindow(async () => ({ id: sessionId }), async () => false);
	const session = await sessions.open(sessionId);
	assert.equal(session.thinkingLevel, "medium", "前置条件：落盘档位与默认一致，不算用户选择");

	// 用户在 composer 选了另一档。
	const confirmed = await sessions.setThinkingLevel(sessionId, "max");
	assert.equal(typeof confirmed, "string");
	assert.equal(session.thinkingLevel, confirmed, "setThinkingLevel 立即作用于运行中会话");

	// 改 manager 默认并同步：会话级选择必须保留。
	await teams.updateManager({ manager: { thinkingLevel: "low" } });
	await sessions.syncAgentConfigChange();
	assert.equal(session.thinkingLevel, confirmed, "manager 默认变更不得覆盖会话级选择");
	await sessions.disposeAll();
});

test("非法 thinking level 被拒绝，清除 manager 配置对无会话选择的会话回退默认", async () => {
	const { teams, sessions, dir } = await makeStack();
	await sessions.setProviderKey("anthropic", "sk-test-key");
	await teams.updateManager({ manager: { thinkingLevel: "high" } });

	const sessionId = "01a013aa-0000-7000-8000-000000000011";
	writeSessionFile(path.join(dir, "sessions"), sessionId, dir, "high");
	await teams.ensureSoloWindow(async () => ({ id: sessionId }), async () => false);
	const session = await sessions.open(sessionId);
	assert.equal(session.thinkingLevel, "high");

	// 非法档位不进会话。
	await assert.rejects(() => sessions.setThinkingLevel(sessionId, "ultra"), /thinkingLevel 必须是/);
	assert.equal(session.thinkingLevel, "high", "非法档位不改变会话状态");

	// 清除 manager 默认：无会话级选择的会话应回退 SDK 默认链，而不是保持旧值。
	await teams.updateManager({ manager: { thinkingLevel: null } });
	await sessions.syncAgentConfigChange();
	assert.notEqual(session.thinkingLevel, "high", "清除默认后不得保留被清除前的档位（判空不能吃掉 null 分支）");
	await sessions.disposeAll();
});
