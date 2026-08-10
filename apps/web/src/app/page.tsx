"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentsPane } from "@/components/agents/agents-pane";
import { ChatPane } from "@/components/chat/chat-pane";
import { CreateWindowDialog } from "@/components/chat/create-window-dialog";
import { SessionList } from "@/components/chat/session-list";
import { NavRail, type AppView } from "@/components/chat/nav-rail";
import { deleteRoom, listRooms } from "@/lib/api";
import type { RoomSummary } from "@/lib/types";

export default function Home() {
	const [rooms, setRooms] = useState<RoomSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [view, setView] = useState<AppView>("chat");
	const [createOpen, setCreateOpen] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const load = () =>
			listRooms()
				.then((rooms) => {
					if (cancelled) return;
					setRooms(rooms);
					setLoadError(null);
					// 默认选中 solo 置顶单例（若无则第一个）；已有选中时不动。
					setSelectedId((prev) => prev ?? rooms.find((r) => r.type === "solo")?.id ?? rooms[0]?.id ?? null);
				})
				.catch((err: unknown) => {
					if (cancelled) return;
					setLoadError(err instanceof Error ? err.message : String(err));
				});
		load();
		// 轻量轮询：会话标题异步生成、active session 切换、消息活动时间都靠它
		// 刷到侧栏（chat-pane 头部已有同节奏轮询，节奏一致）。
		const timer = setInterval(load, 8000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	const upsertRoom = useCallback((room: RoomSummary, existed: boolean) => {
		setRooms((prev) => {
			const hit = prev.find((r) => r.id === room.id);
			if (hit) return prev.map((r) => (r.id === room.id ? room : r));
			// 新窗口插到列表头；solo 永远在最上（后端排序兜底）。
			return existed ? prev : [room, ...prev];
		});
		setSelectedId(room.id);
	}, []);

	const handleNew = useCallback(() => setCreateOpen(true), []);

	// Open a window from inside the chat (e.g. solo DelegateCard "已同步到单聊"
	// link). The window may be brand-new (auto-created by solo routing), so the
	// sidebar list is refetched to pick it up.
	const openWindow = useCallback((id: string) => {
		setView("chat");
		setSelectedId(id);
		listRooms()
			.then((rooms) => setRooms(rooms))
			.catch(() => undefined);
	}, []);

	// ChatPane renames/prompts a room in-place; push the fresh summary up so the
	// sidebar reflects it immediately instead of waiting for the poll.
	const handleRoomUpdated = useCallback((room: RoomSummary) => {
		setRooms((prev) => prev.map((r) => (r.id === room.id ? room : r)));
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await deleteRoom(id);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				return;
			}
			setRooms((prev) => {
				const next = prev.filter((r) => r.id !== id);
				if (selectedId === id) setSelectedId(next.find((r) => r.type === "solo")?.id ?? next[0]?.id ?? null);
				return next;
			});
		},
		[selectedId],
	);

	return (
		<div className="flex h-dvh">
			<NavRail view={view} onView={setView} />
			{view === "chat" ? (
				<>
					<SessionList
						rooms={rooms}
						selectedId={selectedId}
						onSelect={setSelectedId}
						onNew={handleNew}
						onDelete={handleDelete}
					/>
					<main className="flex min-w-0 flex-1 flex-col bg-background">
						{selectedId ? (
							<ChatPane
								key={selectedId}
								roomId={selectedId}
								onOpenWindow={openWindow}
								onRoomUpdated={handleRoomUpdated}
							/>
						) : (
							<div className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/30">
								<p className="text-sm text-muted-foreground">选择左侧窗口，或发起一个新对话</p>
								{loadError ? (
									<p className="text-xs text-destructive">
										无法连接 backend（{loadError}）。请确认 server 已启动。
									</p>
								) : null}
							</div>
						)}
					</main>
					<CreateWindowDialog
						open={createOpen}
						onOpenChange={setCreateOpen}
						onCreated={upsertRoom}
					/>
				</>
			) : (
				<main className="flex min-w-0 flex-1 flex-col bg-background">
					<AgentsPane />
				</main>
			)}
		</div>
	);
}
