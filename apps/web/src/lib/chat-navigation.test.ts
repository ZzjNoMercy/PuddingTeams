import { test } from "node:test";
import assert from "node:assert/strict";
import { groupChatNavigation, navigationTitle } from "./chat-navigation.js";
import type { ChatNavigationItem } from "./types.js";
const item=(sessionId:string, patch:Partial<ChatNavigationItem>={}):ChatNavigationItem=>({roomId:"solo",sessionId,ownerAgentId:"manager",agentName:"Manager",agentEnabled:true,roomType:"solo",roomName:"",title:sessionId,firstMessage:"hello",modifiedAt:"2026-10-15T01:00:00Z",workspaceId:null,workspaceName:"默认工作目录",cwdSnapshot:"/default",contextActive:true,pinned:false,archived:false,...patch});

test("two views contain the same sessions, share pins and filter archives reversibly",()=>{
 const rows=[item("old",{pinned:true,modifiedAt:"2026-01-01"}),item("new"),item("worker",{ownerAgentId:"alpha",agentName:"Alpha",roomType:"direct"}),item("archived",{archived:true})];
 for(const view of ["agent","project"] as const){
  const groups=groupChatNavigation(rows,view,"",false);
  assert.deepEqual(groups.flatMap(g=>g.items.map(i=>i.sessionId)).sort(),["new","old","worker"]);
  assert.equal(groups[0]!.items[0]!.sessionId,"old");
  assert.deepEqual(groupChatNavigation(rows,view,"",true).flatMap(g=>g.items.map(i=>i.sessionId)),["archived"]);
 }
 assert.equal(groupChatNavigation(rows,"agent","",false)[0]!.name,"Manager"); assert.equal(rows.length,4);
});
test("folder identity separates identical names and default cwd; search includes owner, path and title",()=>{
 const rows=[item("one",{workspaceId:"a",workspaceName:"Same",cwdSnapshot:"/a"}),item("two",{workspaceId:"b",workspaceName:"Same",cwdSnapshot:"/b"}),item("three"),item("four",{cwdSnapshot:"/other"})];
 assert.equal(groupChatNavigation(rows,"project","",false).length,4);
 assert.equal(groupChatNavigation(rows,"agent","/b",false)[0]!.items[0]!.sessionId,"two");
 assert.equal(groupChatNavigation(rows,"project","MANAGER",false).flatMap(g=>g.items).length,4);
 assert.equal(navigationTitle(item("",{title:"新对话",firstMessage:"First line\nsecond"})),"First line");
 assert.equal(navigationTitle(item("",{title:"",firstMessage:"(no messages)"})),"新聊天");
});
