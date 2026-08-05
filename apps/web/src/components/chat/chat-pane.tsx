"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, LayersIcon, PlusIcon, UsersIcon } from "lucide-react";
import { toast } from "sonner";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChat } from "@/hooks/useChat";
import { createRoomSession, getRoom, setActiveRoomSession } from "@/lib/api";
import type { ChatStatus, RoomSession, RoomSummary } from "@/lib/types";
import { Composer } from "./composer";
import { Message } from "./message";
import { RoomConfigDialog } from "./room-config-dialog";
import { ManagerAvatar, MemberStack, WorkerAvatar } from "./worker-avatar";

function statusLabelOf(status: ChatStatus): string {
	switch (status) {
		case "connected":
			return "已连接 pi manager";
		case "connecting":
			return "连接中…";
		case "reconnecting":
			return "连接中断，重连中…";
		default:
			return "连接已断开，仍在后台重试";
	}
}

/** The live chat area for one pi session. Keyed by sessionId so switching
 * sessions remounts it (fresh history + WS). */
function SessionChat({
	sessionId,
	emptyHint,
	onStatus,
}: {
	sessionId: string;
	emptyHint?: string;
	onStatus: (s: ChatStatus) => void;
}) {
	const { messages, status, running, send, stop } = useChat(sessionId);
	useEffect(() => onStatus(status), [status, onStatus]);

	return (
		<>
			<Conversation>
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6">
					{messages.length === 0 ? (
						<div className="flex flex-1 items-center justify-center pt-20 text-sm text-muted-foreground">
							{emptyHint ?? "开始和 pi manager 对话"}
						</div>
					) : (
						messages.map((m) => <Message key={m.id} message={m} />)
					)}
				</ConversationContent>
				<ConversationScrollButton className="z-10" />
			</Conversation>
			<Composer sessionId={sessionId} disabled={running} onSend={send} onStop={stop} />
		</>
	);
}

export function ChatPane({ sessionId: roomId }: { sessionId: string }) {
	const [room, setRoom] = useState<RoomSummary | null>(null);
	const [roomOpen, setRoomOpen] = useState(false);
	const [activeId, setActiveId] = useState<string>(roomId);
	const [status, setStatus] = useState<ChatStatus>("connecting");

	useEffect(() => {
		let cancelled = false;
		getRoom(roomId)
			.then((r) => {
				if (cancelled) return;
				setRoom(r);
				setActiveId(r.activeSession || roomId);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [roomId]);

	const handleRoomSaved = useCallback((r: RoomSummary) => {
		setRoom(r);
		setActiveId(r.activeSession || r.sessionId);
	}, []);

	const patchSessions = useCallback((sessions: RoomSession[], active: string) => {
		setRoom((prev) => (prev ? { ...prev, sessions, activeSession: active } : prev));
		setActiveId(active);
	}, []);

	const switchSession = useCallback(
		async (sessionId: string) => {
			if (sessionId === activeId) return;
			try {
				await setActiveRoomSession(roomId, sessionId);
				if (room) {
					patchSessions(
						room.sessions.map((s) => ({ ...s, active: s.id === sessionId })),
						sessionId,
					);
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		},
		[roomId, activeId, room, patchSessions],
	);

	const newSession = useCallback(async () => {
		try {
			const created = await createRoomSession(roomId);
			setRoom((prev) =>
				prev
					? {
							...prev,
							sessions: [
								{ id: created.id, firstMessage: "", modifiedAt: created.modifiedAt, active: true },
								...prev.sessions.map((s) => ({ ...s, active: false })),
							],
							activeSession: created.id,
						}
					: prev,
			);
			setActiveId(created.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [roomId]);

	const members = room?.members ?? [];
	const isSingle = members.length === 1;
	const isGroup = members.length >= 2;
	const headerTitle =
		room?.name ||
		(isSingle ? `与 ${members[0]?.name} 单聊` : isGroup ? "群聊" : "与 pi manager 对话");
	const emptyHint = isGroup
		? `群聊：${members.map((m) => m.name).join("、")} 在房间里，pi manager 负责调度。试试对 manager 说：让 ${members[0]?.name} 分析一个任务…`
		: isSingle
			? `和 ${members[0]?.name} 单聊（经 pi manager 中转）。派一个任务，manager 会交给 ${members[0]?.name} 执行`
			: "开始和 pi manager 对话";

	return (
		<div className="relative flex h-full flex-col">
			<header className="flex items-center justify-between gap-2 px-4 py-2">
				<div className="flex min-w-0 items-center gap-2.5">
					{isGroup ? (
						<MemberStack members={members} size={28} />
					) : isSingle ? (
						<WorkerAvatar name={members[0]!.name} size={28} />
					) : (
						<ManagerAvatar size={28} />
					)}
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{headerTitle}</div>
						<div className="truncate text-xs text-muted-foreground">
							{isGroup
								? `${members.length} 个成员 · ${members.map((m) => m.name).join("、")}`
								: isSingle
									? `与 ${members[0]?.name} 单聊`
									: "与 pi manager 对话"}
						</div>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="sm" variant="outline">
								<LayersIcon className="size-3.5" />
								会话
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
							<div className="px-2 py-1.5 text-xs text-muted-foreground">
								{room?.sessions.length ?? 1} 个会话
							</div>
							{(room?.sessions ?? []).map((s) => (
								<DropdownMenuItem key={s.id} onSelect={() => void switchSession(s.id)}>
									<span className="min-w-0 flex-1 truncate">
										{s.firstMessage || "新对话"}
									</span>
									{s.active ? <CheckIcon className="size-3.5 shrink-0" /> : null}
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => void newSession()}>
								<PlusIcon className="size-3.5" />
								新建会话
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<Button type="button" size="sm" variant="outline" onClick={() => setRoomOpen(true)}>
						<UsersIcon className="size-3.5" />
						{members.length === 0 ? "添加成员" : "成员"}
					</Button>
					<span
						className={`hidden items-center gap-2 text-xs sm:flex ${
							status === "connected"
								? "text-muted-foreground"
								: status === "connecting" || status === "reconnecting"
									? "text-muted-foreground/70"
									: "text-destructive"
						}`}
					>
						{(status === "connecting" || status === "reconnecting") && <Loader size={12} />}
						{statusLabelOf(status)}
					</span>
				</div>
			</header>
			{room && <SessionChat key={activeId} sessionId={activeId} emptyHint={emptyHint} onStatus={setStatus} />}
			<RoomConfigDialog
				sessionId={roomId}
				open={roomOpen}
				onOpenChange={setRoomOpen}
				onSaved={handleRoomSaved}
			/>
		</div>
	);
}
