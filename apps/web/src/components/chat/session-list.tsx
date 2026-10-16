"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, CopyIcon, FolderOpenIcon, MessageCirclePlusIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, PlusIcon, SearchIcon, Settings2Icon, Trash2Icon, UsersRoundIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getRoom, deleteRoomSession, renameRoomSession } from "@/lib/api";
import { groupChatNavigation, navigationTitle, type ChatNavigationGroup, type ChatNavigationView, type NewChatTarget } from "@/lib/chat-navigation";
import { useChatNavigation } from "@/hooks/useChatNavigation";
import { homePortalContainer } from "@/lib/home-portal";
import { compactTime } from "@/lib/time";
import type { ChatNavigationItem, RoomSummary } from "@/lib/types";
import { ManagerAvatar, WorkerAvatar } from "./worker-avatar";
import styles from "./session-list.module.css";

const VIEW_KEY = "puddingteams:chat-navigation-view";
let memoryView: ChatNavigationView = "agent";
function storedView(): ChatNavigationView { try { const stored = window.localStorage.getItem(VIEW_KEY); return stored === "agent" || stored === "project" ? stored : memoryView; } catch { return memoryView; } }
function subscribeView(listener: () => void) {
 window.addEventListener("storage", listener); window.addEventListener(VIEW_KEY, listener);
 return () => { window.removeEventListener("storage", listener); window.removeEventListener(VIEW_KEY, listener); };
}
function avatar(agentId: string, size: number) { return agentId === "manager" ? <ManagerAvatar size={size} /> : <WorkerAvatar name={agentId} size={size} />; }

export function SessionList({ rooms, selectedId, selectedSessionId, onSelectSession, onNew, onDelete, onRoomUpdated, loadError, listReady = true, onRetryLoad, open = true, onClose }: {
 rooms: RoomSummary[]; selectedId: string | null; selectedSessionId: string | null;
 onSelectSession: (item: ChatNavigationItem) => void; onNew: (target?: NewChatTarget) => void;
 onDelete: (id: string) => Promise<boolean>; onRoomUpdated: (room: RoomSummary) => void;
 loadError?: string | null; listReady?: boolean; onRetryLoad?: () => void; open?: boolean; onClose?: () => void;
}) {
 const view = useSyncExternalStore(subscribeView, storedView, () => "agent" as ChatNavigationView);
 const navigation = useChatNavigation(rooms);
 const [archived, setArchived] = useState(false), [query, setQuery] = useState("");
 const [collapsed, setCollapsed] = useState<Set<string>>(new Set()), [expanded, setExpanded] = useState<Set<string>>(new Set());
 const [pendingDelete, setPendingDelete] = useState<{ room: RoomSummary; session?: ChatNavigationItem } | null>(null), [deleting, setDeleting] = useState(false);
 const [pendingSessionDelete, setPendingSessionDelete] = useState<ChatNavigationItem | null>(null), [deletingSession, setDeletingSession] = useState(false);
 const [renaming, setRenaming] = useState<ChatNavigationItem | null>(null), [renameValue, setRenameValue] = useState(""), [savingName, setSavingName] = useState(false);
 const groups = useMemo(() => groupChatNavigation(navigation.items, view, query, archived), [navigation.items, view, query, archived]);
 const archivedCount = navigation.items.filter(item => item.archived).length;
 const error = loadError || navigation.error;
 const toggle = (setter: typeof setCollapsed, id: string) => setter(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
 const chooseView = (next: ChatNavigationView) => {
  memoryView = next;
  try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* Keep the in-memory preference. */ }
  window.dispatchEvent(new Event(VIEW_KEY));
  const selectedGroup = groupChatNavigation(navigation.items, next, query, archived).find(group => group.items.some(item => item.sessionId === selectedSessionId));
  if (selectedGroup) {
   setCollapsed(previous => { const copy = new Set(previous); copy.delete(selectedGroup.id); return copy; });
   if (selectedGroup.items.findIndex(item => item.sessionId === selectedSessionId) >= 5) setExpanded(previous => new Set(previous).add(selectedGroup.id));
  }
 };
 const newInGroup = (group: ChatNavigationGroup) => onNew(group.agentId ? { agentId: group.agentId } : { workspaceId: group.workspaceId });
 const change = (item: ChatNavigationItem, patch: { pinned?: boolean; archived?: boolean }) => void navigation.change(item, patch);
 const renderItem = (item: ChatNavigationItem) => {
  const title = navigationTitle(item), selected = selectedId === item.roomId && selectedSessionId === item.sessionId;
  const room = rooms.find(current => current.id === item.roomId);
  const unread = room?.hasUnreadActivity && room.activitySessionId === item.sessionId;
  return <div key={item.sessionId} className={styles.row} data-selected={selected} data-session-id={item.sessionId}>
   <button type="button" className={styles.select} aria-current={selected ? "page" : undefined} aria-label={`打开聊天：${title}，${item.agentName}，${item.workspaceName}`} onClick={() => { onSelectSession(item); onClose?.(); }}>
    {view === "project" ? avatar(item.ownerAgentId, 22) : null}
    <span className={styles.copy}>
     <span className={styles.title}><span className={styles.titleText}>{title}</span>{item.pinned ? <PinIcon className={styles.pin} aria-label="已置顶" /> : null}{unread ? <i className={styles.unread} aria-label="有未读进展" /> : null}</span>
     <span className={styles.meta} title={item.cwdSnapshot}>{view === "agent" ? item.workspaceName : item.agentName}{item.roomType === "group" ? ` · ${item.roomName || "群聊"}` : ""}{item.modifiedAt ? ` · ${compactTime(item.modifiedAt)}` : ""}</span>
    </span>
   </button>
   <div className={styles.actions}>
    <button type="button" className={styles.icon} disabled={navigation.busyId !== null} title={item.pinned ? "取消置顶" : "置顶聊天"} aria-label={`${item.pinned ? "取消置顶" : "置顶"}：${title}`} onClick={() => change(item, { pinned: !item.pinned })}>{item.pinned ? <PinOffIcon /> : <PinIcon />}</button>
    <button type="button" className={styles.icon} disabled={navigation.busyId !== null} title={archived ? "恢复聊天" : "归档聊天"} aria-label={`${archived ? "恢复" : "归档"}：${title}`} onClick={() => change(item, { archived: !archived })}>{archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}</button>
    <DropdownMenu modal={false}><DropdownMenuTrigger asChild><button type="button" className={styles.icon} title="更多操作" aria-label={`更多操作：${title}`}><MoreHorizontalIcon /></button></DropdownMenuTrigger>
     <DropdownMenuContent className="home-menu min-w-44" align="end" container={homePortalContainer()}>
      <DropdownMenuItem disabled={navigation.busyId !== null} onSelect={() => change(item, { pinned: !item.pinned })}>{item.pinned ? <PinOffIcon /> : <PinIcon />}{item.pinned ? "取消置顶" : "置顶聊天"}</DropdownMenuItem>
      <DropdownMenuItem disabled={!item.contextActive} title={!item.contextActive ? "打开此项目的聊天后可重命名" : undefined} onSelect={() => { setRenaming(item); setRenameValue(title); }}><PencilIcon />重命名聊天</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => change(item, { archived: !archived })} disabled={navigation.busyId !== null}>{archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}{archived ? "恢复聊天" : "归档聊天"}</DropdownMenuItem>
      {archived && room ? <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={navigation.busyId !== null} onSelect={() => { if (room.sessions.length <= 1 && !room.pinned) setPendingDelete({ room, session: item }); else setPendingSessionDelete(item); }}><Trash2Icon />删除聊天…</DropdownMenuItem></> : null}
      {!archived && room && !room.pinned ? <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete({ room })}><Trash2Icon />删除所在对话窗口…</DropdownMenuItem></> : null}
     </DropdownMenuContent>
    </DropdownMenu>
   </div>
  </div>;
 };
 return <aside className={`home-rooms-panel ${styles.panel}`} data-open={open ? "true" : "false"} data-app-sidebar="rooms" data-app-sidebar-shell>
  <div className="home-room-toolbar">
   <label className="home-room-search"><SearchIcon /><input aria-label="搜索聊天" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索聊天" /></label>
   <button type="button" onClick={() => onNew()} aria-label="发起对话" title="发起对话" className="home-new-room"><PlusIcon /></button>
   <button type="button" onClick={onClose} aria-label="关闭对话列表" className="home-close-rooms md:hidden"><XIcon /></button>
  </div>
  <div className={styles.viewbar}>
   <div className={styles.views} role="group" aria-label="聊天列表视图"><button type="button" className={styles.view} aria-pressed={view === "agent"} onClick={() => chooseView("agent")}><UsersRoundIcon />Agent</button><button type="button" className={styles.view} aria-pressed={view === "project"} onClick={() => chooseView("project")}><FolderOpenIcon />项目</button></div>
   <button type="button" className={styles.archiveToggle} aria-label={archived ? "返回聊天" : "查看已归档聊天"} title={archived ? "返回聊天" : "已归档聊天"} aria-pressed={archived} onClick={() => setArchived(!archived)}><ArchiveIcon />{archivedCount ? <span>{archivedCount}</span> : null}</button>
  </div>
  {archived ? <div className={styles.archiveLabel}><span>已归档</span><span>可随时恢复</span></div> : null}
  <div className="home-room-scroll">
   {error ? <div className="home-room-load-error" role="alert"><span>对话列表暂时无法更新：{error}</span><button type="button" onClick={() => { onRetryLoad?.(); void navigation.refresh(); }}>重试</button></div> : null}
   {groups.map(group => {
    const isOpen = Boolean(query.trim()) || !collapsed.has(group.id), showAll = Boolean(query.trim()) || expanded.has(group.id);
    return <section key={group.id} className={styles.group} aria-label={`${group.name}分组`}>
     <div className={styles.header}>
      <button type="button" className={styles.groupToggle} title={group.detail} aria-expanded={isOpen} onClick={() => toggle(setCollapsed, group.id)}><ChevronDownIcon className={styles.chevron} />{group.agentId ? avatar(group.agentId, 24) : <FolderOpenIcon className={styles.folder} />}<span className={styles.groupName}>{group.name}</span><span className={styles.count}>{group.items.length}</span></button>
      <div className={styles.actions}>
       <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className={styles.icon} aria-label={`${group.name}更多操作`} title="更多操作"><MoreHorizontalIcon /></button></DropdownMenuTrigger><DropdownMenuContent className="home-menu min-w-44" align="end" container={homePortalContainer()}>
        <DropdownMenuItem disabled={group.agentEnabled === false} onSelect={() => newInGroup(group)}><MessageCirclePlusIcon />新建聊天</DropdownMenuItem>
        {group.agentId ? <DropdownMenuItem asChild><Link href={`/agents/config?name=${encodeURIComponent(group.agentId)}`}><Settings2Icon />智能体设置</Link></DropdownMenuItem> : <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(group.detail).then(() => toast.success("文件夹路径已复制"), () => toast.error("无法复制文件夹路径"))}><CopyIcon />复制文件夹路径</DropdownMenuItem>}
        <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => toggle(setCollapsed, group.id)}><ChevronDownIcon />{isOpen ? "折叠分组" : "展开分组"}</DropdownMenuItem>
       </DropdownMenuContent></DropdownMenu>
       <button type="button" className={styles.icon} disabled={group.agentEnabled === false} aria-label={`在${group.name}新建聊天`} title="新建聊天" onClick={() => newInGroup(group)}><MessageCirclePlusIcon /></button>
      </div>
     </div>
     {isOpen ? <div className={styles.list}>{(showAll ? group.items : group.items.slice(0, 5)).map(renderItem)}{group.items.length > 5 ? <button type="button" className={styles.more} onClick={() => toggle(setExpanded, group.id)}>{showAll ? "收起显示" : `展开显示其余 ${group.items.length - 5} 个聊天`}<ChevronDownIcon /></button> : null}</div> : null}
    </section>;
   })}
   {!groups.length && !error ? <p className={styles.empty} role={!listReady || !navigation.ready ? "status" : undefined}>{!listReady || !navigation.ready ? "正在加载对话…" : query ? "没有匹配的聊天" : archived ? "暂无已归档聊天" : "暂无聊天，点击 + 发起对话"}</p> : null}
  </div>
  <Dialog open={renaming !== null} onOpenChange={next => { if (!next && !savingName) setRenaming(null); }}><DialogContent><DialogHeader><DialogTitle>重命名聊天</DialogTitle><DialogDescription>修改当前聊天的显示名称。</DialogDescription></DialogHeader>
   <form onSubmit={event => {
    event.preventDefault(); if (!renaming || !renameValue.trim() || savingName) return;
    setSavingName(true);
    void renameRoomSession(renaming.roomId, renaming.sessionId, renameValue.trim()).then(async () => { setRenaming(null); await navigation.refresh(); onRoomUpdated(await getRoom(renaming.roomId)); }).catch(caught => toast.error(caught instanceof Error ? caught.message : String(caught))).finally(() => setSavingName(false));
   }}><Input autoFocus aria-label="聊天名称" value={renameValue} maxLength={60} onChange={event => setRenameValue(event.target.value)} /><DialogFooter className="mt-4"><Button type="button" variant="ghost" disabled={savingName} onClick={() => setRenaming(null)}>取消</Button><Button type="submit" disabled={!renameValue.trim() || savingName}>{savingName ? "保存中…" : "保存"}</Button></DialogFooter></form>
  </DialogContent></Dialog>
  <Dialog open={pendingDelete !== null} onOpenChange={next => { if (!next && !deleting) setPendingDelete(null); }}><DialogContent><DialogHeader><DialogTitle>{pendingDelete?.session ? "删除聊天" : "删除对话窗口"}</DialogTitle><DialogDescription>{pendingDelete?.session ? `确定删除「${navigationTitle(pendingDelete.session)}」吗？该聊天将永久删除，无法恢复。` : `确定删除「${pendingDelete?.room.name || "新对话"}」（${pendingDelete?.room.workspace?.name ?? "默认工作目录"}）吗？窗口内的全部会话将一并删除，无法恢复。`}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</Button><Button type="button" variant="destructive" disabled={deleting} onClick={() => { if (!pendingDelete || deleting) return; setDeleting(true); void onDelete(pendingDelete.room.id).then(deleted => { if (deleted) { setPendingDelete(null); void navigation.refresh(); } }).finally(() => setDeleting(false)); }}>{deleting ? "删除中…" : "删除"}</Button></DialogFooter></DialogContent></Dialog>
  <Dialog open={pendingSessionDelete !== null} onOpenChange={next => { if (!next && !deletingSession) setPendingSessionDelete(null); }}><DialogContent><DialogHeader><DialogTitle>删除聊天</DialogTitle><DialogDescription>确定删除「{pendingSessionDelete ? navigationTitle(pendingSessionDelete) : ""}」吗？该聊天的会话记录将永久删除，无法恢复；{pendingSessionDelete && rooms.find(current => current.id === pendingSessionDelete.roomId)?.pinned ? "将开启一个新的空聊天。" : "所在对话的其他聊天保留。"}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" disabled={deletingSession} onClick={() => setPendingSessionDelete(null)}>取消</Button><Button type="button" variant="destructive" disabled={deletingSession} onClick={() => {
   const item = pendingSessionDelete;
   if (!item || deletingSession) return;
   setDeletingSession(true);
   void (async () => {
    try {
     await deleteRoomSession(item.roomId, item.sessionId);
     const updated = await getRoom(item.roomId);
     setPendingSessionDelete(null);
     await navigation.refresh();
     onRoomUpdated(updated);
     // 删除的是当前打开的聊天时，跟随服务端口径落到窗口剩余的第一个会话。
     if (selectedId === item.roomId && selectedSessionId === item.sessionId) onSelectSession({ ...item, sessionId: updated.activeSession, archived: false });
    } catch (caught) {
     toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
     setDeletingSession(false);
    }
   })();
  }}>{deletingSession ? "删除中…" : "删除"}</Button></DialogFooter></DialogContent></Dialog>
 </aside>;
}
