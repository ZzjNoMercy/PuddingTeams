import { test } from "node:test";
import assert from "node:assert";
import {
	parseWindowsFileV4,
	participantContext,
	pruneWindowsFileV4,
	roomSessionContext,
	WindowsV4ValidationError,
	type WindowsFileV4,
} from "./windows-v4.js";

const createdAt = "2026-10-31T00:00:00.000Z";

function fixture(): WindowsFileV4 {
	return {
		version: 4,
		windows: {
			group: {
				id: "group", type: "group", members: ["worker-a", "worker-b"],
				sessions: [], activeSession: "", roomSessionIds: ["room-1", "room-2"], activeRoomSessionId: "room-1",
				parkedContexts: {}, cwdSnapshot: "/workspace", createdAt,
			},
			solo: {
				id: "solo", type: "solo", members: [], sessions: ["solo-1"], activeSession: "solo-1",
				roomSessionIds: [], activeRoomSessionId: "", parkedContexts: {}, cwdSnapshot: "/workspace", pinned: true, createdAt,
			},
		},
		roomSessions: {
			"room-1": { roomSessionId: "room-1", roomId: "group", cwdSnapshot: "/workspace", createdAt },
			"room-2": { roomSessionId: "room-2", roomId: "group", cwdSnapshot: "/workspace", createdAt },
		},
		participantSessions: {
			"ps-manager": {
				agentSessionId: "ps-manager", roomId: "group", roomSessionId: "room-1", agentId: "manager",
				role: "manager", state: "active", cwdSnapshot: "/workspace", revision: 1, createdAt, updatedAt: createdAt,
			},
			"ps-manager-2": {
				agentSessionId: "ps-manager-2", roomId: "group", roomSessionId: "room-2", agentId: "manager",
				role: "manager", state: "active", cwdSnapshot: "/workspace", revision: 1, createdAt, updatedAt: createdAt,
			},
			"ps-worker": {
				agentSessionId: "ps-worker", roomId: "group", roomSessionId: "room-1", agentId: "worker-a",
				role: "worker", state: "active", cwdSnapshot: "/workspace", revision: 1, createdAt, updatedAt: createdAt,
			},
			"ps-retired": {
				agentSessionId: "ps-retired", roomId: "group", roomSessionId: "room-1", agentId: "worker-b",
				role: "worker", state: "retired", cwdSnapshot: "/workspace", revision: 2, createdAt, updatedAt: createdAt, retiredAt: createdAt, retireReason: "configuration_changed",
			},
		},
		sessionRefs: {
			"solo-1": { sessionId: "solo-1", ownerAgentId: "manager", createdAt },
			"ps-manager": { sessionId: "ps-manager", ownerAgentId: "manager", createdAt },
			"ps-manager-2": { sessionId: "ps-manager-2", ownerAgentId: "manager", createdAt },
			"ps-worker": { sessionId: "ps-worker", ownerAgentId: "worker-a", createdAt },
			"ps-retired": { sessionId: "ps-retired", ownerAgentId: "worker-b", createdAt },
		},
	};
}

test("windows v4: 合法 group/solo 文件通过校验", () => {
	const parsed = parseWindowsFileV4(fixture());
	assert.equal(parsed.windows.group!.roomSessionIds.length, 2);
	assert.equal(parsed.participantSessions["ps-manager"]!.role, "manager");
});

test("windows v4: group 不允许 sessions / 缺 Manager / 重复 active 都拒绝", () => {
	const withSessions = fixture();
	withSessions.windows.group!.sessions = ["x"];
	assert.throws(() => parseWindowsFileV4(withSessions), WindowsV4ValidationError);

	const noManager = fixture();
	delete noManager.participantSessions["ps-manager"];
	delete noManager.sessionRefs["ps-manager"];
	assert.throws(() => parseWindowsFileV4(noManager), /Manager/);

	const duplicate = fixture();
	duplicate.participantSessions["ps-worker-2"] = { ...duplicate.participantSessions["ps-worker"]!, agentSessionId: "ps-worker-2" };
	duplicate.sessionRefs["ps-worker-2"] = { sessionId: "ps-worker-2", ownerAgentId: "worker-a", createdAt };
	assert.throws(() => parseWindowsFileV4(duplicate), /多个 active/);
});

test("windows v4: owner/命名空间/Workspace/版本错误 fail-closed", () => {
	const owner = fixture();
	owner.sessionRefs["ps-worker"]!.ownerAgentId = "worker-b";
	assert.throws(() => parseWindowsFileV4(owner), /owner/);

	const namespace = fixture();
	namespace.sessionRefs["room-1"] = { sessionId: "room-1", ownerAgentId: "manager", createdAt };
	assert.throws(() => parseWindowsFileV4(namespace), /命名空间/);

	const workspace = fixture();
	workspace.roomSessions["room-1"]!.cwdSnapshot = "/other";
	assert.throws(() => parseWindowsFileV4(workspace), /cwdSnapshot/);

	assert.throws(() => parseWindowsFileV4({ ...fixture(), version: 3 }), /v4/);
});

test("windows v4: resolver 解析 Participant 与 RoomSession", () => {
	const data = parseWindowsFileV4(fixture());
	const participant = participantContext(data, "ps-worker");
	assert.equal(participant?.window.id, "group");
	assert.equal(participant?.participant.agentId, "worker-a");
	assert.equal(participant?.active, true);
	assert.equal(participantContext(data, "solo-1"), undefined);

	const room = roomSessionContext(data, "room-2");
	assert.equal(room?.window.id, "group");
	assert.equal(room?.active, false);
});

test("windows v4: prune 保留被引用房间与 retired binding，删除孤儿", () => {
	const data = fixture();
	data.windows.group!.roomSessionIds = ["room-1"];
	data.windows.group!.activeRoomSessionId = "room-1";
	data.roomSessions["orphan"] = { roomSessionId: "orphan", roomId: "group", cwdSnapshot: "/workspace", createdAt };
	data.participantSessions["ps-orphan"] = {
		...data.participantSessions["ps-worker"]!, agentSessionId: "ps-orphan", roomSessionId: "orphan",
	};
	data.sessionRefs["ps-orphan"] = { sessionId: "ps-orphan", ownerAgentId: "worker-a", createdAt };
	const pruned = pruneWindowsFileV4(data);
	assert.deepEqual(Object.keys(pruned.roomSessions).sort(), ["room-1"]);
	assert.deepEqual(Object.keys(pruned.participantSessions).sort(), ["ps-manager", "ps-retired", "ps-worker"]);
	assert.equal(pruned.sessionRefs["ps-orphan"], undefined);
	assert.ok(pruned.sessionRefs["solo-1"]);
});
