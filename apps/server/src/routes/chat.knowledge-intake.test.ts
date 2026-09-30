import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import { MessageSubmissionOperations } from "../store/message-submission-operations.js";
import { KnowledgeSourceStore } from "../knowledge/sources.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { ChatKnowledgeIntake } from "../knowledge/chat-intake.js";
import { registerChatRoutes } from "./chat.js";
import { localViewerIdentity } from "./identity.js";

for (const command of ["/skill:record", "/record"]) test(`Manager HTTP ${command} 可信展开接收；提前未落盘事件不误确认，原话/重放不重复`, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-chat-knowledge-http-"));
	const app = Fastify({ logger: false }); await app.register(websocket);
	const sources = new KnowledgeSourceStore({ stateDir: root, objects: new KnowledgeObjectStore(path.join(root, "objects")) });
	const intake = new ChatKnowledgeIntake({ stateDir: root, sources }), sessionId = "session";
	const original = `${command} 用户原话10月23日`, expanded = "\n<skill>可信技能展开正文</skill>\n用户原话10月23日\n";
	const branch: unknown[] = [], listeners = new Set<(event: unknown) => void>(); let calls = 0;
	const session = { sessionId, sessionFile: path.join(root, "session.jsonl"), messages: [], promptTemplates: [{ name: "record" }], sessionManager: { getBranch: () => branch },
		prompt: async (_text: string, options: { preflightResult(accepted: boolean): void }) => {
			calls++;
			for (const listener of listeners) listener({ type: "message_end", message: { role: "user", content: [{ type: "text", text: original }] } });
			await Promise.resolve(); // A missing durable entry must not resolve the waiter with undefined.
			intake.observeExecution(sessionId, expanded, []);
			const message = { role: "user", content: [{ type: "text", text: expanded }] };
			branch.push({ id: "accepted-user", type: "message", message });
			for (const listener of listeners) listener({ type: "message_end", message });
			writeFileSync(session.sessionFile, branch.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
			await intake.admitManager(session as unknown as AgentSession); options.preflightResult(true);
		} };
	const store = { open: async () => session, generateSessionTitle: async () => {}, subscribe: (_id: string, listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		appendMessageAdmission: async (_id: string, details: unknown) => appendFileSync(session.sessionFile, JSON.stringify({ id: "admission", type: "custom_message", customType: "pudding:message_admission", display: false, details }) + "\n") } as unknown as PiSessionStore;
	const teams = { contextForSession: async () => ({ active: true, window: { id: "window" }, workspaceId: "workspace", cwdSnapshot: root }), windowForSession: async () => ({ type: "solo" }) } as unknown as TeamsStore;
	try {
		await registerChatRoutes(app, store, teams, undefined, undefined, undefined, undefined, undefined, new MessageSubmissionOperations(path.join(root, "operations")), intake);
		const post = () => app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, headers: { "idempotency-key": "accepted-operation" }, payload: { content: original } });
		const first = await post(); assert.equal(first.statusCode, 200, first.body);
		const replay = await post(); assert.equal(replay.statusCode, 200, replay.body); assert.equal(calls, 1);
		branch.push({ id: "assistant", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "curate" }] } });
		const refs = await intake.resolve(session as unknown as AgentSession, localViewerIdentity().user.id, { toolCallId: "curate" });
		assert.equal(refs.sourceIds.length, 1); assert.equal((await sources.readText(localViewerIdentity().user.id, refs.sourceIds[0]!)).text, original);
	} finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
