export function selectChatRoomFromRoute(
	rooms: readonly { id: string; type: string }[],
	previous: string | null,
	linked: string | null,
	stored: string | null,
	navigationPending: boolean,
): { roomId: string | null; staleLink: boolean } {
	const contains = (id: string | null) => Boolean(id && rooms.some((room) => room.id === id));
	const roomId =
		(navigationPending && contains(previous) ? previous : null) ??
		(contains(linked) ? linked : null) ??
		(contains(previous) ? previous : null) ??
		(contains(stored) ? stored : null) ??
		rooms[0]?.id ??
		null;
	return { roomId, staleLink: !navigationPending && Boolean(linked) && !contains(linked) };
}

/** Correct a deleted Session link only while the callback still names the URL's target. */
export function invalidChatSessionReplacement(query: string, roomId: string, sessionId: string): string | null {
	const params = new URLSearchParams(query);
	if (params.get("room") !== roomId || params.get("session") !== sessionId) return null;
	params.delete("session");
	return `/chats?${params.toString()}`;
}
