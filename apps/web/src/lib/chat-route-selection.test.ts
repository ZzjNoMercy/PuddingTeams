import assert from "node:assert/strict";
import test from "node:test";
import { invalidChatSessionReplacement, selectChatRoomFromRoute } from "./chat-route-selection";

const rooms = [
	{ id: "manager", type: "solo" },
	{ id: "worker-a", type: "direct" },
	{ id: "worker-b", type: "group" },
];

test("a valid deep link wins over a stored room after navigation settles", () => {
	assert.deepEqual(selectChatRoomFromRoute(rooms, "worker-a", "worker-b", "worker-a", false), { roomId: "worker-b", staleLink: false });
});

test("a pending local navigation keeps its selected room until the URL catches up", () => {
	assert.deepEqual(selectChatRoomFromRoute(rooms, "worker-b", "worker-a", "worker-a", true), { roomId: "worker-b", staleLink: false });
});

test("a deleted deep link falls back to an existing room and asks to clear its session", () => {
	assert.deepEqual(selectChatRoomFromRoute(rooms, null, "deleted-room", "worker-a", false), { roomId: "worker-a", staleLink: true });
});

test("a solo link opens Manager in the unified chat route", () => {
	assert.deepEqual(selectChatRoomFromRoute(rooms, null, "manager", null, false), { roomId: "manager", staleLink: false });
});

test("returning to the route without a room immediately restores the current direct chat", () => {
	assert.deepEqual(selectChatRoomFromRoute(rooms, "worker-b", null, "worker-a", false), { roomId: "worker-b", staleLink: false });
});

test("deleted session correction preserves the Manager return target and ignores an older callback", () => {
	assert.equal(
		invalidChatSessionReplacement("room=worker-a&session=deleted&returnSession=manager%2Fone", "worker-a", "deleted"),
		"/chats?room=worker-a&returnSession=manager%2Fone",
	);
	assert.equal(invalidChatSessionReplacement("room=worker-b&session=current", "worker-a", "deleted"), null);
	assert.equal(invalidChatSessionReplacement("room=worker-a&session=current", "worker-a", "deleted"), null);
});
