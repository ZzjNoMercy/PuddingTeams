import { randomUUID } from "node:crypto";
import type { TeamsStore } from "../store/teams.js";
import { agentDisplayName, agentRunConfigRevision } from "../store/teams.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { AgentInvoker } from "./invoker.js";
import { ConversationSnapshots } from "../store/conversation-snapshots.js";
import { ForkOperations, type ForkOperation } from "../store/fork-operations.js";
import { includeOffloadedResults, referencedSnapshotFiles, snapshotEntries } from "./conversation-snapshot.js";

export class SessionForks {
 private running = new Map<string,Promise<unknown>>();
 constructor(private teams: TeamsStore, private sessions: PiSessionStore, private invoker: AgentInvoker,
  private snapshots: ConversationSnapshots, private operations: ForkOperations, private privateRoots: string[]) {}
 async targets(sourceId: string) {
  const context=await this.teams.contextForSession(sourceId); if(!context) throw new Error("fork_source_gone");
  const session=await this.sessions.open(sourceId);
  const active=(await this.invoker.delegationsForManagerSession(sourceId)).some(record=>["running","waiting_admission","waiting_input","cancel_requested","reconciling"].includes(record.executionState));
  const cap=await this.sessions.nativeSessionCapability(sourceId);
  let reason=!cap.nativePi?"snapshot_source_unsupported":!context.active?"session_context_inactive":!session.isIdle||active||cap.waiting.length||await this.sessions.hasPendingInputs(sourceId)?"fork_source_busy":undefined;
  if(!reason)await this.sessions.committedBranch(sourceId).catch(error=>{reason=error instanceof Error?error.message.split(":")[0]:"snapshot_incompatible_history";});
  const candidates=await Promise.all((await this.teams.eligibleWorkersFor(context.window)).map(async agent=>{
   const capability=await this.sessions.snapshotImportCapability(agent.name);
   return capability?{workerId:agent.name,label:agent.displayName??agent.name,snapshotImport:capability}:undefined;
  }));
  const targets=candidates.filter(target=>target!==undefined);
  return { reason, leafEntryId: session.sessionManager.getLeafId(), targets };
 }
 async fork(key: string, sourceId: string, workerId: string, leaf: string): Promise<{snapshotId:string;sessionId:string;roomId:string;sourceSessionId:string}> {
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key)) throw new Error("invalid fork operation key");
  const existing=this.running.get(key); if(existing) { await existing; return this.fork(key,sourceId,workerId,leaf); }
  const action=this.perform(key,sourceId,workerId,leaf); this.running.set(key,action);
  try{return await action;}finally{this.running.delete(key);}
 }
 private async perform(key: string, sourceId: string, workerId: string, leaf: string) {
  let record=await this.operations.get(key);
  if(record && (record.sourceSessionId!==sourceId||record.targetWorkerId!==workerId||record.expectedSourceLeafEntryId!==leaf)) throw new Error("fork_operation_conflict");
  if(record?.terminal) throw new Error(record.terminal==="configuration_changed"?"fork_target_configuration_changed":"fork_operation_gone");
  if(record?.stage==="attached") {
   if(!await this.teams.contextForSession(record.sessionId)||(await this.sessions.list()).every(session=>session.id!==record!.sessionId)) { await this.operations.put({...record,terminal:"gone"}); throw new Error("fork_operation_gone"); }
   return this.result(record);
  }
  if(!record) {
   await this.sessions.withActiveContextLifecycle(sourceId,async()=>{
    const target=await this.targets(sourceId); if(target.reason) throw new Error(target.reason);
    if(target.leafEntryId!==leaf) throw new Error("fork_source_changed");
    const contextForRange=(await this.teams.contextForSession(sourceId))!;
    if(!(await this.teams.eligibleWorkersFor(contextForRange.window)).some(agent=>agent.name===workerId)) throw new Error("worker_out_of_scope");
    if(!target.targets.some(agent=>agent.workerId===workerId)) throw new Error("snapshot_import_unsupported");
    await this.sessions.nativeExecutions?.assertDelegationReady(sourceId);
    const context=(await this.teams.contextForSession(sourceId))!, agent=(await this.teams.getAgent(workerId))!;
    record={key,sourceSessionId:sourceId,expectedSourceLeafEntryId:leaf,targetWorkerId:workerId,targetAgentRevision:agentRunConfigRevision(agent),snapshotId:randomUUID(),sessionId:randomUUID(),workspaceId:context.workspaceId,cwdSnapshot:context.cwdSnapshot,stage:"reserved",createdAt:new Date().toISOString()};
    await this.operations.put(record);
    await this.freeze(record);
   });
  }
  return this.advance(record!);
 }
 private async freeze(record: ForkOperation) {
  const session=await this.sessions.open(record.sourceSessionId).catch(()=>{throw new Error("fork_source_gone");});
  if(session.sessionManager.getLeafId()!==record.expectedSourceLeafEntryId) throw new Error("fork_source_changed");
  const guard=await this.targets(record.sourceSessionId); if(guard.reason)throw new Error(guard.reason);
  const branch=await this.sessions.committedBranch(record.sourceSessionId);
  const entries=snapshotEntries(branch);
  entries.push(...await this.sessions.historicalGoalEntries(record.sourceSessionId));
  await includeOffloadedResults(entries,branch,this.privateRoots);
  const files=await referencedSnapshotFiles(entries,this.privateRoots);
  if(Buffer.byteLength(JSON.stringify(entries),"utf8")>await this.sessions.snapshotImportBudget(record.targetWorkerId)) throw new Error("snapshot_too_large");
  await this.snapshots.save({id:record.snapshotId,sourceSessionId:record.sourceSessionId,sourceLeafEntryId:record.expectedSourceLeafEntryId,cwdSnapshot:record.cwdSnapshot,sourceWorkspaceId:record.workspaceId,entries},files);
  record.stage="snapshot_saved"; await this.operations.put(record);
 }
 private async advance(record: ForkOperation) {
  if(record.stage==="reserved") {
   // A rename may have committed before the journal stage. Reconcile bytes.
   const saved=await this.snapshots.load(record.snapshotId).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;});
   if(saved){this.validateSnapshot(record,saved);record.stage="snapshot_saved";await this.operations.put(record);} else await this.sessions.withActiveContextLifecycle(record.sourceSessionId,()=>this.freeze(record));
  }
  const agent=await this.teams.getAgent(record.targetWorkerId);
  if(!agent||agent.enabled===false||agentRunConfigRevision(agent)!==record.targetAgentRevision) {
   const attached=await this.teams.contextForSession(record.sessionId),ref=await this.teams.sessionRef(record.sessionId);
   if(attached&&ref?.ownerAgentId===record.targetWorkerId&&ref.sourceSnapshotId===record.snapshotId&&attached.cwdSnapshot===record.cwdSnapshot) {record.windowId=attached.window.id;record.stage="attached";await this.operations.put(record);return this.result(record);}
   await this.operations.put({...record,terminal:"configuration_changed"});throw new Error("fork_target_configuration_changed");
  }
  if(record.stage==="snapshot_saved") {
   const snapshot=await this.snapshots.load(record.snapshotId);this.validateSnapshot(record,snapshot);
   await this.sessions.importSnapshot(snapshot,record.targetWorkerId,record.sessionId,record.targetAgentRevision);
   record.stage="session_saved";await this.operations.put(record);
  }
  if(record.stage==="session_saved") {
   const room=await this.teams.ensureDirectWindow(record.targetWorkerId,record.workspaceId,async()=>({id:record.sessionId}),{cwdSnapshot:record.cwdSnapshot,requireEnabledMember:true});
   await this.teams.addWindowSession(room.id,record.sessionId,{ownerAgentId:record.targetWorkerId,sourceSnapshotId:record.snapshotId});
   record.windowId=room.id;record.stage="attached";await this.operations.put(record);
  }
  return this.result(record);
 }
 private validateSnapshot(record: ForkOperation,snapshot: import("../store/conversation-snapshots.js").ConversationSnapshot) {
  if(snapshot.sourceSessionId!==record.sourceSessionId || snapshot.sourceLeafEntryId!==record.expectedSourceLeafEntryId || snapshot.cwdSnapshot!==record.cwdSnapshot || snapshot.sourceWorkspaceId!==record.workspaceId)throw new Error("snapshot_integrity_failed");
 }
 private result(record: ForkOperation) {return {snapshotId:record.snapshotId,sessionId:record.sessionId,roomId:record.windowId!,sourceSessionId:record.sourceSessionId};}
 async origin(id:string) {
  const ref=await this.teams.sessionRef(id);if(!ref||!await this.teams.contextForSession(id))throw new Error("fork_target_gone");
  if(!ref.sourceSnapshotId)return null;
  const snapshot=await this.snapshots.load(ref.sourceSnapshotId),sourceContext=await this.teams.contextForSession(snapshot.sourceSessionId);
  const sourceExists=Boolean(sourceContext && (await this.sessions.list()).some(session=>session.id===snapshot.sourceSessionId));
  const sourceRef=sourceExists ? await this.teams.sessionRef(snapshot.sourceSessionId) : undefined;
  const sourceAgent=sourceRef ? await this.teams.getAgent(sourceRef.ownerAgentId) : undefined;
  return {sourceAgentName:sourceRef?.ownerAgentId==="manager"?"Manager":sourceAgent?agentDisplayName(sourceAgent):undefined, snapshotId:snapshot.id,sourceSessionId:snapshot.sourceSessionId,sourceLeafEntryId:snapshot.sourceLeafEntryId,createdAt:snapshot.createdAt,sourceExists,
   sourceRoomId:sourceExists?sourceContext?.window.id:undefined,sourceActive:sourceExists&&sourceContext?.active===true};
 }
 async canStartNewIntent(key:string) {const record=await this.operations.get(key);return !record||record.terminal==="configuration_changed";}
 async recover() {for(const record of await this.operations.list()) if(record.stage!=="attached"&&!record.terminal) await this.advance(record).catch(error=>{console.warn(`fork ${record.key}: ${error instanceof Error?error.message:String(error)}`);});}
}
