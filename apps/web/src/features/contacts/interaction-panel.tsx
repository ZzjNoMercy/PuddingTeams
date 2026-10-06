"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, CalendarIcon, MapPinIcon, XIcon } from "lucide-react";
import { contactsRequest, type ContactEdgeDetail, type ContactGraphEdge } from "@/lib/contacts";
import styles from "./contacts-graph.module.css";

const statuses = { all: "全部", done: "已发生", planned: "计划", cancelled: "已取消", unknown: "待确认" };
function dateLabel(value: string | null) {
 if (!value) return "时间待确认";
 if (value.length === 10) return value;
 return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
export function InteractionPanel({ vault, revision, edge, names, selfName, onClose }: {
 vault: string; revision: number; edge: ContactGraphEdge; names: Map<string, string>; selfName: string; onClose: () => void;
}) {
 const [status, setStatus] = useState<keyof typeof statuses>("all"), [offset, setOffset] = useState(0), [retry, setRetry] = useState(0);
 const [result, setResult] = useState<{ key: string; data?: ContactEdgeDetail; error?: string } | null>(null);
 const key = JSON.stringify([vault, revision, edge.id, status, offset, retry]);
 useEffect(() => {
  let active = true;
  const query = new URLSearchParams({ vault, revision: String(revision), status, offset: String(offset) });
  void contactsRequest<ContactEdgeDetail>(`/graph/edges/${encodeURIComponent(edge.id)}?${query}`)
   .then(data => { if (active) setResult({ key, data }); })
   .catch(error => { if (active) setResult({ key, error: error instanceof Error ? error.message : "往来读取失败" }); });
  return () => { active = false; };
 }, [vault, revision, edge.id, status, offset, retry, key]);
 const current = result?.key === key ? result : null;
 const href = (note: string) => `/knowledge?${new URLSearchParams({ vault, note })}`;
 return <aside className={styles.evidence} aria-label="共同往来列表">
  <header><button className={styles.close} aria-label="关闭共同往来" onClick={onClose}><XIcon size={17} /></button>
   <h3>{names.get(edge.from)} <span>↔</span> {names.get(edge.to)}</h3>
   <p className={styles.counts}>已发生 {edge.doneCount} 次 · 计划 {edge.plannedCount} 次</p>
  </header>
  <div className={styles.statusTabs} aria-label="往来状态筛选">{Object.entries(statuses).map(([value, label]) => <button key={value} aria-pressed={status === value} onClick={() => { setStatus(value as keyof typeof statuses); setOffset(0); }}>{label}</button>)}</div>
  <div className={styles.evidenceBody}>
   {!current ? <p role="status">正在读取共同往来…</p> : current.error ? <div role="alert"><p>{current.error}</p><button onClick={() => setRetry(value => value + 1)}>重试读取</button></div> : <>
    {!current.data?.interactions.length && <p className={styles.noEvents}>暂无{status === "all" ? "共同" : statuses[status]}往来。</p>}
    {current.data?.interactions.map(item => <Link key={item.id} href={href(item.source.path)} className={styles.interaction}>
     <div className={styles.eventMeta}><time><CalendarIcon size={12} />{dateLabel(item.occurredAt)}</time><span data-status={item.status}>{statuses[item.status]}</span></div>
     <h4>{item.title.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")}<ArrowUpRightIcon size={14} /></h4>
     {item.location && <p className={styles.place}><MapPinIcon size={12} />{item.location}</p>}
     {item.summary && <p className={styles.eventSummary}>{item.summary}</p>}
     <p className={styles.participants}>参与人：{item.participants.map(person => person.isSelf ? selfName : person.name).join("、")}</p>
     <span className={styles.readRecord}>查看完整记录</span>
    </Link>)}
    {current.data && current.data.total > 20 && <div className={styles.pages}><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(current.data.total / 20)}</span><button disabled={current.data.nextOffset === null} onClick={() => setOffset(current.data!.nextOffset!)}>下一页</button></div>}
    {status === "all" && Boolean(current.data?.relations.length) && <section className={styles.directRelations}><h4>人物关系与引用</h4>{current.data?.relations.map((relation, i) => <Link key={i} href={href(relation.source.path)}><strong>{relation.label}</strong><span>{names.get(relation.from)} → {names.get(relation.to)}</span><span>查看来源<ArrowUpRightIcon size={12} /></span></Link>)}</section>}
   </>}
  </div>
 </aside>;
}
