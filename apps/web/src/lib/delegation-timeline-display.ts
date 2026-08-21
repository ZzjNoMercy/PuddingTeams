import type { DelegationTimelineEvent } from "./types";

export type TimelineDisplayEvent = DelegationTimelineEvent & {
	displaySeqEnd?: number;
	displayEventCount?: number;
};

/** Legacy PuddingClaw token rows are presentation-coalesced; storage stays append-only. */
export function coalescePuddingClawTokens(events: DelegationTimelineEvent[]): TimelineDisplayEvent[] {
	const display: TimelineDisplayEvent[] = [];
	for (const event of events) {
		const isToken = event.source === "puddingclaw" && event.sourceEvent === "token";
		const previous = display.at(-1);
		if (isToken && previous?.source === "puddingclaw" && previous.sourceEvent === "token") {
			display[display.length - 1] = {
				...previous,
				content: `${previous.content ?? ""}${event.content ?? ""}`,
				displaySeqEnd: event.seq,
				displayEventCount: (previous.displayEventCount ?? 1) + 1,
			};
			continue;
		}
		display.push(isToken ? { ...event, displaySeqEnd: event.seq, displayEventCount: 1 } : event);
	}
	return display;
}

/**
 * Remove only proven duplicate terminal rows. Generic runtime.progress events
 * carry real Connector progress (for example Claude Code tool_use) and must
 * survive a later completed/failed/cancelled boundary.
 */
export function timelineForDisplay(events: DelegationTimelineEvent[]): TimelineDisplayEvent[] {
	const coalesced = coalescePuddingClawTokens(events);
	return coalesced.filter((event, index) => {
		const later = coalesced.slice(index + 1);
		if ((event.sourceEvent === "token" || event.sourceEvent === "token.batch") && later.some((item) => item.sourceEvent === "final_response")) {
			return false;
		}
		const duplicateTerminalProgress = event.sourceEvent === "runtime.progress" && event.title.trim() === "worker 执行完成";
		if ((event.sourceEvent === "done" || duplicateTerminalProgress) && later.some((item) => item.sourceEvent === "runtime.completed" || item.sourceEvent === "runtime.failed")) {
			return false;
		}
		return true;
	});
}
