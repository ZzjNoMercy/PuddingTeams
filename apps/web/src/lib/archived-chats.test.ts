import { test } from "node:test";
import assert from "node:assert/strict";
import { archivedChatGroups, archivedReturnHref } from "./archived-chats";
import { applyArchivedChatAction } from "./archived-chat-actions";
import type { ChatNavigationItem, RoomSummary } from "./types";
const item=(sessionId:string,patch:Partial<ChatNavigationItem>={}):ChatNavigationItem=>({roomId:"room",sessionId,ownerAgentId:"manager",agentName:"Manager",agentEnabled:true,roomType:"solo",roomName:"",title:sessionId,firstMessage:"hello",modifiedAt:"2026-10-16T01:00:00Z",workspaceId:"project",workspaceName:"项目",cwdSnapshot:"/project",contextActive:true,pinned:false,archived:true,...patch});

test("archive filters exclude live chats, separate identical folder names and search across owners",()=>{
 const rows=[item("old",{pinned:true,modifiedAt:"2026-10-01"}),item("new"),item("live",{archived:false}),item("other",{workspaceId:"other",ownerAgentId:"worker",agentName:"Worker"})];
 const groups=archivedChatGroups(rows,"","","");assert.equal(groups.length,2);assert.equal(groups.flatMap(g=>g.items).length,3);assert.deepEqual(groups.find(g=>g.id==="project:project")?.items.map(i=>i.sessionId),["new","old"]);
 assert.equal(archivedChatGroups(rows,"Worker","worker","project:other")[0]?.items[0]?.sessionId,"other");
 assert.equal(archivedChatGroups(rows,"","worker","project:project").length,0);
 assert.equal(rows[0]?.sessionId,"old");
});
test("archive return routes preserve selected Session and reject external or recursive destinations",()=>{
 assert.equal(archivedReturnHref("/chats?room=solo&session=s&returnSession=manager&view=bad"),"/chats?room=solo&session=s&returnSession=manager");
 for(const bad of [null,"https://evil.invalid/chats","//evil.invalid/chats","/chats/archived","/chats/../settings","javascript:alert(1)"])assert.equal(archivedReturnHref(bad),"/chats");
});
test("delete rechecks archive status, protects unarchived siblings and atomically guards a last direct Session",async()=>{
 const target=item("old",{roomType:"direct",ownerAgentId:"worker"});let rows=[target];let room={id:"room",pinned:false,sessions:[{id:"old"},{id:"live"}]} as RoomSummary;const calls:string[]=[];
 const deps={list:async()=>({items:rows,revision:1}),room:async()=>room,removeRoom:async(id:string,only?:string)=>{calls.push(`room:${id}:${only}`);},removeSession:async(id:string,sid:string)=>{calls.push(`session:${id}:${sid}`);},update:async()=>({revision:2,flags:{archived:false,pinned:false}})};
 await applyArchivedChatAction(target,"delete",deps);assert.deepEqual(calls,["session:room:old"]);
 room={...room,sessions:[{id:"old"}] as RoomSummary["sessions"]};await applyArchivedChatAction(target,"delete",deps);assert.equal(calls[1],"room:room:old");
 rows=[{...target,archived:false}];await assert.rejects(()=>applyArchivedChatAction(target,"delete",deps),/已在其他窗口恢复/);assert.equal(calls.length,2);
 await applyArchivedChatAction(target,"restore",deps);assert.equal(calls.length,2);
 rows=[{...target,roomType:"solo",contextActive:false}];room={...room,pinned:true,sessions:[{id:"another-project"}] as RoomSummary["sessions"]};await applyArchivedChatAction(rows[0]!,"delete",deps);assert.equal(calls[2],"session:room:old","parked Manager deletion must not switch projects or remove its window");
});
