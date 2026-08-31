import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
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
	credentials: CredentialsStore;
	dir: string;
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
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: { model: "openai/gpt-5" } },
	});
	await teams.upsertAgent({
		name: "cmdworker",
		description: "command worker",
		invoke: { type: "command", command: "echo", runArgs: [] },
	});
	const app = Fastify();
	registerAgentsRoutes(app, teams, { credentials });
	return { app, teams, credentials, dir };
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
	// 并发同名创建在存储写锁内分配 id，两次都成功且不会互相覆盖。
	const [concurrentA, concurrentB] = await Promise.all([
		app.inject({
			method: "POST",
			url: "/api/agents",
			payload: { displayName: "Concurrent Worker", invoke: { type: "command", command: "echo", runArgs: [] } },
		}),
		app.inject({
			method: "POST",
			url: "/api/agents",
			payload: { displayName: "Concurrent Worker", invoke: { type: "command", command: "echo", runArgs: [] } },
		}),
	]);
	assert.equal(concurrentA.statusCode, 200);
	assert.equal(concurrentB.statusCode, 200);
	assert.deepEqual(
		new Set([concurrentA.json().agent.name, concurrentB.json().agent.name]),
		new Set(["concurrent-worker", "concurrent-worker-2"]),
	);
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

test("duplicate: 原子生成新身份，复制普通配置但不复制凭证、env、头像与启用状态", async () => {
	const { app, teams, credentials } = await makeStack();
	const source = (await teams.getAgent("piworker"))!;
	await teams.upsertAgent({
		...source,
		displayName: "研究 Worker",
		description: "负责研究",
		enabled: true,
		env: { LEGACY_TOKEN: "must-not-copy", PLAIN_OPTION: "also-not-copied" },
		avatar: "piworker.png",
		responsibility: { domain: "research", owns: ["资料检索"], excludes: ["发布"] },
		piResources: { systemPrompt: "严谨核验", enabledSkills: ["research"] },
		connector: {
			...source.connector!,
			config: { model: "openai/gpt-5", thinkingLevel: "high" },
			secretRefs: { API_TOKEN: "API_TOKEN" },
		},
		capabilityExtensions: [{
			id: "source-binding",
			extensionId: "research-cap",
			capabilityId: "research",
			enabled: true,
			config: { region: "cn" },
			secretRefs: { CAP_TOKEN: "CAP_TOKEN" },
		}],
	});
	await credentials.setSecrets("piworker", { API_TOKEN: "source-secret", CAP_TOKEN: "source-cap-secret" });

	// 并发复制也必须在注册表写锁内分配不同 id，不能互相覆盖。
	const [first, second] = await Promise.all([
		app.inject({ method: "POST", url: "/api/agents/piworker/duplicate" }),
		app.inject({ method: "POST", url: "/api/agents/piworker/duplicate" }),
	]);
	assert.equal(first.statusCode, 200);
	assert.equal(second.statusCode, 200);
	const copies = [first.json().agent, second.json().agent];
	assert.deepEqual(new Set(copies.map((agent) => agent.name)), new Set(["piworker-copy", "piworker-copy-2"]));
	assert.deepEqual(new Set(copies.map((agent) => agent.displayName)), new Set(["研究 Worker 副本", "研究 Worker 副本 2"]));

	for (const copy of copies) {
		assert.equal(copy.enabled, false);
		assert.equal(copy.extensionRevision, 1);
		assert.equal(copy.avatar, undefined);
		assert.equal(copy.env, undefined);
		assert.equal(copy.connector.secretRefs, undefined);
		assert.deepEqual(copy.connector.config, { model: "openai/gpt-5", thinkingLevel: "high" });
		assert.deepEqual(copy.responsibility, { domain: "research", owns: ["资料检索"], excludes: ["发布"] });
		assert.deepEqual(copy.piResources, { systemPrompt: "严谨核验", enabledSkills: ["research"] });
		assert.equal(copy.capabilityExtensions.length, 1);
		assert.notEqual(copy.capabilityExtensions[0].id, "source-binding");
		assert.equal(copy.capabilityExtensions[0].secretRefs, undefined);
		assert.deepEqual(copy.capabilityExtensions[0].config, { region: "cn" });
		assert.deepEqual(await credentials.listConfigured(copy.name), []);
	}
	assert.notEqual(copies[0].capabilityExtensions[0].id, copies[1].capabilityExtensions[0].id);

	const unchanged = (await teams.getAgent("piworker"))!;
	assert.equal(unchanged.enabled, true);
	assert.deepEqual(unchanged.connector?.secretRefs, { API_TOKEN: "API_TOKEN" });
	assert.deepEqual(await credentials.listConfigured("piworker"), ["API_TOKEN", "CAP_TOKEN"]);

	assert.equal((await app.inject({ method: "POST", url: "/api/agents/manager/duplicate" })).statusCode, 400);
	assert.equal((await app.inject({ method: "POST", url: "/api/agents/cmdworker/duplicate" })).statusCode, 400);
	assert.equal((await app.inject({ method: "POST", url: "/api/agents/missing/duplicate" })).statusCode, 404);
});

test("duplicate identity: 删除后的 id 永不复用，旧 Window/binding、迟到 Run 与孤儿凭证不能附着到新副本", async () => {
	const { app, teams, credentials, dir } = await makeStack();
	const firstResponse = await app.inject({ method: "POST", url: "/api/agents/piworker/duplicate" });
	assert.equal(firstResponse.statusCode, 200);
	const first = firstResponse.json().agent;
	const enabled = await teams.setEnabled(first.name, true);
	assert.equal(enabled.extensionRevision, 2);

	const oldWindow = await teams.ensureDirectWindow(first.name, undefined, async () => ({ id: "old-room-session" }));
	await teams.rememberWorkerSession(
		oldWindow.id,
		oldWindow.activeSession,
		first.name,
		"old-session-handle",
		undefined,
		oldWindow.cwdSnapshot,
		enabled.extensionRevision!,
	);
	assert.equal(
		(await teams.getWindow(oldWindow.id))?.workerBindings?.[oldWindow.activeSession]?.[first.name]?.sessionHandle,
		"old-session-handle",
	);

	const removed = await app.inject({ method: "DELETE", url: `/api/agents/${first.name}` });
	assert.equal(removed.statusCode, 204);
	const persistedRegistry = JSON.parse(readFileSync(path.join(dir, "teams", "agents.json"), "utf-8"));
	assert.equal(persistedRegistry.version, 2);
	assert.ok(persistedRegistry.retiredAgentIds.includes(first.name), "tombstone 必须与删除在同一次 agents.json 原子写中持久化");
	// 模拟“Agent 已删除、凭证清理前进程崩溃”留下的孤儿命名空间。
	await credentials.setSecrets(first.name, { ORPHAN_TOKEN: "must-never-rebind" });

	const secondResponse = await app.inject({ method: "POST", url: "/api/agents/piworker/duplicate" });
	assert.equal(secondResponse.statusCode, 200);
	const second = secondResponse.json().agent;
	assert.equal(first.name, "piworker-copy");
	assert.equal(second.name, "piworker-copy-2");
	assert.notEqual(second.name, first.name);
	assert.ok((await teams.reservedAgentIds()).includes(first.name));
	assert.deepEqual(await credentials.listConfigured(second.name), []);

	const secondEnabled = await teams.setEnabled(second.name, true);
	assert.equal(secondEnabled.extensionRevision, enabled.extensionRevision, "revision 可相同，但不可变 id 必须隔离身份");
	assert.deepEqual(await teams.windowMembers(oldWindow.id), [], "旧 Window 的 retired member 不得解析成新副本");

	// 旧 Run 删除后才结束：仍只能按 retired id 回写，不能命中新副本。
	await teams.rememberWorkerSession(
		oldWindow.id,
		oldWindow.activeSession,
		first.name,
		"late-session-handle",
		undefined,
		oldWindow.cwdSnapshot,
		enabled.extensionRevision!,
	);
	const afterLateRun = await teams.getWindow(oldWindow.id);
	assert.equal(
		afterLateRun?.workerBindings?.[oldWindow.activeSession]?.[first.name]?.sessionHandle,
		"old-session-handle",
		"迟到 Run 不得改写已删除身份的 binding",
	);
	assert.equal(afterLateRun?.workerBindings?.[oldWindow.activeSession]?.[second.name], undefined);

	// 所有创建路径都必须尊重 tombstone，显式指定旧 id 也不可复活。
	const resurrect = await app.inject({
		method: "POST",
		url: "/api/agents",
		payload: {
			name: first.name,
			displayName: "错误复活",
			description: "",
			connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		},
	});
	assert.equal(resurrect.statusCode, 400);
	assert.match(resurrect.json().error, /已退役/);
});

test("config: pi worker 传 manager 字段 400；未知 agent 404", async () => {
	const { app, teams } = await makeStack();
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
	assert.equal(
		(await app.inject({
			method: "PUT",
			url: "/api/agents/fresh-id",
			payload: { description: "不得借更新接口创建", invoke: { type: "command", command: "echo", runArgs: [] } },
		})).statusCode,
		404,
	);
	assert.equal(
		(await app.inject({
			method: "PUT",
			url: "/api/agents/unsafe%20id",
			payload: { description: "不得持久化不安全 id", invoke: { type: "command", command: "echo", runArgs: [] } },
		})).statusCode,
		404,
	);
	await assert.rejects(
		teams.upsertAgent({ name: "unsafe id", description: "x", invoke: { type: "command", command: "echo", runArgs: [] } }),
		/name 只能包含/,
	);
});
