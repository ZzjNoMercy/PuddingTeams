import type { FastifyInstance } from "fastify";
import type { SessionForks } from "../agent-runtime/session-forks.js";

export function registerSessionForkRoutes(app: FastifyInstance, service: SessionForks) {
 app.get<{Params:{id:string}}>("/api/sessions/:id/snapshot-origin",async(req,reply)=>{try{return {origin:await service.origin(req.params.id)};}catch(error){return reply.code(404).send({error:error instanceof Error?error.message:String(error)});}});
 app.get<{Params:{id:string}}>("/api/sessions/:id/fork-targets",async(req,reply)=>{
  try{return await service.targets(req.params.id);}catch(error){return reply.code(404).send({error:String(error),code:"fork_source_gone"});}
 });
 app.post<{Params:{id:string};Body:{workerId?:string;expectedSourceLeafEntryId?:string}}>("/api/sessions/:id/forks",async(req,reply)=>{
  if(!req.body?.workerId||!req.body.expectedSourceLeafEntryId||typeof req.headers["idempotency-key"]!=="string") return reply.code(400).send({error:"fork requires worker, source leaf and operation key"});
  try{return await service.fork(req.headers["idempotency-key"],req.params.id,req.body.workerId,req.body.expectedSourceLeafEntryId);}
  catch(error){const code=(error instanceof Error?error.message.split(":")[0]:undefined)??"fork_operation_uncertain";return reply.code(code==="worker_out_of_scope"?403:code.includes("unsupported")||code.startsWith("snapshot_")?422:409).send({error:code,code,canStartNewIntent:await service.canStartNewIntent(req.headers["idempotency-key"] as string).catch(()=>false)});}
 });
}
