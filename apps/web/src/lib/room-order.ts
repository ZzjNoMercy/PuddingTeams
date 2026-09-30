import type { RoomSummary } from "@/lib/types";

/** RoomSummary.modifiedAt is the server's activity time or creation fallback. */
export function sortRoomsByActivity<T extends Pick<RoomSummary, "id" | "modifiedAt">>(rooms: readonly T[]): T[] {
	const timestamp = (room: T) => {
		const parsed = Date.parse(room.modifiedAt);
		return Number.isFinite(parsed) ? parsed : -Infinity;
	};
	return [...rooms].sort((a, b) => timestamp(b) - timestamp(a) || a.id.localeCompare(b.id));
}

/** Within one activity revision, acknowledgements can only reduce unread state. */
export function preferCurrentRoomSummary<T extends Pick<RoomSummary, "id" | "activityRevision" | "readRevision" | "hasUnreadActivity">>(current: T | null | undefined, incoming: T): T {
	if (!current || current.id !== incoming.id) return incoming;
	if (incoming.activityRevision < current.activityRevision) return current;
	if (incoming.activityRevision === current.activityRevision) {
		if (incoming.readRevision < current.readRevision) return current;
		if (incoming.readRevision === current.readRevision && !current.hasUnreadActivity && incoming.hasUnreadActivity) return current;
	}
	return incoming;
}

/** The fetched set owns membership; newer local revisions own each room's summary. */
export function reconcileRoomList<T extends Pick<RoomSummary, "id" | "modifiedAt" | "activityRevision" | "readRevision" | "hasUnreadActivity">>(current: readonly T[], fetched: readonly T[]): T[] {
	const byId = new Map(current.map((room) => [room.id, room]));
	return sortRoomsByActivity(fetched.map((room) => preferCurrentRoomSummary(byId.get(room.id), room)));
}
