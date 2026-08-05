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

export function SessionList({
	rooms,
	selectedId,
	onSelect,
	onNew,
	onDelete,
	creating,
}: {
	rooms: RoomSummary[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
	creating: boolean;
}) {
	const [pendingDelete, setPendingDelete] = useState<RoomSummary | null>(null);

	return (
		<div className="flex h-full w-64 shrink-0 flex-col bg-muted/50">
			<div className="p-3">
				<Button type="button" onClick={onNew} disabled={creating} className="w-full">
					{creating ? "创建中…" : "+ 新对话"}
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{rooms.length === 0 ? (
					<p className="px-2 py-6 text-center text-xs text-muted-foreground">还没有对话</p>
				) : (
					rooms.map((room) => {
						const members = room.members ?? [];
						const isSingle = members.length === 1;
						const isGroup = members.length >= 2;
						const title =
							room.name ||
							(isSingle ? `与 ${members[0]?.name} 单聊` : isGroup ? "群聊" : "新对话");
						return (
							<div
								key={room.sessionId}
								className={`group relative mb-0.5 rounded-md ${
									room.sessionId === selectedId
										? "bg-accent text-accent-foreground"
										: "hover:bg-muted"
								}`}
							>
								<button
									type="button"
									onClick={() => onSelect(room.sessionId)}
									className="flex w-full items-start gap-2 px-2 py-2 pr-7 text-left"
								>
									{isGroup ? (
										<MemberStack members={members} size={22} className="mt-0.5" />
									) : isSingle ? (
										<WorkerAvatar name={members[0]!.name} size={26} className="mt-0.5" />
									) : (
										<ManagerAvatar size={26} className="mt-0.5" />
									)}
									<div className="min-w-0 flex-1">
										<div className="truncate text-sm font-medium">{title}</div>
										<div className="mt-0.5 truncate text-xs text-muted-foreground">
											{isGroup
												? `${members.length} 个成员 · ${members.map((m) => m.name).join("、")}`
												: isSingle
													? `与 ${members[0]?.name} 单聊`
													: "与 pi manager 对话"}
										</div>
										<div className="text-xs text-muted-foreground/60">
											{room.modifiedAt
												? new Date(room.modifiedAt).toLocaleString()
												: "刚刚"}
										</div>
									</div>
								</button>
								<button
									type="button"
									aria-label="删除对话"
									onClick={() => setPendingDelete(room)}
									className="absolute top-2 right-1.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
								>
									<XIcon className="size-3.5" />
								</button>
							</div>
						);
					})
				)}
			</div>

			<Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除对话</DialogTitle>
						<DialogDescription>
							确定删除「{pendingDelete?.name || "新对话"}」吗？该对话的历史记录将一并删除，无法恢复。
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
								if (pendingDelete) onDelete(pendingDelete.sessionId);
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
