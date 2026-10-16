"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArchiveIcon, ArrowLeftIcon, FolderOpenIcon, LoaderCircleIcon, MoreHorizontalIcon, RotateCcwIcon, SearchIcon, SlidersHorizontalIcon, Trash2Icon, UsersRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useChatNavigation } from "@/hooks/useChatNavigation";
import { applyArchivedChatAction } from "@/lib/archived-chat-actions";
import { archivedChatGroups, archivedReturnHref } from "@/lib/archived-chats";
import { navigationTitle } from "@/lib/chat-navigation";
import { homePortalContainer } from "@/lib/home-portal";
import type { ChatNavigationItem } from "@/lib/types";
import styles from "./page.module.css";

const timestamp = (value: string) => {
 const date = new Date(value);
 return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
};

function ArchivedChats() {
 const params = useSearchParams();
 const returnHref = archivedReturnHref(params.get("returnTo"));
 const navigation = useChatNavigation(0);
 const [query, setQuery] = useState(""), [agentId, setAgentId] = useState(""), [projectId, setProjectId] = useState("");
 const [pendingDelete, setPendingDelete] = useState<{ items: ChatNavigationItem[]; label: string } | null>(null);
 const [progress, setProgress] = useState<{ action: "restore" | "delete"; done: number; total: number } | null>(null);
 const [failures, setFailures] = useState<string[]>([]);
 const running = useRef(false), mounted = useRef(true);
 const refresh = navigation.refresh;
 useEffect(() => { mounted.current = true; const timer = setInterval(() => { if (!running.current) void refresh(); }, 8000); return () => { mounted.current = false; clearInterval(timer); }; }, [refresh]);
 const archived = navigation.items.filter(item => item.archived);
 const groups = useMemo(() => archivedChatGroups(navigation.items, query, agentId, projectId), [navigation.items, query, agentId, projectId]);
 const projects = useMemo(() => archivedChatGroups(navigation.items.map(item => ({ ...item, archived: true })), "", "", ""), [navigation.items]);
 const agents = [...new Map(navigation.items.map(item => [item.ownerAgentId, item.agentName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
 const visibleCount = groups.reduce((count, group) => count + group.items.length, 0);
 const busy = progress !== null;
 const run = async (items: ChatNavigationItem[], action: "restore" | "delete") => {
  if (running.current || !items.length) return;
  running.current = true; setProgress({ action, done: 0, total: items.length }); setFailures([]);
  const failed: string[] = [];
  try {
   for (const [index, item] of items.entries()) {
    try { await applyArchivedChatAction(item, action); }
    catch (error) { failed.push(`${navigationTitle(item)}：${error instanceof Error ? error.message : String(error)}`); }
    if (mounted.current) setProgress({ action, done: index + 1, total: items.length });
   }
   await refresh();
   if (mounted.current) {
    setPendingDelete(null); setFailures(failed);
    const succeeded = items.length - failed.length;
    if (succeeded) toast.success(`已${action === "restore" ? "恢复" : "删除"} ${succeeded} 个聊天${action === "restore" ? "，可从聊天列表继续" : ""}`);
    if (failed.length) toast.error(`${failed.length} 个聊天未${action === "restore" ? "恢复" : "删除"}，请查看详情后重试`);
   }
  } finally { running.current = false; if (mounted.current) setProgress(null); }
 };
 return <>
  <SectionTopbar crumbs={[{ label: "对话", href: returnHref }, { label: "已归档聊天" }]} />
  <div className={styles.scroll}>
   <div className={styles.content}>
    <Link href={returnHref} className={styles.back}><ArrowLeftIcon />返回聊天</Link>
    <header className={styles.heading}><div><h1>已归档聊天</h1><p>集中管理历史聊天，恢复后可继续对话。</p></div><Button variant="destructive" className={styles.deleteAll} disabled={busy || !archived.length || !navigation.ready} onClick={() => setPendingDelete({ items: [...archived], label: "全部已归档聊天" })}><Trash2Icon />全部删除</Button></header>
    <div className={styles.filters}>
     <label className={styles.search}><SearchIcon /><input aria-label="搜索已归档的聊天" placeholder="搜索已归档的聊天" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
     <label className={styles.select}><UsersRoundIcon /><select aria-label="筛选 Agent" value={agentId} disabled={busy} onChange={event => setAgentId(event.target.value)}><option value="">全部 Agent</option>{agentId && !agents.some(([id]) => id === agentId) ? <option value={agentId}>所选 Agent（已无聊天）</option> : null}{agents.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
     <label className={styles.select}><FolderOpenIcon /><select aria-label="筛选项目" value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}><option value="">所有项目</option>{projectId && !projects.some(group => group.id === projectId) ? <option value={projectId}>所选项目（已无聊天）</option> : null}{projects.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
    </div>
    {progress ? <p className={styles.status} role="status"><LoaderCircleIcon className="animate-spin" />正在{progress.action === "restore" ? "恢复" : "删除"}… {progress.done}/{progress.total}</p> : null}
    {navigation.error ? <div className={styles.error} role="alert"><span>{navigation.error}</span><Button variant="outline" onClick={() => void refresh()}>重试</Button></div> : null}
    {failures.length ? <div className={styles.error} role="alert"><strong>部分操作未完成</strong><ul>{failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul><Button variant="outline" onClick={() => setFailures([])}>收起详情</Button></div> : null}
    {!navigation.ready ? <div className={styles.empty} role="status"><LoaderCircleIcon className="animate-spin" /><h2>正在加载归档聊天…</h2></div> : null}
    {groups.map(group => <section className={styles.group} key={group.id} aria-label={`${group.name}的归档聊天`}>
     <header className={styles.groupHead}><FolderOpenIcon /><h2 title={group.detail}>{group.name}</h2><span>{group.items.length} 个聊天</span><DropdownMenu modal={false}><DropdownMenuTrigger asChild><button type="button" className={styles.icon} disabled={busy} aria-label={`${group.name}归档操作`}><MoreHorizontalIcon /></button></DropdownMenuTrigger><DropdownMenuContent container={homePortalContainer()} className="home-menu" align="end"><DropdownMenuItem onSelect={() => void run(group.items, "restore")}><RotateCcwIcon />恢复本组 {group.items.length} 个聊天</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete({ items: [...group.items], label: `「${group.name}」当前显示的归档聊天` })}><Trash2Icon />删除本组归档聊天…</DropdownMenuItem></DropdownMenuContent></DropdownMenu></header>
     <div className={styles.card}>{group.items.map(item => <article key={item.sessionId} className={styles.row} data-archived-session-id={item.sessionId}>
      <div className={styles.rowCopy}><h3 title={navigationTitle(item)}>{navigationTitle(item)}</h3><p><span>{timestamp(item.modifiedAt)}</span><span className={styles.agent}>{item.agentName}{item.sourceSnapshotId ? " · 快照分支" : ""}</span></p></div>
      <div className={styles.actions}><button type="button" className={styles.icon} disabled={busy} title="永久删除聊天" aria-label={`删除归档聊天：${navigationTitle(item)}`} onClick={() => setPendingDelete({ items: [item], label: `「${navigationTitle(item)}」` })}><Trash2Icon /></button><Button variant="secondary" className={styles.restore} disabled={busy} onClick={() => void run([item], "restore")} aria-label={`恢复聊天：${navigationTitle(item)}`}>取消归档</Button></div>
     </article>)}</div>
    </section>)}
    {navigation.ready && !navigation.error && !visibleCount ? <div className={styles.empty}><ArchiveIcon /><h2>{archived.length ? "没有匹配的归档聊天" : "暂无归档聊天"}</h2><p>{archived.length ? "试试其他关键词，或清除筛选条件。" : "归档后的聊天会显示在这里，可随时恢复。"}</p>{archived.length ? <Button variant="outline" onClick={() => { setQuery(""); setAgentId(""); setProjectId(""); }}><SlidersHorizontalIcon />清除筛选</Button> : <Button variant="outline" asChild><Link href={returnHref}>返回聊天</Link></Button>}</div> : null}
   </div>
  </div>
  <Dialog open={pendingDelete !== null} onOpenChange={next => { if (!next && !running.current) setPendingDelete(null); }}><DialogContent showCloseButton={!busy} onEscapeKeyDown={event => { if (running.current) event.preventDefault(); }} onPointerDownOutside={event => { if (running.current) event.preventDefault(); }}><DialogHeader><DialogTitle>永久删除{pendingDelete?.items.length === 1 ? "聊天" : "归档聊天"}</DialogTitle><DialogDescription>确定永久删除{pendingDelete?.label}（{pendingDelete?.items.length ?? 0} 个）吗？会话记录将被删除，无法恢复。未归档的聊天会保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" disabled={busy} onClick={() => setPendingDelete(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => { if (pendingDelete) void run(pendingDelete.items, "delete"); }}>{busy ? `删除中 ${progress?.done}/${progress?.total}` : "永久删除"}</Button></DialogFooter></DialogContent></Dialog>
 </>;
}

export default function ArchivedChatsPage() {
 return <div className={`home-shell desktop-app-frame m1-app-shell h-dvh ${styles.shell}`}><DesktopTitlebar /><div className="desktop-app-body"><div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell><NavRail view="chat" /></div><main className={styles.main}><Suspense fallback={<SectionTopbar title="已归档聊天" />}><ArchivedChats /></Suspense></main></div></div>;
}
