import type { FastifyInstance } from "fastify";
import { TeamsStore, type AgentConfig, type RoomConfig } from "../store/teams.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";

export interface RoomSessionSummary {
	id: string;
	firstMessage: string;
	modifiedAt: string;
	active: boolean;
}

export interface RoomSummary {
	sessionId: string;
	name: string;
	firstMessage: string;
	modifiedAt: string;
	agents?: string[];
	members: AgentConfig[];
	sessions: RoomSessionSummary[];
	activeSession: string;
}

async function buildRoomSummary(
	sessions: PiSessionStore,
	teams: TeamsStore,
	room: RoomConfig,
	fallbackName: string,
): Promise<RoomSummary> {
	const list = await sessions.list();
	const byId = new Map(list.map((s) => [s.id, s]));
	const { sessions: ids, active } = await teams.roomSessionList(room.sessionId);
	return {
		sessionId: room.sessionId,
		name: room.name || fallbackName,
		firstMessage: byId.get(room.sessionId)?.firstMessage ?? "",
		modifiedAt: byId.get(active)?.modifiedAt ?? "",
		agents: room.agents,
		members: await teams.roomMembers(room.sessionId),
		sessions: ids.map((id) => {
			const info = byId.get(id);
			return {
				id,
				firstMessage: info?.firstMessage ?? "新对话",
				modifiedAt: info?.modifiedAt ?? "",
				active: id === active,
			};
		}),
		activeSession: active,
	};
}

export function registerRoomsRoutes(app: FastifyInstance, sessions: PiSessionStore, teams: TeamsStore): void {
	app.get("/api/rooms", async () => {
		const sessionList = await sessions.list();
		const diskIds = new Set(sessionList.map((s) => s.id));
		const rooms: RoomSummary[] = [];
		for (const s of sessionList) {
			const room = await teams.getRoom(s.id);
			rooms.push(await buildRoomSummary(sessions, teams, room, s.firstMessage || "新对话"));
		}
		// Rooms created but never messaged have no JSONL file yet (pi writes
		// lazily on the first message); surface them anyway so a fresh room
		// doesn't vanish from the sidebar on reload.
		for (const room of await teams.listRooms()) {
			if (diskIds.has(room.sessionId)) continue;
			const members = await teams.roomMembers(room.sessionId);
			const { sessions: ids, active } = await teams.roomSessionList(room.sessionId);
			rooms.push({
				sessionId: room.sessionId,
				name:
					room.name ||
					(members.length === 1
						? `与 ${members[0]!.name} 单聊`
						: members.length >= 2
							? "群聊"
							: "新对话"),
				firstMessage: "",
				modifiedAt: new Date().toISOString(),
				agents: room.agents,
				members,
				sessions: ids.map((id) => ({ id, firstMessage: "", modifiedAt: "", active: id === active })),
				activeSession: active,
			});
		}
		// Newest first: fresh rooms sort to the top; disk order may not be.
		rooms.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		return { rooms };
	});

	// A room config is our own registry (keyed by sessionId) and does not
	// require the session file to exist yet — a fresh session is only written
	// to disk on its first message.
	app.get<{ Params: { id: string } }>("/api/rooms/:id", async (req) => {
		const session = (await sessions.list()).find((s) => s.id === req.params.id);
		const room: RoomConfig = await teams.getRoom(req.params.id);
		return { room: await buildRoomSummary(sessions, teams, room, session?.firstMessage || "新对话") };
	});

	app.patch<{ Params: { id: string }; Body: { name?: string; agents?: string[] } }>(
		"/api/rooms/:id",
		async (req, reply) => {
			if (!req.body || (req.body.name === undefined && req.body.agents === undefined)) {
				return reply.code(400).send({ error: "nothing to update (name or agents)" });
			}
			const room = await teams.patchRoom(req.params.id, {
				name: req.body.name,
				agents: req.body.agents,
			});
			return { room: { sessionId: room.sessionId, name: room.name, agents: room.agents } };
		},
	);

	app.get<{ Params: { id: string } }>("/api/rooms/:id/sessions", async (req) => {
		const room: RoomConfig = await teams.getRoom(req.params.id);
		const summary = await buildRoomSummary(sessions, teams, room, "新对话");
		return { sessions: summary.sessions, active: summary.activeSession };
	});

	/** Create a new pi session inside a room and activate it. */
	app.post<{ Params: { id: string } }>("/api/rooms/:id/sessions", async (req, reply) => {
		try {
			const created = await sessions.create();
			await teams.addRoomSession(req.params.id, created.id);
			return { session: created };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	/** Switch the active session of a room. */
	app.post<{ Params: { id: string; sid: string } }>(
		"/api/rooms/:id/sessions/:sid/activate",
		async (req, reply) => {
			try {
				await teams.setActiveRoomSession(req.params.id, req.params.sid);
				return { ok: true };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);
}
