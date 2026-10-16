"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GitBranchIcon, ArrowUpRightIcon } from "lucide-react";
import { SERVER_URL } from "@/lib/api";
import styles from "./snapshot-origin.module.css";

type Origin = { snapshotId: string; sourceSessionId: string; createdAt: string; sourceExists: boolean; sourceActive: boolean; sourceRoomId?: string; sourceAgentName?: string };

export function SnapshotOrigin({ sessionId, snapshotId }: { sessionId: string; snapshotId: string }) {
 const [origin, setOrigin] = useState<Origin | null>(null);
 const [failed, setFailed] = useState(false);
 useEffect(() => {
  const controller = new AbortController();
  void fetch(`${SERVER_URL}/api/sessions/${sessionId}/snapshot-origin`, { signal: controller.signal })
   .then(async response => { if (!response.ok) throw new Error("snapshot origin unavailable"); return response.json() as Promise<{ origin: Origin | null }>; })
   .then(value => { if (!controller.signal.aborted) setOrigin(value.origin); })
   .catch(() => { if (!controller.signal.aborted) setFailed(true); });
  return () => controller.abort();
 }, [sessionId, snapshotId]);
 const source = origin?.sourceAgentName ? `${origin.sourceAgentName} 原对话` : "来源对话";
 return <aside className={styles.banner} aria-label="快照分支来源">
  <GitBranchIcon className={styles.icon} aria-hidden="true" />
  <div className={styles.copy}><strong>{origin?.sourceAgentName ? `从 ${origin.sourceAgentName} 创建的快照分支` : "快照分支"}</strong><span>继承的历史保留在原对话中；在这里发送的新消息由当前 Worker 回复。</span>
   {origin?.sourceExists && origin.sourceRoomId ? <Link className={styles.link} href={`/chats?room=${encodeURIComponent(origin.sourceRoomId)}&session=${encodeURIComponent(origin.sourceSessionId)}`}>返回{source}<ArrowUpRightIcon aria-hidden="true" /></Link> : origin ? <span>来源对话已删除，历史快照仍保留。</span> : failed ? <span>来源信息暂不可用。</span> : null}
  </div>
 </aside>;
}
