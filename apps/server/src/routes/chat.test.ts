import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { TeamsStore } from "../store/teams.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { DriverRegistry } from "../agent-runtime/driver-registry.js";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import { modelsJsonPath } from "../pi-bridge/custom-providers.js";
import { ProviderDeletionCoordinator } from "../pi-bridge/provider-deletion.js";
import { registerChatRoutes } from "./chat.js";
import { registerProvidersRoutes } from "./providers.js";
import { UploadStore } from "../store/uploads.js";
import type { AgentDriver } from "../agent-runtime/types.js";
import { WorkStateStore } from "../store/work-state.js";

async function makeStack(health?: { dataHomeId?: string; runId?: string }) {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-chat-routes-"));
	process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent-dir");
	const teams = new TeamsStore(
		{ state: path.join(dir, "teams"), assets: path.join(dir, "teams"), managedWorkspaces: path.join(dir, "managed") },
		dir,
	);
	await teams.init();
	const delegations = new DelegationStore(path.join(dir, "runtime"));
	await delegations.init();
	const secrets = new InteractionSecretStore(path.join(dir, "secrets"));
	await secrets.init();
	const drivers = new DriverRegistry();
	const runtime = new AgentRuntime(delegations, secrets, (id) => drivers.get(id), { ttlMs: 60_000 });
	const invoker = new AgentInvoker(teams, runtime, drivers, undefined, dir);
	const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams, invoker);
	const workStates = new WorkStateStore(path.join(dir, "work-state"));
	await workStates.init();
	const app = Fastify({ logger: false });
	await app.register(websocket);
	const providerDeletion = new ProviderDeletionCoordinator(path.join(dir, "secrets", "provider-deletion-journal.json"), sessions);
	await registerChatRoutes(app, sessions, teams, workStates, undefined, invoker, health, providerDeletion);
	return { app, dir, sessions, teams, delegations, drivers, runtime, invoker, workStates, providerDeletion };
}

test("CLI-managed health identifies the exact server instance and data home", async () => {
	const { app, sessions } = await makeStack({ dataHomeId: "fixture-home", runId: "fixture-run" });
	try {
		const response = await app.inject({ method: "GET", url: "/api/health" });
		assert.equal(response.statusCode, 200);
		assert.deepEqual(response.json(), { ok: true, service: "puddingteams-server", piVersion: response.json().piVersion, dataHomeId: "fixture-home", runId: "fixture-run" });
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Worker 单聊模型设置持久化、会话隔离、恢复默认且不修改 Agent 配置", async () => {
	const { app, sessions, teams, drivers, dir } = await makeStack();
	const worker = { name: "modelworker", description: "test", connector: { extensionId: "codex", connectorId: "codex", transport: "spawn" as const, config: { model: "worker-default", effort: "medium" } } };
	const captured: unknown[] = [];
	const driver: AgentDriver = {
		id: worker.name,
		capabilities: async () => ({ operations: ["run", "continue"], interactionKinds: [], progress: "none", transport: "spawn", runtimeModel: { effortLevels: ["low", "medium", "high"] } }),
		async *run(input) { captured.push(input.options?.runtimeModel); yield { type: "started", sessionHandle: "native-thread" }; yield { type: "completed", result: { agentId: worker.name, status: "completed", content: "done", sessionHandle: "native-thread" } }; },
		async *continue(input) { yield* this.run(input, { cwd: dir, env: {} }); },
		async *respond() {},
		probe: async () => { throw new Error("unused"); },
	};
	drivers.register(driver);
	try {
		await teams.upsertAgent(worker);
		const first = await sessions.create(undefined, { type: "direct", members: [worker.name], cwd: dir });
		const window = await teams.createWindow({ type: "direct", members: [worker.name], sessionId: first.id });
		const second = await sessions.create(undefined, { type: "direct", members: [worker.name], cwd: dir });
		await teams.addWindowSession(window.id, second.id);
		const endpoint = `/api/sessions/${first.id}/worker-runtime-model`;
		const initial = await app.inject({ method: "GET", url: endpoint });
		assert.equal(initial.statusCode, 200, initial.body);
		assert.deepEqual(initial.json().defaults, { model: "worker-default", effort: "medium" });
		for (const payload of [{ effort: "invalid" }, { model: "" }, { sandbox: "danger-full-access" }]) {
			assert.equal((await app.inject({ method: "PUT", url: endpoint, payload })).statusCode, 400);
		}
		const saved = await app.inject({ method: "PUT", url: endpoint, payload: { model: "override", effort: "high" } });
		assert.equal(saved.statusCode, 200, saved.body);
		assert.deepEqual(saved.json().settings, { model: "override", effort: "high" });
		assert.deepEqual((await app.inject({ method: "GET", url: `/api/sessions/${second.id}/worker-runtime-model` })).json().settings, {});
		await sessions.dispose(first.id);
		assert.deepEqual((await app.inject({ method: "GET", url: endpoint })).json().settings, { model: "override", effort: "high" });
		const send = await app.inject({ method: "POST", url: `/api/sessions/${first.id}/messages`, payload: { content: "hello" } });
		assert.equal(send.statusCode, 200, send.body);
		assert.deepEqual(captured[0], { model: "override", effort: "high" });
		assert.deepEqual((await teams.getAgent(worker.name))?.connector?.config, worker.connector.config);
		const cleared = await app.inject({ method: "PUT", url: endpoint, payload: { model: null, effort: null } });
		assert.equal(cleared.statusCode, 200, cleared.body);
		assert.deepEqual(cleared.json().settings, {});
		await sessions.dispose(first.id);
		assert.deepEqual(await sessions.workerRuntimeModel(first.id), {});
		const solo = await teams.ensureSoloWindow((workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }), async () => true);
		assert.equal((await app.inject({ method: "PUT", url: `/api/sessions/${solo.activeSession}/worker-runtime-model`, payload: { effort: "high" } })).statusCode, 400);
	} finally { await sessions.disposeAll(); await app.close(); }
});

function writeSkill(agentDir: string, name: string, description: string): void {
	const dir = path.join(agentDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf-8");
}

test("已有 solo Session 在新增自定义 Provider 和 key 后可切到新模型", async () => {
	const { app, sessions, teams, providerDeletion } = await makeStack();
	try {
		await registerProvidersRoutes(app, sessions, providerDeletion);
		const solo = await teams.ensureSoloWindow(
			(workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
			async (id) => (await sessions.list()).some((session) => session.id === id),
		);
		await sessions.ensureSessionFile(solo.activeSession);
		const initialProviderRevision = (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision as string;
		const provider = await app.inject({
			method: "PUT", url: "/api/providers/custom/fixture",
			payload: { expectedRevision: initialProviderRevision, name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "fixture-model" }] },
		});
		assert.equal(provider.statusCode, 200, provider.body);
		const staleCreate = await app.inject({
			method: "PUT", url: "/api/providers/custom/fixture",
			payload: { expectedRevision: initialProviderRevision, name: "Stale", baseUrl: "http://127.0.0.1:3/v1", api: "openai-completions", models: [{ id: "fixture-model" }] },
		});
		assert.equal(staleCreate.statusCode, 409, staleCreate.body);
		assert.equal(staleCreate.json().code, "provider_conflict");
		assert.equal((await app.inject({ method: "GET", url: "/api/providers/custom" })).json().providers.find((entry: { id: string }) => entry.id === "fixture")?.name, "Fixture");
		const missingVersion = await app.inject({ method: "PUT", url: "/api/providers/custom/fixture", payload: { name: "Missing" } });
		assert.equal(missingVersion.statusCode, 400, missingVersion.body);
		const key = await app.inject({ method: "POST", url: "/api/providers/fixture/key", payload: { apiKey: "fixture-only" } });
		assert.equal(key.statusCode, 200, key.body);
		const selected = await app.inject({
			method: "POST", url: `/api/sessions/${solo.activeSession}/model`, payload: { model: "fixture/fixture-model" },
		});
		assert.equal(selected.statusCode, 200, selected.body);
		assert.equal(selected.json().model.id, "fixture/fixture-model");
		assert.equal((await sessions.open(solo.activeSession)).model?.provider, "fixture");
		const firstProviderRevision = (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision as string;
		const replaced = await app.inject({
			method: "PUT", url: "/api/providers/custom/fixture",
			payload: { expectedRevision: firstProviderRevision, name: "Fixture v2", baseUrl: "http://127.0.0.1:2/v1", api: "openai-completions", models: [{ id: "fixture-model" }] },
		});
		assert.equal(replaced.statusCode, 200, replaced.body);
		assert.equal((await sessions.open(solo.activeSession)).model?.baseUrl, "http://127.0.0.1:2/v1");
		const staleDelete = await app.inject({ method: "DELETE", url: "/api/providers/custom/fixture", headers: { "x-expected-revision": firstProviderRevision } });
		assert.equal(staleDelete.statusCode, 409, staleDelete.body);
		assert.equal(staleDelete.json().code, "provider_conflict");
		assert.equal(await sessions.hasModelAuth("fixture"), true, "旧版删除不得先撤销凭证");
		assert.equal(await sessions.hasProvider("fixture"), true);
		const missingDeleteVersion = await app.inject({ method: "DELETE", url: "/api/providers/custom/fixture" });
		assert.equal(missingDeleteVersion.statusCode, 400, missingDeleteVersion.body);
		assert.equal(await sessions.hasModelAuth("fixture"), true);
		const removeBeforeCatalogConflict = sessions.removeProviderKey.bind(sessions);
		sessions.removeProviderKey = async (id) => {
			await removeBeforeCatalogConflict(id);
			const file = modelsJsonPath();
			writeFileSync(file, `${readFileSync(file, "utf8")} `);
		};
		try {
			const racedDelete = await app.inject({ method: "DELETE", url: "/api/providers/custom/fixture", headers: { "x-expected-revision": (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision } });
			assert.equal(racedDelete.statusCode, 409, racedDelete.body);
			assert.equal(await sessions.hasProvider("fixture"), true);
			assert.equal(await sessions.hasModelAuth("fixture"), true, "目录提交前冲突需恢复刚撤销的 key");
		} finally { sessions.removeProviderKey = removeBeforeCatalogConflict; }
		const removeProviderKey = sessions.removeProviderKey.bind(sessions);
		sessions.removeProviderKey = async () => { throw new Error("credential revoke failed"); };
		const blockedDelete = await app.inject({ method: "DELETE", url: "/api/providers/custom/fixture", headers: { "x-expected-revision": (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision } });
		assert.equal(blockedDelete.statusCode, 400, blockedDelete.body);
		assert.equal(await sessions.hasProvider("fixture"), true, "撤销凭证失败时保留 Provider 目录");
		sessions.removeProviderKey = removeProviderKey;
		const deleted = await app.inject({ method: "DELETE", url: "/api/providers/custom/fixture", headers: { "x-expected-revision": (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision } });
		assert.equal(deleted.statusCode, 200, deleted.body);
		assert.equal(await sessions.hasProvider("fixture"), false);
		assert.notEqual((await sessions.open(solo.activeSession)).model?.provider, "fixture");
		const builtinKey = await app.inject({ method: "POST", url: "/api/providers/openai/key", payload: { apiKey: "builtin-fixture-key" } });
		assert.equal(builtinKey.statusCode, 200, builtinKey.body);
		const absentCustom = await app.inject({ method: "DELETE", url: "/api/providers/custom/openai" });
		assert.equal(absentCustom.statusCode, 404, absentCustom.body);
		assert.equal(await sessions.hasModelAuth("openai"), true, "误删不存在的自定义 Provider 不能撤销内置 key");
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("Provider 删除恢复失败后目录与凭证写入均封锁至重启恢复", async () => {
	const { app, dir, sessions, providerDeletion } = await makeStack();
	try {
		await registerProvidersRoutes(app, sessions, providerDeletion);
		const initialRevision = (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision as string;
		assert.equal((await app.inject({ method: "PUT", url: "/api/providers/custom/fixture", payload: { expectedRevision: initialRevision, name: "Fixture", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] } })).statusCode, 200);
		assert.equal((await app.inject({ method: "POST", url: "/api/providers/fixture/key", payload: { apiKey: "old-key" } })).statusCode, 200);
		const revision = (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision as string;
		const originalRemove = sessions.removeProviderKey.bind(sessions);
		const originalRestore = sessions.restoreProviderCredential.bind(sessions);
		sessions.removeProviderKey = async (id) => {
			await originalRemove(id);
			const file = modelsJsonPath();
			writeFileSync(file, `${readFileSync(file, "utf8")} `);
		};
		sessions.restoreProviderCredential = async () => { throw new Error("injected restore failure"); };
		const failed = await app.inject({ method: "DELETE", url: "/api/providers/custom/fixture", headers: { "x-expected-revision": revision } });
		assert.equal(failed.statusCode, 503, failed.body);
		assert.equal(failed.json().code, "provider_recovery_required");
		for (const request of [
			{ method: "POST", url: "/api/providers/fixture/key", payload: { apiKey: "new-key" } },
			{ method: "DELETE", url: "/api/providers/fixture/key" },
			{ method: "PUT", url: "/api/providers/custom/fixture", payload: { expectedRevision: (await app.inject({ method: "GET", url: "/api/providers/custom" })).json().revision, name: "Changed", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] } },
		] as const) {
			const blocked = await app.inject(request);
			assert.equal(blocked.statusCode, 503, blocked.body);
			assert.equal(blocked.json().code, "provider_recovery_required");
		}
		sessions.removeProviderKey = originalRemove;
		sessions.restoreProviderCredential = originalRestore;
		assert.equal(await new ProviderDeletionCoordinator(path.join(dir, "secrets", "provider-deletion-journal.json"), sessions).recover(), "restored");
		assert.equal(await sessions.hasModelAuth("fixture"), true);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});

test("GET /api/sessions/:id/commands 返回 manager 当前真实启用的 Skill 命令", async () => {
	const { app, sessions, teams } = await makeStack();
	writeSkill(process.env.PI_CODING_AGENT_DIR!, "release-check", "检查发布风险");
	await teams.updateManager({ piResources: { enabledSkills: ["release-check"] } });
	const summary = await sessions.create();
	const res = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/commands` });
	assert.equal(res.statusCode, 200, res.body);
	assert.deepEqual(res.json(), {
		commands: [{ name: "skill:release-check", description: "检查发布风险", source: "skill" }],
	});
	await app.close();
});

test("GET /api/sessions/:id/commands 在 direct 窗口使用目标 pi worker 的 Skill 范围", async () => {
	const { app, sessions, teams } = await makeStack();
	writeSkill(process.env.PI_CODING_AGENT_DIR!, "data-check", "核对数据口径");
	await teams.upsertAgent({
		name: "piworker",
		description: "pi worker",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		piResources: { enabledSkills: ["data-check"] },
	});
	const summary = await sessions.create(undefined, { type: "direct", members: ["piworker"], cwd: teams.defaultContextCwd() });
	await teams.createWindow({ type: "direct", members: ["piworker"], sessionId: summary.id });
	const res = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/commands` });
	assert.equal(res.statusCode, 200, res.body);
	assert.deepEqual(res.json(), {
		commands: [{ name: "skill:data-check", description: "核对数据口径", source: "skill" }],
	});
	await app.close();
});

test("GET /api/sessions/:id/messages 包含运行中隐藏投影", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	await sessions.appendCustomMessageProjection(summary.id, {
		customType: "pudding:task_assign",
		content: "生成页面",
		details: {
			taskId: "call-1",
			delegationId: "delegation-1",
			worker: "designer",
			from: "solo",
			status: "running",
			processView: true,
		},
	});

	const res = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(res.statusCode, 200, res.body);
	assert.equal((res.json() as { running: boolean }).running, false);
	const projection = (res.json() as { messages: Array<{ role?: string; customType?: string; display?: boolean; details?: Record<string, unknown> }> })
		.messages.find((message) => message.role === "custom" && message.customType === "pudding:task_assign");
	assert.ok(projection, "驻留 AgentSession 的展示消息必须与 SessionManager 隐藏投影同步");
	assert.equal(projection.display, false);
	assert.equal(projection.details?.delegationId, "delegation-1");
	assert.equal(projection.details?.processView, true);
	sessions.isRunning = (id: string) => id === summary.id;
	const active = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(active.statusCode, 200, active.body);
	assert.equal((active.json() as { running: boolean }).running, true, "running must be independent of visible tool calls");
	await app.close();
});

test("GET 历史标出已保存但没有完成回复的最后一条用户消息", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	const user = { role: "user" as const, content: [{ type: "text" as const, text: "已接受后进程中断" }], timestamp: Date.now() };
	session.sessionManager.appendMessage(user as never);
	session.state.messages.push(user as never);
	await sessions.ensureSessionFile(summary.id);
	const incomplete = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(incomplete.statusCode, 200, incomplete.body);
	assert.equal((incomplete.json() as { unansweredUserMessage: boolean }).unansweredUserMessage, true);
	const durableHistory = readFileSync(summary.sessionFile, "utf8");
	writeFileSync(summary.sessionFile, durableHistory.split("\n").filter((line) => {
		if (!line) return false;
		const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
		return !(entry.type === "message" && entry.message?.role === "user");
	}).join("\n") + "\n");
	const memoryOnly = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal((memoryOnly.json() as { unansweredUserMessage: boolean }).unansweredUserMessage, false, "内存 user 不能证明已保存");
	writeFileSync(summary.sessionFile, durableHistory);
	sessions.isRunning = () => true;
	const running = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal((running.json() as { unansweredUserMessage: boolean }).unansweredUserMessage, false);
	sessions.isRunning = () => false;
	const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "已完成" }], timestamp: Date.now() };
	session.sessionManager.appendMessage(assistant as never);
	session.state.messages.push(assistant as never);
	await sessions.ensureSessionFile(summary.id);
	const complete = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal((complete.json() as { unansweredUserMessage: boolean }).unansweredUserMessage, false);
	await app.close();
});

test("GET 历史标出已落盘的工具调用回合仍无最终回复", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	const user = { role: "user" as const, content: [{ type: "text" as const, text: "调用工具" }], timestamp: Date.now() };
	const toolUse = {
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: "pending-tool", name: "bash", arguments: { command: "pwd" } }],
		stopReason: "toolUse" as const, timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(user as never);
	session.state.messages.push(user as never);
	session.sessionManager.appendMessage(toolUse as never);
	session.state.messages.push(toolUse as never);
	await sessions.ensureSessionFile(summary.id);
	const route = `/api/sessions/${summary.id}/messages`;
	const incomplete = await app.inject({ method: "GET", url: route });
	assert.equal(incomplete.statusCode, 200, incomplete.body);
	assert.equal(incomplete.json().unfinishedAssistantTurn, true);
	assert.equal(incomplete.json().unansweredUserMessage, false);
	const durableHistory = readFileSync(summary.sessionFile, "utf8");
	writeFileSync(summary.sessionFile, durableHistory.split("\n").filter((line) => {
		if (!line) return false;
		const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
		return !(entry.type === "message" && entry.message?.role === "assistant");
	}).join("\n") + "\n");
	const memoryOnly = await app.inject({ method: "GET", url: route });
	assert.equal(memoryOnly.json().unfinishedAssistantTurn, false, "内存 assistant 不能证明工具调用已保存");
	writeFileSync(summary.sessionFile, durableHistory);
	sessions.isRunning = () => true;
	const running = await app.inject({ method: "GET", url: route });
	assert.equal(running.json().unfinishedAssistantTurn, false);
	sessions.isRunning = () => false;
	const finalReply = { role: "assistant" as const, content: [{ type: "text" as const, text: "已完成" }], stopReason: "stop" as const, timestamp: Date.now() };
	session.sessionManager.appendMessage(finalReply as never);
	session.state.messages.push(finalReply as never);
	await sessions.ensureSessionFile(summary.id);
	const complete = await app.inject({ method: "GET", url: route });
	assert.equal(complete.json().unfinishedAssistantTurn, false);
	await app.close();
});

test("GET /api/sessions/:id/messages 对不存在的 Session 返回 404", async () => {
	const { app } = await makeStack();
	const res = await app.inject({ method: "GET", url: "/api/sessions/does-not-exist/messages" });
	assert.equal(res.statusCode, 404, res.body);
	assert.deepEqual(res.json(), { error: "session not found" });
	await app.close();
});

test("普通消息仅在 pi 准入确认后返回 accepted，拒绝时保留错误", async () => {
	const app = Fastify({ logger: false });
	await app.register(websocket);
	let entered!: () => void;
	const promptEntered = new Promise<void>((resolve) => { entered = resolve; });
	let admit!: (accepted: boolean) => void;
	let promptCalls = 0;
	const fakeSession = {
		messages: [{ role: "user" }],
		prompt: async (_text: string, options: { preflightResult: (accepted: boolean) => void }) => {
			promptCalls += 1;
			if (promptCalls === 2) { options.preflightResult(true); return; }
			entered();
			await new Promise<void>((resolve, reject) => {
				admit = (accepted) => {
					options.preflightResult(accepted);
					if (accepted) resolve();
					else reject(new Error("模型准入失败"));
				};
			});
		},
	};
	const fakeStore = { open: async () => fakeSession } as unknown as PiSessionStore;
	await registerChatRoutes(app, fakeStore);
	try {
		let settled = false;
		const pending = app.inject({ method: "POST", url: "/api/sessions/existing/messages", payload: { content: "等待准入" } });
		void pending.then(() => { settled = true; });
		await promptEntered;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.equal(settled, false, "准入未确认时不得提前清空客户端草稿");
		admit(false);
		const rejected = await pending;
		assert.equal(rejected.statusCode, 400, rejected.body);
		assert.match(rejected.body, /模型准入失败/);
		const accepted = await app.inject({ method: "POST", url: "/api/sessions/existing/messages", payload: { content: "再次提交" } });
		assert.equal(accepted.statusCode, 200, accepted.body);
		assert.equal(accepted.json().accepted, true);
	} finally {
		await app.close();
	}
});

test("模型明确拒绝消息且没有新增 user 时回收本次冻结附件", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-rejected-uploads-"));
	const uploads = new UploadStore(path.join(dir, "uploads"));
	await uploads.init();
	const session = {
		messages: [] as Array<{ role: string }>,
		prompt: async (_text: string, options: { preflightResult: (accepted: boolean) => void }) => {
			options.preflightResult(false);
			throw new Error("模型准入失败");
		},
	};
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, { open: async () => session } as unknown as PiSessionStore, undefined, undefined, uploads);
	try {
		const response = await app.inject({
			method: "POST", url: "/api/sessions/rejected/messages",
			payload: { content: "读取附件", attachments: [{ filename: "evidence.txt", mediaType: "text/plain", data: Buffer.from("evidence").toString("base64") }] },
		});
		assert.equal(response.statusCode, 400, response.body);
		assert.match(response.body, /模型准入失败/);
		assert.deepEqual(readdirSync(path.join(dir, "uploads", "rejected")), []);
		const forged = await app.inject({
			method: "POST", url: "/api/sessions/rejected/messages",
			headers: { "x-puddingteams-first-work-freeze-id": "a".repeat(64) },
			payload: { content: "不能伪造可回收批次", attachments: [{ filename: "forged.txt", data: "eA==" }] },
		});
		assert.equal(forged.statusCode, 400, forged.body);
		assert.match(forged.body, /只能由内部请求指定/);
		assert.deepEqual(readdirSync(path.join(dir, "uploads", "rejected")), []);
	} finally { await app.close(); }
});

test("准入失败若仍出现新增 user，则保留可能已被引用的冻结附件", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-uncertain-uploads-"));
	const uploads = new UploadStore(path.join(dir, "uploads"));
	await uploads.init();
	const session = {
		messages: [] as Array<{ role: string }>,
		prompt: async (_text: string, options: { preflightResult: (accepted: boolean) => void }) => {
			session.messages.push({ role: "user" });
			options.preflightResult(false);
			throw new Error("模型准入失败");
		},
	};
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, { open: async () => session } as unknown as PiSessionStore, undefined, undefined, uploads);
	try {
		const response = await app.inject({
			method: "POST", url: "/api/sessions/uncertain/messages",
			payload: { content: "读取附件", attachments: [{ filename: "evidence.txt", data: Buffer.from("evidence").toString("base64") }] },
		});
		assert.equal(response.statusCode, 400, response.body);
		assert.equal(readdirSync(path.join(dir, "uploads", "uncertain")).length, 1);
	} finally { await app.close(); }
});

test("停驻项目的 Session 拒绝消息写入，切回前不会误用当前项目 cwd", async () => {
	const { app, sessions, teams } = await makeStack();
	const solo = await teams.ensureSoloWindow(
		(workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
		async (id) => (await sessions.list()).some((session) => session.id === id),
	);
	const workspace = await teams.workspaces.createManaged("parked-chat");
	const target = await teams.contextForWorkspace(workspace.id);
	const targetSession = await sessions.create(undefined, {
		type: "solo",
		members: [],
		workspaceId: workspace.id,
		cwd: target.cwdSnapshot,
	});
	await teams.replaceWindowWorkspace(solo.id, workspace.id, targetSession.id, solo);

	const res = await app.inject({
		method: "POST",
		url: `/api/sessions/${solo.activeSession}/messages`,
		payload: { content: "不应写入未激活项目" },
	});
	assert.equal(res.statusCode, 409, res.body);
	assert.deepEqual(res.json(), { error: "session_context_inactive" });
	await sessions.sendCustomMessage(
		solo.activeSession,
		{ customType: "pudding:late_audit", content: "迟到终态只记审计" },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	assert.equal(sessions.isOpen(solo.activeSession), false, "parked 审计写入后必须卸载，不能驻留或唤醒模型");
	const persisted = (await sessions.list()).find((session) => session.id === solo.activeSession)!;
	assert.match(readFileSync(persisted.sessionFile, "utf8"), /pudding:late_audit/);
	await sessions.disposeAll();
	await app.close();
});

test("POST /abort 在服务端未确认运行时返回可见失败而非假成功", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const res = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(res.statusCode, 409, res.body);
	assert.deepEqual(res.json(), { aborted: false, reconciledToolResults: 0, error: "当前会话没有正在运行的任务" });
	await app.close();
});

test("Manager Stop 先推进 Goal epoch，迟到工具结果不能继续写 durable state", async () => {
	const { app, sessions, workStates } = await makeStack();
	const summary = await sessions.create();
	const goal = await workStates.create({
		sessionId: summary.id,
		goal: "stop fence",
		completionBoundary: "no late writes",
		operationId: "goal-before-stop",
	});
	const session = await sessions.open(summary.id);
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
	Object.defineProperty(session, "isIdle", { configurable: true, get: () => false });
	Object.defineProperty(session, "abort", { configurable: true, value: async () => undefined });

	const stopped = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(stopped.statusCode, 200, stopped.body);
	const interrupted = await workStates.getActive(summary.id);
	assert.equal(interrupted?.execution.status, "interrupted");
	assert.equal(interrupted?.execution.epoch, goal.execution.epoch + 1);
	await assert.rejects(
		() => workStates.update(summary.id, interrupted!.revision, { currentBrief: "late mutation" }, "late-tool", goal.execution.epoch, goal.goalId),
		/epoch 已变化/,
	);
	await app.close();
});

test("Manager abort 不响应时停止有服务端截止时间，随后刷新不被 repair queue 锁死", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
	Object.defineProperty(session, "isIdle", { configurable: true, get: () => false });
	Object.defineProperty(session, "abort", { configurable: true, value: () => new Promise<void>(() => undefined) });
	const startedAt = Date.now();
	const stop = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(stop.statusCode, 500, stop.body);
	assert.match((stop.json() as { error: string }).error, /停止 Manager 超时/);
	assert.ok(Date.now() - startedAt < 7_000, "服务端停止必须在 deadline 后返回");
	const refreshStartedAt = Date.now();
	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	assert.ok(Date.now() - refreshStartedAt < 1_000, "刷新不得等待已经超时的 abort promise");
	await app.close();
});

test("waiting_admission 刷新补回 needs_input，停止只取消 Teams 准入且不启动 Worker", async () => {
	const { app, sessions, runtime, dir } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	const assistant = {
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: "call-admission", name: "agent_claude-code__delegate", arguments: { task: "只读查询" } }],
		api: "openai", provider: "openai", model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(assistant as never);
	session.state.messages.push(assistant as never);
	await sessions.ensureSessionFile(summary.id);
	let driverStarted = false;
	const driver: AgentDriver = {
		id: "claude-code",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn", workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: [] } }; },
		async *run() { driverStarted = true; }, async *continue() {}, async *respond() {},
		async probe() { throw new Error("unused"); },
	};
	const pending = await runtime.delegate({
		cwdSnapshot: dir, windowId: "manager-window", managerSessionId: summary.id, managerToolCallId: "call-admission",
		agentId: driver.id, agentRevision: 0, message: "只读查询", mode: "run",
		workspaceExecutionPolicy: { mode: "read_only_shared", source: "manager_derived", reason: "只读", baselineStrategy: "filesystem_manifest", promoteOnAcceptance: false },
		driver,
	}, { cwd: dir, env: {} });
	assert.equal(pending.status, "needs_input");
	assert.equal(driverStarted, false);

	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	const recovered = (refreshed.json() as { messages: Array<{ role?: string; toolCallId?: string; details?: Record<string, unknown> }> }).messages
		.find((message) => message.role === "toolResult" && message.toolCallId === "call-admission");
	assert.equal(recovered?.details?.status, "needs_input");
	assert.equal(recovered?.details?.source, "platform_policy");
	assert.equal(recovered?.details?.workerStarted, false);

	const stopped = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(stopped.statusCode, 200, stopped.body);
	assert.equal(stopped.json().aborted, true);
	assert.equal((await runtime.getDelegation(pending.delegation.id))?.executionState, "cancelled");
	assert.equal((await runtime.getDelegation(pending.delegation.id))?.receipt?.workerStarted, false);
	assert.equal(driverStarted, false);
	await app.close();
});

test("并行工具一项失败后停止并刷新：原错误与 Delegation 终态都只持久化一次", async () => {
	const { app, sessions, teams, drivers, runtime, dir } = await makeStack();
	const summary = await sessions.create();
	await teams.ensureSoloWindow(async () => ({ id: summary.id }), async () => true);
	const session = await sessions.open(summary.id);
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "toolCall" as const, id: "call-bash", name: "bash", arguments: { command: "git branch --show-current" } },
			{ type: "toolCall" as const, id: "call-delegate", name: "agent_claude-code__delegate", arguments: { task: "查询分支" } },
		],
		api: "openai",
		provider: "openai",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(assistant as never);
	session.state.messages.push(assistant as never);
	await sessions.ensureSessionFile(summary.id);

	const driver: AgentDriver = {
		id: "claude-code",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" }; },
		async *run() {
			yield { type: "failed", result: { agentId: "claude-code", status: "failed", errorCode: "workspace_policy_blocked", error: "workspace policy denied", recoverable: true } };
		},
		async *continue() {},
		async *respond() {},
		async probe() { throw new Error("unused"); },
	};
	drivers.register(driver);
	await runtime.delegate({
		cwdSnapshot: dir,
		windowId: "manager-window",
		managerSessionId: summary.id,
		managerToolCallId: "call-delegate",
		agentId: driver.id,
		agentRevision: 0,
		message: "查询分支",
		mode: "run",
	}, { cwd: dir, env: {} });

	const emit = (sessions as unknown as { forwardEvent: (id: string, event: Record<string, unknown>) => void }).forwardEvent.bind(sessions);
	emit(summary.id, { type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "git branch --show-current" } });
	emit(summary.id, {
		type: "tool_execution_end",
		toolCallId: "call-bash",
		toolName: "bash",
		result: { content: [{ type: "text", text: "fatal: not a git repository" }], details: { exitCode: 128 } },
		isError: true,
	});

	let live = true;
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => live });
	Object.defineProperty(session, "isIdle", { configurable: true, get: () => !live });
	Object.defineProperty(session, "abort", { configurable: true, value: async () => { live = false; } });
	const stop = await app.inject({ method: "POST", url: `/api/sessions/${summary.id}/abort` });
	assert.equal(stop.statusCode, 200, stop.body);
	assert.deepEqual(stop.json(), { aborted: true, reconciledToolResults: 2 });
	assert.equal(await sessions.appendToolResultIfPending(summary.id, {
		toolCallId: "call-bash", toolName: "bash", text: "duplicate must not be appended", details: { exitCode: 999 },
	}), true);
	assert.equal(await sessions.appendToolResultIfPending(summary.id, {
		toolCallId: "call-bash", toolName: "bash", text: "duplicate must not be appended", details: { exitCode: 999 },
	}), true);

	await sessions.dispose(summary.id);
	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	const body = refreshed.json() as { messages: Array<{ role?: string; toolCallId?: string; content?: Array<{ text?: string }>; details?: Record<string, unknown> }> };
	const results = body.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.filter((message) => message.toolCallId === "call-bash").length, 1);
	assert.equal(results.filter((message) => message.toolCallId === "call-delegate").length, 1);
	assert.equal(results.find((message) => message.toolCallId === "call-bash")?.content?.[0]?.text, "fatal: not a git repository");
	assert.equal(results.find((message) => message.toolCallId === "call-delegate")?.details?.errorCode, "workspace_policy_blocked");
	await app.close();
});

test("并行普通工具刷新：已结束项回放原错误，未结束项保持 running", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	const session = await sessions.open(summary.id);
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "toolCall" as const, id: "call-failed", name: "bash", arguments: { command: "false" } },
			{ type: "toolCall" as const, id: "call-running", name: "bash", arguments: { command: "long-running" } },
		],
		api: "openai", provider: "openai", model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
	session.sessionManager.appendMessage(assistant as never);
	session.state.messages.push(assistant as never);
	const emit = (sessions as unknown as { forwardEvent: (id: string, event: Record<string, unknown>) => void }).forwardEvent.bind(sessions);
	emit(summary.id, { type: "tool_execution_start", toolCallId: "call-failed", toolName: "bash", args: { command: "false" } });
	emit(summary.id, { type: "tool_execution_start", toolCallId: "call-running", toolName: "bash", args: { command: "long-running" } });
	emit(summary.id, {
		type: "tool_execution_end", toolCallId: "call-failed", toolName: "bash", isError: true,
		result: { content: [{ type: "text", text: "exit 1" }], details: { exitCode: 1 } },
	});
	Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

	const refreshed = await app.inject({ method: "GET", url: `/api/sessions/${summary.id}/messages` });
	assert.equal(refreshed.statusCode, 200, refreshed.body);
	const body = refreshed.json() as {
		messages: Array<{ role?: string; toolCallId?: string }>;
		runningToolCallIds: string[];
		recoveredToolResults: Array<{ toolCallId: string; text: string; isError: boolean }>;
	};
	assert.deepEqual(body.runningToolCallIds, ["call-running"]);
	assert.deepEqual(body.recoveredToolResults, [{ toolCallId: "call-failed", toolName: "bash", text: "exit 1", details: { exitCode: 1 }, isError: true }]);
	assert.equal(body.messages.some((message) => message.role === "toolResult"), false, "streaming 时不得抢先写原生 toolResult");
	await app.close();
});

test("GET /api/sessions/:id/messages 对非「不存在」错误保持 500 穿透", async () => {
	const app = Fastify({ logger: false });
	await app.register(websocket);
	const broken = {
		open: async () => {
			throw new Error("disk exploded");
		},
	} as unknown as PiSessionStore;
	await registerChatRoutes(app, broken);
	const res = await app.inject({ method: "GET", url: "/api/sessions/x/messages" });
	assert.equal(res.statusCode, 500, res.body);
	await app.close();
});

test("消息入口把 Workspace 外绝对文件冻结为会话附件，外部目录拒绝隐式挂载", async () => {
	const { teams, dir } = await makeStack();
	const sessionId = "freeze-session";
	await teams.createWindow({ type: "direct", members: ["puddingclaw"], sessionId });
	const sourceRoot = mkdtempSync(path.join(tmpdir(), "pt-chat-external-"));
	const source = path.join(sourceRoot, "notes.txt");
	writeFileSync(source, "frozen-content", "utf-8");
	let received = "";
	const fakeSession = {
		messages: [],
		prompt: async (text: string, options: { preflightResult: (accepted: boolean) => void }) => {
			received = text;
			options.preflightResult(true);
		},
	};
	const fakeStore = {
		open: async () => fakeSession,
		generateSessionTitle: async () => undefined,
	} as unknown as PiSessionStore;
	const uploads = new UploadStore(path.join(dir, "uploads"));
	await uploads.init();
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, fakeStore, teams, undefined, uploads);
	const fileResponse = await app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/messages`,
		payload: { content: `读取 \`${source}\`` },
	});
	assert.equal(fileResponse.statusCode, 200, fileResponse.body);
	assert.ok(!received.includes(source), "模型输入不得继续引用可变的 Workspace 外源文件");
	assert.match(received, /uploads\/freeze-session\//);
	const frozenPath = (fileResponse.json() as { attachments: Array<{ path: string }> }).attachments[0]!.path;
	assert.equal(readFileSync(frozenPath, "utf-8"), "frozen-content");

	const directoryResponse = await app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/messages`,
		payload: { content: `读取目录 \`${sourceRoot}\`` },
	});
	assert.equal(directoryResponse.statusCode, 400, directoryResponse.body);
	assert.match(directoryResponse.body, /登记为 Workspace|临时挂载/);
	const missingResponse = await app.inject({
		method: "POST",
		url: `/api/sessions/${sessionId}/messages`,
		payload: { content: "读取 `/definitely/not/a/real/puddingteams-file.txt`" },
	});
	assert.equal(missingResponse.statusCode, 400, missingResponse.body);
	assert.match(missingResponse.body, /不存在或不可访问/);
	await app.close();
});

test("WS 连接不存在的 Session 以 4404 关闭（前端据此停止重连）", async () => {
	const { app } = await makeStack();
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	assert(address && typeof address === "object");
	const closeCode = await new Promise<number>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/sessions/does-not-exist/ws`);
		ws.onclose = (ev) => resolve(ev.code);
		ws.onerror = () => reject(new Error("ws error before close"));
		setTimeout(() => reject(new Error("timed out waiting for ws close")), 5000);
	});
	assert.equal(closeCode, 4404);
	await app.close();
});

test("WS session_ready 后可立即接收 Session 投影事件", async () => {
	const { app, sessions } = await makeStack();
	const summary = await sessions.create();
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	assert(address && typeof address === "object");
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/sessions/${summary.id}/ws`);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for session_ready projection")), 5000);
			let ready = false;
			ws.onmessage = (frame) => {
				try {
					const event = JSON.parse(String(frame.data)) as { type?: string; message?: { customType?: string } };
					if (event.type === "session_ready") {
						ready = true;
						void sessions.appendCustomMessageProjection(summary.id, { customType: "pudding:task_assign", content: "ready fixture" }).catch(reject);
					} else if (event.type === "message_start" && event.message?.customType === "pudding:task_assign") {
						assert.equal(ready, true);
						clearTimeout(timer);
						resolve();
					}
				} catch (error) { clearTimeout(timer); reject(error); }
			};
			ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error before projection")); };
		});
	} finally {
		if (ws.readyState === WebSocket.OPEN) {
			await new Promise<void>((resolve) => { ws.onclose = () => resolve(); ws.close(); });
		}
		await sessions.disposeAll();
		await app.close();
	}
});

test("POST /api/sessions/:id/thinking-level 设置会话级档位并拒绝非法值", async () => {
	const { app, sessions, teams } = await makeStack();
	try {
		const solo = await teams.ensureSoloWindow(
			(workspaceId, cwd) => sessions.create(undefined, { type: "solo", members: [], workspaceId, cwd }),
			async (id) => (await sessions.list()).some((session) => session.id === id),
		);
		await sessions.ensureSessionFile(solo.activeSession);

		const missing = await app.inject({ method: "POST", url: `/api/sessions/${solo.activeSession}/thinking-level`, payload: {} });
		assert.equal(missing.statusCode, 400, missing.body);

		const invalid = await app.inject({ method: "POST", url: `/api/sessions/${solo.activeSession}/thinking-level`, payload: { thinkingLevel: "ultra" } });
		assert.equal(invalid.statusCode, 400, invalid.body);

		const applied = await app.inject({ method: "POST", url: `/api/sessions/${solo.activeSession}/thinking-level`, payload: { thinkingLevel: "high" } });
		assert.equal(applied.statusCode, 200, applied.body);
		assert.equal(typeof applied.json().thinkingLevel, "string");
		// 非法值不得改变会话状态（只有成功响应才带确认值）。
		assert.equal(invalid.json().thinkingLevel, undefined);
	} finally {
		await sessions.disposeAll();
		await app.close();
	}
});
