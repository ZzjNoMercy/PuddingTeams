import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { KnowledgeObservationService } from "../knowledge/observation.js";
import { KnowledgeSearchIndex } from "../knowledge/search-index.js";
import { KnowledgeSourceStore } from "../knowledge/sources.js";
import { ContactsProjection } from "../knowledge/contacts.js";
import { copySchemaPreset } from "../knowledge/schema-presets.js";
import { ReviewStore } from "../knowledge/wiki/review-store.js";
import { PublishJournal } from "../knowledge/wiki/publish-journal.js";
import { MarkdownWikiPublisher } from "../knowledge/wiki/publisher-markdown.js";
import { CalendarStore } from "./store.js";
import { CalendarService } from "./service.js";
import { calendarTools } from "./tools.js";
import { registerCalendarRoutes } from "../routes/calendar.js";
import { setInteractionStatus, type CalendarStatusSync, type InteractionStatusDeps } from "../knowledge/interaction-status.js";

const owner = "calendar-test-owner";
async function fixture() {
 const base = await mkdtemp(path.join(tmpdir(),"pt-calendar-people-")), root = path.join(base,"wiki");
 await mkdir(path.join(root,"People"),{recursive:true});
 await writeFile(path.join(root,"wiki.schema.json"),JSON.stringify(copySchemaPreset("people")));
 for (const [id,name] of [["a","日历人物甲"],["b","日历人物乙"],["c","仅被提及的人物"]]) await writeFile(path.join(root,`People/${id}.md`),`---\nid: ${id}\ntype: person\ntitle: ${name}\n---\n`);
 const bindings = new KnowledgeBindingRegistry(path.join(base,"bindings")), objects = new KnowledgeObjectStore(path.join(base,"objects")), acceptance = new KnowledgeAcceptanceStore(path.join(base,"accepted"));
 const binding = await bindings.create({ownerId:owner,name:"测试人脉",description:"隔离测试",rootPath:root});
 const reviews = new ReviewStore(path.join(base,"reviews")), journal = new PublishJournal(path.join(base,"operations"));
 const searchIndex = new KnowledgeSearchIndex(path.join(base,"cache"),objects), observation = new KnowledgeObservationService(acceptance,{objects,journal,searchIndex});
 const contacts = new ContactsProjection({bindings,objects,acceptance,observation,searchIndex}), sources = new KnowledgeSourceStore({stateDir:path.join(base,"sources"),objects});
 const store = new CalendarStore(path.join(base,"calendar")), service = new CalendarService(store,{contacts,bindings,objects,acceptance,observation,sources,reviews});
 const calendarSync: CalendarStatusSync = {
  get: async (ownerId,eventId) => { const event = await store.get(ownerId,eventId); return { revision: event.revision, status: event.status }; },
  setStatus: (ownerId,eventId,operationId,expectedRevision,status) => service.setStatus(ownerId,eventId,operationId,expectedRevision,status,{source:"wiki"}),
 };
 const statusDeps: InteractionStatusDeps = { bindings, observation, acceptance, calendar: calendarSync };
 service.setInteractionStatusSync((args) => setInteractionStatus(statusDeps, args, { source: "calendar" }));
 const publisher = new MarkdownWikiPublisher({bindings,objects,acceptance,observation,searchIndex,reviews,journal,operationsDir:path.join(base,"operations"),assertSourceCurrent:batch=>service.assertPublicationCurrent(batch)});
 const people = (await service.people(owner,"",binding.id)).sources[0]!.people;
 const input = {title:"北京饭局",description:"共同安排\n- involves: [[People/c]]",location:"北京",kind:"event",busy:true,timeZone:"Asia/Shanghai",allDay:false,start:"2026-10-05T20:00:00+08:00",end:"2026-10-05T21:00:00+08:00",participants:people.slice(0,2).map(p=>({bindingId:binding.id,personId:p.personId})),interaction:{bindingId:binding.id,kind:"meal"}};
 async function publish(batchId: string) { const r = (await reviews.get(batchId))!; const {decision} = await reviews.decide({batchId,operationId:`approve-${batchId}`,actorId:owner,decision:"approve",manifestHash:r.batch.manifestHash,reviewedFiles:r.batch.files.map(f=>f.targetPath)}); return publisher.onApproved(r.batch,decision); }
 return {base,root,bindings,binding,objects,acceptance,observation,contacts,reviews,store,service,publisher,input,people,publish};
}

test("calendar -> reviewed Wiki -> contacts graph: replay, cold reopen, reschedule, cancellation, no inferred completion",async()=>{
 const f=await fixture(); try {
  const first=await f.service.mutate(owner,"create",undefined,"create",0,f.input,[f.binding.id]);
  assert.equal(first.interactionState?.status,"pending_review");
  assert.deepEqual((await f.service.mutate(owner,"create",undefined,"create",0,f.input,[f.binding.id])).id,first.id);
  assert.equal((await f.reviews.list()).length,1);
  const file=first.interactionState!.path!;
  assert.equal(file,"Interactions/北京饭局.md");
  await assert.rejects(readFile(path.join(f.root,file)),{code:"ENOENT"});
  assert.equal((await new CalendarStore(path.join(f.base,"calendar")).get(owner,first.id)).participants?.length,2);
  const second=await f.service.mutate(owner,"update",first.id,"reschedule",1,{...f.input,start:"2026-10-06T20:00:00+08:00",end:"2026-10-06T21:00:00+08:00"},[f.binding.id]);
  await f.publish(first.interactionState!.batchId!);
  assert.equal((await f.reviews.get(first.interactionState!.batchId!))!.status,"conflict");
  await assert.rejects(readFile(path.join(f.root,file)),{code:"ENOENT"});
  await f.publish(second.interactionState!.batchId!);
  const publishedState = (await f.service.get(owner,first.id)).interactionState!;
  assert.equal(publishedState.status,"published"); assert.equal(new URL(publishedState.noteUrl!,"http://localhost").searchParams.get("note"),file);
  const text=await readFile(path.join(f.root,file),"utf8"); assert.match(text,/status: "planned"/); assert.match(text,/2026-10-06T12:00:00.000Z/);
  const graph=await f.contacts.load(owner,f.binding.id); assert.equal(graph.graphEdges.length,3); assert(graph.graphEdges.every(e=>e.plannedCount===1 && e.doneCount===0));
  assert(!graph.graphEdges.some(e=>[e.from,e.to].includes(f.people[2]!.personId)),"description cannot create extra participant evidence");
  const third=await f.service.mutate(owner,"update",first.id,"again",2,{...f.input,title:"更新的饭局"},[f.binding.id]);
  assert.equal(third.interactionState!.path,file); await f.publish(third.interactionState!.batchId!);
  const reviewCount=(await f.reviews.list()).length;
  const cancelled=await f.service.mutate(owner,"cancel",first.id,"cancel",3,undefined,[f.binding.id]);
  assert.equal(cancelled.status,"cancelled");
  assert.equal(cancelled.interactionState?.status,"published","取消后沿用已发布往来页的投影");
  assert.deepEqual(cancelled.wikiSync,{ok:true,path:file,changed:true});
  assert.equal((await f.reviews.list()).length,reviewCount,"取消不再生成审核候选");
  assert.match(await readFile(path.join(f.root,file),"utf8"),/status: "cancelled"/);
  assert.equal((await f.contacts.load(owner,f.binding.id)).graphEdges.length,0);
  const listed=await f.service.list(owner); assert.equal(listed.length,1,"已取消日程保留在日历中可见"); assert.equal(listed[0]!.status,"cancelled");
  const done=await f.service.setStatus(owner,first.id,"mark-done",4,"done",{scope:[f.binding.id]});
  assert.equal(done.status,"done"); assert.deepEqual(done.wikiSync,{ok:true,path:file,changed:true});
  const doneText=await readFile(path.join(f.root,file),"utf8"); assert.match(doneText,/status: "done"/); assert.match(doneText,/occurredAt: "2026-10-05T12:00:00.000Z"/);
  const replayed=await f.service.setStatus(owner,first.id,"mark-done",4,"done",{scope:[f.binding.id]});
  assert.equal(replayed.revision,done.revision,"operationId 幂等重放");
  await assert.rejects(f.service.setStatus(owner,first.id,"mark-done",4,"cancelled",{scope:[f.binding.id]}),{code:"operation_conflict"});
  const restored=await f.service.setStatus(owner,first.id,"restore",5,"confirmed",{scope:[f.binding.id]});
  assert.equal(restored.status,"confirmed");
  assert.match(await readFile(path.join(f.root,file),"utf8"),/status: "planned"/);
 } finally {await rm(f.base,{recursive:true,force:true});}
});

test("calendar preserves external Wiki edits/moves and reports partial success; no duplicate page",async()=>{
 const f=await fixture(); try {
  const first=await f.service.mutate(owner,"create",undefined,"create",0,f.input); await f.publish(first.interactionState!.batchId!);
  const file=path.join(f.root,first.interactionState!.path!), original=await readFile(file,"utf8"); await writeFile(file,`${original}\n用户在 Obsidian 添加的原文\n`);
  const next=await f.service.mutate(owner,"update",first.id,"change",1,{...f.input,title:"改期"});
  assert.equal(next.interactionState?.status,"needs_attention"); assert.match(next.interactionState!.message,/独立修改/);
  assert.equal((await f.store.get(owner,first.id)).title,"改期"); assert.equal(await readFile(file,"utf8"),`${original}\n用户在 Obsidian 添加的原文\n`);
  await assert.rejects(f.service.retry(owner,first.id),/独立修改/);
  await rename(file,path.join(f.root,"Interactions/moved.md"));
  const moved=await f.service.mutate(owner,"update",first.id,"change-moved",2,{...f.input,title:"改期二"});
  assert.equal(moved.interactionState?.status,"needs_attention"); assert.match(moved.interactionState!.message,/移动或删除/);
  await assert.rejects(readFile(file),{code:"ENOENT"});
 } finally {await rm(f.base,{recursive:true,force:true});}
});

test("calendar participant permissions, mounted scope and explicit identity; service/tool/API use same path",async()=>{
 const f=await fixture(); const app=Fastify(); registerCalendarRoutes(app,f.store,()=>owner,f.service); try {
  const tools=calendarTools(f.service,async()=>({ownerId:owner,bindingIds:[],assertCurrent:async()=>{}}));
  const create=tools.find(t=>t.name==="calendar_create_event")!;
  await assert.rejects(create.execute("id",{operationId:"bad",event:f.input},undefined,undefined,{} as never),/未在当前会话挂载/);
  assert.equal((await f.store.list(owner)).length,0);
  await assert.rejects(f.service.mutate(owner,"create",undefined,"forged",0,{...f.input,participants:[{bindingId:f.binding.id,personId:"f".repeat(64)}]}),/参与人已移除/);
  await assert.rejects(f.service.mutate(owner,"create",undefined,"duplicate",0,{...f.input,participants:[f.input.participants[0],f.input.participants[0]]}),/不重复/);
  const response=await app.inject({method:"POST",url:"/api/calendar/events",payload:{operationId:"api",expectedRevision:0,event:f.input}}); assert.equal(response.statusCode,200); assert.equal(response.json().event.interactionState.status,"pending_review");
  const empty=await f.service.people(owner,"",undefined,[]); assert.equal(empty.sources.length,0);
  const scoped=calendarTools(f.service,async()=>({ownerId:owner,bindingIds:[f.binding.id],assertCurrent:async()=>{}}));
  const reader=scoped.find(t=>t.name==="calendar_find_people")!; const result=await reader.execute("id",{query:"日历人物甲"},undefined,undefined,{} as never); assert.equal((JSON.parse((result.content[0] as {text:string}).text)).sources[0].people.length,1);
  await f.bindings.revoke(owner,f.binding.id,f.binding.bindingRevision);
  const event=response.json().event; const cancelled=await f.service.mutate(owner,"cancel",event.id,"revoked-cancel",1,undefined,[f.binding.id]).catch(e=>e);
  assert(cancelled instanceof Error); assert.equal((await f.store.get(owner,event.id)).status,"confirmed");
  assert.equal((await app.inject(`/api/calendar/people?vault=${f.binding.id}`)).statusCode,404);
 } finally {await app.close();await rm(f.base,{recursive:true,force:true});}
});

test("calendar interaction notes take the event title as filename, disambiguate collisions and sanitize unsafe characters",async()=>{
 const f=await fixture(); try {
  const first=await f.service.mutate(owner,"create",undefined,"name-a",0,f.input,[f.binding.id]);
  assert.equal(first.interactionState!.path,"Interactions/北京饭局.md");
  const same=await f.service.mutate(owner,"create",undefined,"name-b",0,{...f.input,start:"2026-10-06T20:00:00+08:00",end:"2026-10-06T21:00:00+08:00"},[f.binding.id]);
  assert.equal(same.interactionState!.path,`Interactions/北京饭局-${same.id.slice(0,8)}.md`);
  const messy=await f.service.mutate(owner,"create",undefined,"name-c",0,{...f.input,title:"A/B: 测试 *标题? [x] #y",start:"2026-10-07T20:00:00+08:00",end:"2026-10-07T21:00:00+08:00"},[f.binding.id]);
  assert.equal(messy.interactionState!.path,"Interactions/A-B-测试-标题-x-y.md");
  const blank=await f.service.mutate(owner,"create",undefined,"name-d",0,{...f.input,title:"???",start:"2026-10-08T20:00:00+08:00",end:"2026-10-08T21:00:00+08:00"},[f.binding.id]);
  assert.equal(blank.interactionState!.path,`Interactions/calendar-${blank.id}.md`);
  await f.publish(first.interactionState!.batchId!);
  const renamed=await f.service.mutate(owner,"update",same.id,"name-b2",1,{...f.input,start:"2026-10-06T20:00:00+08:00",end:"2026-10-06T21:00:00+08:00"},[f.binding.id]);
  assert.equal(renamed.interactionState!.path,same.interactionState!.path);
 } finally {await rm(f.base,{recursive:true,force:true});}
});
