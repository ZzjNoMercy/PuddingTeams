import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { TeamsStore } from "../store/teams.js";
import { AgentCreationOperations } from "../store/agent-creation-operations.js";
import { registerAgentsRoutes } from "./agents.js";

const payload = { displayName: "Data Analyst", description: "Analyze data", invoke: { type: "command" as const, command: "echo", runArgs: [] } };

async function makeStack(dir = mkdtempSync(path.join(tmpdir(), "pt-agent-create-"))) {
	const teams = new TeamsStore({ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") }, dir);
	await teams.init();
	const app = Fastify();
	const operationsPath = path.join(dir, "state", "agent-creation-operations.json");
	registerAgentsRoutes(app, teams, { agentCreationStatePath: operationsPath });
	return { app, teams, dir, operationsPath };
}

test("Agent 首次创建响应丢失后，同键重试与重启只返回原身份", async () => {
	const first = await makeStack();
	const key = "agent-create-0001";
	let name = "";
	try {
		const send = () => first.app.inject({ method: "POST", url: "/api/agents", headers: { "idempotency-key": key }, payload });
		const [a, b] = await Promise.all([send(), send()]);
		assert.equal(a.statusCode, 200, a.body);
		assert.equal(b.statusCode, 200, b.body);
		name = a.json().agent.name as string;
		assert.equal(name, "data-analyst");
		assert.equal(b.json().agent.name, name);
		const changed = await first.app.inject({ method: "POST", url: "/api/agents", headers: { "idempotency-key": key }, payload: { ...payload, displayName: "Other" } });
		assert.equal(changed.statusCode, 409, changed.body);
		assert.equal(changed.json().code, "idempotency_conflict");
	} finally { await first.app.close(); }
	const restarted = await makeStack(first.dir);
	try {
		const replay = await restarted.app.inject({ method: "POST", url: "/api/agents", headers: { "idempotency-key": key }, payload });
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().agent.name, name);
		assert.equal((await restarted.teams.listAgents()).filter((agent) => agent.name === name).length, 1);
	} finally { await restarted.app.close(); }
});

test("Agent 写入后预约确认中断时返回需核对的冲突，拒绝二次创建", async () => {
	const { app, teams, operationsPath } = await makeStack();
	const key = "agent-create-uncertain-0001";
	try {
		const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		const operations = new AgentCreationOperations(operationsPath);
		const reserved = await operations.reserve(key, hash, "data-analyst", true, []);
		await teams.upsertAgent({ ...payload, name: reserved.agentName }, { createOnly: true });
		const retry = await app.inject({ method: "POST", url: "/api/agents", headers: { "idempotency-key": key }, payload });
		assert.equal(retry.statusCode, 409, retry.body);
		assert.equal(retry.json().code, "agent_creation_uncertain");
		assert.equal(retry.json().agentName, reserved.agentName);
		assert.equal((await teams.listAgents()).filter((agent) => agent.name === reserved.agentName).length, 1);
	} finally { await app.close(); }
});

test("带操作键的自动 ID 分配跳过已退役 Agent 身份", async () => {
	const { app, teams } = await makeStack();
	try {
		await teams.upsertAgent({ ...payload, name: "data-analyst" }, { createOnly: true });
		assert.equal(await teams.removeAgent("data-analyst"), true);
		const created = await app.inject({ method: "POST", url: "/api/agents", headers: { "idempotency-key": "agent-retired-0001" }, payload });
		assert.equal(created.statusCode, 200, created.body);
		assert.equal(created.json().agent.name, "data-analyst-2");
	} finally { await app.close(); }
});

test("损坏的 Agent 创建账本拒绝预约，修复后 constructor 键仍能幂等重放", async () => {
	const { app, teams, dir, operationsPath } = await makeStack();
	const headers = { "idempotency-key": "constructor" };
	try {
		mkdirSync(path.dirname(operationsPath), { recursive: true });
		writeFileSync(operationsPath, "[]");
		const refused = await app.inject({ method: "POST", url: "/api/agents", headers, payload });
		assert.equal(refused.statusCode, 400, refused.body);
		assert.match(refused.json().error, /账本无效/);
		assert.equal(readFileSync(operationsPath, "utf8"), "[]");
		assert.equal((await teams.listAgents()).filter((agent) => agent.name === "data-analyst").length, 0);
		writeFileSync(operationsPath, "{}");
		const created = await app.inject({ method: "POST", url: "/api/agents", headers, payload });
		assert.equal(created.statusCode, 200, created.body);
	} finally { await app.close(); }
	const restarted = await makeStack(dir);
	try {
		const replay = await restarted.app.inject({ method: "POST", url: "/api/agents", headers, payload });
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(replay.json().agent.name, "data-analyst");
		assert.equal((await restarted.teams.listAgents()).filter((agent) => agent.name === "data-analyst").length, 1);
	} finally { await restarted.app.close(); }
});
