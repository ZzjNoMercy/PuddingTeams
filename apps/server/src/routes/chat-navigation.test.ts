import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { TeamsStore } from "../store/teams.js";
import { ChatNavigationStore } from "../store/chat-navigation.js";
import { registerChatNavigationRoutes } from "./chat-navigation.js";
import { RoomActivityStore } from "../rooms/room-activity-store.js";

test("navigation metadata survives restart, serializes updates and preserves corrupt state", async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), "pt-nav-state-"));
 try {
  const file = path.join(dir,"navigation.json"), store = new ChatNavigationStore(file);
  await Promise.all([store.update("one",{pinned:true}),store.update("one",{archived:true}),store.update("two",{pinned:true})]);
  const state = await new ChatNavigationStore(file).read();
  assert.equal(state.revision,3); assert.deepEqual(state.sessions.one,{pinned:true,archived:true});
  await store.update("one",{archived:false});
  assert.deepEqual((await store.read()).sessions.one,{pinned:true,archived:false});
  const corrupt='{"version":1,"revision":1,"sessions":"invalid"}'; await writeFile(file,corrupt);
  await assert.rejects(()=>store.update("one",{pinned:false}),/invalid chat navigation state/);
  assert.equal(await readFile(file,"utf8"),corrupt);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test("index includes parked projects and real owners; flags never change execution or cross room ownership", async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(),"pt-nav-routes-")); const app = Fastify();
 try {
  const teams = new TeamsStore({state:path.join(dir,"state"),assets:dir,managedWorkspaces:path.join(dir,"managed")},dir);
  await teams.init();
  await teams.upsertAgent({name:"alpha",description:"Worker",invoke:{type:"command",command:"echo",runArgs:[]}});
  await teams.ensureSoloWindow(async()=>({id:"manager-old"}),async()=>false);
  const projectPath=path.join(dir,"project"); await mkdir(projectPath);
  const project=await teams.workspaces.createFromPath({path:projectPath});
  await teams.replaceWindowWorkspace("solo",project.id,"manager-new");
  const worker=await teams.createWindow({type:"direct",members:["alpha"],sessionId:"worker"});
  await teams.addWindowSession(worker.id,"worker",{ownerAgentId:"alpha",sourceSnapshotId:"snapshot-fixture"});
  const before=await readFile(path.join(dir,"state","windows.json"),"utf8");
  registerChatNavigationRoutes(app,{teams,statePath:path.join(dir,"nav.json"),sessions:{list:async()=>["manager-old","manager-new","worker","unowned"].map(id=>({id,sessionFile:"fixture",firstMessage:"hello",modifiedAt:"2026-10-15T01:00:00Z",active:false}))}});
  const index=(await app.inject({url:"/api/chat-navigation"})).json();
  assert.equal(index.items.find((i:{sessionId:string})=>i.sessionId==="worker").sourceSnapshotId,"snapshot-fixture");
  assert.equal(index.items.length,3); assert.equal(index.items.find((i:{sessionId:string})=>i.sessionId==="manager-old").contextActive,false);
  assert.equal(index.items.find((i:{sessionId:string})=>i.sessionId==="worker").ownerAgentId,"alpha");
  assert.equal(index.items.find((i:{sessionId:string})=>i.sessionId==="manager-new").workspaceId,project.id);
  for(const payload of [{},{archived:"true"},{members:[]},{pinned:true,unexpected:true}]) assert.equal((await app.inject({method:"PATCH",url:"/api/chat-navigation/solo/manager-old",payload})).statusCode,400);
  assert.equal((await app.inject({method:"PATCH",url:`/api/chat-navigation/${worker.id}/manager-old`,payload:{archived:true}})).statusCode,404);
  assert.equal((await app.inject({method:"PATCH",url:"/api/chat-navigation/solo/unowned",payload:{pinned:true}})).statusCode,404);
  const update=await app.inject({method:"PATCH",url:"/api/chat-navigation/solo/manager-old",payload:{pinned:true,archived:true}}); assert.equal(update.statusCode,200,update.body);
  const after=(await app.inject({url:"/api/chat-navigation"})).json();
  assert.equal(after.items.length,3); assert.equal(after.items.find((i:{sessionId:string})=>i.sessionId==="manager-old").archived,true);
  assert.equal(await readFile(path.join(dir,"state","windows.json"),"utf8"),before);
  assert.equal((await new ChatNavigationStore(path.join(dir,"nav.json")).read()).sessions["manager-old"]?.pinned,true);
 } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});

test("group navigation 用 roomSessionId 作为行身份，flags 按房间键持久", async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(),"pt-nav-group-")); const app = Fastify();
 try {
  const teams = new TeamsStore({state:path.join(dir,"state"),assets:dir,managedWorkspaces:path.join(dir,"managed")},dir);
  await teams.init();
  await teams.upsertAgent({name:"alpha",description:"Worker",invoke:{type:"command",command:"echo",runArgs:[]}});
  await teams.upsertAgent({name:"beta",description:"Worker",invoke:{type:"command",command:"echo",runArgs:[]}});
  const group = await teams.createWindow({type:"group",members:["alpha","beta"],sessionId:"manager-g"});
  const roomSessionId = group.activeRoomSessionId!;
  registerChatNavigationRoutes(app,{teams,statePath:path.join(dir,"nav.json"),sessions:{list:async()=>[{id:"manager-g",sessionFile:"fixture",firstMessage:"hello",modifiedAt:"2026-10-15T01:00:00Z",name:"Manager",active:false}]}});
  const index=(await app.inject({url:"/api/chat-navigation"})).json();
  const item=index.items.find((i:{sessionId:string})=>i.sessionId===roomSessionId);
  assert.ok(item); assert.equal(item.roomType,"group"); assert.equal(item.managerParticipantSessionId,"manager-g");
  assert.equal(item.workspaceName,"默认工作目录");
  assert.equal((await app.inject({method:"PATCH",url:`/api/chat-navigation/${group.id}/${roomSessionId}`,payload:{pinned:true}})).statusCode,200);
  assert.equal((await new ChatNavigationStore(path.join(dir,"nav.json")).read()).sessions[roomSessionId]?.pinned,true);
  assert.equal((await app.inject({method:"PATCH",url:`/api/chat-navigation/other/${roomSessionId}`,payload:{pinned:true}})).statusCode,404);
 } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});

test("group navigation 行级未读来自 RoomActivityStore，已读后清除", async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(),"pt-nav-unread-")); const app = Fastify();
 try {
  const teams = new TeamsStore({state:path.join(dir,"state"),assets:dir,managedWorkspaces:path.join(dir,"managed")},dir);
  await teams.init();
  await teams.upsertAgent({name:"alpha",description:"Worker",invoke:{type:"command",command:"echo",runArgs:[]}});
  await teams.upsertAgent({name:"beta",description:"Worker",invoke:{type:"command",command:"echo",runArgs:[]}});
  const group = await teams.createWindow({type:"group",members:["alpha","beta"],sessionId:"manager-u"});
  const roomSessionId = group.activeRoomSessionId!;
  const activity = new RoomActivityStore(path.join(dir,"room-activity.json"));
  await activity.record(roomSessionId, {eventId:"event-1", at:"2026-10-31T01:00:00.000Z", preview:"未读消息"});
  registerChatNavigationRoutes(app,{teams,statePath:path.join(dir,"nav.json"),roomActivity:activity,sessions:{list:async()=>[{id:"manager-u",sessionFile:"fixture",firstMessage:"hello",modifiedAt:"2026-10-31T00:00:00Z",active:false}]}});
  const before=(await app.inject({url:"/api/chat-navigation"})).json().items.find((item:{sessionId:string})=>item.sessionId===roomSessionId);
  assert.equal(before.hasUnreadActivity,true);
  assert.equal(before.lastMessagePreview,"未读消息");
  await activity.markRead(roomSessionId);
  const after=(await app.inject({url:"/api/chat-navigation"})).json().items.find((item:{sessionId:string})=>item.sessionId===roomSessionId);
  assert.equal(after.hasUnreadActivity,false);
 } finally { await app.close(); await rm(dir,{recursive:true,force:true}); }
});
