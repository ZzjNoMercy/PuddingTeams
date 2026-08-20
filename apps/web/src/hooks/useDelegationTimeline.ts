"use client";

import { useEffect, useState } from "react";
import { delegationTimelineWsUrl, fetchDelegationTimeline } from "@/lib/api";
import type { DelegationTimelineEvent } from "@/lib/types";

function mergeEvents(current: DelegationTimelineEvent[], incoming: DelegationTimelineEvent[]): DelegationTimelineEvent[] {
	const bySeq = new Map(current.map((event) => [event.seq, event]));
	for (const event of incoming) bySeq.set(event.seq, event);
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Append-only history + live subscription for spawn CLI worker activities. */
export function useDelegationTimeline(delegationId: string | null) {
	const [events, setEvents] = useState<DelegationTimelineEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [live, setLive] = useState(false);
	const [agentId, setAgentId] = useState("");
	const [status, setStatus] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!delegationId) return;
		let disposed = false;
		let ws: WebSocket | null = null;
		fetchDelegationTimeline(delegationId)
			.then((snapshot) => {
				if (disposed) return;
				setEvents(snapshot.events);
				setLive(snapshot.live);
				setAgentId(snapshot.agentId);
				setStatus(snapshot.status);
				setLoading(false);
				const afterSeq = snapshot.events.at(-1)?.seq ?? 0;
				ws = new WebSocket(delegationTimelineWsUrl(delegationId, afterSeq));
				ws.onmessage = (message) => {
					let payload: { type?: string; event?: DelegationTimelineEvent; live?: boolean; status?: string };
					try {
						payload = JSON.parse(message.data as string) as typeof payload;
					} catch {
						return;
					}
					if (payload.type === "timeline_event" && payload.event) {
						setEvents((current) => mergeEvents(current, [payload.event!]));
						if (payload.event.sourceEvent === "runtime.completed" || payload.event.sourceEvent === "runtime.failed") setLive(false);
					}
					if (payload.type === "timeline_ready") {
						setLive(Boolean(payload.live));
						if (payload.status) setStatus(payload.status);
					}
				};
				ws.onerror = () => setLive(false);
			})
			.catch((reason: unknown) => {
				if (disposed) return;
				setLoading(false);
				setError(reason instanceof Error ? reason.message : String(reason));
			});

		return () => {
			disposed = true;
			ws?.close();
		};
	}, [delegationId]);

	return { events, loading, live, agentId, status, error };
}
