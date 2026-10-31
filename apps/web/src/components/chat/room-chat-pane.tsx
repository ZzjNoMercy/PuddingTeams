"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	abandonGoal,
	abortRoomTurn,
	createRoomGoal,
	resumeGoal,
	supersedeGoal,
	closeUnknownRoomTurn,
	fetchRoomGoal,
	fetchRoomSummary,
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
	const [goal, setGoal] = useState<{ goal: string; completionBoundary: string; status: string; goalId: string; revision: number; executionStatus?: string; managerParticipantSessionId: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const loading = timeline === null && error === null;
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [forking, setForking] = useState(false);
	const [goalOpen, setGoalOpen] = useState(false);
	const [goalDraft, setGoalDraft] = useState("");
	const [boundaryDraft, setBoundaryDraft] = useState("");
	const [creatingGoal, setCreatingGoal] = useState(false);
	const [replacingGoal, setReplacingGoal] = useState(false);
	const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
	const bottomRef = useRef<HTMLDivElement | null>(null);
	const loadGeneration = useRef(0);
	const forkKeyRef = useRef<string | null>(null);

	const load = useCallback(async () => {
		const generation = ++loadGeneration.current;
		if (!roomSessionId) { setTimeline(null); return; }
		try {
			const next = await fetchRoomTimeline(room.id, roomSessionId);
			if (generation !== loadGeneration.current) return;
			let currentGoal: Awaited<ReturnType<typeof fetchRoomGoal>> = null;
			try { currentGoal = await fetchRoomGoal(room.id, roomSessionId); }
			catch { currentGoal = null; }
			if (generation !== loadGeneration.current) return;
			setTimeline((current) => current ? { ...next, events: mergeEvents(current.events, next.events), lastEventSeq: Math.max(current.lastEventSeq, next.lastEventSeq) } : next);
			setGoal(currentGoal);
			setError(null);
			void markRoomSessionRead(room.id, roomSessionId);
		} catch (caught) {
			if (generation !== loadGeneration.current) return;
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
	const canSend = Boolean(roomSessionId) && !recoveryRequired && !sending;
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
		const activeAgentId = activeTurn ? timeline?.participants.find((item) => item.agentSessionId === activeTurn.agentSessionId)?.agentId : undefined;
		if (activeTurn && targetAgentId && activeAgentId && targetAgentId !== activeAgentId) {
			toast.error(`当前回合属于 @${agentDisplayName(room.members.find((member) => member.name === activeAgentId) ?? { name: activeAgentId })}，followUp 只能发给同一 Participant`);
			return;
		}
		setSending(true);
		try {
			await sendRoomMessage(room.id, roomSessionId, {
				content,
				mentions: targetAgentId ? [targetAgentId] : [],
				...(activeTurn ? { delivery: "followUp" as const, expectedParticipantTurnId: activeTurn.id } : {}),
			}, crypto.randomUUID());
			setDraft("");
		} catch (caught) {
			toast.error(caught instanceof Error ? caught.message : String(caught));
		} finally { setSending(false); }
	}, [activeTurn, canSend, draft, room.id, roomSessionId, targetAgentId, timeline?.participants, room.members]);

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
		const operationKey = forkKeyRef.current ?? crypto.randomUUID();
		forkKeyRef.current = operationKey;
		try {
			const forked = await forkRoomSession(room.id, roomSessionId, { operationKey });
			forkKeyRef.current = null;
			const updated = await getRoom(room.id);
			onRoomUpdated?.(updated);
			onSessionActivated?.(updated);
			setRoomSessionId(forked.roomSessionId);
		} catch (caught) {
			toast.error(caught instanceof Error ? caught.message : String(caught));
		} finally { setForking(false); }
	}, [onRoomUpdated, onSessionActivated, room.id, roomSessionId]);

	const handleSessionChange = useCallback(async (nextRoomSessionId: string) => {
		loadGeneration.current += 1;
		setTimeline(null);
		setGoal(null);
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
					<Button size="sm" variant="outline" onClick={() => setGoalOpen(true)}>{goal ? "Goal…" : "设 Goal"}</Button>
					<Button size="sm" variant="outline" onClick={() => {
						if (!roomSessionId) return;
						void fetchRoomSummary(room.id, roomSessionId)
							.then((summary) => navigator.clipboard.writeText(summary.text || "（暂无公开摘要）"))
							.then(() => toast.success("公共摘要已复制"))
							.catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : String(caught)));
					}}>分享摘要</Button>
					{activeTurn ? <Button size="sm" variant="outline" onClick={() => void handleStop()}>停止</Button> : null}
					{activeTurn && ["unknown", "reconciling"].includes(activeTurn.status)
						? <Button size="sm" variant="outline" onClick={() => void handleCloseUnknown()}>确认无运行</Button> : null}
				</div>
			</header>
			{goal ? (
				<div className="border-b border-border/70 bg-muted/30 px-5 py-2 text-xs">
					<span className="font-medium">Goal</span> · {goal.goal}
					<span className="ml-2 text-muted-foreground">验收：{goal.completionBoundary}</span>
					<span className="ml-2 text-muted-foreground">{goal.status}</span>
				<Button
					size="sm" variant="ghost" className="ml-2 h-6 px-2 text-xs"
					onClick={() => {
						if (!goal.managerParticipantSessionId) return;
						void abandonGoal(goal.managerParticipantSessionId, goal.goalId, goal.revision, "用户在房间放弃 Goal")
							.then(() => { toast.success("Goal 已放弃"); void load(); })
							.catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : String(caught)));
					}}
				>放弃 Goal</Button>
				</div>
			) : null}
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
					placeholder={activeTurn ? "当前回合进行中；发送会作为 followUp 追加" : "输入消息，Enter 发送，Shift+Enter 换行"}
					disabled={!canSend}
					className="min-h-[72px]"
				/>
				<div className="mt-2 flex justify-end">
					<Button size="sm" disabled={!canSend || !draft.trim()} onClick={() => void handleSend()}>{sending ? "发送中…" : "发送"}</Button>
				</div>
			</div>
			<Dialog open={goalOpen} onOpenChange={setGoalOpen}>
				<DialogContent>
					<DialogHeader><DialogTitle>{goal ? "当前 Goal" : "新建 Goal"}</DialogTitle><DialogDescription>Goal 归属当前 RoomSession 的 Manager Participant Session。</DialogDescription></DialogHeader>
					{goal ? <div className="space-y-1 text-sm"><p>{goal.goal}</p><p className="text-muted-foreground">验收：{goal.completionBoundary}</p><p className="text-muted-foreground">状态：{goal.status}</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => setReplacingGoal(true)}>更换 Goal</Button>{goal.executionStatus === "interrupted" ? <Button size="sm" variant="outline" onClick={() => {
							void resumeGoal(goal.managerParticipantSessionId, goal.goalId, goal.revision)
								.then(() => { toast.success("Goal 已恢复"); return load(); })
								.catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : String(caught)));
						}}>恢复 Goal</Button> : null}</div></div> : null}
					{(!goal || replacingGoal) ? (
						<div className="space-y-3">
							<Input value={goalDraft} onChange={(event) => setGoalDraft(event.target.value)} placeholder="Goal（要达成什么）" />
							<Textarea value={boundaryDraft} onChange={(event) => setBoundaryDraft(event.target.value)} placeholder="验收边界（怎样算完成）" className="min-h-[72px]" />
						</div>
					) : null}
					<DialogFooter>
						<Button variant="outline" onClick={() => setGoalOpen(false)}>关闭</Button>
						{(!goal || replacingGoal) ? <Button disabled={creatingGoal || !goalDraft.trim() || !boundaryDraft.trim()} onClick={() => {
							if (!roomSessionId) return;
							setCreatingGoal(true);
							const action = goal && replacingGoal
								? supersedeGoal(goal.managerParticipantSessionId, {
									expectedGoalId: goal.goalId, expectedRevision: goal.revision, reason: "用户在房间更换 Goal",
									goal: goalDraft.trim(), completionBoundary: boundaryDraft.trim(),
								})
								: createRoomGoal(room.id, roomSessionId, { goal: goalDraft.trim(), completionBoundary: boundaryDraft.trim() }, crypto.randomUUID());
							void action
								.then(() => { toast.success(goal && replacingGoal ? "Goal 已更换" : "Goal 已创建"); setGoalOpen(false); setReplacingGoal(false); setGoalDraft(""); setBoundaryDraft(""); return load(); })
								.catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : String(caught)))
								.finally(() => setCreatingGoal(false));
						}}>{creatingGoal ? "提交中…" : goal && replacingGoal ? "更换" : "创建"}</Button> : null}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
