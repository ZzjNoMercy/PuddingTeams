"use client";
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { listRoomsWithContext, SERVER_URL } from "@/lib/api";
import { sessionShareLink } from "@/lib/session-link";
import type { RoomSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import styles from "./fork-session-dialog.module.css";

const reasons:Record<string,string>={fork_source_busy:"源会话还在执行、等待审批或有未读输入，请先完成或停止",fork_source_uncommitted:"来源还没有已提交的对话记录",fork_source_changed:"源对话有新内容，请重新选择当前快照",fork_source_gone:"源会话已删除",worker_out_of_scope:"目标 Worker 不在当前群聊范围，请先调整成员",snapshot_import_unsupported:"目标 Worker 不支持快照导入",snapshot_source_unsupported:"该 Connector 不支持原生快照",snapshot_too_large:"这段对话超出了目标 Worker 能导入的大小上限，无法创建快照对话",fork_target_configuration_changed:"目标 Worker 的配置已变化，请重新确认",fork_operation_gone:"之前的 Fork 对话已删除，需要重新创建",fork_operation_uncertain:"上一次 Fork 的结果未确认，请点「重试上一次 Fork」继续核对",session_context_inactive:"请先切换到来源项目"};
type Intent = { key:string; workerId:string; expectedSourceLeafEntryId:string };
type Mode = "snapshot" | "reference";
export function ForkSessionDialog({sourceId,roomId,open,onOpenChange}:{sourceId:string;roomId:string;open:boolean;onOpenChange:(open:boolean)=>void}) {
 const workerFieldId=useId();
 const [data,setData]=useState<{reason?:string;leafEntryId?:string;targets:Array<{workerId:string;label:string}>}>();
 const [worker,setWorker]=useState(""),[error,setError]=useState(""),[errorCode,setErrorCode]=useState(""),[busy,setBusy]=useState(false);
 const [resetAllowed,setResetAllowed]=useState(false),[revision,setRevision]=useState(0);
 const [intent,setIntent]=useState<Intent|null>(null),router=useRouter(), storageKey=`puddingteams:fork:${sourceId}`;
 const [mode,setMode]=useState<Mode>("snapshot");
 const [rooms,setRooms]=useState<RoomSummary[]>();
 useEffect(()=>{
  if(!open)return;let active=true;
  void Promise.resolve().then(async()=>{
   if(!active)return;setData(undefined);setError("");setErrorCode("");setResetAllowed(false);
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
 // 仅引用模式：拿房间列表定位目标 Worker 的单聊，便于复制后直达。
 useEffect(()=>{
  if(!open||mode!=="reference")return;let active=true;
  void listRoomsWithContext().then(({rooms:list})=>{if(active)setRooms(list);}).catch(()=>{});
  return()=>{active=false;};
 },[open,mode]);
 // 深链只在同一 Workspace 内可读：单聊必须落在源房间所属的项目里，
 // 否则「复制链接并打开聊天」会把用户带进一个读不了该链接的房间。
 const sourceWorkspaceId=rooms?.find(room=>room.id===roomId)?.workspace?.id??null;
 const directRoom=rooms?.find(room=>room.type==="direct"&&room.members.some(member=>member.name===worker)&&(room.workspace?.id??null)===sourceWorkspaceId);
 const copyLink=async()=>{
  const link=sessionShareLink(roomId,sourceId);
  try{await navigator.clipboard.writeText(link);toast.success("链接已复制；粘贴到聊天或委派材料里，对方即可按需回读");return true;}
  catch{toast.error("无法复制链接");return false;}
 };
 const openWorkerChat=async()=>{
  if(!directRoom)return;
  if(await copyLink()){onOpenChange(false);router.push(`/chats?room=${encodeURIComponent(directRoom.id)}&session=${encodeURIComponent(directRoom.activeSession)}`);}
 };
 const submit=async()=>{
  if(busy)return;
  const operation=intent??{key:crypto.randomUUID(),workerId:worker,expectedSourceLeafEntryId:data?.leafEntryId??""};
  if(!operation.workerId||!operation.expectedSourceLeafEntryId)return;
  setIntent(operation);try{sessionStorage.setItem(storageKey,JSON.stringify(operation));}catch{/* in-memory identity remains */}
  setBusy(true);setError("");setErrorCode("");
  try{
   const res=await fetch(`${SERVER_URL}/api/sessions/${sourceId}/forks`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":operation.key},body:JSON.stringify({workerId:operation.workerId,expectedSourceLeafEntryId:operation.expectedSourceLeafEntryId}),signal:AbortSignal.timeout(20000)});
   const body=await res.json();if(!res.ok){setErrorCode(typeof body.code==="string"?body.code:"");setResetAllowed(body.canStartNewIntent===true);throw new Error(reasons[body.code]??body.error??"Fork 未确认，请重试上一次操作");}
   sessionStorage.removeItem(storageKey);setIntent(null);
   router.push(`/chats?room=${encodeURIComponent(body.roomId)}&session=${encodeURIComponent(body.sessionId)}`);
  }catch(err){setError(err instanceof Error?err.message:String(err));}finally{setBusy(false);}
 };
 return <Dialog open={open} onOpenChange={value=>{if(!busy)onOpenChange(value);}}><DialogContent className={styles.dialog} showCloseButton={!busy} onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDownOutside={event=>{if(busy)event.preventDefault();}}>
  <DialogHeader className={styles.header}><DialogTitle className={styles.title}>交给 Worker</DialogTitle><DialogDescription className={styles.description}>{mode==="snapshot"?"复制已提交的对话快照，由目标 Worker 接手。沿用项目目录，不会自动发送任务。":"生成指向本对话的链接；Worker 从链接按需回读最新进展，不复制历史。适合「跟进同一件事」「补充背景」。"}</DialogDescription></DialogHeader>
  <div className={styles.body}>
   <div className={styles.modes} role="radiogroup" aria-label="交接方式">
    <button type="button" role="radio" aria-checked={mode==="snapshot"} className={styles.mode} data-active={mode==="snapshot"} disabled={busy} onClick={()=>setMode("snapshot")}>复制快照<span>冻结当前历史副本，Worker 独立接手，之后各干各的</span></button>
    <button type="button" role="radio" aria-checked={mode==="reference"} className={styles.mode} data-active={mode==="reference"} disabled={busy} onClick={()=>setMode("reference")}>仅引用链接<span>不复制历史，Worker 用 session_read 按需回读最新内容</span></button>
   </div>
   {data?.reason&&mode==="snapshot"?<p className={styles.notice} role="status">{reasons[data.reason]??data.reason}</p>:null}
   <div className={styles.field}>
    <label htmlFor={workerFieldId}>目标 Worker</label>
    <Select value={worker} disabled={busy||(mode==="snapshot"&&(Boolean(intent)||!data?.targets.length))} onValueChange={setWorker}>
     <SelectTrigger id={workerFieldId} aria-label="目标 Worker" className={styles.select}><SelectValue placeholder={!data&&!error?"正在读取 Worker…":"选择 Worker"} /></SelectTrigger>
     <SelectContent position="popper" className={styles.options}>{(data?.targets??[]).map(target=><SelectItem key={target.workerId} value={target.workerId}>{target.label}</SelectItem>)}</SelectContent>
    </Select>
   </div>
   {!data&&!error?<p className={styles.loading} role="status"><LoaderCircleIcon size={14} className="animate-spin" aria-hidden="true" />正在读取可用 Worker…</p>:null}
   {mode==="snapshot"&&data&&!data.targets.length?<p className={styles.hint}>当前范围没有支持快照导入的 Worker。</p>:null}
   {mode==="reference"?<p className={styles.hint}>链接只在同一项目（Workspace）内可读；Worker 读到的内容以引用时刻之后的最新进展为准。</p>:null}
   {mode==="reference"&&worker?directRoom
     ?<Button type="button" variant="outline" className={styles.openChat} onClick={()=>void openWorkerChat()}>复制链接并打开与 {directRoom.members.find(member=>member.name===worker)?.displayName??worker} 的聊天</Button>
     :<p className={styles.hint}>还没有与该 Worker 的单聊；复制链接后可先在对话列表新建。</p>:null}
   {error?<div className={styles.error} role="alert"><p>{error}</p><p>{errorCode==="snapshot_too_large"?"重试不会改变结果，请换一段更短的对话。":"重试沿用同一次操作，不会重复创建。"}</p></div>:null}
   {resetAllowed?<Button type="button" className={styles.reset} variant="outline" disabled={busy} onClick={()=>{sessionStorage.removeItem(storageKey);setIntent(null);setRevision(value=>value+1);}}>重新选择当前快照</Button>:null}
  </div>
  <DialogFooter className={styles.footer}>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>onOpenChange(false)}>取消</Button>
   {mode==="reference"
    ?<Button type="button" onClick={()=>void copyLink()}>复制链接</Button>
    :<Button type="button" disabled={busy||(!intent&&(!worker||!data?.leafEntryId||Boolean(data.reason)))} onClick={()=>void submit()}>{busy?<LoaderCircleIcon size={15} className="animate-spin" aria-hidden="true" />:null}{busy?"正在创建…":intent?"重试上一次 Fork":"创建快照对话"}</Button>}
  </DialogFooter>
 </DialogContent></Dialog>;
}
