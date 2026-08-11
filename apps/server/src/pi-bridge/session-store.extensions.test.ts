import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore, type AgentConfig } from "../store/teams.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { delegateToolName } from "../agent-runtime/extensions.js";
import type { AgentDriver, AgentEvent, DriverCapabilities } from "../agent-runtime/types.js";
import { PiSessionStore } from "./session-store.js";
import { CORE_TOOL_SEARCH } from "./agent-extensions.js";

/**
 * Phase 4 集成测试：真实 pi AgentSession 装配（extensionFactories →
 * ResourceLoader → createAgentSession），验证 manager Session 的工具集与
 * 激活状态，以及禁用后的立即撤权（active tools 移除）。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function agentConfig(name: string): AgentConfig {
	return {
		name,
		description: `${name} worker`,
		invoke: { type: "command", command: "echo", runArgs: ["run"] },
		enabled: true,
	};
}

function makeDriver(id: string): AgentDriver {
	return {
		id,
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue"], interactionKinds: [], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: id, status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async *continue(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: id, status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: id, status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const, enabled: true,
				compatibility: "supported" as const,
				capabilities: { operations: ["run"], interactionKinds: [], progress: "none" as const, transport: "spawn" as const },
				issues: [],
			};
		},
	};
}

test("Phase4 集成: 真实 manager Session 只暴露成员工具，禁用后立即从 active tools 移除", async () => {
	// 隔离 pi 的全局 agentDir（settings/extensions），测试不写用户 home。
	process.env.PI_CODING_AGENT_DIR = freshDir("pt-ext-agentdir-");
	const dir = freshDir("pt-ext-int-");
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	await teams.upsertAgent(agentConfig("alpha"));
	await teams.upsertAgent(agentConfig("beta"));

	const delegations = new DelegationStore(path.join(dir, "rt"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "sec"));
	await secrets.init();
	const drivers = new DriverRegistry();
	drivers.register(makeDriver("alpha"));
	const runtime = new AgentRuntime(delegations, secrets, (agentId) => drivers.get(agentId), {
		ttlMs: 24 * 60 * 60 * 1000,
	});
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);

	try {
		// direct 窗口（成员 alpha）：真实会话的工具集不含非成员 beta 的工具。
		const summary = await sessions.create(undefined, { type: "direct", members: ["alpha"] });
		const session = await sessions.open(summary.id);
		const allNames = session.getAllTools().map((t) => t.name);
		assert.ok(allNames.includes(delegateToolName("alpha")), "成员工具必须注册进 manager Session");
		assert.ok(allNames.includes(CORE_TOOL_SEARCH));
		assert.ok(!allNames.includes("list_agents"), "roster 不做成工具（由 prompt 注入取代）");
		assert.ok(!allNames.includes(delegateToolName("beta")), "非成员 Agent 的工具不在该窗口 Session 的工具集里");
		const active = session.getActiveToolNames();
		assert.ok(active.includes(delegateToolName("alpha")), "direct 默认激活该 Agent 的基础委托工具");

		// 撤权（§3.3.6）：禁用 alpha 后活跃会话立即从 active tools 移除该工具。
		await teams.setEnabled("alpha", false);
		let removed = false;
		for (let i = 0; i < 50; i++) {
			if (!session.getActiveToolNames().includes(delegateToolName("alpha"))) {
				removed = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(removed, "禁用后必须立即从 active tools 移除（不等空闲重建）");
		// 工具仍注册（未卸载），但已不可见；入口拒绝由 AgentInvoker 二次校验兜底。
		assert.ok(session.getAllTools().some((t) => t.name === delegateToolName("alpha")));
	} finally {
		await sessions.disposeAll();
	}
});
