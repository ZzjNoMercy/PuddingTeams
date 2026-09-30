"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { toast } from "sonner";
import { ChatPane } from "@/components/chat/chat-pane";
import { CreateWindowDialog } from "@/components/chat/create-window-dialog";
import { SessionList } from "@/components/chat/session-list";
import { NavRail } from "@/components/chat/nav-rail";
import { QueryRouteObserver } from "@/components/chat/query-route-observer";
import { DesktopTitlebar, toggleAppSidebar, useAppSidebarHidden } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";
import { deleteRoom, listRooms } from "@/lib/api";
import { invalidChatSessionReplacement, selectChatRoomFromRoute } from "@/lib/chat-route-selection";
import { preferCurrentRoomSummary, reconcileRoomList, sortRoomsByActivity } from "@/lib/room-order";
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

function linkedRoomId(): string | null {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("room");
}

function linkedSessionId(): string | null {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("session");
}

function linkedReturnSessionId(): string | null {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("returnSession");
}

function currentQuery(): string {
	return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).toString();
}

function chatHref(roomId: string | null, sessionId: string | null, returnSessionId: string | null): string {
	const params = new URLSearchParams();
	if (roomId) params.set("room", roomId);
	if (sessionId) params.set("session", sessionId);
	if (returnSessionId) params.set("returnSession", returnSessionId);
	return params.toString() ? `/chats?${params.toString()}` : "/chats";
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
	const router = useRouter();
	const [rooms, setRooms] = useState<RoomSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const roomsRef = useRef(rooms);
	const selectedIdRef = useRef(selectedId);
	const [requestedSessionId, setRequestedSessionId] = useState<string | null>(() => linkedSessionId());
	const [returnSessionId, setReturnSessionId] = useState<string | null>(() => linkedReturnSessionId());
	const routeQuery = useRef(currentQuery());
	const [selectionNonce, setSelectionNonce] = useState(0);
	const [createOpen, setCreateOpen] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [hasLoadedRooms, setHasLoadedRooms] = useState(false);
	const [roomListRetry, setRoomListRetry] = useState(0);
	const [roomsOpen, setRoomsOpen] = useState(true);
	const sidebarHidden = useAppSidebarHidden();
	const roomListRequest = useRef(0);
	useEffect(() => { roomsRef.current = rooms; }, [rooms]);
	useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
	const selectRoom = useCallback((id: string | null) => {
		selectedIdRef.current = id;
		setSelectedId(id);
		setRequestedSessionId(null);
		persistActiveRoomId(id);
		const href = chatHref(id, null, returnSessionId);
		routeQuery.current = href.split("?")[1] ?? "";
		router.push(href);
	}, [router, returnSessionId]);
	const selectActivityRoom = useCallback((room: RoomSummary) => {
		const sessionId = room.activitySessionId && room.sessions.some((session) => session.id === room.activitySessionId)
			? room.activitySessionId : null;
		selectedIdRef.current = room.id;
		setSelectedId(room.id);
		setRequestedSessionId(sessionId);
		setSelectionNonce((value) => value + 1);
		persistActiveRoomId(room.id);
		const href = chatHref(room.id, sessionId, returnSessionId);
		routeQuery.current = href.split("?")[1] ?? "";
		router.push(href);
	}, [router, returnSessionId]);

	const onRouteChange = useCallback((query: string) => {
		if (routeQuery.current === query) return;
		routeQuery.current = query;
		const params = new URLSearchParams(query);
		const roomId = params.get("room");
		const returnId = params.get("returnSession");
		if (roomsRef.current.length) {
			const { roomId: fallback, staleLink } = selectChatRoomFromRoute(roomsRef.current, selectedIdRef.current, roomId, storedActiveRoomId(), false);
			if (staleLink || (!roomId && params.has("session"))) {
				selectedIdRef.current = fallback;
				setSelectedId(fallback);
				setRequestedSessionId(null);
				setReturnSessionId(returnId);
				setSelectionNonce((value) => value + 1);
				persistActiveRoomId(fallback);
				const href = chatHref(fallback, null, returnId);
				routeQuery.current = href.split("?")[1] ?? "";
				router.replace(href);
				return;
			}
			if (!roomId) {
				selectedIdRef.current = fallback;
				setSelectedId(fallback);
				setRequestedSessionId(null);
				setReturnSessionId(returnId);
				setSelectionNonce((value) => value + 1);
				persistActiveRoomId(fallback);
				return;
			}
		}
		selectedIdRef.current = roomId;
		setSelectedId(roomId);
		setRequestedSessionId(params.get("session"));
		setReturnSessionId(returnId);
		setSelectionNonce((value) => value + 1);
		if (roomId) persistActiveRoomId(roomId);
	}, [router]);
	const onInvalidRequestedSession = useCallback((roomId: string, sessionId: string) => {
		if (selectedIdRef.current !== roomId || routeQuery.current !== currentQuery()) return;
		const href = invalidChatSessionReplacement(currentQuery(), roomId, sessionId);
		if (!href) return;
		setRequestedSessionId(null);
		setSelectionNonce((value) => value + 1);
		routeQuery.current = href.split("?")[1] ?? "";
		router.replace(href);
	}, [router]);

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			const requestId = ++roomListRequest.current;
			return listRooms()
				.then((fetched) => {
					if (cancelled || requestId !== roomListRequest.current) return;
					const rooms = reconcileRoomList(roomsRef.current, fetched);
					roomsRef.current = rooms;
					setRooms(rooms);
					setHasLoadedRooms(true);
					setLoadError(null);
					// 刷新后优先恢复仍存在的 direct/group 房间；失效深链修正 URL。
					const previous = selectedIdRef.current;
					const stored = storedActiveRoomId();
					const linked = linkedRoomId();
					const navigationPending = currentQuery() !== routeQuery.current;
					const { roomId: next, staleLink } = selectChatRoomFromRoute(rooms, previous, linked, stored, navigationPending);
					persistActiveRoomId(next);
					selectedIdRef.current = next;
					setSelectedId(next);
					if (staleLink || (!navigationPending && !linked && linkedSessionId())) {
						setRequestedSessionId(null);
						const href = chatHref(next, null, linkedReturnSessionId());
						routeQuery.current = href.split("?")[1] ?? "";
						router.replace(href);
					}
				})
				.catch((err: unknown) => {
					if (cancelled || requestId !== roomListRequest.current) return;
					setLoadError(err instanceof Error ? err.message : String(err));
				});
		};
		load();
		// 轻量轮询：会话标题异步生成、active session 切换、消息活动时间都靠它
		// 刷到侧栏（chat-pane 头部已有同节奏轮询，节奏一致）。
		const timer = setInterval(load, 8000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [router, roomListRetry]);

	const upsertRoom = useCallback((room: RoomSummary) => {
		roomListRequest.current += 1;
		setRooms((prev) => {
			const hit = prev.find((r) => r.id === room.id);
			if (hit) return sortRoomsByActivity(prev.map((r) => (r.id === room.id ? preferCurrentRoomSummary(r, room) : r)));
			// Existing direct rooms can be absent from a stale local list too.
			// Show the selected room immediately; polling restores server order.
			return sortRoomsByActivity([room, ...prev]);
		});
		selectRoom(room.id);
	}, [selectRoom]);

	const handleNew = useCallback(() => setCreateOpen(true), []);

	// Open a window from inside the chat (e.g. solo DelegateCard "已同步到单聊"
	// link). The window may be brand-new (auto-created by solo routing), so the
	// sidebar list is refetched to pick it up.
	const openWindow = useCallback((id: string) => {
		selectRoom(id);
		const requestId = ++roomListRequest.current;
		listRooms()
			.then((fetched) => {
				if (requestId !== roomListRequest.current) return;
				const rooms = reconcileRoomList(roomsRef.current, fetched);
				roomsRef.current = rooms;
				setRooms(rooms);
				setHasLoadedRooms(true);
				setLoadError(null);
			})
			.catch((error: unknown) => {
				if (requestId === roomListRequest.current) setLoadError(error instanceof Error ? error.message : String(error));
			});
	}, [selectRoom]);

	// ChatPane renames/prompts a room in-place; push the fresh summary up so the
	// sidebar reflects it immediately instead of waiting for the poll.
	const handleRoomUpdated = useCallback((room: RoomSummary) => {
		roomListRequest.current += 1;
		setRooms((prev) => sortRoomsByActivity(prev.some((item) => item.id === room.id)
			? prev.map((item) => item.id === room.id ? preferCurrentRoomSummary(item, room) : item)
			: [...prev, room]));
	}, []);

	// manager 建房落定后立刻重拉房间列表，让新群聊马上出现在侧栏。
	const handleRoomsMayHaveChanged = useCallback(() => {
		const requestId = ++roomListRequest.current;
		listRooms()
			.then((fetched) => {
				if (requestId !== roomListRequest.current) return;
				const rooms = reconcileRoomList(roomsRef.current, fetched);
				roomsRef.current = rooms;
				setRooms(rooms);
				setHasLoadedRooms(true);
				setLoadError(null);
			})
			.catch((error: unknown) => {
				if (requestId === roomListRequest.current) setLoadError(error instanceof Error ? error.message : String(error));
			});
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await deleteRoom(id);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				return false;
			}
			roomListRequest.current += 1;
			const next = roomsRef.current.filter((room) => room.id !== id);
			roomsRef.current = next;
			setRooms(next);
			if (selectedIdRef.current === id) selectRoom(next[0]?.id ?? null);
			return true;
		},
		[selectRoom],
	);

	return (
		<div className="home-shell desktop-app-frame m1-app-shell h-dvh">
			<Suspense fallback={null}><QueryRouteObserver onChange={onRouteChange} /></Suspense>
			<DesktopTitlebar />
			<div className="desktop-app-body">
				{roomsOpen && !sidebarHidden ? <button type="button" className="home-rooms-backdrop fixed inset-0 z-30 bg-black/30 md:hidden" aria-label="关闭对话列表" onClick={() => setRoomsOpen(false)} /> : null}
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="chat" />
				</div>
				<div className="m1-chat-content flex min-w-0 min-h-0 flex-1 flex-col">
					<SectionTopbar title="对话" />
					<div className="m1-chat-columns flex min-h-0 min-w-0 flex-1">
						<SessionList
							rooms={rooms}
							selectedId={selectedId}
							onSelect={selectActivityRoom}
							onNew={handleNew}
							onDelete={handleDelete}
							loadError={loadError}
							listReady={hasLoadedRooms}
							onRetryLoad={() => setRoomListRetry((value) => value + 1)}
							open={roomsOpen}
							onClose={() => setRoomsOpen(false)}
						/>
						<main className="home-main-stage flex min-w-0 flex-1 flex-col">
							{returnSessionId ? <Link href={`/?session=${encodeURIComponent(returnSessionId)}`} className="flex min-h-10 items-center gap-2 border-b border-border/70 bg-background px-5 text-xs font-medium text-primary hover:bg-muted/50"><ArrowLeftIcon className="size-3.5" />返回 Manager 原工作</Link> : null}
							{selectedId ? (
								<ChatPane
									key={`${selectedId}:${requestedSessionId ?? ""}:${selectionNonce}`}
									roomId={selectedId}
									requestedSessionId={requestedSessionId}
									onInvalidRequestedSession={onInvalidRequestedSession}
									onOpenWindow={openWindow}
									onRoomUpdated={handleRoomUpdated}
									onSessionActivated={(updated) => {
										handleRoomUpdated(updated);
										setRequestedSessionId(updated.activeSession);
										const href = chatHref(updated.id, updated.activeSession, returnSessionId);
										routeQuery.current = href.split("?")[1] ?? "";
										router.push(href);
									}}
									onOpenRoomList={() => {
										if (sidebarHidden) toggleAppSidebar();
										setRoomsOpen(true);
									}}
									onRoomsMayHaveChanged={handleRoomsMayHaveChanged}
								/>
							) : (
								<div className="flex flex-1 flex-col items-center justify-center gap-4">
									<p className="text-sm text-muted-foreground">选择左侧窗口，或发起一个新对话</p>
									{loadError ? (
										<p className="text-xs text-destructive">
											无法连接 backend（{loadError}）。请确认 server 已启动。
										</p>
									) : null}
								</div>
							)}
						</main>
					</div>
				</div>
			</div>
			<CreateWindowDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={upsertRoom}
				initialWorkspaceId={rooms.find((room) => room.id === selectedId)?.workspace?.id}
			/>
		</div>
	);
}
