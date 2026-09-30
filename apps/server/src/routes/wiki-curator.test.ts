import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerWikiCuratorRoutes } from "./wiki-curator.js";
import { localViewerIdentity } from "./identity.js";
import type { CuratorJob } from "../knowledge/curator-jobs.js";

test("curator POST只接声明的用户输入，不接受伪造origin/sourceText/owner", async () => {
	const app = Fastify(), captured: unknown[] = [];
	const job = { id: "job", status: "queued" } as CuratorJob;
	registerWikiCuratorRoutes(app, {
		service: { create: async (input: unknown) => { captured.push(input); return { job, replayed: false }; } },
	} as unknown as Parameters<typeof registerWikiCuratorRoutes>[1]);
	try {
		const response = await app.inject({ method: "POST", url: "/api/wiki/curator-jobs", payload: {
			operationId: "op", bindingId: "binding", agentId: "wiki", task: "用户整理指令", ownerId: "other",
			origin: { sessionId: "forged", windowId: "forged" }, sourceText: "伪造用户原话",
		} });
		assert.equal(response.statusCode, 202);
		assert.deepEqual(captured, [{ operationId: "op", bindingId: "binding", agentId: "wiki", task: "用户整理指令", uploads: undefined, ownerId: localViewerIdentity().user.id }]);
	} finally { await app.close(); }
});

test("curator取消核owner和可见库，提交已获胜返回409", async () => {
	const app = Fastify(), calls: string[] = [], ownerId = localViewerIdentity().user.id;
	let job = { id: "job", ownerId, targetBindingId: "binding", status: "running" } as CuratorJob;
	let visible = true;
	registerWikiCuratorRoutes(app, {
		jobs: { get: async () => job }, bindings: { list: async () => visible ? [{ id: "binding" }] : [] },
		service: { cancel: async (owner: string, id: string) => { calls.push(`${owner}:${id}`); throw new Error("整理任务状态已变化"); } },
	} as unknown as Parameters<typeof registerWikiCuratorRoutes>[1]);
	try {
		const url = "/api/wiki/curator-jobs/job/cancel";
		job = { ...job, ownerId: "other" }; assert.equal((await app.inject({ method: "POST", url })).statusCode, 404);
		job = { ...job, ownerId }; visible = false; assert.equal((await app.inject({ method: "POST", url })).statusCode, 404);
		assert.deepEqual(calls, []);
		visible = true; assert.equal((await app.inject({ method: "POST", url })).statusCode, 409);
		assert.deepEqual(calls, [`${ownerId}:job`]);
	} finally { await app.close(); }
});
