"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentsPane } from "@/components/agents/agents-pane";
import { ChatPane } from "@/components/chat/chat-pane";
import { SessionList } from "@/components/chat/session-list";
import { NavRail, type AppView } from "@/components/chat/nav-rail";
import { createSession, deleteSession, listRooms } from "@/lib/api";
import { getPreferredModel } from "@/lib/model-pref";
import type { RoomSummary } from "@/lib/types";

export default function Home() {
	const [rooms, setRooms] = useState<RoomSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [view, setView] = useState<AppView>("chat");
	const [creating, setCreating] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		listRooms()
			.then((rooms) => {
				if (cancelled) return;
				setRooms(rooms);
				setLoadError(null);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setLoadError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const prependRoom = useCallback((room: RoomSummary) => {
		setRooms((prev) => [room, ...prev]);
		setSelectedId(room.sessionId);
	}, []);

	const handleNew = useCallback(async () => {
		if (creating) return;
		setCreating(true);
		try {
			const session = await createSession(getPreferredModel() ?? undefined);
			prependRoom({
				sessionId: session.id,
				name: session.firstMessage || "新对话",
				firstMessage: session.firstMessage,
				modifiedAt: session.modifiedAt,
				members: [],
				sessions: [
					{ id: session.id, firstMessage: session.firstMessage, modifiedAt: session.modifiedAt, active: true },
				],
				activeSession: session.id,
			});
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	}, [creating, prependRoom]);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await deleteSession(id);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				return;
			}
			setRooms((prev) => {
				const next = prev.filter((s) => s.sessionId !== id);
				if (selectedId === id) setSelectedId(next[0]?.sessionId ?? null);
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
						creating={creating}
					/>
					<main className="flex min-w-0 flex-1 flex-col bg-background">
						{selectedId ? (
							<ChatPane key={selectedId} sessionId={selectedId} />
						) : (
							<div className="flex flex-1 flex-col items-center justify-center gap-4 bg-muted/30">
								<p className="text-sm text-muted-foreground">选择左侧房间，或新建一个</p>
								{loadError ? (
									<p className="text-xs text-destructive">
										无法连接 backend（{loadError}）。请确认 server 已启动。
									</p>
								) : null}
							</div>
						)}
					</main>
				</>
			) : (
				<main className="flex min-w-0 flex-1 flex-col bg-background">
					<AgentsPane />
				</main>
			)}
		</div>
	);
}
