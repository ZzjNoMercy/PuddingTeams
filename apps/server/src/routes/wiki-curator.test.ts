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

test("整理详情保留submitting状态、宿主深链及安全诊断并保持owner权限", async () => {
 const app = Fastify(), ownerId = localViewerIdentity().user.id;
 let job = { id: "job", ownerId, targetBindingId: "binding", status: "submitting", diagnostics: { modelTurns: 2, submitAttempts: 1, submitErrors: 0, modelId: "fixture" } } as CuratorJob;
 registerWikiCuratorRoutes(app, { jobs: { get: async () => job }, bindings: { list: async () => [{ id: "binding" }] } } as unknown as Parameters<typeof registerWikiCuratorRoutes>[1]);
 try {
  const response = await app.inject({ method: "GET", url: "/api/wiki/curator-jobs/job" }); assert.equal(response.statusCode, 200);
  const dto = response.json().job; assert.equal(dto.status, "submitting"); assert.equal(dto.jobUrl, "/knowledge?vault=binding&job=job"); assert.equal(dto.reviewUrl, undefined); assert.deepEqual(dto.diagnostics, job.diagnostics);
  job = { ...job, status: "failed", failureCode: "model_timeout", diagnostics: { ...job.diagnostics!, stopReason: "aborted", errorCategory: "timeout" } };
  const failed = (await app.inject({ method: "GET", url: "/api/wiki/curator-jobs/job" })).json().job;
  assert.equal(failed.status, "failed"); assert.equal(failed.failureCode, "model_timeout"); assert.equal(failed.diagnostics.errorCategory, "timeout");
  job = { ...job, ownerId: "other" }; assert.equal((await app.inject({ method: "GET", url: "/api/wiki/curator-jobs/job" })).statusCode, 404);
 } finally { await app.close(); }
});

test("material是声明的用户素材，要求单独保留且不接受伪造authority", async () => {
	const app=Fastify(),captured:unknown[]=[];
	registerWikiCuratorRoutes(app,{service:{create:async(input:unknown)=>{captured.push(input);return {job:{id:"job",status:"queued",sources:[]} as unknown as CuratorJob};}}} as unknown as Parameters<typeof registerWikiCuratorRoutes>[1]);
	try { const r=await app.inject({method:"POST",url:"/api/wiki/curator-jobs",payload:{operationId:"op",bindingId:"v",agentId:"wiki",task:"要求",material:"  原文\n保留换行  ",sourceText:"伪造",ownerId:"other",origin:{sessionId:"forged"},sourceIds:["forged"],executionMode:"worker"}});assert.equal(r.statusCode,202);assert.deepEqual(captured,[{operationId:"op",bindingId:"v",agentId:"wiki",task:"要求",sourceText:"  原文\n保留换行  ",uploads:undefined,ownerId:localViewerIdentity().user.id}]);
		assert.equal((await app.inject({method:"POST",url:"/api/wiki/curator-jobs",payload:{operationId:"op",bindingId:"v",agentId:"wiki",task:"要求",material:""}})).statusCode,400);
	} finally {await app.close();}
});

test("global/scoped task queries authorize before counts, search, sorting and pagination",async()=>{
	const app=Fastify(),ownerId=localViewerIdentity().user.id;
	const jobs=[{id:"one",ownerId,targetBindingId:"v1",status:"pending_review",candidateBatchId:"b",task:"不要显示工程长指令",sources:[{kind:"text",title:"会面",origin:{channel:"user_input"}}],createdAt:"2026-10-01T01:00:00Z",updatedAt:"2026-10-01T01:00:00Z"},{id:"two",ownerId,targetBindingId:"v2",status:"queued",sources:[],createdAt:"2026-10-01T02:00:00Z",updatedAt:"2026-10-01T02:00:00Z"},{id:"hidden",ownerId,targetBindingId:"hidden",status:"queued",sources:[],updatedAt:"2026-10-03T01:00:00Z"}];
	let status="published";
	registerWikiCuratorRoutes(app,{jobs:{list:async()=>jobs},bindings:{list:async()=>[{id:"v1",name:"人脉"},{id:"v2",name:"研究"}]},reviews:{get:async()=>({ownerId,status,updatedAt:"2026-10-02T01:00:00Z",batch:{id:"b",bindingId:"v1",files:[]}})}} as unknown as Parameters<typeof registerWikiCuratorRoutes>[1]);
	try {const all=(await app.inject({method:"GET",url:"/api/wiki/curator-jobs?limit=1"})).json();assert.equal(all.total,2);assert.equal(all.jobs[0].id,"one");assert.equal(all.counts.active,1);assert.equal(all.counts.ended,1);assert.equal(all.jobs.length,1);
		const page=(await app.inject({method:"GET",url:"/api/wiki/curator-jobs?offset=1&limit=1"})).json();assert.equal(page.jobs[0].id,"two");
		assert.equal((await app.inject({method:"GET",url:"/api/wiki/curator-jobs?bindingId=v1&group=pending"})).json().total,0);
		status="pending_review";assert.equal((await app.inject({method:"GET",url:"/api/wiki/curator-jobs?bindingId=v1&group=pending&q=%E4%BC%9A%E9%9D%A2"})).json().total,1);
		assert.equal((await app.inject({method:"GET",url:"/api/wiki/curator-jobs?bindingId=hidden"})).json().total,0);
		for(const query of ["limit=0","limit=101","offset=-1","since=bad","group=bad"])assert.equal((await app.inject({method:"GET",url:`/api/wiki/curator-jobs?${query}`})).statusCode,400);
	}finally{await app.close();}
});
