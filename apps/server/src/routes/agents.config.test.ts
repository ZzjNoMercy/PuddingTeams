import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { TeamsStore } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import { registerAgentsRoutes } from "./agents.js";

/**
 * 统一配置接口测试（§10.5）：PUT /api/agents/:name/config 对 pinned manager
 * 与 pi worker 同构合并更新；非 pi worker 传 manager/connector 字段 400。
 */

interface Stack {
	app: FastifyInstance;
	teams: TeamsStore;
}

async function makeStack(): Promise<Stack> {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-agent-config-"));
	const credentials = new CredentialsStore(path.join(dir, "sec"));
	await credentials.init();
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
		900_000,
		credentials,
	);
	await teams.init();
	await teams.upsertAgent({
		name: "piworker",
		description: "pi worker",
		connector: { extensionId: "pi", connectorId: "pi", config: { model: "openai/gpt-5" } },
	});
	await teams.upsertAgent({
		name: "cmdworker",
		description: "command worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
	});
	const app = Fastify();
	registerAgentsRoutes(app, teams, { credentials });
	return { app, teams };
}

test("config: pinned manager 合并更新（manager settings 键级合并）", async () => {
	const { app } = await makeStack();
	const first = await app.inject({
		method: "PUT",
		url: "/api/agents/manager/config",
		payload: {
			description: "新描述",
			manager: { model: "openai/gpt-5" },
			piResources: { enabledSkills: ["lib-skill"], systemPrompt: "人格" },
		},
	});
	assert.equal(first.statusCode, 200);
	const agent = first.json().agent;
	assert.equal(agent.description, "新描述");
	assert.equal(agent.manager.model, "openai/gpt-5");
	assert.deepEqual(agent.piResources, { enabledSkills: ["lib-skill"], systemPrompt: "人格" });
	assert.ok(first.json().affectedSessions);

	// 第二次只补 thinkingLevel：model / description / piResources 保持。
	const second = await app.inject({
		method: "PUT",
		url: "/api/agents/manager/config",
		payload: { manager: { thinkingLevel: "high" } },
	});
	assert.equal(second.statusCode, 200);
	const merged = second.json().agent;
	assert.equal(merged.manager.thinkingLevel, "high");
	assert.equal(merged.manager.model, "openai/gpt-5");
	assert.equal(merged.description, "新描述");
	assert.deepEqual(merged.piResources, { enabledSkills: ["lib-skill"], systemPrompt: "人格" });
});

test("config: manager 传 connector 字段 400", async () => {
	const { app } = await makeStack();
	const res = await app.inject({
		method: "PUT",
		url: "/api/agents/manager/config",
		payload: { connector: { config: {} } },
	});
	assert.equal(res.statusCode, 400);
});

test("config: pi worker 合并更新（description/piResources/connector.config）", async () => {
	const { app, teams } = await makeStack();
	const res = await app.inject({
		method: "PUT",
		url: "/api/agents/piworker/config",
		payload: {
			description: "改过的",
			responsibility: { domain: "代码", owns: ["review"], excludes: [] },
			piResources: { enabledSkills: ["a", "b", "a"], enabledPrompts: [] },
			connector: { config: { model: "anthropic/claude" } },
		},
	});
	assert.equal(res.statusCode, 200);
	const agent = res.json().agent;
	assert.equal(agent.description, "改过的");
	assert.equal(agent.responsibility.domain, "代码");
	// 归一化：去重排序；空名单不保留。
	assert.deepEqual(agent.piResources, { enabledSkills: ["a", "b"] });
	// connector 绑定保留，仅 config 更新。
	assert.equal(agent.connector.extensionId, "pi");
	assert.equal(agent.connector.connectorId, "pi");
	assert.deepEqual(agent.connector.config, { model: "anthropic/claude" });

	// null 清除语义：responsibility 与 piResources 删除。
	const cleared = await app.inject({
		method: "PUT",
		url: "/api/agents/piworker/config",
		payload: { responsibility: null, piResources: null },
	});
	assert.equal(cleared.statusCode, 200);
	assert.equal(cleared.json().agent.responsibility, undefined);
	assert.equal(cleared.json().agent.piResources, undefined);
	const stored = await teams.getAgent("piworker");
	assert.equal(stored?.piResources, undefined);
});

test("config: 非 pi worker 传 manager 或 connector 字段 400", async () => {
	const { app } = await makeStack();
	const withManager = await app.inject({
		method: "PUT",
		url: "/api/agents/cmdworker/config",
		payload: { manager: { model: "openai/gpt-5" } },
	});
	assert.equal(withManager.statusCode, 400);
	const withConnector = await app.inject({
		method: "PUT",
		url: "/api/agents/cmdworker/config",
		payload: { connector: { config: {} } },
	});
	assert.equal(withConnector.statusCode, 400);
	// 非 pi worker 传 piResources 也被 store 校验拒绝。
	const withResources = await app.inject({
		method: "PUT",
		url: "/api/agents/cmdworker/config",
		payload: { piResources: { enabledSkills: ["a"] } },
	});
	assert.equal(withResources.statusCode, 400);
	// 普通 description 更新仍然可用。
	const ok = await app.inject({
		method: "PUT",
		url: "/api/agents/cmdworker/config",
		payload: { description: "合法更新" },
	});
	assert.equal(ok.statusCode, 200);
	assert.equal(ok.json().agent.description, "合法更新");
});

test("config: worker displayName 更新与清除（name/id 解耦）", async () => {
	const { app, teams } = await makeStack();
	// 设置显示名：内部 id 不变。
	const set = await app.inject({
		method: "PUT",
		url: "/api/agents/piworker/config",
		payload: { displayName: "数据分析员" },
	});
	assert.equal(set.statusCode, 200);
	assert.equal(set.json().agent.name, "piworker");
	assert.equal(set.json().agent.displayName, "数据分析员");
	// 清除（null 与空串等价）：displayName 删除，展示回退 id。
	for (const payload of [{ displayName: null }, { displayName: "  " }]) {
		const cleared = await app.inject({ method: "PUT", url: "/api/agents/piworker/config", payload });
		assert.equal(cleared.statusCode, 200);
		assert.equal(cleared.json().agent.displayName, undefined);
	}
	// 非法类型 400；超长 400。
	assert.equal(
		(await app.inject({ method: "PUT", url: "/api/agents/piworker/config", payload: { displayName: 42 } })).statusCode,
		400,
	);
	assert.equal(
		(await app.inject({ method: "PUT", url: "/api/agents/piworker/config", payload: { displayName: "超".repeat(41) } })).statusCode,
		400,
	);
	assert.equal((await teams.getAgent("piworker"))?.displayName, undefined);
});

test("config: pinned manager displayName 更新", async () => {
	const { app } = await makeStack();
	const res = await app.inject({
		method: "PUT",
		url: "/api/agents/manager/config",
		payload: { displayName: "大管家" },
	});
	assert.equal(res.statusCode, 200);
	assert.equal(res.json().agent.name, "manager");
	assert.equal(res.json().agent.displayName, "大管家");
});

test("create: 无 name 时从 displayName 派生内部 id", async () => {
	const { app } = await makeStack();
	// 纯中文显示名 → worker-<随机> 回退。
	const zh = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: { displayName: "数据分析员", invoke: { type: "command", command: "echo", runArgs: [] } },
	});
	assert.equal(zh.statusCode, 200);
	assert.match(zh.json().agent.name, /^worker-[0-9a-f]{6}$/);
	assert.equal(zh.json().agent.displayName, "数据分析员");
	// ASCII 显示名 → slug；撞名追加 -2。
	const first = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: { displayName: "Data Analyst", invoke: { type: "command", command: "echo", runArgs: [] } },
	});
	assert.equal(first.statusCode, 200);
	assert.equal(first.json().agent.name, "data-analyst");
	const second = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: { displayName: "data analyst", invoke: { type: "command", command: "echo", runArgs: [] } },
	});
	assert.equal(second.json().agent.name, "data-analyst-2");
	// 无 name 且无 displayName → 400；显式 name 非法字符 → 400。
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/agents", payload: { invoke: { type: "command", command: "echo", runArgs: [] } } })).statusCode,
		400,
	);
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/agents", payload: { name: "坏 名字", invoke: { type: "command", command: "echo", runArgs: [] } } })).statusCode,
		400,
	);
	// 显式合法 name + displayName 共存：id 用显式值。
	const explicit = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: { name: "pi-c", displayName: "本地 pi worker C", invoke: { type: "command", command: "echo", runArgs: [] } },
	});
	assert.equal(explicit.statusCode, 200);
	assert.equal(explicit.json().agent.name, "pi-c");
	assert.equal(explicit.json().agent.displayName, "本地 pi worker C");
});

test("config: pi worker 传 manager 字段 400；未知 agent 404", async () => {
	const { app } = await makeStack();
	assert.equal(
		(
			await app.inject({
				method: "PUT",
				url: "/api/agents/piworker/config",
				payload: { manager: { model: "x" } },
			})
		).statusCode,
		400,
	);
	assert.equal(
		(await app.inject({ method: "PUT", url: "/api/agents/ghost/config", payload: { description: "x" } })).statusCode,
		404,
	);
});
