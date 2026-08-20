"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChatPane } from "@/components/chat/chat-pane";
import { CreateWindowDialog } from "@/components/chat/create-window-dialog";
import { SessionList } from "@/components/chat/session-list";
import { NavRail } from "@/components/chat/nav-rail";
import { deleteRoom, listRooms } from "@/lib/api";
import type { RoomSummary } from "@/lib/types";

const ACTIVE_ROOM_STORAGE_KEY = "puddingteams:active-room";

function storedActiveRoomId(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(ACTIVE_ROOM_STORAGE_KEY);
	} catch {
		return null;
	}
}

function persistActiveRoomId(id: string | null): void {
	if (typeof window === "undefined") return;
	try {
		if (id) window.localStorage.setItem(ACTIVE_ROOM_STORAGE_KEY, id);
		else window.localStorage.removeItem(ACTIVE_ROOM_STORAGE_KEY);
	} catch {
		// Storage can be unavailable in hardened/private browser contexts. The
		// in-memory selection still works for the current page lifetime.
	}
}

export default function Home() {
	const [rooms, setRooms] = useState<RoomSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [roomsOpen, setRoomsOpen] = useState(true);
	const selectRoom = useCallback((id: string | null) => {
		setSelectedId(id);
		persistActiveRoomId(id);
	}, []);

	useEffect(() => {
		let cancelled = false;
		const load = () =>
			listRooms()
				.then((rooms) => {
					if (cancelled) return;
					setRooms(rooms);
					setLoadError(null);
					// 刷新后优先恢复最后打开且仍存在的房间。只有历史选择失效
					// （删除/换数据目录）时才回退到 solo manager。
					setSelectedId((prev) => {
						const stored = storedActiveRoomId();
						const next =
							(prev && rooms.some((room) => room.id === prev) ? prev : null) ??
							(stored && rooms.some((room) => room.id === stored) ? stored : null) ??
							rooms.find((room) => room.type === "solo")?.id ??
							rooms[0]?.id ??
							null;
						persistActiveRoomId(next);
						return next;
					});
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
		selectRoom(room.id);
	}, [selectRoom]);

	const handleNew = useCallback(() => setCreateOpen(true), []);

	// Open a window from inside the chat (e.g. solo DelegateCard "已同步到单聊"
	// link). The window may be brand-new (auto-created by solo routing), so the
	// sidebar list is refetched to pick it up.
	const openWindow = useCallback((id: string) => {
		selectRoom(id);
		listRooms()
			.then((rooms) => setRooms(rooms))
			.catch(() => undefined);
	}, [selectRoom]);

	// ChatPane renames/prompts a room in-place; push the fresh summary up so the
	// sidebar reflects it immediately instead of waiting for the poll.
	const handleRoomUpdated = useCallback((room: RoomSummary) => {
		setRooms((prev) => prev.map((r) => (r.id === room.id ? room : r)));
	}, []);

	// manager 建房落定后立刻重拉房间列表，让新群聊马上出现在侧栏。
	const handleRoomsMayHaveChanged = useCallback(() => {
		listRooms()
			.then((rooms) => setRooms(rooms))
			.catch(() => undefined);
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await deleteRoom(id);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				return;
			}
			const next = rooms.filter((room) => room.id !== id);
			setRooms(next);
			if (selectedId === id) selectRoom(next.find((room) => room.type === "solo")?.id ?? next[0]?.id ?? null);
		},
		[rooms, selectedId, selectRoom],
	);

	return (
		<div className="home-shell flex h-dvh">
			<NavRail view="chat" />
			{roomsOpen ? <button type="button" className="fixed inset-0 z-30 bg-black/30 md:hidden" aria-label="关闭对话列表" onClick={() => setRoomsOpen(false)} /> : null}
			<SessionList
				rooms={rooms}
				selectedId={selectedId}
				onSelect={selectRoom}
				onNew={handleNew}
				onDelete={handleDelete}
				open={roomsOpen}
				onClose={() => setRoomsOpen(false)}
			/>
			<main className="home-main-stage flex min-w-0 flex-1 flex-col">
				{selectedId ? (
					<ChatPane
						key={selectedId}
						roomId={selectedId}
						onOpenWindow={openWindow}
						onRoomUpdated={handleRoomUpdated}
						onOpenRoomList={() => setRoomsOpen(true)}
						onRoomsMayHaveChanged={handleRoomsMayHaveChanged}
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
		</div>
	);
}
