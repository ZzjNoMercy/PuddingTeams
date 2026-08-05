"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChatPane } from "@/components/chat/chat-pane";
import { SessionList } from "@/components/chat/session-list";
import { createSession, deleteSession, listSessions } from "@/lib/api";
import { getPreferredModel } from "@/lib/model-pref";
import type { SessionSummary } from "@/lib/types";

export default function Home() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		listSessions()
			.then((sessions) => {
				if (cancelled) return;
				setSessions(sessions);
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

	const handleNew = useCallback(async () => {
		if (creating) return;
		setCreating(true);
		try {
			const session = await createSession(getPreferredModel() ?? undefined);
			setSessions((prev) => [session, ...prev]);
			setSelectedId(session.id);
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	}, [creating]);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await deleteSession(id);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				return;
			}
			setSessions((prev) => {
				const next = prev.filter((s) => s.id !== id);
				if (selectedId === id) setSelectedId(next[0]?.id ?? null);
				return next;
			});
		},
		[selectedId],
	);

	return (
		<div className="flex h-dvh">
			<SessionList
				sessions={sessions}
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
						<p className="text-sm text-muted-foreground">选择左侧对话，或新建一个</p>
						{loadError ? (
							<p className="text-xs text-destructive">
								无法连接 backend（{loadError}）。请确认 server 已启动。
							</p>
						) : null}
					</div>
				)}
			</main>
		</div>
	);
}
