import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {ConversationSnapshots} from "./conversation-snapshots.js";
import {ForkOperations,type ForkOperation} from "./fork-operations.js";
import {MessageSubmissionOperations} from "./message-submission-operations.js";
import {snapshotEntries} from "../agent-runtime/conversation-snapshot.js";

test("P3 snapshot integrity covers source metadata and independently owned asset bytes",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"pt-snapshot-integrity-"));
 try{
  const file=path.join(dir,"source.txt");await writeFile(file,"original");const snapshots=new ConversationSnapshots(path.join(dir,"snapshots"));
  const snapshot=await snapshots.save({id:"snap-1",sourceSessionId:"source",sourceLeafEntryId:"leaf",cwdSnapshot:dir,sourceWorkspaceId:"registered-project",entries:[{type:"message",id:"user",parentId:null,timestamp:"2026-10-14",message:{role:"user",content:[{type:"text",text:`read ${file}`}],timestamp:1}}]},[file]);
  assert.equal((await snapshots.load(snapshot.id)).sourceWorkspaceId,"registered-project");
  await writeFile(file,"different");assert.equal(await readFile(snapshot.assets[0]!.ref,"utf8"),"original");
  const manifest=path.join(snapshots.root,snapshot.id,"manifest.json"),bytes=await readFile(manifest,"utf8");
  await chmod(manifest,0o600);await writeFile(manifest,JSON.stringify({...JSON.parse(bytes),sourceSessionId:"another"}));await assert.rejects(()=>snapshots.load(snapshot.id),/snapshot_integrity_failed/);
  await writeFile(manifest,bytes);await chmod(snapshot.assets[0]!.ref,0o600);await writeFile(snapshot.assets[0]!.ref,"tampered");await assert.rejects(()=>snapshots.load(snapshot.id),/snapshot_integrity_failed/);
  await assert.rejects(()=>snapshots.save({id:"../escape",sourceSessionId:"source",sourceLeafEntryId:"leaf",cwdSnapshot:dir,entries:[]},[]),/invalid snapshot id/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("P3 fork journal rejects identity changes, stage rollback and malformed records, including prototype keys",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"pt-fork-journal-"));
 try{
  const file=path.join(dir,"forks.json"),ops=new ForkOperations(file);
  const record:ForkOperation={key:"constructor",sourceSessionId:"source",expectedSourceLeafEntryId:"leaf",targetWorkerId:"worker",targetAgentRevision:1,snapshotId:"snap",sessionId:"target",cwdSnapshot:dir,stage:"reserved",createdAt:"2026-10-14"};
  assert.equal(await ops.get(record.key),undefined);await ops.put(record);assert.deepEqual(await new ForkOperations(file).get(record.key),record);
  await assert.rejects(()=>ops.put({...record,workspaceId:"other"}),/fork_operation_conflict/);
  await ops.put({...record,stage:"snapshot_saved"});await assert.rejects(()=>ops.put(record),/fork_operation_uncertain/);
  await writeFile(file,JSON.stringify({version:1,operations:{bad:{stage:"attached"}}}));await assert.rejects(()=>new ForkOperations(file).list(),/fork_operation_uncertain/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("P3 definite rejection permits exactly one same-key retry; accepted queued input cannot be replayed as new",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"pt-native-retry-"));
 try{
  const ops=new MessageSubmissionOperations(dir),hash="a".repeat(64),context="b".repeat(64),key="retryable-0001";
  assert.equal(await ops.reserve(key,"session",hash,context),"new");await ops.markRetryable(key,"session",hash);
  assert.deepEqual(await Promise.all([ops.reserve(key,"session",hash,context),ops.reserve(key,"session",hash,context)]),["new","unconfirmed"]);
  await ops.markAccepted(key,"session",hash,{operationId:key,processId:"process",disposition:"queued",delivery:"followUp",persistence:"pending"});
  await assert.rejects(()=>ops.markRetryable(key,"session",hash));assert.equal(await new MessageSubmissionOperations(dir).reserve(key,"session",hash,context),"accepted");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("P3 snapshots reject orphan tool results rather than replay or silently repair history",()=>{
 assert.throws(()=>snapshotEntries([{type:"message",id:"result",parentId:null,timestamp:"2026-10-14",message:{role:"toolResult",toolCallId:"missing",toolName:"bash",content:[{type:"text",text:"done"}],isError:false,timestamp:1}}]),/snapshot_incompatible_history/);
});
