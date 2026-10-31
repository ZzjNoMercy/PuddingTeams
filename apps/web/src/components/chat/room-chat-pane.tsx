"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	abortRoomTurn,
	closeUnknownRoomTurn,
	fetchRoomTimeline,
	forkRoomSession,
	getRoom,
	markRoomSessionRead,
	roomTimelineWsUrl,
	sendRoomMessage,
	setActiveRoomSession,
} from "@/lib/api";
import type { RoomEventView, RoomPublicTurn, RoomSummary, RoomTimelineSnapshot } from "@/lib/types";
import { agentDisplayName } from "@/lib/types";

/**
 * 群聊房间时间线：只消费 RoomEvent/PublicTurn，不读 Manager 私有 JSONL。
 * 首期 UI 提供结构化 @（成员按钮）、发送、停止与 unknown 解除。
 */
function mergeEvents(previous: RoomEventView[], next: RoomEventView[]): RoomEventView[] {
	if (!previous.length) return next;
	const byId = new Map(previous.map((event) => [event.id, event]));
	for (const event of next) byId.set(event.id, event);
	return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function RoomChatPane({
	room,
	requestedSessionId,
	onRoomUpdated,
	onSessionActivated,
	onInvalidRequestedSession,
}: {
	room: RoomSummary;
	requestedSessionId?: string | null;
	onRoomUpdated?: (room: RoomSummary) => void;
	onSessionActivated?: (room: RoomSummary) => void;
	onInvalidRequestedSession?: (roomId: string, sessionId: string) => void;
}) {
	const roomSessions = useMemo(() => room.roomSessions ?? [], [room.roomSessions]);
	const resolveSessionId = useCallback(() => {
		const ids = roomSessions.map((item) => item.roomSessionId);
		if (requestedSessionId && ids.includes(requestedSessionId)) return requestedSessionId;
		if (requestedSessionId) {
			const byManager = roomSessions.find((item) => item.managerParticipantSessionId === requestedSessionId);
			if (byManager) return byManager.roomSessionId;
		}
		if (room.activeRoomSessionId && ids.includes(room.activeRoomSessionId)) return room.activeRoomSessionId;
		return ids[0] ?? "";
	}, [requestedSessionId, room.activeRoomSessionId, roomSessions]);

	const [roomSessionId, setRoomSessionId] = useState(resolveSessionId);

	const [timeline, setTimeline] = useState<RoomTimelineSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const loading = timeline === null && error === null;
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [forking, setForking] = useState(false);
	const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
	const bottomRef = useRef<HTMLDivElement | null>(null);

	const load = useCallback(async () => {
		if (!roomSessionId) { setTimeline(null); return; }
		try {
			const next = await fetchRoomTimeline(room.id, roomSessionId);
			setTimeline((current) => current ? { ...next, events: mergeEvents(current.events, next.events), lastEventSeq: Math.max(current.lastEventSeq, next.lastEventSeq) } : next);
			setError(null);
			void markRoomSessionRead(room.id, roomSessionId);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	}, [room.id, roomSessionId]);

	useEffect(() => {
		const timer = setTimeout(() => { void load(); }, 0);
		return () => clearTimeout(timer);
	}, [load]);

	useEffect(() => {
		if (!roomSessionId) return;
		let disposed = false;
		let socket: WebSocket | undefined;
		let retry = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		const connect = () => {
		socket = new WebSocket(roomTimelineWsUrl(room.id, roomSessionId));
		socket.onmessage = (message) => {
			try {
				const payload = JSON.parse(message.data as string) as {
					type?: string; snapshot?: { events?: RoomEventView[]; activeTurn?: RoomPublicTurn };
					event?: RoomEventView; turn?: RoomPublicTurn; message?: string;
				};
				if (payload.type === "room_ready" && payload.snapshot) {
					setTimeline((current) => current ? {
						...current,
						events: mergeEvents(current.events, payload.snapshot!.events ?? []),
						activeTurn: payload.snapshot!.activeTurn,
						lastEventSeq: Math.max(current.lastEventSeq, ...(payload.snapshot!.events ?? []).map((event) => event.seq), 0),
					} : current);
					return;
				}
				if (payload.type === "room_event" && payload.event) {
					const event = payload.event;
					setTimeline((current) => {
						if (!current || current.events.some((item) => item.id === event.id)) return current;
						return { ...current, events: [...current.events, event], lastEventSeq: Math.max(current.lastEventSeq, event.seq) };
					});
					if (event.kind !== "message") void load();
					return;
				}
				if (payload.type === "participant_turn" && payload.turn) {
					const turn = payload.turn;
					setTimeline((current) => current ? {
						...current,
						activeTurn: ["admitted", "running", "waiting_input", "reconciling", "unknown"].includes(turn.status) ? turn : undefined,
						turns: [...current.turns.filter((item) => item.id !== turn.id), turn],
					} : current);
					if (!["admitted", "running", "waiting_input", "reconciling", "unknown"].includes(turn.status)) void load();
					return;
				}
				if (payload.type === "error" && payload.message) setError(payload.message);
			} catch { /* ignore malformed frame */ }
		};
		socket.onopen = () => { retry = 0; void load(); };
		socket.onerror = () => setError("房间实时连接失败");
		socket.onclose = () => {
			if (disposed) return;
			reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 10_000));
			retry += 1;
		};
		};
		connect();
		return () => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			socket?.close();
		};
	}, [load, room.id, roomSessionId]);

	useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [timeline?.events.length, timeline?.activeTurn?.status]);

	const activeTurn = timeline?.activeTurn;
	const recoveryRequired = Boolean(timeline?.capabilities.recoveryRequired);
	const canSend = Boolean(roomSessionId) && !activeTurn && !recoveryRequired && !sending;
	const labels = useMemo(() => {
		const map = new Map<string, string>();
		for (const member of room.members) map.set(member.name, agentDisplayName(member));
		map.set("manager", "Manager");
		return map;
	}, [room.members]);

	const actorLabel = useCallback((event: RoomEventView) => {
		if (event.actor.kind === "user") return "用户";
		if (event.actor.kind === "system") return "系统";
		return labels.get(event.actor.agentId ?? "") ?? event.actor.agentId ?? "Agent";
	}, [labels]);

	const handleSend = useCallback(async () => {
		const content = draft.trim();
		if (!content || !roomSessionId || !canSend) return;
		setSending(true);
		try {
			await sendRoomMessage(room.id, roomSessionId, {
				content,
				mentions: targetAgentId ? [targetAgentId] : [],
			}, crypto.randomUUID());
			setDraft("");
		} catch (caught) {
			toast.error(caught instanceof Error ? caught.message : String(caught));
		} finally { setSending(false); }
	}, [canSend, draft, room.id, roomSessionId, targetAgentId]);

	const handleStop = useCallback(async () => {
		if (!roomSessionId) return;
		try { await abortRoomTurn(room.id, roomSessionId); void load(); }
		catch (caught) { toast.error(caught instanceof Error ? caught.message : String(caught)); }
	}, [load, room.id, roomSessionId]);

	const handleCloseUnknown = useCallback(async () => {
		if (!roomSessionId || !activeTurn) return;
		try { await closeUnknownRoomTurn(room.id, roomSessionId, activeTurn.id, "用户确认远端无活动 Run"); void load(); }
		catch (caught) { toast.error(caught instanceof Error ? caught.message : String(caught)); }
	}, [activeTurn, load, room.id, roomSessionId]);

	const handleFork = useCallback(async () => {
		if (!roomSessionId) return;
		setForking(true);
		try {
			const forked = await forkRoomSession(room.id, roomSessionId, { operationKey: crypto.randomUUID() });
			const updated = await getRoom(room.id);
			onRoomUpdated?.(updated);
			onSessionActivated?.(updated);
			setRoomSessionId(forked.roomSessionId);
		} catch (caught) {
			toast.error(caught instanceof Error ? caught.message : String(caught));
		} finally { setForking(false); }
	}, [onRoomUpdated, onSessionActivated, room.id, roomSessionId]);

	const handleSessionChange = useCallback(async (nextRoomSessionId: string) => {
		setTimeline(null);
		setRoomSessionId(nextRoomSessionId);
		try {
			await setActiveRoomSession(room.id, nextRoomSessionId);
			const updated = await getRoom(room.id);
			onRoomUpdated?.(updated);
			onSessionActivated?.(updated);
		} catch (caught) {
			toast.error(caught instanceof Error ? caught.message : String(caught));
		}
	}, [onRoomUpdated, onSessionActivated, room.id]);

	const requestedResolved = !requestedSessionId
		|| roomSessions.some((item) => item.roomSessionId === requestedSessionId || item.managerParticipantSessionId === requestedSessionId);
	if (requestedSessionId && !requestedResolved) {
		return <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
			<p>指定的房间会话已不存在。</p>
			<Button size="sm" variant="outline" onClick={() => onInvalidRequestedSession?.(room.id, requestedSessionId)}>回到当前会话</Button>
		</div>;
	}

	if (!roomSessions.length) {
		return <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">此群聊还没有 RoomSession。</div>;
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center gap-3 border-b border-border/70 px-5 py-2">
				<span className="truncate text-sm font-medium">{room.name}</span>
				<Select value={roomSessionId} onValueChange={(value) => void handleSessionChange(value)}>
					<SelectTrigger className="h-8 w-[220px] text-xs"><SelectValue placeholder="选择房间会话" /></SelectTrigger>
					<SelectContent>
						{roomSessions.map((item) => <SelectItem key={item.roomSessionId} value={item.roomSessionId}>{item.name}</SelectItem>)}
					</SelectContent>
				</Select>
				<div className="ml-auto flex items-center gap-2">
					<Button size="sm" variant="outline" disabled={Boolean(activeTurn) || forking} onClick={() => void handleFork()}>{forking ? "Fork 中…" : "Fork"}</Button>
					{activeTurn ? <Button size="sm" variant="outline" onClick={() => void handleStop()}>停止</Button> : null}
					{activeTurn && ["unknown", "reconciling"].includes(activeTurn.status)
						? <Button size="sm" variant="outline" onClick={() => void handleCloseUnknown()}>确认无运行</Button> : null}
				</div>
			</header>
			{recoveryRequired ? (
				<div className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-xs text-amber-700">
					房间需要恢复：{timeline?.capabilities.recoveryReason ?? "请检查服务端日志"}
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{loading ? <p className="text-sm text-muted-foreground">正在加载房间时间线…</p> : null}
				{error ? <p className="text-sm text-destructive">{error}</p> : null}
				<div className="flex flex-col gap-3">
					{(timeline?.events ?? []).map((event) => (
						<div key={event.id} className={event.kind === "terminal" ? "text-xs text-muted-foreground" : "text-sm"}>
							<div className="mb-0.5 text-xs text-muted-foreground">{actorLabel(event)}</div>
							<div className="whitespace-pre-wrap break-words">{event.content}</div>
							{event.attachments?.length ? <div className="mt-1 flex flex-wrap gap-1">{event.attachments.map((item) => <span key={item.path} className="rounded border border-border px-1.5 py-0.5 text-xs">{item.name}</span>)}</div> : null}
						</div>
					))}
					{activeTurn ? <p className="text-xs text-muted-foreground">{labels.get(timeline?.participants.find((item) => item.agentSessionId === activeTurn.agentSessionId)?.agentId ?? "") ?? ""}{activeTurn.status === "running" ? "正在回复…" : activeTurn.status === "waiting_input" ? "等待输入/审批…" : activeTurn.status === "unknown" ? "执行结果未知，可确认无运行后解除" : "处理中…"}</p> : null}
					<div ref={bottomRef} />
				</div>
			</div>
			<div className="border-t border-border/70 px-5 py-3">
				<div className="mb-2 flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">发送给</span>
					<Button size="sm" variant={targetAgentId === null ? "secondary" : "outline"} onClick={() => setTargetAgentId(null)}>Manager</Button>
					{room.members.map((member) => (
						<Button key={member.name} size="sm" variant={targetAgentId === member.name ? "secondary" : "outline"} onClick={() => setTargetAgentId(member.name)}>@{agentDisplayName(member)}</Button>
					))}
				</div>
				<Textarea
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void handleSend();
						}
					}}
					placeholder={activeTurn ? "当前回合进行中；可停止或等待完成" : "输入消息，Enter 发送，Shift+Enter 换行"}
					disabled={!canSend}
					className="min-h-[72px]"
				/>
				<div className="mt-2 flex justify-end">
					<Button size="sm" disabled={!canSend || !draft.trim()} onClick={() => void handleSend()}>{sending ? "发送中…" : "发送"}</Button>
				</div>
			</div>
		</div>
	);
}
