/**
 * windows.json v4 的房间域 schema 与纯校验（方案 §17.4/§18.1）。
 *
 * Part II 是唯一契约：group 只使用 roomSessionIds/activeRoomSessionId，
 * ParticipantSession 通过 participantSessions 注册。本模块不碰文件系统，
 * TeamsStore 的读写与启动对账在下一层使用这里的校验与 prune。
 */

export type WindowTypeV4 = "solo" | "direct" | "group";
export type ParticipantRole = "manager" | "worker";
export type ParticipantState = "active" | "retired" | "tombstoned";

export interface WindowRecordV4 {
	id: string;
	type: WindowTypeV4;
	name?: string;
	members: string[];
	/** solo/direct: agentSessionIds；group 必须为空数组。 */
	sessions: string[];
	/** solo/direct 的当前会话；group 为空串。 */
	activeSession: string;
	/** group 的房间会话（newest first）；solo/direct 为空数组。 */
	roomSessionIds: string[];
	/** group 的当前房间会话；solo/direct 为空串。 */
	activeRoomSessionId: string;
	prompt?: string;
	parkedContexts: Record<string, unknown>;
	workspaceId?: string;
	cwdSnapshot: string;
	pinned?: boolean;
	createdAt: string;
}

export interface RoomSessionRefV4 {
	roomSessionId: string;
	roomId: string;
	workspaceId?: string;
	cwdSnapshot: string;
	customName?: string;
	generatedName?: string;
	createdAt: string;
	sourceSnapshotId?: string;
}

export interface ParticipantSessionRefV4 {
	agentSessionId: string;
	roomId: string;
	roomSessionId: string;
	agentId: string;
	role: ParticipantRole;
	state: ParticipantState;
	workspaceId?: string;
	cwdSnapshot: string;
	lastRoomEntryId?: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	retiredAt?: string;
	retireReason?: "configuration_changed" | "room_session_deleted";
}

export interface SessionRefV4 {
	sessionId: string;
	ownerAgentId: string;
	createdAt: string;
	sourceSnapshotId?: string;
	provider?: { driverId: string; agentRevision: number; providerSessionHandle?: string };
}

export interface WindowsFileV4 {
	version: 4;
	windows: Record<string, WindowRecordV4>;
	roomSessions: Record<string, RoomSessionRefV4>;
	participantSessions: Record<string, ParticipantSessionRefV4>;
	sessionRefs: Record<string, SessionRefV4>;
	retiredCreationOperations?: Record<string, string>;
}

export class WindowsV4ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WindowsV4ValidationError";
	}
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
	throw new WindowsV4ValidationError(message);
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`${label} 必须是 ISO 时间`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value) fail(`${label} 必须是非空字符串`);
	return value;
}

function id(value: unknown, label: string): string {
	if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${label} 不是合法 id`);
	return value;
}

function parseWindow(raw: unknown, key: string): WindowRecordV4 {
	if (!isRecord(raw)) fail(`window ${key} 不是对象`);
	if (raw.id !== key) fail(`window ${key} id 不一致`);
	if (raw.type !== "solo" && raw.type !== "direct" && raw.type !== "group") fail(`window ${key} type 无效`);
	if (!Array.isArray(raw.members) || !raw.members.every((member) => typeof member === "string" && member)) fail(`window ${key} members 无效`);
	if (!Array.isArray(raw.sessions) || !raw.sessions.every((session) => typeof session === "string" && session)) fail(`window ${key} sessions 无效`);
	if (!Array.isArray(raw.roomSessionIds) || !raw.roomSessionIds.every((room) => typeof room === "string" && room)) fail(`window ${key} roomSessionIds 无效`);
	if (!isRecord(raw.parkedContexts)) fail(`window ${key} parkedContexts 无效`);
	const window: WindowRecordV4 = {
		id: key,
		type: raw.type,
		...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
		members: [...raw.members],
		sessions: [...raw.sessions],
		activeSession: typeof raw.activeSession === "string" ? raw.activeSession : "",
		roomSessionIds: [...raw.roomSessionIds],
		activeRoomSessionId: typeof raw.activeRoomSessionId === "string" ? raw.activeRoomSessionId : "",
		...(typeof raw.prompt === "string" && raw.prompt ? { prompt: raw.prompt } : {}),
		parkedContexts: { ...raw.parkedContexts },
		...(optionalString(raw.workspaceId, `window ${key} workspaceId`) ? { workspaceId: raw.workspaceId as string } : {}),
		cwdSnapshot: typeof raw.cwdSnapshot === "string" ? raw.cwdSnapshot : fail(`window ${key} cwdSnapshot 无效`),
		...(raw.pinned === true ? { pinned: true } : {}),
		createdAt: timestamp(raw.createdAt, `window ${key} createdAt`),
	};
	if (window.type === "group") {
		if (window.sessions.length !== 0 || window.activeSession !== "") fail(`group window ${key} 不能有 sessions/activeSession`);
		if (window.roomSessionIds.length === 0) fail(`group window ${key} 至少需要一个 RoomSession`);
		if (!window.roomSessionIds.includes(window.activeRoomSessionId)) fail(`group window ${key} activeRoomSessionId 不属于窗口`);
		if (Object.keys(window.parkedContexts).length > 0) fail(`group window ${key} 不支持 parkedContexts`);
	} else {
		if (window.sessions.length === 0) fail(`${window.type} window ${key} 至少需要一个 Session`);
		if (!window.sessions.includes(window.activeSession)) fail(`${window.type} window ${key} activeSession 不属于窗口`);
		if (window.roomSessionIds.length !== 0 || window.activeRoomSessionId !== "") fail(`${window.type} window ${key} 不能有 RoomSession`);
	}
	return window;
}

function parseRoomSession(raw: unknown, key: string, windows: Record<string, WindowRecordV4>, sessionIds: Set<string>): RoomSessionRefV4 {
	if (!isRecord(raw)) fail(`roomSession ${key} 不是对象`);
	if (raw.roomSessionId !== key) fail(`roomSession ${key} id 不一致`);
	if (sessionIds.has(key)) fail(`RoomSession 与 Agent Session 命名空间冲突: ${key}`);
	const roomId = id(raw.roomId, `roomSession ${key} roomId`);
	const window = windows[roomId];
	if (!window || window.type !== "group") fail(`roomSession ${key} 的 roomId 不是 group 窗口`);
	if (!window.roomSessionIds.includes(key)) fail(`roomSession ${key} 未被所属窗口索引`);
	const room: RoomSessionRefV4 = {
		roomSessionId: key,
		roomId,
		...(optionalString(raw.workspaceId, `roomSession ${key} workspaceId`) ? { workspaceId: raw.workspaceId as string } : {}),
		cwdSnapshot: typeof raw.cwdSnapshot === "string" && raw.cwdSnapshot ? raw.cwdSnapshot : fail(`roomSession ${key} cwdSnapshot 无效`),
		...(optionalString(raw.customName, `roomSession ${key} customName`) ? { customName: raw.customName as string } : {}),
		...(optionalString(raw.generatedName, `roomSession ${key} generatedName`) ? { generatedName: raw.generatedName as string } : {}),
		createdAt: timestamp(raw.createdAt, `roomSession ${key} createdAt`),
		...(optionalString(raw.sourceSnapshotId, `roomSession ${key} sourceSnapshotId`) ? { sourceSnapshotId: raw.sourceSnapshotId as string } : {}),
	};
	if (room.workspaceId !== window.workspaceId) fail(`roomSession ${key} Workspace 与窗口不一致`);
	if (room.cwdSnapshot !== window.cwdSnapshot) fail(`roomSession ${key} cwdSnapshot 与窗口不一致`);
	return room;
}

function parseParticipant(raw: unknown, key: string, rooms: Record<string, RoomSessionRefV4>, refs: Record<string, SessionRefV4>): ParticipantSessionRefV4 {
	if (!isRecord(raw)) fail(`participant ${key} 不是对象`);
	if (raw.agentSessionId !== key) fail(`participant ${key} agentSessionId 不一致`);
	if (refs[key]?.ownerAgentId !== raw.agentId) fail(`participant ${key} owner 与 sessionRef 不一致`);
	const roomSessionId = id(raw.roomSessionId, `participant ${key} roomSessionId`);
	const room = rooms[roomSessionId];
	if (!room) fail(`participant ${key} 的 RoomSession 不存在`);
	if (raw.roomId !== room.roomId) fail(`participant ${key} roomId 与 RoomSession 不一致`);
	if (!raw.agentId || typeof raw.agentId !== "string") fail(`participant ${key} agentId 无效`);
	if (raw.role !== "manager" && raw.role !== "worker") fail(`participant ${key} role 无效`);
	if (raw.state !== "active" && raw.state !== "retired" && raw.state !== "tombstoned") fail(`participant ${key} state 无效`);
	if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) fail(`participant ${key} revision 无效`);
	const participant: ParticipantSessionRefV4 = {
		agentSessionId: key,
		roomId: room.roomId,
		roomSessionId,
		agentId: raw.agentId,
		role: raw.role,
		state: raw.state,
		...(optionalString(raw.workspaceId, `participant ${key} workspaceId`) ? { workspaceId: raw.workspaceId as string } : {}),
		cwdSnapshot: typeof raw.cwdSnapshot === "string" && raw.cwdSnapshot ? raw.cwdSnapshot : fail(`participant ${key} cwdSnapshot 无效`),
		...(optionalString(raw.lastRoomEntryId, `participant ${key} lastRoomEntryId`) ? { lastRoomEntryId: raw.lastRoomEntryId as string } : {}),
		revision: raw.revision as number,
		createdAt: timestamp(raw.createdAt, `participant ${key} createdAt`),
		updatedAt: timestamp(raw.updatedAt, `participant ${key} updatedAt`),
		...(raw.retiredAt !== undefined ? { retiredAt: timestamp(raw.retiredAt, `participant ${key} retiredAt`) } : {}),
		...(raw.retireReason !== undefined ? { retireReason: raw.retireReason as ParticipantSessionRefV4["retireReason"] } : {}),
	};
	if (participant.workspaceId !== room.workspaceId) fail(`participant ${key} Workspace 与 RoomSession 不一致`);
	if (participant.cwdSnapshot !== room.cwdSnapshot) fail(`participant ${key} cwdSnapshot 与 RoomSession 不一致`);
	if (participant.state === "retired" && !participant.retiredAt) fail(`participant ${key} retired 必须有 retiredAt`);
	return participant;
}

export function parseWindowsFileV4(raw: unknown): WindowsFileV4 {
	if (!isRecord(raw)) fail("windows.json 不是对象");
	if (raw.version !== 4) fail("windows.json 需要 v4；旧版本不迁移");
	if (!isRecord(raw.windows) || !isRecord(raw.roomSessions) || !isRecord(raw.participantSessions) || !isRecord(raw.sessionRefs)) fail("windows.json 缺少必需映射");
	const windows: Record<string, WindowRecordV4> = {};
	for (const [key, value] of Object.entries(raw.windows)) windows[key] = parseWindow(value, key);
	const sessionRefs: Record<string, SessionRefV4> = {};
	for (const [key, value] of Object.entries(raw.sessionRefs)) {
		if (!isRecord(value) || value.sessionId !== key || typeof value.ownerAgentId !== "string" || !value.ownerAgentId) fail(`sessionRef ${key} 无效`);
		sessionRefs[key] = {
			sessionId: key,
			ownerAgentId: value.ownerAgentId,
			createdAt: timestamp(value.createdAt, `sessionRef ${key} createdAt`),
			...(optionalString(value.sourceSnapshotId, `sessionRef ${key} sourceSnapshotId`) ? { sourceSnapshotId: value.sourceSnapshotId as string } : {}),
			...(isRecord(value.provider) ? { provider: value.provider as SessionRefV4["provider"] } : {}),
		};
	}
	for (const [key, window] of Object.entries(windows)) {
		for (const session of window.sessions) {
			const ref = sessionRefs[session];
			if (!ref) fail(`window ${key} 的 Session ${session} 缺少 sessionRef`);
			if (window.type === "direct" ? ref.ownerAgentId !== window.members[0] : ref.ownerAgentId !== "manager") fail(`window ${key} 的 Session ${session} owner 不匹配`);
		}
	}
	const roomSessions: Record<string, RoomSessionRefV4> = {};
	for (const [key, value] of Object.entries(raw.roomSessions)) roomSessions[key] = parseRoomSession(value, key, windows, new Set(Object.keys(sessionRefs)));
	for (const [key, room] of Object.entries(roomSessions)) {
		if (!Object.values(windows).some((window) => window.roomSessionIds.includes(key))) fail(`roomSession ${key} 没有窗口引用`);
		if (room.roomId !== Object.values(windows).find((window) => window.roomSessionIds.includes(key))!.id) fail(`roomSession ${key} roomId 不一致`);
	}
	const participantSessions: Record<string, ParticipantSessionRefV4> = {};
	for (const [key, value] of Object.entries(raw.participantSessions)) participantSessions[key] = parseParticipant(value, key, roomSessions, sessionRefs);
	const activeKeys = new Set<string>();
	const managerByRoom = new Map<string, number>();
	for (const participant of Object.values(participantSessions)) {
		if (participant.state !== "active") continue;
		const unique = `${participant.roomSessionId}\u0000${participant.agentId}`;
		if (activeKeys.has(unique)) fail(`同一 RoomSession/Agent 存在多个 active binding: ${unique}`);
		activeKeys.add(unique);
		if (participant.role === "manager") {
			managerByRoom.set(participant.roomSessionId, (managerByRoom.get(participant.roomSessionId) ?? 0) + 1);
		}
	}
	for (const roomSessionId of Object.keys(roomSessions)) {
		if (managerByRoom.get(roomSessionId) !== 1) fail(`RoomSession ${roomSessionId} 必须恰好有一个 active Manager binding`);
	}
	return {
		version: 4,
		windows,
		roomSessions,
		participantSessions,
		sessionRefs,
		...(isRecord(raw.retiredCreationOperations) ? { retiredCreationOperations: raw.retiredCreationOperations as Record<string, string> } : {}),
	};
}

/** 只保留仍被窗口引用的 RoomSession，以及其 active/retired Participant 与 owner Session。 */
export function pruneWindowsFileV4(data: WindowsFileV4): WindowsFileV4 {
	const referencedRooms = new Set(Object.values(data.windows).flatMap((window) => window.roomSessionIds));
	const roomSessions: Record<string, RoomSessionRefV4> = {};
	for (const [key, room] of Object.entries(data.roomSessions)) if (referencedRooms.has(key)) roomSessions[key] = room;
	const participantSessions: Record<string, ParticipantSessionRefV4> = {};
	for (const [key, participant] of Object.entries(data.participantSessions)) {
		if (roomSessions[participant.roomSessionId] && participant.state !== "tombstoned") participantSessions[key] = participant;
	}
	const owned = new Set(Object.values(data.windows).flatMap((window) => window.sessions));
	for (const key of Object.keys(participantSessions)) owned.add(key);
	const sessionRefs: Record<string, SessionRefV4> = {};
	for (const [key, ref] of Object.entries(data.sessionRefs)) if (owned.has(key)) sessionRefs[key] = ref;
	return { ...data, roomSessions, participantSessions, sessionRefs };
}

export interface ParticipantContextV4 {
	window: WindowRecordV4;
	roomSession: RoomSessionRefV4;
	participant: ParticipantSessionRefV4;
	active: boolean;
}

export function participantContext(data: Pick<WindowsFileV4, "windows" | "roomSessions" | "participantSessions">, agentSessionId: string): ParticipantContextV4 | undefined {
	const participant = data.participantSessions[agentSessionId];
	if (!participant) return undefined;
	const roomSession = data.roomSessions[participant.roomSessionId];
	if (!roomSession) return undefined;
	const window = data.windows[roomSession.roomId];
	if (!window || window.type !== "group") return undefined;
	return { window, roomSession, participant, active: window.activeRoomSessionId === roomSession.roomSessionId };
}

export interface RoomContextV4 {
	window: WindowRecordV4;
	roomSession: RoomSessionRefV4;
	active: boolean;
}

export function roomSessionContext(data: Pick<WindowsFileV4, "windows" | "roomSessions">, roomSessionId: string): RoomContextV4 | undefined {
	const roomSession = data.roomSessions[roomSessionId];
	if (!roomSession) return undefined;
	const window = data.windows[roomSession.roomId];
	if (!window || window.type !== "group") return undefined;
	return { window, roomSession, active: window.activeRoomSessionId === roomSessionId };
}
