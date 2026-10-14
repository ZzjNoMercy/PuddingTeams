"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {SERVER_URL} from "@/lib/api";
type Origin={snapshotId:string;sourceSessionId:string;createdAt:string;sourceExists:boolean;sourceActive:boolean;sourceRoomId?:string};
export function SnapshotOrigin({sessionId,snapshotId}:{sessionId:string;snapshotId:string}) {
 const [origin,setOrigin]=useState<Origin|null>(null),[failed,setFailed]=useState(false);
 useEffect(()=>{const controller=new AbortController();void fetch(`${SERVER_URL}/api/sessions/${sessionId}/snapshot-origin`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error("snapshot origin unavailable");return response.json() as Promise<{origin:Origin|null}>;}).then(value=>setOrigin(value.origin)).catch(()=>{if(!controller.signal.aborted)setFailed(true);});return()=>controller.abort();},[sessionId,snapshotId]);
 return <div className="home-session-marker flex-wrap gap-2" title={snapshotId}>
  <span>来源快照 {snapshotId.slice(0,8)} · 独立 Worker 对话</span>
  {origin?.sourceExists && origin.sourceActive && origin.sourceRoomId ? <Link className="underline" href={`/chats?room=${encodeURIComponent(origin.sourceRoomId)}&session=${encodeURIComponent(origin.sourceSessionId)}`}>查看来源对话</Link> : origin?.sourceExists ? <span>切回来源项目后可查看</span> : origin ? <span>来源对话已删除，快照保留</span> : failed ? <span>来源信息暂不可用</span> : null}
 </div>;
}
