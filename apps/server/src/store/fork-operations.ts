import { mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface ForkOperation {
 key: string; sourceSessionId: string; expectedSourceLeafEntryId: string; targetWorkerId: string; targetAgentRevision: number;
 snapshotId: string; sessionId: string; windowId?: string; workspaceId?: string; cwdSnapshot: string;
 stage: "reserved" | "snapshot_saved" | "session_saved" | "attached"; terminal?: "gone" | "configuration_changed"; createdAt: string;
}
const stages = ["reserved","snapshot_saved","session_saved","attached"];
const immutable = ["key","sourceSessionId","targetWorkerId","expectedSourceLeafEntryId","snapshotId","sessionId","targetAgentRevision","cwdSnapshot","workspaceId","createdAt"] as const;
function validate(record: ForkOperation, key: string) {
 if (!record || typeof record !== "object" || record.key !== key || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key)
  || [record.sourceSessionId,record.expectedSourceLeafEntryId,record.targetWorkerId,record.snapshotId,record.sessionId,record.cwdSnapshot,record.createdAt].some(value=>typeof value!=="string"||!value)
  || !Number.isInteger(record.targetAgentRevision) || record.targetAgentRevision < 0 || !stages.includes(record.stage)
  || record.terminal !== undefined && !["gone","configuration_changed"].includes(record.terminal) || record.stage === "attached" && !record.windowId) throw new Error("fork_operation_uncertain");
}
/** One durable journal owns snapshot/import/attachment recovery. */
export class ForkOperations {
 private tail = Promise.resolve(); private uncertain = false;
 constructor(private file: string) {}
 async list(): Promise<ForkOperation[]> { return Object.values(await this.read()); }
 private async read(): Promise<Record<string,ForkOperation>> {
  try {
   const data=JSON.parse(await readFile(this.file,"utf8"));
   if(data.version!==1||!data.operations||typeof data.operations!=="object"||Array.isArray(data.operations))throw new Error("fork_operation_uncertain");
   for(const [key,record] of Object.entries(data.operations))validate(record as ForkOperation,key);
   return data.operations;
  } catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return Object.create(null);throw error; }
 }
 async get(key: string) {const records=await this.read();return Object.hasOwn(records,key)?records[key]:undefined;}
 async put(record: ForkOperation) {
  const action=async()=>{
   if(this.uncertain)throw new Error("fork_operation_uncertain");validate(record,record.key);
   const records=await this.read(),prior=Object.hasOwn(records,record.key)?records[record.key]:undefined;
   if(prior && immutable.some(key=>prior[key]!==record[key]))throw new Error("fork_operation_conflict");
   if(prior && (stages.indexOf(record.stage)<stages.indexOf(prior.stage) || prior.terminal && record.terminal!==prior.terminal || prior.windowId && record.windowId!==prior.windowId))throw new Error("fork_operation_uncertain");
   records[record.key]=record;await mkdir(path.dirname(this.file),{recursive:true});
   const temp=`${this.file}.${randomUUID()}.tmp`,fd=await open(temp,"wx",0o600);
   try{await fd.writeFile(JSON.stringify({version:1,operations:records}));await fd.sync();}finally{await fd.close();}
   // A rename error can be ambiguous. Keep the namespace and stop this process;
   // a fresh journal reconciles the committed file instead of issuing new IDs.
   try{await rename(temp,this.file);const dir=await open(path.dirname(this.file),"r");try{await dir.sync();}finally{await dir.close();}}
   catch(error){this.uncertain=true;throw error;}
  };
  const run=this.tail.then(action,action);this.tail=run.catch(()=>{});return run;
 }
}
