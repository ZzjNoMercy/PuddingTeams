import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { UploadStore } from "../store/uploads.js";
import type { TeamsStore } from "../store/teams.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { MessageSubmissionOperations } from "../store/message-submission-operations.js";
import { directTaskId } from "../agent-runtime/direct-dispatch.js";
import { registerChatRoutes } from "./chat.js";

test("ordinary pi message key replays accepted after response loss and restart without a second user", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-chat-operation-"));
	const operationsDir = path.join(dir, "operations");
	const sessionFile = path.join(dir, "session.jsonl");
	const branch: Array<{ type: "message"; id: string; message: { role: "user"; content: Array<{ type: "text"; text: string }> } }> = [];
	const listeners = new Set<(event: { type: "message_end"; message: { role: "user"; content: Array<{ type: "text"; text: string }> } }) => void>();
	let promptCalls = 0;
	const session = {
		messages: [{ role: "user" }],
		sessionFile,
		sessionManager: { getBranch: () => branch },
		prompt: async (text: string, options: { preflightResult: (accepted: boolean) => void }) => {
			promptCalls += 1;
			const message = { role: "user" as const, content: [{ type: "text" as const, text }] };
			const entry = { type: "message" as const, id: randomUUID(), message };
			branch.push(entry);
			for (const listener of listeners) listener({ type: "message_end", message });
			writeFileSync(sessionFile, `${branch.map((item) => JSON.stringify(item)).join("\n")}\n`);
			options.preflightResult(true);
		},
	};
	const store = {
		open: async () => session,
		subscribe: (_id: string, listener: (event: { type: "message_end"; message: { role: "user"; content: Array<{ type: "text"; text: string }> } }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		appendMessageAdmission: async (_id: string, facts: { operationId: string; requestHash: string; contextHash: string; userEntryId: string }) => {
			assert.ok(branch.some((entry) => entry.id === facts.userEntryId));
			appendFileSync(sessionFile, `${JSON.stringify({ type: "custom_message", id: randomUUID(), customType: "pudding:message_admission", display: false, details: facts })}\n`);
		},
	} as unknown as PiSessionStore;
	const makeApp = async () => {
		const app = Fastify({ logger: false });
		await app.register(websocket);
		await registerChatRoutes(app, store, undefined, undefined, undefined, undefined, undefined, undefined, new MessageSubmissionOperations(operationsDir));
		return app;
	};
	const key = randomUUID();
	const post = (app: Awaited<ReturnType<typeof makeApp>>, content: string, operationKey = key) => app.inject({ method: "POST", url: "/api/sessions/existing/messages", headers: { "idempotency-key": operationKey }, payload: { content } });
	const firstApp = await makeApp();
	try {
		const missing = await firstApp.inject({ method: "POST", url: "/api/sessions/existing/messages", payload: { content: "hello" } });
		assert.equal(missing.statusCode, 428);
		const first = await post(firstApp, "hello");
		assert.equal(first.statusCode, 200, first.body);
		assert.equal(promptCalls, 1);
		const replay = await post(firstApp, "hello");
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(promptCalls, 1);
		const conflict = await post(firstApp, "different");
		assert.equal(conflict.statusCode, 409);
		assert.equal(conflict.json().code, "message_operation_conflict");
	} finally { await firstApp.close(); }
	const ledgerFile = path.join(operationsDir, `${createHash("sha256").update(key).digest("hex")}.json`);
	const ledger = JSON.parse(readFileSync(ledgerFile, "utf8")) as { state: string };
	writeFileSync(ledgerFile, `${JSON.stringify({ ...ledger, state: "reserved" })}\n`);
	const restartedApp = await makeApp();
	try {
		const replay = await post(restartedApp, "hello");
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(promptCalls, 1);
		assert.equal(branch.length, 1);
		assert.equal((JSON.parse(readFileSync(ledgerFile, "utf8")) as { state: string }).state, "accepted");
		const missingMarkerKey = randomUUID();
		const requestHash = createHash("sha256").update(JSON.stringify({ content: "hello", attachments: [] })).digest("hex");
		const contextHash = createHash("sha256").update(JSON.stringify({ windowId: null, workspaceId: null, cwdSnapshot: null })).digest("hex");
		assert.equal(await new MessageSubmissionOperations(operationsDir).reserve(missingMarkerKey, "existing", requestHash, contextHash), "new");
		const missing = await post(restartedApp, "hello", missingMarkerKey);
		assert.equal(missing.statusCode, 409);
		assert.equal(missing.json().code, "message_delivery_unconfirmed");
		assert.equal(promptCalls, 1);
	} finally { await restartedApp.close(); }
});

test("missing absolute path is a durable preflight rejection, not an uncertain delivery", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-message-preflight-reject-"));
	const operationsDir = path.join(dir, "operations");
	let opened = 0;
	const store = { open: async () => { opened++; throw new Error("must not open a session"); } } as unknown as PiSessionStore;
	const makeApp = async () => {
		const app = Fastify({ logger: false });
		await app.register(websocket);
		await registerChatRoutes(app, store, undefined, undefined, undefined, undefined, undefined, undefined, new MessageSubmissionOperations(operationsDir));
		return app;
	};
	const key = randomUUID();
	const content = `读取 ${path.join(dir, "missing.txt")}`;
	const send = (app: Awaited<ReturnType<typeof makeApp>>, body = content) => app.inject({
		method: "POST", url: "/api/sessions/existing/messages", headers: { "idempotency-key": key }, payload: { content: body },
	});
	const firstApp = await makeApp();
	try {
		const first = await send(firstApp);
		assert.equal(first.statusCode, 400, first.body);
		assert.equal(first.json().code, "message_operation_rejected");
	} finally { await firstApp.close(); }
	const restartedApp = await makeApp();
	try {
		const replay = await send(restartedApp);
		assert.equal(replay.statusCode, 400, replay.body);
		assert.equal(replay.json().code, "message_operation_rejected");
		const changed = await send(restartedApp, "changed");
		assert.equal(changed.statusCode, 409);
		assert.equal(changed.json().code, "message_operation_conflict");
		assert.equal(opened, 0);
	} finally { await restartedApp.close(); }
});

test("malformed attachment is rejected before freezing, while a freeze failure stays unconfirmed", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-message-upload-boundary-"));
	let freezes = 0;
	const uploads = { saveWithLocalFiles: async () => { freezes++; throw new Error("freeze interrupted"); } } as unknown as UploadStore;
	const store = { open: async () => { throw new Error("must not prompt"); } } as unknown as PiSessionStore;
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, store, undefined, undefined, uploads, undefined, undefined, undefined,
		new MessageSubmissionOperations(path.join(dir, "operations")));
	try {
		const invalid = () => app.inject({ method: "POST", url: "/api/sessions/existing/messages", headers: { "idempotency-key": "invalid-upload-12345" },
			payload: { content: "hello", attachments: [{ filename: "bad.txt", data: "!" }] } });
		assert.equal((await invalid()).json().code, "message_operation_rejected");
		assert.equal((await invalid()).json().code, "message_operation_rejected");
		assert.equal(freezes, 0);
		const interrupted = () => app.inject({ method: "POST", url: "/api/sessions/existing/messages", headers: { "idempotency-key": "freeze-failed-12345" },
			payload: { content: "hello", attachments: [{ filename: "ok.txt", data: "aGVsbG8=" }] } });
		assert.equal((await interrupted()).json().code, "message_delivery_unconfirmed");
		assert.equal((await interrupted()).json().code, "message_delivery_unconfirmed");
		assert.equal(freezes, 1);
	} finally { await app.close(); }
});

test("direct message key does not write a second user card or dispatch a second Worker", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-direct-operation-"));
	const operationsDir = path.join(dir, "operations");
	const cards: string[] = [];
	let delegations = 0;
	let workspaceId = "workspace";
	let sessionContextPresent = true;
	const teams = {
		contextForSession: async () => sessionContextPresent ? { active: true, cwdSnapshot: dir, workspaceId, window: { id: "direct-window" } } : undefined,
		windowForSession: async () => ({ id: "direct-window", type: "direct", members: ["worker"], cwdSnapshot: dir, workspaceId: "workspace" }),
		getAgent: async () => ({ name: "worker", pinned: false, invoke: { type: "codex" } }),
	} as unknown as TeamsStore;
	let lifecycleTail = Promise.resolve();
	const withLifecycle = async (_id: string, action: () => Promise<unknown>) => {
		const prior = lifecycleTail;
		let release!: () => void;
		lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
		await prior;
		try { return await action(); }
		finally { release(); }
	};
	const invoker = {
		withActiveSessionLifecycle: withLifecycle,
		requireAgent: async () => ({ name: "worker" }),
		delegate: async (params: { onDelegationCreated?: (record: unknown) => void }) => {
			delegations += 1;
			await withLifecycle("direct-session", async () => { params.onDelegationCreated?.({ id: "delegation-1" }); });
			return new Promise(() => undefined);
		},
	} as unknown as AgentInvoker;
	const store = {
		open: async () => ({ messages: [{ role: "user" }] }),
		workerRuntimeModel: async () => ({}),
		sendCustomMessage: async (_id: string, message: { customType: string }) => { cards.push(message.customType); },
		sendCustomMessageDurable: async (_id: string, message: { customType: string }) => { cards.push(message.customType); },
		sessionName: async () => "Direct",
	} as unknown as PiSessionStore;
	const makeApp = async () => {
		const app = Fastify({ logger: false });
		await app.register(websocket);
		await registerChatRoutes(app, store, teams, undefined, undefined, invoker, undefined, undefined, new MessageSubmissionOperations(operationsDir));
		return app;
	};
	const key = randomUUID();
	const send = (app: Awaited<ReturnType<typeof makeApp>>) => app.inject({ method: "POST", url: "/api/sessions/direct-session/messages", headers: { "idempotency-key": key }, payload: { content: "让 Worker 执行" } });
	const firstApp = await makeApp();
	try {
		const first = await send(firstApp);
		assert.equal(first.statusCode, 200, first.body);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(cards, ["pudding:user_message", "pudding:task_assign"]);
		assert.equal(delegations, 1);
		const replay = await send(firstApp);
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(cards.length, 2);
		assert.equal(delegations, 1);
	} finally { await firstApp.close(); }
	const restartedApp = await makeApp();
	try {
		const replay = await send(restartedApp);
		assert.equal(replay.statusCode, 200, replay.body);
		assert.equal(cards.length, 2);
		assert.equal(delegations, 1);
		workspaceId = "another-workspace";
		const moved = await send(restartedApp);
		assert.equal(moved.statusCode, 409);
		assert.equal(moved.json().code, "message_operation_conflict");
		workspaceId = "workspace";
		sessionContextPresent = false;
		const orphaned = await send(restartedApp);
		assert.equal(orphaned.statusCode, 400);
		assert.equal(cards.length, 2);
		assert.equal(delegations, 1);
	} finally { await restartedApp.close(); }
});

test("direct card persistence failure leaves the operation unconfirmed and never dispatches", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-direct-failed-card-"));
	let writes = 0;
	let delegations = 0;
	const teams = {
		contextForSession: async () => ({ active: true, cwdSnapshot: dir, workspaceId: "workspace", window: { id: "direct-window" } }),
		windowForSession: async () => ({ id: "direct-window", type: "direct", members: ["worker"] }),
		getAgent: async () => ({ name: "worker", pinned: false, invoke: { type: "codex" } }),
	} as unknown as TeamsStore;
	const invoker = {
		withActiveSessionLifecycle: async (_id: string, action: () => Promise<unknown>) => action(),
		requireAgent: async () => ({ name: "worker" }),
		delegate: async () => { delegations += 1; return new Promise(() => undefined); },
	} as unknown as AgentInvoker;
	const store = {
		open: async () => ({ messages: [{ role: "user" }] }),
		workerRuntimeModel: async () => ({}),
		sendCustomMessageDurable: async () => { writes += 1; throw new Error("JSONL write failed"); },
	} as unknown as PiSessionStore;
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, store, teams, undefined, undefined, invoker, undefined, undefined, new MessageSubmissionOperations(path.join(dir, "operations")));
	try {
		const request = () => app.inject({ method: "POST", url: "/api/sessions/direct-session/messages", headers: { "idempotency-key": "failed-card-12345678" }, payload: { content: "任务" } });
		const first = await request();
		assert.equal(first.statusCode, 409);
		assert.equal(first.json().code, "message_delivery_unconfirmed");
		const retry = await request();
		assert.equal(retry.statusCode, 409);
		assert.equal(retry.json().code, "message_delivery_unconfirmed");
		assert.equal(writes, 1);
		assert.equal(delegations, 0);
	} finally { await app.close(); }
});

test("restart recovers a reserved direct operation only from matching JSONL cards and Delegation", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-direct-recover-"));
	const operationsDir = path.join(dir, "operations");
	const sessionFile = path.join(dir, "direct.jsonl");
	const sessionId = "direct-session";
	const windowId = "direct-window";
	const workspaceId = "workspace";
	const content = "重启后核对";
	const requestHash = createHash("sha256").update(JSON.stringify({ content, attachments: [] })).digest("hex");
	const contextHash = createHash("sha256").update(JSON.stringify({ windowId, workspaceId, cwdSnapshot: dir })).digest("hex");
	const acceptedKey = randomUUID();
	const missingCardKey = randomUUID();
	const firstProcess = new MessageSubmissionOperations(operationsDir);
	assert.equal(await firstProcess.reserve(acceptedKey, sessionId, requestHash, contextHash), "new");
	assert.equal(await firstProcess.reserve(missingCardKey, sessionId, requestHash, contextHash), "new");
	const taskId = directTaskId(acceptedKey);
	writeFileSync(sessionFile, [
		{ type: "custom_message", id: "user", display: true, customType: "pudding:user_message", content, details: { operationId: acceptedKey, windowId } },
		{ type: "custom_message", id: "assign", display: true, customType: "pudding:task_assign", content, details: { operationId: acceptedKey, taskId, windowId, worker: "worker", from: "direct", status: "running" } },
	].map((item) => JSON.stringify(item)).join("\n") + "\n");
	const delegations = [acceptedKey, missingCardKey].map((operationId) => ({
		operationId, managerSessionId: sessionId, managerToolCallId: directTaskId(operationId), windowId, workspaceId,
		cwdSnapshot: dir, agentId: "worker", purpose: "execution",
	}));
	const teams = {
		contextForSession: async () => ({ active: true, cwdSnapshot: dir, workspaceId, window: { id: windowId } }),
		windowForSession: async () => ({ id: windowId, type: "direct", members: ["worker"] }),
		getAgent: async () => ({ name: "worker", pinned: false, invoke: { type: "codex" } }),
	} as unknown as TeamsStore;
	let writes = 0;
	let dispatches = 0;
	const store = {
		open: async () => ({ sessionFile, messages: [] }),
		sendCustomMessageDurable: async () => { writes += 1; },
	} as unknown as PiSessionStore;
	const invoker = {
		delegationsForManagerSession: async () => delegations,
		withActiveSessionLifecycle: async (_id: string, action: () => Promise<unknown>) => action(),
		requireAgent: async () => ({ name: "worker" }),
		delegate: async () => { dispatches += 1; return new Promise(() => undefined); },
	} as unknown as AgentInvoker;
	const app = Fastify({ logger: false });
	await app.register(websocket);
	await registerChatRoutes(app, store, teams, undefined, undefined, invoker, undefined, undefined, new MessageSubmissionOperations(operationsDir));
	try {
		const post = (key: string) => app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, headers: { "idempotency-key": key }, payload: { content } });
		const recovered = await post(acceptedKey);
		assert.equal(recovered.statusCode, 200, recovered.body);
		assert.equal(await new MessageSubmissionOperations(operationsDir).reserve(acceptedKey, sessionId, requestHash, contextHash), "accepted");
		const missing = await post(missingCardKey);
		assert.equal(missing.statusCode, 409);
		assert.equal(missing.json().code, "message_delivery_unconfirmed");
		assert.equal(writes, 0);
		assert.equal(dispatches, 0);
	} finally { await app.close(); }
});
