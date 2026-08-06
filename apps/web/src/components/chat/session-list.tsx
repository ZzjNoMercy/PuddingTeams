"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
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
	const membersText =
		room.type === "group"
			? `${members.length} 个成员 · ${members.map((m) => m.name).join("、")}`
			: room.type === "direct"
				? `与 ${members[0]?.name} 单聊`
				: "与 pi manager 对话";
	// 第二行：active session 的标题/首条消息（会话上下文）；没有会话标题时退回
	// 成员摘要（群聊）或与窗口名去重后的类型描述。
	const active = room.sessions.find((s) => s.active);
	const sessionTitle = active?.name || (active?.firstMessage !== "新对话" ? active?.firstMessage : "") || "";
	const subtitle = sessionTitle || (room.type === "group" ? membersText : room.name !== membersText ? membersText : "");
	return (
		<div
			className={`group relative mb-0.5 rounded-md ${
				selected ? "bg-accent text-accent-foreground" : "hover:bg-muted"
			}`}
		>
			<button
				type="button"
				onClick={() => onSelect(room.id)}
				className="flex w-full items-start gap-2 px-2 py-2 pr-7 text-left"
			>
				{room.type === "group" ? (
					<MemberStack members={members} size={22} className="mt-0.5" />
				) : room.type === "direct" ? (
					<WorkerAvatar name={members[0]!.name} size={26} className="mt-0.5" />
				) : (
					<ManagerAvatar size={26} className="mt-0.5" />
				)}
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{room.name}</div>
					{subtitle ? (
						<div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
					) : null}
					<div className="text-xs text-muted-foreground/60 tabular-nums">
						{room.modifiedAt ? new Date(room.modifiedAt).toLocaleString() : "刚刚"}
					</div>
				</div>
			</button>
			{!room.pinned ? (
				<button
					type="button"
					aria-label="删除对话"
					onClick={() => onDelete(room)}
					className="absolute top-2 right-1.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
				>
					<XIcon className="size-3.5" />
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
}: {
	rooms: RoomSummary[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
}) {
	const [pendingDelete, setPendingDelete] = useState<RoomSummary | null>(null);
	const solo = rooms.filter((r) => r.type === "solo");
	const directs = rooms.filter((r) => r.type === "direct");
	const groups = rooms.filter((r) => r.type === "group");

	return (
		<div className="flex h-full w-64 shrink-0 flex-col bg-muted/50">
			<div className="p-3">
				<Button type="button" onClick={onNew} className="w-full">
					+ 发起对话
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{solo.map((room) => (
					<WindowRow
						key={room.id}
						room={room}
						selected={room.id === selectedId}
						onSelect={onSelect}
						onDelete={setPendingDelete}
					/>
				))}
				{directs.length > 0 ? (
					<div className="mt-3">
						<p className="px-2 pb-1 text-xs font-medium text-muted-foreground">单聊</p>
						{directs.map((room) => (
							<WindowRow
								key={room.id}
								room={room}
								selected={room.id === selectedId}
								onSelect={onSelect}
								onDelete={setPendingDelete}
							/>
						))}
					</div>
				) : null}
				{groups.length > 0 ? (
					<div className="mt-3">
						<p className="px-2 pb-1 text-xs font-medium text-muted-foreground">群聊</p>
						{groups.map((room) => (
							<WindowRow
								key={room.id}
								room={room}
								selected={room.id === selectedId}
								onSelect={onSelect}
								onDelete={setPendingDelete}
							/>
						))}
					</div>
				) : null}
				{rooms.length === 0 ? (
					<p className="px-2 py-6 text-center text-xs text-muted-foreground">还没有对话</p>
				) : null}
			</div>

			<Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除对话</DialogTitle>
						<DialogDescription>
							确定删除「{pendingDelete?.name || "新对话"}」吗？窗口内的全部会话将一并删除，无法恢复。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingDelete(null)}>
							取消
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								if (pendingDelete) onDelete(pendingDelete.id);
								setPendingDelete(null);
							}}
						>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
