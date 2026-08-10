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
	const teams = new TeamsStore(path.join(dir, "teams"), dir, 900_000, credentials);
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
