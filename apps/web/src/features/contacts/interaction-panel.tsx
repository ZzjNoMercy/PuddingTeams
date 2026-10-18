"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, CalendarIcon, MapPinIcon, UsersIcon } from "lucide-react";
import { contactsRequest, type ContactEdgeDetail, type ContactGraphEdge } from "@/lib/contacts";
import { ContactPreviewDialog } from "./contact-preview-dialog";
import styles from "./interaction-panel.module.css";

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
 const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
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
 const items = current?.data?.interactions ?? [];
 const selected = (selection?.key === key && items.find(item => item.id === selection.id)) || items[0];
 const href = (note: string) => `/knowledge?${new URLSearchParams({ vault, note })}`;
 const title = `${names.get(edge.from) ?? "人物"} ↔ ${names.get(edge.to) ?? "人物"}`;
 return <ContactPreviewDialog title={`${title}的共同往来`} description="按状态浏览共同往来，选择记录查看详情" onClose={onClose}>
  <header className={styles.header}><span className={styles.eyebrow}>共同往来</span><h2>{title}</h2><p>已发生 {edge.doneCount} 次 · 计划 {edge.plannedCount} 次</p></header>
  <div className={styles.statusTabs} aria-label="往来状态筛选">{Object.entries(statuses).map(([value, label]) => <button key={value} aria-pressed={status === value} onClick={() => { setStatus(value as keyof typeof statuses); setOffset(0); }}>{label}</button>)}</div>
  {!current ? <p className={styles.message} role="status">正在读取共同往来…</p> : current.error ? <div className={styles.message} role="alert"><p>{current.error}</p><button onClick={() => setRetry(value => value + 1)}>重试读取</button></div> : <div className={styles.workspace}>
   <aside className={styles.listPane} aria-label="共同往来列表"><div className={styles.listHeading}>往来记录 <span>{current.data?.total ?? 0}</span></div>
    <div className={styles.list} key={key}>
     {!items.length && <p className={styles.empty}>暂无{status === "all" ? "共同" : statuses[status]}往来。</p>}
     {items.map(item => <button key={item.id} className={styles.record} aria-label={`${dateLabel(item.occurredAt)} · ${item.title} · ${statuses[item.status]}`} aria-pressed={selected?.id === item.id} onClick={() => setSelection({ key, id: item.id })}>
      <span className={styles.recordMeta}><time>{dateLabel(item.occurredAt)}</time><span>{statuses[item.status]}</span></span>
      <strong>{item.title.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")}</strong>
      {(item.summary || item.location) && <span className={styles.excerpt}>{item.summary || item.location}</span>}
     </button>)}
    </div>
    {current.data && current.data.total > 20 && <nav className={styles.pages} aria-label="往来分页"><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(current.data.total / 20)}</span><button disabled={current.data.nextOffset === null} onClick={() => setOffset(current.data!.nextOffset!)}>下一页</button></nav>}
   </aside>
   <article className={styles.detail} key={`${key}:${selected?.id ?? "empty"}`} aria-label="往来详情">
    {selected ? <><div className={styles.detailMeta}><span data-status={selected.status}>{statuses[selected.status]}</span><time><CalendarIcon size={13} />{dateLabel(selected.occurredAt)}</time></div>
     <h3>{selected.title.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")}</h3>
     <dl className={styles.facts}>{selected.location && <div><dt><MapPinIcon size={14} />地点</dt><dd>{selected.location}</dd></div>}<div><dt><UsersIcon size={14} />参与人</dt><dd>{selected.participants.map(person => person.isSelf ? selfName : person.name).join("、") || "未记录"}</dd></div></dl>
     {selected.summary && <section className={styles.summary}><h4>往来摘要</h4><p>{selected.summary}</p></section>}
     <Link href={href(selected.source.path)} className={styles.source}>打开原始记录<ArrowUpRightIcon size={14} /></Link>
    </> : <p className={styles.empty}>没有可查看的往来记录。</p>}
    {status === "all" && Boolean(current.data?.relations.length) && <section className={styles.relations}><h4>人物关系与引用</h4>{current.data?.relations.map((relation, i) => <Link key={i} href={href(relation.source.path)}><strong>{relation.label}</strong><span>{names.get(relation.from)} → {names.get(relation.to)}</span><ArrowUpRightIcon size={13} /></Link>)}</section>}
   </article>
  </div>}
 </ContactPreviewDialog>;
}
