"use client";

import { useMemo, useState } from "react";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { agentDisplayName, type RoomSummary } from "@/lib/types";
import { sessionTitle } from "@/lib/global-search-results";
import { compactTime } from "@/lib/time";
import { ManagerAvatar, MemberStack, WorkerAvatar } from "./worker-avatar";
import { MessagePreview } from "./message-preview";

function WindowRow({
	room,
	selected,
	onSelect,
	onDelete,
}: {
	room: RoomSummary;
	selected: boolean;
	onSelect: (room: RoomSummary) => void;
	onDelete: (room: RoomSummary) => void;
}) {
	const members = room.members ?? [];
	const directMemberName = members[0]?.name ?? "Worker";
	const active = room.sessions.find((session) => session.active);
	const fallback = room.type === "group"
		? `${members.length} 位 Worker 共同协作`
		: room.type === "direct"
			? members[0]?.description || `与 ${members[0] ? agentDisplayName(members[0]) : "Worker"} 单聊`
			: "理解消息、组织协作并汇总结果";
	const fromOtherSession = Boolean(room.activitySessionId && room.activitySessionId !== room.activeSession);
	const subtitle = room.lastMessagePreview || (active ? sessionTitle(active.name, active.firstMessage) : null) || fallback;
	const displayName = (room.type === "solo" ? "Manager" : room.type === "direct" ? room.name.replace(/^与\s+(.+)\s+单聊$/, "$1") : room.name).trim() || fallback;
	const workspaceName = room.workspace?.name ?? "默认工作目录";

	return (
		<div className={`home-room-row group ${selected ? "is-selected" : ""}`}>
			<button type="button" onClick={() => onSelect(room)} className="home-room-select" aria-label={`${displayName}，${workspaceName}，${room.hasUnreadActivity ? "有未读进展，" : ""}${fromOtherSession ? "其他会话，" : ""}${subtitle}`} aria-current={selected ? "true" : undefined}>
				<span className="home-room-avatar">
					{room.type === "group" ? (
						<MemberStack members={members} size={40} />
					) : room.type === "direct" ? (
						<WorkerAvatar name={directMemberName} size={40} />
					) : (
						<ManagerAvatar size={40} />
					)}
				</span>
				<span className="home-room-copy">
					<span className="home-room-title">{displayName}{room.hasUnreadActivity ? <><i className="home-room-unread" aria-hidden="true" /><span className="sr-only">，有未读进展</span></> : null}</span>
					{/* 工作目录不进列表项：它是一条常驻的第三行，读起来像状态而不是内容，
					    而且多数房间的标题已经指向同一个项目。仍留在 aria-label 与删除
					    确认里——不可见不等于不可访问，删除时也要能分辨是哪个目录。 */}
					<span className="home-room-preview" title={workspaceName}>{fromOtherSession ? room.hasUnreadActivity ? "其他会话有未读进展 · " : "其他会话 · " : ""}<MessagePreview content={subtitle} /></span>
				</span>
				<span className="home-room-time">{compactTime(room.modifiedAt)}</span>
			</button>
			{!room.pinned ? (
				<button type="button" aria-label={`删除对话：${displayName}，${room.workspace?.name ?? "默认工作目录"}`} onClick={() => onDelete(room)} className="home-room-delete">
					<XIcon />
				</button>
			) : null}
		</div>
	);
}

export function SessionList({
	rooms,
	selectedId,
	onSelect,
	onNew,
	onDelete,
	loadError,
	listReady = true,
	onRetryLoad,
	open = true,
	onClose,
}: {
	rooms: RoomSummary[];
	selectedId: string | null;
	onSelect: (room: RoomSummary) => void;
	onNew: () => void;
	onDelete: (id: string) => Promise<boolean>;
	loadError?: string | null;
	listReady?: boolean;
	onRetryLoad?: () => void;
	open?: boolean;
	onClose?: () => void;
}) {
	const [pendingDelete, setPendingDelete] = useState<RoomSummary | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [query, setQuery] = useState("");
	const visibleRooms = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return rooms;
		return rooms.filter((room) => {
			const haystack = [room.name, room.workspace?.name ?? "", room.lastMessagePreview, ...room.members.map((member) => agentDisplayName(member)), ...room.sessions.flatMap((session) => [session.name, session.firstMessage])].join(" ");
			return haystack.toLocaleLowerCase().includes(normalized);
		});
	}, [query, rooms]);
	// solo Manager 是置顶单例（原型同款），其余对话按活动时间排在「最近对话」里。
	const pinnedRooms = visibleRooms.filter((room) => room.type === "solo");
	const conversations = visibleRooms.filter((room) => room.type !== "solo");

	const renderRoom = (room: RoomSummary) => (
		<WindowRow
			key={room.id}
			room={room}
			selected={room.id === selectedId}
			onSelect={(selectedRoom) => { onSelect(selectedRoom); onClose?.(); }}
			onDelete={setPendingDelete}
		/>
	);

	return (
		<aside className="home-rooms-panel" data-open={open ? "true" : "false"} data-app-sidebar="rooms" data-app-sidebar-shell>
			<div className="home-room-toolbar">
				<label className="home-room-search">
					<SearchIcon />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索聊天" />
				</label>
				<button type="button" onClick={onNew} aria-label="发起对话" title="发起对话" className="home-new-room"><PlusIcon /></button>
				<button type="button" onClick={onClose} aria-label="关闭对话列表" className="home-close-rooms md:hidden"><XIcon /></button>
			</div>
		<div className="home-room-scroll">
			{loadError ? <div className="home-room-load-error" role="alert"><span>对话列表暂时无法更新：{loadError}</span>{onRetryLoad ? <button type="button" onClick={onRetryLoad}>重试</button> : null}</div> : null}
					{pinnedRooms.length > 0 ? (
						<section className="home-room-section home-room-section-pinned">
							{pinnedRooms.map(renderRoom)}
						</section>
					) : null}
					{conversations.length > 0 ? (
						<section className="home-room-section">
							<div className="home-room-section-title"><span>最近对话</span><span>{conversations.length}</span></div>
							{conversations.map(renderRoom)}
				</section>
			) : null}
					{pinnedRooms.length === 0 && conversations.length === 0 && !loadError ? <p className="home-room-empty" role={!listReady ? "status" : undefined}>{listReady ? "没有匹配的聊天" : "正在加载对话…"}</p> : null}
			</div>

			<Dialog open={pendingDelete !== null} onOpenChange={(next) => { if (!next && !deleting) setPendingDelete(null); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除对话</DialogTitle>
						<DialogDescription>确定删除「{pendingDelete?.name || "新对话"}」（{pendingDelete?.workspace?.name ?? "默认工作目录"}）吗？窗口内的全部会话将一并删除，无法恢复。</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</Button>
						<Button type="button" variant="destructive" disabled={deleting} onClick={() => {
							if (!pendingDelete || deleting) return;
							setDeleting(true);
							void onDelete(pendingDelete.id).then((deleted) => {
								if (deleted) setPendingDelete(null);
							}).finally(() => setDeleting(false));
						}}>{deleting ? "删除中…" : "删除"}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</aside>
	);
}
