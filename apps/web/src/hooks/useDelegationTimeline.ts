"use client";

import { useEffect, useState } from "react";
import { delegationTimelineWsUrl, fetchDelegationTimeline } from "@/lib/api";
import type { DelegationTimelineEvent } from "@/lib/types";

function mergeEvents(current: DelegationTimelineEvent[], incoming: DelegationTimelineEvent[]): DelegationTimelineEvent[] {
	const bySeq = new Map(current.map((event) => [event.seq, event]));
	for (const event of incoming) bySeq.set(event.seq, event);
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function isTerminalEvent(event: DelegationTimelineEvent): boolean {
	return event.sourceEvent === "runtime.completed" || event.sourceEvent === "runtime.failed";
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
		let terminalSeen = false;
		fetchDelegationTimeline(delegationId)
			.then((snapshot) => {
				if (disposed) return;
				terminalSeen = snapshot.events.some(isTerminalEvent);
				setEvents(snapshot.events);
				setLive(snapshot.live && !terminalSeen);
				setAgentId(snapshot.agentId);
				setStatus(snapshot.status);
				setLoading(false);
				const afterSeq = snapshot.events.at(-1)?.seq ?? 0;
				ws = new WebSocket(delegationTimelineWsUrl(delegationId, afterSeq));
				ws.onmessage = (message) => {
					if (disposed) return;
					let payload: { type?: string; event?: DelegationTimelineEvent; live?: boolean; executionState?: string };
					try {
						payload = JSON.parse(message.data as string) as typeof payload;
					} catch {
						return;
					}
					if (payload.type === "timeline_event" && payload.event) {
						setEvents((current) => mergeEvents(current, [payload.event!]));
						if (isTerminalEvent(payload.event)) { terminalSeen = true; setLive(false); }
					}
					if (payload.type === "timeline_ready") {
						setLive(Boolean(payload.live) && !terminalSeen);
						if (payload.executionState) setStatus(payload.executionState);
					}
				};
				ws.onerror = () => { if (!disposed) setLive(false); };
				ws.onclose = () => { if (!disposed) setLive(false); };
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
