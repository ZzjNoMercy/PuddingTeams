import type { FastifyInstance } from "fastify";
import { TeamsStore, type AgentConfig, type WindowConfig, type WindowType } from "../store/teams.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";

export interface RoomSessionSummary {
	id: string;
	/** LLM-generated title, else the first message text. */
	name: string;
	firstMessage: string;
	modifiedAt: string;
	active: boolean;
}

export interface RoomSummary {
	id: string;
	type: WindowType;
	name: string;
	firstMessage: string;
	modifiedAt: string;
	members: AgentConfig[];
	sessions: RoomSessionSummary[];
	activeSession: string;
	pinned: boolean;
	workerSessions: Record<string, string>;
	/** User-edited window system prompt ('' = default relay guidance). */
	prompt: string;
}

const TYPE_ORDER: Record<WindowType, number> = { solo: 0, direct: 1, group: 2 };

function autoTitle(w: WindowConfig, members: AgentConfig[]): string {
	if (w.type === "solo") return "与 pi manager 对话";
	if (w.type === "direct") return `与 ${w.members[0] ?? members[0]?.name ?? ""} 单聊`;
	return `群聊：${(members.length ? members : []).map((m) => m.name).join("、") || w.members.join("、")}`;
}

async function buildWindowSummary(
	sessions: PiSessionStore,
	teams: TeamsStore,
	w: WindowConfig,
): Promise<RoomSummary> {
	const list = await sessions.list();
	const byId = new Map(list.map((s) => [s.id, s]));
	const { sessions: ids, active } = await teams.windowSessionList(w.id);
	const members = await teams.windowMembers(w.id);
	const activeInfo = byId.get(active);
	// 窗口名：自定义名优先，否则按类型派生（"与 X 单聊"等）。active session 的
	// LLM 标题不混入窗口名——侧栏/头部把它作为第二行的会话上下文展示。
	return {
		id: w.id,
		type: w.type,
		name: w.name || autoTitle(w, members),
		firstMessage: byId.get(ids[0]!)?.firstMessage ?? "",
		modifiedAt: activeInfo?.modifiedAt ?? w.createdAt,
		members,
		sessions: ids.map((id) => {
			const info = byId.get(id);
			return {
				id,
				name: info?.name ?? "",
				firstMessage: info?.firstMessage ?? "新对话",
				modifiedAt: info?.modifiedAt ?? "",
				active: id === active,
			};
		}),
		activeSession: active,
		pinned: Boolean(w.pinned),
		workerSessions: w.workerSessions ?? {},
		prompt: w.prompt ?? "",
	};
}

export function registerRoomsRoutes(app: FastifyInstance, sessions: PiSessionStore, teams: TeamsStore): void {
	const ensureSolo = () =>
		teams.ensureSoloWindow(
			() => sessions.create(),
			async (id) => (await sessions.list()).some((s) => s.id === id),
		);

	/** A window must own ≥1 live pi session and its active session must be
	 * live. A session is only written to disk on its first assistant message,
	 * so a window created but never messaged has no file — treat in-memory
	 * open sessions as alive too. After a restart any session that was never
	 * messaged is gone forever (pi persists lazily), leaving the window
	 * pointing at a dead session id and producing "Session not found" on every
	 * read. Repair: switch the active to the newest live session (or mint a
	 * fresh one when none survive) and prune the dead ids so the session
	 * dropdown stays clean. Dead sessions carry no messages, so pruning loses
	 * nothing. */
	const ensureWindowAlive = async (w: WindowConfig): Promise<void> => {
		const diskIds = new Set((await sessions.list()).map((s) => s.id));
		const isLive = (id: string) => diskIds.has(id) || sessions.isOpen(id);
		const dead = w.sessions.filter((id) => !isLive(id));
		if (dead.length === 0) return;
		const live = w.sessions.filter((id) => isLive(id));
		if (live.length === 0) {
			const created = await sessions.create(undefined, { type: w.type, members: w.members, prompt: w.prompt });
			await teams.addWindowSession(w.id, created.id);
		} else if (!isLive(w.activeSession)) {
			await teams.setActiveWindowSession(w.id, live[0]!);
		}
		for (const id of dead) await teams.removeWindowSession(w.id, id);
	};

	app.get("/api/rooms", async () => {
		// solo 窗口恒在：没有则补建（含会话）。
		await ensureSolo();
		const windows = await teams.listWindows();
		for (const w of windows) await ensureWindowAlive(w);
		const rooms: RoomSummary[] = [];
		for (const w of windows) rooms.push(await buildWindowSummary(sessions, teams, w));
		rooms.sort(
			(a, b) =>
				TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
				new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
		);
		return { rooms };
	});

	app.get<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		await ensureWindowAlive(w);
		return { room: await buildWindowSummary(sessions, teams, w) };
	});

	/** 发起对话：direct（单聊）或 group（群聊）。solo 是置顶单例，不在此创建；
	 * 单聊按 worker 去重——已存在则直接返回既有窗口。 */
	app.post<{ Body: { type?: string; members?: string[]; name?: string; prompt?: string } }>(
		"/api/rooms",
		async (req, reply) => {
			const type = req.body?.type;
			const members = [...new Set(req.body?.members ?? [])];
			if (type !== "direct" && type !== "group") {
				return reply
					.code(400)
					.send({ error: 'type 必须是 "direct"（单聊）或 "group"（群聊）；solo 是置顶单例，不能手动创建' });
			}
			if (type === "direct") {
				if (members.length !== 1) return reply.code(400).send({ error: "单聊需要恰好 1 个 worker" });
				const existing = await teams.findDirectWindow(members[0]!);
				if (existing) {
					return { room: await buildWindowSummary(sessions, teams, existing), existed: true };
				}
			} else if (members.length < 2) {
				return reply.code(400).send({ error: "群聊至少需要 2 个 worker" });
			}
			const agents = await teams.listAgents();
			const known = new Set(agents.map((a) => a.name));
			for (const m of members) {
				if (!known.has(m)) return reply.code(400).send({ error: `worker not found: ${m}` });
			}
			try {
				const created = await sessions.create(undefined, { type, members, prompt: req.body?.prompt });
				const w = await teams.createWindow({
					type,
					members,
					name: req.body?.name,
					prompt: req.body?.prompt,
					sessionId: created.id,
				});
				return { room: await buildWindowSummary(sessions, teams, w), existed: false };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.patch<{ Params: { id: string }; Body: { name?: string; members?: string[]; prompt?: string } }>(
		"/api/rooms/:id",
		async (req, reply) => {
			if (
				!req.body ||
				(req.body.name === undefined && req.body.members === undefined && req.body.prompt === undefined)
			) {
				return reply.code(400).send({ error: "nothing to update (name, members or prompt)" });
			}
			try {
				const w = await teams.updateWindow(req.params.id, {
					name: req.body.name,
					members: req.body.members,
					prompt: req.body.prompt,
				});
				return { room: await buildWindowSummary(sessions, teams, w) };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	/** 删除窗口（级联删除其全部 pi session）。solo 拒绝（405）。 */
	app.delete<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		if (w.pinned) return reply.code(405).send({ error: "solo 窗口不可删除" });
		try {
			const sessionIds = await teams.removeWindow(req.params.id);
			for (const sid of sessionIds) await sessions.remove(sid);
			return reply.code(204).send();
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.get<{ Params: { id: string } }>("/api/rooms/:id/sessions", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		const summary = await buildWindowSummary(sessions, teams, w);
		return { sessions: summary.sessions, active: summary.activeSession };
	});

	/** 窗口内新建一个 pi session 并激活。 */
	app.post<{ Params: { id: string } }>("/api/rooms/:id/sessions", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		try {
			const created = await sessions.create(undefined, { type: w.type, members: w.members, prompt: w.prompt });
			await teams.addWindowSession(req.params.id, created.id);
			return { session: created };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	/** 窗口内删除一个 pi session（最后一个受保护）。 */
	app.delete<{ Params: { id: string; sid: string } }>(
		"/api/rooms/:id/sessions/:sid",
		async (req, reply) => {
			const { removed, blocked } = await teams.removeWindowSession(req.params.id, req.params.sid);
			if (blocked) return reply.code(400).send({ error: blocked });
			if (!removed) return reply.code(404).send({ error: "session not found in window" });
			await sessions.remove(req.params.sid);
			return reply.code(204).send();
		},
	);

	/** 切换窗口的 active pi session。 */
	app.post<{ Params: { id: string; sid: string } }>(
		"/api/rooms/:id/sessions/:sid/activate",
		async (req, reply) => {
			try {
				await teams.setActiveWindowSession(req.params.id, req.params.sid);
				return { ok: true };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);
}
