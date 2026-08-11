import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { registerAgentsRoutes } from "./agents.js";
import { registerRoomsRoutes } from "./rooms.js";
import { registerWorkspacesRoutes } from "./workspaces.js";

/**
 * 信任门路由测试（迁移方案 §7）：PUT trust 决策 API、preview 按信任状态
 * 过滤 workspace 来源、unscoped 无泄漏、撤销信任标 runtimeDirty。
 */

async function makeStack() {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-trust-routes-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	await teams.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const app = Fastify({ logger: false });
	registerWorkspacesRoutes(app, teams.workspaces, undefined, sessions);
	registerAgentsRoutes(app, teams);
	registerRoomsRoutes(app, sessions, teams, invoker);
	return { app, teams, sessions, dir };
}

/** 含可注入资源的外部项目：AGENTS.md + .pi/skills/ws-skill。 */
function makeExternalProject(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pt-trust-project-"));
	writeFileSync(path.join(root, "AGENTS.md"), "项目上下文 SECRET");
	mkdirSync(path.join(root, ".pi", "skills", "ws-skill"), { recursive: true });
	writeFileSync(
		path.join(root, ".pi", "skills", "ws-skill", "SKILL.md"),
		"---\nname: ws-skill\ndescription: 项目技能\n---\n\n正文\n",
	);
	return root;
}

async function registerExternal(
	app: ReturnType<typeof Fastify>,
	root: string,
): Promise<{ id: string; trust: { state: string } }> {
	const res = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
	assert.equal(res.statusCode, 200, res.body);
	return res.json().workspace;
}

async function preview(app: ReturnType<typeof Fastify>, workspaceId?: string) {
	const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
	const res = await app.inject({ method: "GET", url: `/api/agents/manager/pi-resources/preview${query}` });
	assert.equal(res.statusCode, 200, res.body);
	return res.json().preview;
}

test("信任门 API: PUT trust 状态流转、校验与详情摘要", async () => {
	const { app, sessions } = await makeStack();
	const ws = await registerExternal(app, makeExternalProject());
	assert.equal(ws.trust.state, "pending", "外部登记初始 pending");

	const bad = await app.inject({ method: "PUT", url: `/api/workspaces/${ws.id}/trust`, payload: { state: "maybe" } });
	assert.equal(bad.statusCode, 400);
	const missing = await app.inject({ method: "PUT", url: "/api/workspaces/nope/trust", payload: { state: "trusted" } });
	assert.equal(missing.statusCode, 404);

	const trusted = await app.inject({
		method: "PUT",
		url: `/api/workspaces/${ws.id}/trust`,
		payload: { state: "trusted", approvedResources: ["context", "skills"] },
	});
	assert.equal(trusted.statusCode, 200, trusted.body);
	assert.equal(trusted.json().workspace.trust.state, "trusted");
	assert.deepEqual(trusted.json().workspace.trust.approvedResources, ["context", "skills"]);
	assert.equal(trusted.json().dirtySessions, 0);

	const detail = await app.inject({ method: "GET", url: `/api/workspaces/${ws.id}` });
	assert.equal(detail.statusCode, 200);
	assert.equal(detail.json().workspace.trust.state, "trusted");
	assert.deepEqual(detail.json().workspace.resources, { contextFiles: 1, skills: 1, prompts: 0 });
	assert.ok(!JSON.stringify(detail.json()).includes("SECRET"), "摘要不得包含正文");

	await sessions.disposeAll();
	await app.close();
});

test("信任门 preview: pending 不进候选集，trusted 按 approvedResources 过滤", async () => {
	const { app, sessions } = await makeStack();
	const ws = await registerExternal(app, makeExternalProject());

	const pending = await preview(app, ws.id);
	assert.equal(pending.workspace.id, ws.id);
	assert.equal(pending.workspace.trust.state, "pending");
	assert.equal(pending.segments.some((s: { source: string }) => s.source === "workspace-context"), false);
	assert.deepEqual(pending.contextFiles, []);
	assert.equal(pending.skills.some((s: { source: string }) => s.source === "workspace"), false);

	await app.inject({ method: "PUT", url: `/api/workspaces/${ws.id}/trust`, payload: { state: "trusted" } });
	const trusted = await preview(app, ws.id);
	assert.ok(trusted.segments.some((s: { source: string }) => s.source === "workspace-context"));
	assert.ok(trusted.contextFiles.some((p: string) => p.endsWith("AGENTS.md")));
	assert.ok(trusted.skills.some((s: { name: string; source: string }) => s.name === "ws-skill" && s.source === "workspace"));

	await app.inject({
		method: "PUT",
		url: `/api/workspaces/${ws.id}/trust`,
		payload: { state: "trusted", approvedResources: ["skills"] },
	});
	const skillsOnly = await preview(app, ws.id);
	assert.equal(skillsOnly.segments.some((s: { source: string }) => s.source === "workspace-context"), false);
	assert.ok(skillsOnly.skills.some((s: { name: string }) => s.name === "ws-skill"));

	await app.inject({ method: "PUT", url: `/api/workspaces/${ws.id}/trust`, payload: { state: "denied" } });
	const denied = await preview(app, ws.id);
	assert.equal(denied.skills.some((s: { source: string }) => s.source === "workspace"), false);
	assert.deepEqual(denied.contextFiles, []);

	await sessions.disposeAll();
	await app.close();
});

test("信任门 preview: 无 workspace 的窗口不泄漏任何 workspace-context（§6.3）", async () => {
	const { app, sessions, dir } = await makeStack();
	// 默认 cwd 里故意放 AGENTS.md：unscoped preview 也不得出现（对照组是受信任后应出现）。
	writeFileSync(path.join(dir, "AGENTS.md"), "不应泄漏的上下文");

	const unscoped = await preview(app);
	assert.equal(unscoped.workspace, null);
	assert.deepEqual(unscoped.contextFiles, []);
	assert.equal(unscoped.segments.some((s: { source: string }) => s.source === "workspace-context"), false);
	assert.equal(unscoped.skills.some((s: { source: string }) => s.source === "workspace"), false);

	// 对照：同一目录登记为外部项目并 trusted 后，context 应出现。
	const ws = await registerExternal(app, dir);
	await app.inject({ method: "PUT", url: `/api/workspaces/${ws.id}/trust`, payload: { state: "trusted" } });
	const trusted = await preview(app, ws.id);
	assert.ok(trusted.segments.some((s: { source: string }) => s.source === "workspace-context"));

	await sessions.disposeAll();
	await app.close();
});

test("信任门: managed 默认 trusted，撤销信任标活跃 Session runtimeDirty（§7.3）", async () => {
	const { app, teams, sessions } = await makeStack();
	const managed = await teams.workspaces.createManaged("M");
	assert.equal(managed.trust.state, "trusted");

	const room = await app.inject({
		method: "POST",
		url: "/api/rooms",
		payload: { type: "direct", members: ["alpha"], workspaceId: managed.id },
	});
	assert.equal(room.statusCode, 200, room.body);

	const revoked = await app.inject({
		method: "PUT",
		url: `/api/workspaces/${managed.id}/trust`,
		payload: { state: "denied" },
	});
	assert.equal(revoked.statusCode, 200, revoked.body);
	assert.equal(revoked.json().workspace.trust.state, "denied");
	assert.ok(revoked.json().dirtySessions >= 1, "引用该 workspace 的活跃 Session 必须标 runtimeDirty");

	// 撤销后 preview 不再出现 workspace 来源。
	const denied = await preview(app, managed.id);
	assert.equal(denied.segments.some((s: { source: string }) => s.source === "workspace-context"), false);

	// 重新信任不再重复标 dirty。
	const reTrusted = await app.inject({
		method: "PUT",
		url: `/api/workspaces/${managed.id}/trust`,
		payload: { state: "trusted" },
	});
	assert.equal(reTrusted.json().dirtySessions, 0);

	await sessions.disposeAll();
	await app.close();
});

test("信任门: realpath 漂移后读取侧自动按 pending 处理", async () => {
	const { app, sessions } = await makeStack();
	const root = makeExternalProject();
	const ws = await registerExternal(app, root);
	await app.inject({ method: "PUT", url: `/api/workspaces/${ws.id}/trust`, payload: { state: "trusted" } });

	// 目录被替换为指向别处的 symlink。
	const elsewhere = mkdtempSync(path.join(tmpdir(), "pt-trust-swap-"));
	const old = `${root}-old`;
	await import("node:fs").then((fs) => {
		fs.renameSync(root, old);
		fs.symlinkSync(elsewhere, root);
	});

	const detail = await app.inject({ method: "GET", url: `/api/workspaces/${ws.id}` });
	assert.equal(detail.json().workspace.trust.state, "pending", "realpath 漂移必须自动退回 pending");
	// 身份已变化的 workspace 同时被 require 挡住：preview 直接 400，不泄漏任何内容。
	const drifted = await app.inject({
		method: "GET",
		url: `/api/agents/manager/pi-resources/preview?workspaceId=${encodeURIComponent(ws.id)}`,
	});
	assert.equal(drifted.statusCode, 400);

	await sessions.disposeAll();
	await app.close();
});
