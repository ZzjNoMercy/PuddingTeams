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
import type { RoomSummary } from "@/lib/types";
import { compactTime } from "@/lib/time";
import { ManagerAvatar, MemberStack, WorkerAvatar } from "./worker-avatar";

function WindowRow({
	room,
	selected,
	onSelect,
	onDelete,
}: {
	room: RoomSummary;
	selected: boolean;
	onSelect: (id: string) => void;
	onDelete: (room: RoomSummary) => void;
}) {
	const members = room.members ?? [];
	const active = room.sessions.find((session) => session.active);
	const fallback = room.type === "group"
		? `${members.length} 位 Worker 共同协作`
		: room.type === "direct"
			? members[0]?.description || `与 ${members[0]?.name ?? "Worker"} 单聊`
			: "理解消息、组织协作并汇总结果";
	const subtitle = active?.name || (active?.firstMessage !== "新对话" ? active?.firstMessage : "") || fallback;
	const displayName = room.type === "direct" ? room.name.replace(/^与\s+(.+)\s+单聊$/, "$1") : room.name;

	return (
		<div className={`home-room-row group ${selected ? "is-selected" : ""}`}>
			<button type="button" onClick={() => onSelect(room.id)} className="home-room-select">
				<span className="home-room-avatar">
					{room.type === "group" ? (
						<MemberStack members={members} size={36} />
					) : room.type === "direct" ? (
						<WorkerAvatar name={members[0]!.name} size={36} />
					) : (
						<ManagerAvatar size={36} />
					)}
				</span>
				<span className="home-room-copy">
					<span className="home-room-title">{displayName}</span>
					<span className="home-room-preview">{subtitle}</span>
				</span>
				<span className="home-room-time">{compactTime(room.modifiedAt)}</span>
			</button>
			{!room.pinned ? (
				<button type="button" aria-label="删除对话" onClick={() => onDelete(room)} className="home-room-delete">
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
	open = true,
	onClose,
}: {
	rooms: RoomSummary[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
	open?: boolean;
	onClose?: () => void;
}) {
	const [pendingDelete, setPendingDelete] = useState<RoomSummary | null>(null);
	const [query, setQuery] = useState("");
	const visibleRooms = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return rooms;
		return rooms.filter((room) => {
			const haystack = [room.name, ...room.members.map((member) => member.name), ...room.sessions.map((session) => session.name || session.firstMessage)].join(" ");
			return haystack.toLocaleLowerCase().includes(normalized);
		});
	}, [query, rooms]);
	const solo = visibleRooms.filter((room) => room.type === "solo");
	const directs = visibleRooms.filter((room) => room.type === "direct");
	const groups = visibleRooms.filter((room) => room.type === "group");

	const renderRoom = (room: RoomSummary) => (
		<WindowRow
			key={room.id}
			room={room}
			selected={room.id === selectedId}
			onSelect={(id) => { onSelect(id); onClose?.(); }}
			onDelete={setPendingDelete}
		/>
	);

	return (
		<aside className={`home-rooms-panel ${open ? "max-md:flex" : "max-md:hidden"}`}>
			<div className="home-workspace-head">
				<h1>PuddingTeams</h1>
				<button type="button" onClick={onNew} aria-label="发起对话" title="发起对话" className="home-new-room"><PlusIcon /></button>
				<button type="button" onClick={onClose} aria-label="关闭对话列表" className="home-close-rooms md:hidden"><XIcon /></button>
			</div>
			<label className="home-room-search">
				<SearchIcon />
				<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索聊天" />
			</label>
			<div className="home-room-scroll">
				{solo.map(renderRoom)}
				{directs.length > 0 ? (
					<section className="home-room-section">
						<div className="home-room-section-title"><span>单聊</span><span>{directs.length}</span></div>
						{directs.map(renderRoom)}
					</section>
				) : null}
				{groups.length > 0 ? (
					<section className="home-room-section">
						<div className="home-room-section-title"><span>群聊</span><span>{groups.length}</span></div>
						{groups.map(renderRoom)}
					</section>
				) : null}
				{visibleRooms.length === 0 ? <p className="home-room-empty">没有匹配的聊天</p> : null}
			</div>

			<Dialog open={pendingDelete !== null} onOpenChange={(next) => !next && setPendingDelete(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除对话</DialogTitle>
						<DialogDescription>确定删除「{pendingDelete?.name || "新对话"}」吗？窗口内的全部会话将一并删除，无法恢复。</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingDelete(null)}>取消</Button>
						<Button type="button" variant="destructive" onClick={() => {
							if (pendingDelete) onDelete(pendingDelete.id);
							setPendingDelete(null);
						}}>删除</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</aside>
	);
}
