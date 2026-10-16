"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArchiveIcon, ArrowLeftIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useChatNavigation } from "@/hooks/useChatNavigation";
import { ChatPane } from "@/components/chat/chat-pane";
import { CreateWindowDialog } from "@/components/chat/create-window-dialog";
import { SessionList } from "@/components/chat/session-list";
import { NavRail } from "@/components/chat/nav-rail";
import { QueryRouteObserver } from "@/components/chat/query-route-observer";
import { DesktopTitlebar, toggleAppSidebar, useAppSidebarHidden } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";
import { createRoom, createRoomSession, deleteRoom, getManagerSessionLocation, getRoom, listRooms, setActiveRoomSession, switchRoomWorkspace } from "@/lib/api";
import { invalidChatSessionReplacement, selectChatRoomFromRoute } from "@/lib/chat-route-selection";
import { preferCurrentRoomSummary, reconcileRoomList, sortRoomsByActivity } from "@/lib/room-order";
import { LatestSerialQueue } from "@/lib/latest-serial-queue";
import type { NewChatTarget } from "@/lib/chat-navigation";
import type { ChatNavigationItem, RoomSummary } from "@/lib/types";

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
	const navigation = useChatNavigation(rooms);
	const roomsRef = useRef(rooms);
	const selectedIdRef = useRef(selectedId);
	// Static HTML and the first client render must use the same route state.
	// QueryRouteObserver restores deep links after hydration; null ensures its
	// first notification is processed, including an empty query string.
	const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
	const [returnSessionId, setReturnSessionId] = useState<string | null>(null);
	const routeQuery = useRef<string | null>(null);
	const [selectionNonce, setSelectionNonce] = useState(0);
	const [createOpen, setCreateOpen] = useState(false);
	const [createTarget, setCreateTarget] = useState<NewChatTarget>({});
	const selectionQueue = useRef(new LatestSerialQueue());
	const pendingNavigation = useRef<string | null>(null);
	const chatCreationPending = useRef(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [hasLoadedRooms, setHasLoadedRooms] = useState(false);
	const [roomListRetry, setRoomListRetry] = useState(0);
	const [roomsOpen, setRoomsOpen] = useState(true);
	const sidebarHidden = useAppSidebarHidden();
	const roomListRequest = useRef(0);
	useEffect(() => { roomsRef.current = rooms; }, [rooms]);
	useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
	const selectRoom = useCallback((id: string | null) => {
		selectionQueue.current.invalidate();
		selectedIdRef.current = id;
		setSelectedId(id);
		setRequestedSessionId(null);
		persistActiveRoomId(id);
		const href = chatHref(id, null, returnSessionId);
		routeQuery.current = href.split("?")[1] ?? "";
		router.push(href);
	}, [router, returnSessionId]);
	const selectSession = useCallback((item: Pick<ChatNavigationItem, "roomType" | "roomId" | "sessionId">, options?: { returnId: string | null; replace: boolean }) => {
		const navigationKey = `${item.roomId}:${item.sessionId}`;
		pendingNavigation.current = navigationKey;
		selectionQueue.current.invalidate();
		void selectionQueue.current.enqueue(async (isCurrent) => {
			try {
				if (item.roomType === "solo") {
					const location = await getManagerSessionLocation(item.roomId, item.sessionId);
					if (!isCurrent()) return;
					if (!location.active) await switchRoomWorkspace(item.roomId, location.workspaceId, "in_place");
				}
				if (!isCurrent()) return;
				let room = await getRoom(item.roomId);
				if (!isCurrent()) return;
				if (!room.sessions.some(session => session.id === item.sessionId)) throw new Error("聊天所在项目已变化，请刷新列表后重试");
				if (room.activeSession !== item.sessionId) {
					await setActiveRoomSession(room.id, item.sessionId);
					room = await getRoom(room.id);
				}
				if (!isCurrent()) return;
				roomListRequest.current++;
				setRooms(previous => sortRoomsByActivity(previous.map(current => current.id === room.id ? room : current)));
				selectedIdRef.current = room.id;
				setSelectedId(room.id);
				setRequestedSessionId(item.sessionId);
				setSelectionNonce(value => value + 1);
				persistActiveRoomId(room.id);
				const href = chatHref(room.id, item.sessionId, options ? options.returnId : returnSessionId);
				routeQuery.current = href.split("?")[1] ?? "";
				if (options?.replace) router.replace(href); else router.push(href);
			} catch (error) {
				if (!isCurrent()) return;
				toast.error(error instanceof Error ? error.message : String(error));
				if (options?.replace && (error as { status?: number }).status === 404) {
					selectedIdRef.current = item.roomId;
					setSelectedId(item.roomId);
					setRequestedSessionId(null);
					const href = chatHref(item.roomId, null, options.returnId);
					routeQuery.current = href.split("?")[1] ?? "";
					router.replace(href);
				}
			} finally { if (pendingNavigation.current === navigationKey) pendingNavigation.current = null; }
		});
	}, [router, returnSessionId]);
	useEffect(() => () => selectionQueue.current.invalidate(), []);

	const onRouteChange = useCallback((query: string) => {
		if (routeQuery.current === query) return;
		selectionQueue.current.invalidate();
		routeQuery.current = query;
		const params = new URLSearchParams(query);
		const roomId = params.get("room");
		const returnId = params.get("returnSession");
		const sessionId = params.get("session");
		if (roomId && sessionId && roomsRef.current.some(room => room.id === roomId && room.type === "solo")) {
			setReturnSessionId(returnId);
			selectSession({ roomId, sessionId, roomType: "solo" }, { returnId, replace: true });
			return;
		}
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
	}, [router, selectSession]);
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
					const linkedSession = linkedSessionId();
					const target = rooms.find(room => room.id === next);
					if (!navigationPending && !staleLink && linkedSession && target?.type === "solo" && !target.sessions.some(session => session.id === linkedSession)) {
						if (pendingNavigation.current !== `${target.id}:${linkedSession}`) selectSession({ roomId: target.id, sessionId: linkedSession, roomType: "solo" }, { returnId: linkedReturnSessionId(), replace: true });
						return;
					}
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
	}, [router, roomListRetry, selectSession]);

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

	// 侧栏 Agent 组的「新建聊天」：Agent 已确定，与聊天区右上角新会话同逻辑——
	// 直接创建/复用并打开，不再弹选择对话框。工作空间沿用当前选中房间的项目。
	const createChatForAgent = useCallback(async (agentId: string) => {
		if (chatCreationPending.current) return;
		chatCreationPending.current = true;
		const workspaceId = roomsRef.current.find(room => room.id === selectedIdRef.current)?.workspace?.id ?? null;
		try {
			let room: RoomSummary;
			if (agentId === "manager") {
				room = await getRoom("solo");
				if ((room.workspace?.id ?? null) !== workspaceId) {
					const switched = await switchRoomWorkspace(room.id, workspaceId, "in_place");
					room = switched.room;
					// 首次进入目标上下文时已自动建好第一个空会话，直接打开。
					if (!switched.restored) {
						upsertRoom(await getRoom(room.id));
						toast.success("已打开未开始的聊天");
						return;
					}
				}
			} else {
				const created = await createRoom({ type: "direct", members: [agentId], ...(workspaceId ? { workspaceId } : {}) });
				room = created.room;
			}
			const created = await createRoomSession(room.id, undefined, { workspaceId: room.workspace?.id ?? null, cwdSnapshot: room.cwdSnapshot });
			toast.success(created.reused
				? room.id === selectedIdRef.current && room.activeSession === created.id ? "已在新会话中" : "已打开现有空白会话"
				: "聊天已创建");
			upsertRoom(await getRoom(room.id));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally { chatCreationPending.current = false; }
	}, [upsertRoom]);

	const handleNew = useCallback((target?: NewChatTarget) => {
		if (target?.agentId) {
			void createChatForAgent(target.agentId);
			return;
		}
		const selected = roomsRef.current.find(room => room.id === selectedIdRef.current);
		setCreateTarget({ agentId: selected?.type === "solo" ? "manager" : selected?.type === "direct" ? selected.members[0]?.name : undefined, workspaceId: selected?.workspace?.id ?? null, ...target });
		setCreateOpen(true);
	}, [createChatForAgent]);

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

	const selectedSession = requestedSessionId ?? rooms.find(room => room.id === selectedId)?.activeSession ?? null;
	const archivedSelection = navigation.items.find(item => item.roomId === selectedId && item.sessionId === selectedSession && item.archived);
	const archiveHref = `/chats/archived?returnTo=${encodeURIComponent(chatHref(selectedId, selectedSession, returnSessionId))}`;

	return (
		<div className="home-shell desktop-app-frame m1-app-shell h-dvh">
			<Suspense fallback={null}><QueryRouteObserver onChange={onRouteChange} /></Suspense>
			<DesktopTitlebar />
			<div className="desktop-app-body">
				{roomsOpen && !sidebarHidden ? <button type="button" className="chat-navigation-backdrop home-rooms-backdrop fixed inset-0 z-30 bg-black/30 md:hidden" aria-label="关闭对话列表" onClick={() => setRoomsOpen(false)} /> : null}
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="chat" />
				</div>
				<div className="m1-chat-content flex min-w-0 min-h-0 flex-1 flex-col">
					<SectionTopbar title="对话" />
					<div className="m1-chat-columns flex min-h-0 min-w-0 flex-1">
						<SessionList
							rooms={rooms}
							navigation={navigation}
							archiveHref={archiveHref}
							selectedId={selectedId}
							selectedSessionId={requestedSessionId ?? rooms.find(room => room.id === selectedId)?.activeSession ?? null}
							onSelectSession={selectSession}
							onRoomUpdated={handleRoomUpdated}
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
							{archivedSelection ? (
								<div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center" aria-label="已归档聊天">
									<ArchiveIcon className="size-8 text-muted-foreground" />
									<h2 className="text-base font-medium">此聊天已归档</h2>
									<p className="text-sm text-muted-foreground">恢复后可继续对话。</p>
									<div className="flex gap-2"><Button disabled={navigation.busyId !== null} onClick={() => void navigation.change(archivedSelection, { archived: false })}>恢复聊天</Button><Button variant="outline" asChild><Link href={archiveHref}>管理已归档聊天</Link></Button></div>
								</div>
							) : !navigation.ready || (navigation.error && !navigation.items.length) ? (
								<div className="flex flex-1 flex-col items-center justify-center gap-3" role="status"><p className="text-sm text-muted-foreground">{navigation.error ?? "正在加载对话…"}</p>{navigation.error ? <Button variant="outline" onClick={() => void navigation.refresh()}>重试</Button> : null}</div>
							) : selectedId ? (
								<ChatPane
									key={`${selectedId}:${requestedSessionId ?? ""}:${selectionNonce}`}
									roomId={selectedId}
									requestedSessionId={requestedSessionId}
									onInvalidRequestedSession={onInvalidRequestedSession}
									onOpenWindow={openWindow}
									onRoomUpdated={handleRoomUpdated}
									onSessionActivated={(updated) => {
										handleRoomUpdated(updated);
										// 路由只指向普通会话。
										const viewed = updated.activeSession;
										setRequestedSessionId(viewed);
										const href = chatHref(updated.id, viewed, returnSessionId);
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
				initialWorkspaceId={createTarget.workspaceId}
				initialAgentId={createTarget.agentId}
				newSessionOnExisting
			/>
		</div>
	);
}
