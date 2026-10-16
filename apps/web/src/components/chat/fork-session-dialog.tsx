"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon } from "lucide-react";
import { SERVER_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import styles from "./fork-session-dialog.module.css";

const reasons:Record<string,string>={fork_source_busy:"源会话仍在执行、等待审批或有未消费输入，请先完成或停止并核对",fork_source_uncommitted:"来源还没有已提交的对话记录",fork_source_changed:"源对话已更新，请重新选择当前快照",fork_source_gone:"源会话已删除",worker_out_of_scope:"目标 Worker 不在当前群聊范围，请先调整成员",snapshot_import_unsupported:"目标 Worker 不支持快照导入",snapshot_source_unsupported:"该 Connector 不支持原生快照",snapshot_too_large:"对话超过目标的导入预算",fork_target_configuration_changed:"目标 Worker 配置已变化，请核对原操作",fork_operation_gone:"原 Fork 对话已删除，不会重新创建",fork_operation_uncertain:"原操作结果尚未确认，请保留操作键继续核对",session_context_inactive:"请先切换到来源项目"};
type Intent = { key:string; workerId:string; expectedSourceLeafEntryId:string };
export function ForkSessionDialog({sourceId,open,onOpenChange}:{sourceId:string;open:boolean;onOpenChange:(open:boolean)=>void}) {
 const workerFieldId=useId();
 const [data,setData]=useState<{reason?:string;leafEntryId?:string;targets:Array<{workerId:string;label:string}>}>();
 const [worker,setWorker]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [resetAllowed,setResetAllowed]=useState(false),[revision,setRevision]=useState(0);
 const [intent,setIntent]=useState<Intent|null>(null),router=useRouter(), storageKey=`puddingteams:fork:${sourceId}`;
 useEffect(()=>{
  if(!open)return;let active=true;
  void Promise.resolve().then(async()=>{
   if(!active)return;setData(undefined);setError("");setResetAllowed(false);
   let saved:Intent|null=null;
   try { const stored=JSON.parse(sessionStorage.getItem(storageKey)??"null");
    if(stored && typeof stored.key==="string" && typeof stored.workerId==="string" && typeof stored.expectedSourceLeafEntryId==="string") saved=stored;
   }catch{/* malformed local receipt cannot supply an operation identity */}
   setIntent(saved);if(saved)setWorker(saved.workerId);
   try { const res=await fetch(`${SERVER_URL}/api/sessions/${sourceId}/fork-targets`),next=await res.json();
    if(!res.ok)throw new Error(next.error);
    if(active){setData(next);if(!saved)setWorker(next.targets[0]?.workerId??"");}
   }catch(error){if(active)setError(error instanceof Error?error.message:String(error));}
  });
  return()=>{active=false;};
 },[open,sourceId,storageKey,revision]);
 const submit=async()=>{
  if(busy)return;
  const operation=intent??{key:crypto.randomUUID(),workerId:worker,expectedSourceLeafEntryId:data?.leafEntryId??""};
  if(!operation.workerId||!operation.expectedSourceLeafEntryId)return;
  setIntent(operation);try{sessionStorage.setItem(storageKey,JSON.stringify(operation));}catch{/* in-memory identity remains */}
  setBusy(true);setError("");
  try{
   const res=await fetch(`${SERVER_URL}/api/sessions/${sourceId}/forks`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":operation.key},body:JSON.stringify({workerId:operation.workerId,expectedSourceLeafEntryId:operation.expectedSourceLeafEntryId}),signal:AbortSignal.timeout(20000)});
   const body=await res.json();if(!res.ok){setResetAllowed(body.canStartNewIntent===true);throw new Error(reasons[body.code]??body.error??"Fork 未确认，请使用原操作继续核对");}
   sessionStorage.removeItem(storageKey);setIntent(null);
   router.push(`/chats?room=${encodeURIComponent(body.roomId)}&session=${encodeURIComponent(body.sessionId)}`);
  }catch(err){setError(err instanceof Error?err.message:String(err));}finally{setBusy(false);}
 };
 return <Dialog open={open} onOpenChange={value=>{if(!busy)onOpenChange(value);}}><DialogContent className={styles.dialog} showCloseButton={!busy} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDownOutside={event=>{if(busy)event.preventDefault();}}>
  <DialogHeader className={styles.header}><DialogTitle className={styles.title}>Fork 到 Worker</DialogTitle><DialogDescription className={styles.description}>复制已提交的对话快照，由目标 Worker 接手。沿用项目目录，不会自动发送任务。</DialogDescription></DialogHeader>
  <div className={styles.body}>
   {data?.reason?<p className={styles.notice} role="status">{reasons[data.reason]??data.reason}</p>:null}
   <div className={styles.field}>
    <label htmlFor={workerFieldId}>目标 Worker</label>
    <Select value={worker} disabled={busy||Boolean(intent)||!data?.targets.length} onValueChange={setWorker}>
     <SelectTrigger id={workerFieldId} aria-label="目标 Worker" className={styles.select}><SelectValue placeholder={!data&&!error?"正在读取 Worker…":"选择 Worker"} /></SelectTrigger>
     <SelectContent position="popper" className={styles.options}>{(data?.targets??[]).map(target=><SelectItem key={target.workerId} value={target.workerId}>{target.label}</SelectItem>)}</SelectContent>
    </Select>
   </div>
   {!data&&!error?<p className={styles.loading} role="status"><LoaderCircleIcon size={14} className="animate-spin" aria-hidden="true" />正在读取可用 Worker…</p>:null}
   {data&&!data.targets.length?<p className={styles.hint}>当前范围没有支持快照导入的 Worker。</p>:null}
   {error?<div className={styles.error} role="alert"><p>{error}</p><p>结果未确认时保留原操作键，不会另建一份。</p></div>:null}
   {resetAllowed?<Button type="button" className={styles.reset} variant="outline" disabled={busy} onClick={()=>{sessionStorage.removeItem(storageKey);setIntent(null);setRevision(value=>value+1);}}>重新选择当前快照</Button>:null}
  </div>
  <DialogFooter className={styles.footer}>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>onOpenChange(false)}>取消</Button>
   <Button type="button" disabled={busy||(!intent&&(!worker||!data?.leafEntryId||Boolean(data.reason)))} onClick={()=>void submit()}>{busy?<LoaderCircleIcon size={15} className="animate-spin" aria-hidden="true" />:null}{busy?"正在创建…":intent?"核对原 Fork":"创建快照对话"}</Button>
  </DialogFooter>
 </DialogContent></Dialog>;
}
