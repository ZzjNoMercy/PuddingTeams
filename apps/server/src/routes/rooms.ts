import type { FastifyInstance } from "fastify";
import { TeamsStore, agentDisplayName, type AgentConfig, type WindowConfig, type WindowType } from "../store/teams.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { isWorkspaceDirectoryAvailable, type WorkspaceSummary } from "../store/workspaces.js";
import type { WorkerBinding } from "../store/teams.js";
import { WorkStateOperationConflictError, type WorkStateStore } from "../store/work-state.js";
import type { ProductSettingsStore } from "../store/product-settings.js";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeFile } from "../platform/native-file-opener.js";

export interface RoomSessionSummary {
	id: string;
	/** LLM-generated title, else the first message text. */
	name: string;
	firstMessage: string;
	modifiedAt: string;
	active: boolean;
	/** 会话当前模型 ref（`${provider}/${modelId}`），composer 选择器的真值来源。 */
	model?: string;
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
	/** Per-worker last session handle (multi-turn continuity). */
	workerBindings: Record<string, WorkerBinding>;
	/** 群聊协作提示词（仅 Group 可编辑；Direct 固定 relay，写入会被拒绝）。 */
	prompt: string;
	/** Window 创建时冻结的实际运行目录；无项目模式也有。 */
	cwdSnapshot: string;
	contextAvailable: boolean;
	/** null means the intentional default-cwd chat mode. */
	workspace: WorkspaceSummary | null;
}

const TYPE_ORDER: Record<WindowType, number> = { solo: 0, direct: 1, group: 2 };

function autoTitle(w: WindowConfig, members: AgentConfig[]): string {
	if (w.type === "solo") return "与 pi manager 对话";
	// 标题渲染显示名（缺省回退 id）；w.members 里是内部 id。
	if (w.type === "direct") return `与 ${members[0] ? agentDisplayName(members[0]) : (w.members[0] ?? "")} 单聊`;
	return `群聊：${(members.length ? members : []).map((m) => agentDisplayName(m)).join("、") || w.members.join("、")}`;
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
	const workspace = w.workspaceId
		? (await teams.workspaces.list()).find((item) => item.id === w.workspaceId)
		: undefined;
	if (w.workspaceId && !workspace) throw new Error(`workspace not found: ${w.workspaceId}`);
	const activeInfo = byId.get(active);
	const contextAvailable = workspace
		? workspace.available && workspace.canonicalPath === w.cwdSnapshot
		: await isWorkspaceDirectoryAvailable(w.cwdSnapshot, w.cwdSnapshot);
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
				model: info?.model,
			};
		}),
		activeSession: active,
		pinned: Boolean(w.pinned),
		workerBindings: w.workerBindings ?? {},
		prompt: w.prompt ?? "",
		cwdSnapshot: w.cwdSnapshot,
		contextAvailable,
		workspace: workspace ?? null,
	};
}

export function registerRoomsRoutes(
	app: FastifyInstance,
	sessions: PiSessionStore,
	teams: TeamsStore,
	invoker?: AgentInvoker,
	workStates?: WorkStateStore,
	localFiles?: {
		open?: (targetPath: string) => Promise<void>;
		additionalRoots?: readonly string[];
		productSettings?: ProductSettingsStore;
	},
): void {
	const openLocalFile = localFiles?.open ?? openNativeFile;
	const additionalFileRoots = localFiles?.additionalRoots ?? [];
	const contextFor = async (w: WindowConfig) => ({
		type: w.type,
		members: w.members,
		prompt: w.prompt,
		workspaceId: w.workspaceId,
		cwd: await teams.workspaceFor(w.id),
	});
	const ensureSolo = () =>
		teams.ensureSoloWindow(
			async (workspaceId, cwdSnapshot) => {
				return sessions.create(undefined, {
					type: "solo",
					members: [],
					workspaceId,
					cwd: cwdSnapshot,
				});
			},
			// pi lazily persists a new Session on its first assistant message.
			// A freshly created solo Session is therefore alive in memory before
			// it appears in list(); do not replace it on the next GET /rooms.
			async (id) => sessions.isOpen(id) || (await sessions.list()).some((s) => s.id === id),
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
			const created = await sessions.create(undefined, await contextFor(w));
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
		return { rooms, defaultCwdSnapshot: teams.defaultContextCwd() };
	});

	app.get<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		await ensureWindowAlive(w);
		return { room: await buildWindowSummary(sessions, teams, w) };
	});

	/** Open a file or directory referenced by chat markdown. Relative paths resolve from the
	 * room's frozen cwd; absolute paths must still stay inside that cwd or a
	 * platform-owned attachment root. realpath containment also blocks symlink
	 * escapes. */
	app.post<{ Params: { id: string }; Body: { path?: string } }>(
		"/api/rooms/:id/open-file",
		async (req, reply) => {
			const window = await teams.getWindow(req.params.id);
			if (!window) return reply.code(404).send({ error: "window not found" });
			const requested = req.body?.path?.trim();
			if (!requested || requested.includes("\0")) {
				return reply.code(400).send({ error: "path must be a non-empty local file path" });
			}
			try {
				const rawPath = requested.startsWith("file:")
					? fileURLToPath(requested)
					: requested;
				const workspaceRoot = await realpath(await teams.workspaceFor(window.id));
				const target = await realpath(
					path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceRoot, rawPath),
				);
				const extraRoots = await Promise.all(
					additionalFileRoots.map((root) => realpath(root).catch(() => undefined)),
				);
				const allowedRoots = [workspaceRoot, ...extraRoots.filter((root): root is string => Boolean(root))];
				const allowed = allowedRoots.some((root) => {
					const relative = path.relative(root, target);
					return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
				});
				if (!allowed) throw new Error("文件不在当前项目或平台附件目录中");
				const targetStat = await stat(target);
				if (!targetStat.isFile() && !targetStat.isDirectory()) throw new Error("目标不是文件或目录");
				await openLocalFile(target);
				return { path: target };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	/** 发起对话：direct（单聊）或 group（群聊）。solo 是置顶单例，不在此创建；
	 * 单聊按 worker 去重——已存在则直接返回既有窗口。 */
	app.post<{ Body: { type?: string; members?: string[]; name?: string; prompt?: string; workspaceId?: string } }>(
		"/api/rooms",
		async (req, reply) => {
			const type = req.body?.type;
			const members = [...new Set(req.body?.members ?? [])];
			const workspaceId = req.body?.workspaceId?.trim() || undefined;
			if (workspaceId) {
				try {
					await teams.workspaces.require(workspaceId);
				} catch (err) {
					return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
				}
			}
			const context = await teams.contextForWorkspace(workspaceId);
			if (type !== "direct" && type !== "group") {
				return reply
					.code(400)
					.send({ error: 'type 必须是 "direct"（单聊）或 "group"（群聊）；solo 是置顶单例，不能手动创建' });
			}
			if (type === "direct") {
				if (members.length !== 1) return reply.code(400).send({ error: "单聊需要恰好 1 个 worker" });
				const existing = await teams.findDirectWindow(members[0]!, workspaceId);
				if (existing) {
					return { room: await buildWindowSummary(sessions, teams, existing), existed: true };
				}
			} else if (members.length < 2) {
				return reply.code(400).send({ error: "群聊至少需要 2 个 worker" });
			}
			const agents = await teams.listAgents();
			const known = new Set(agents.map((a) => a.name));
			const pinned = new Set(agents.filter((a) => a.pinned).map((a) => a.name));
			for (const m of members) {
				if (!known.has(m)) return reply.code(400).send({ error: `worker not found: ${m}` });
				if (pinned.has(m)) return reply.code(400).send({ error: `「${m}」是内置 manager，不能作为窗口成员` });
			}
			try {
				if (type === "direct") {
					let createdHere = false;
					const w = await teams.ensureDirectWindow(members[0]!, workspaceId, async () => {
						createdHere = true;
						return sessions.create(undefined, {
							type,
							members,
							prompt: req.body?.prompt,
							workspaceId,
							cwd: context.cwdSnapshot,
						});
					}, { name: req.body?.name, prompt: req.body?.prompt, cwdSnapshot: context.cwdSnapshot });
					return { room: await buildWindowSummary(sessions, teams, w), existed: !createdHere };
				}
				const created = await sessions.create(undefined, {
					type,
					members,
					prompt: req.body?.prompt,
					workspaceId,
					cwd: context.cwdSnapshot,
				});
				const w = await teams.createWindow({
					type,
					members,
					workspaceId,
					cwdSnapshot: context.cwdSnapshot,
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
				(req.body.name === undefined &&
					req.body.members === undefined &&
					req.body.prompt === undefined)
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

	/** 切项目默认克隆窗口；显式 in_place 才停止任务并重建全部 manager/worker Session。 */
	app.post<{ Params: { id: string }; Body: { workspaceId?: string | null; mode?: "new_window" | "in_place" } }>(
		"/api/rooms/:id/switch-workspace",
		async (req, reply) => {
			const source = await teams.getWindow(req.params.id);
			if (!source) return reply.code(404).send({ error: "window not found" });
			if (!req.body || !("workspaceId" in req.body)) {
				return reply.code(400).send({ error: "workspaceId is required; use null for no workspace" });
			}
			const rawWorkspaceId = req.body.workspaceId;
			if (rawWorkspaceId !== null && (typeof rawWorkspaceId !== "string" || !rawWorkspaceId.trim())) {
				return reply.code(400).send({ error: "workspaceId must be a non-empty string or null" });
			}
			const workspaceId = rawWorkspaceId === null ? undefined : rawWorkspaceId!.trim();
			let target;
			try {
				target = await teams.contextForWorkspace(workspaceId);
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
			if (workspaceId === source.workspaceId && target.cwdSnapshot === source.cwdSnapshot) {
				return { room: await buildWindowSummary(sessions, teams, source), existed: true };
			}
			if (req.body?.mode === "in_place" && source.type === "direct") {
				const existing = await teams.findDirectWindow(source.members[0]!, workspaceId, target.cwdSnapshot);
				if (existing && existing.id !== source.id) {
					return reply.code(409).send({ error: "该 worker 在目标项目已有单聊；请使用默认切换打开既有窗口" });
				}
			}
			try {
				if (req.body?.mode !== "in_place") {
					const ctx = {
						type: source.type,
						members: source.members,
						prompt: source.prompt,
						workspaceId,
					cwd: target.cwdSnapshot,
					};
					if (source.type === "direct") {
						const existing = await teams.findDirectWindow(source.members[0]!, workspaceId, target.cwdSnapshot);
						const next = await teams.ensureDirectWindow(
							source.members[0]!,
							workspaceId,
							() => sessions.create(undefined, ctx),
							{ name: source.name, prompt: source.prompt, cwdSnapshot: target.cwdSnapshot },
						);
						return { room: await buildWindowSummary(sessions, teams, next), existed: Boolean(existing) };
					}
					if (source.type === "solo") {
						return reply.code(400).send({ error: "solo 项目切换必须使用 in_place" });
					}
					const created = await sessions.create(undefined, ctx);
					const next = await teams.createWindow({
						type: source.type,
						members: source.members,
						name: source.name,
						prompt: source.prompt,
						workspaceId,
						cwdSnapshot: target.cwdSnapshot,
						sessionId: created.id,
					});
					return { room: await buildWindowSummary(sessions, teams, next), existed: false };
				}
				if (!invoker) throw new Error("in-place workspace switching is unavailable");
				const switched = await invoker.switchWorkspaceInPlace(
					source.id,
					workspaceId,
					(fresh, cwd) =>
						sessions.create(undefined, {
							type: fresh.type,
							members: fresh.members,
							prompt: fresh.prompt,
							workspaceId,
							cwd,
						}),
					(id) => sessions.remove(id),
				);
				return { room: await buildWindowSummary(sessions, teams, switched.window), existed: switched.existed };
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
			for (const sid of sessionIds) {
				await invoker?.cancelManagerSession(sid);
				await sessions.remove(sid);
				await workStates?.removeSession(sid);
			}
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
	app.post<{ Params: { id: string }; Body: { goal?: string; completionBoundary?: string; reviewMode?: "manager" | "independent"; reviewerModel?: string } }>("/api/rooms/:id/sessions", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		const requestedGoal = req.body?.goal?.trim();
		const requestedBoundary = req.body?.completionBoundary?.trim();
		if ((requestedGoal && !requestedBoundary) || (!requestedGoal && requestedBoundary)) {
			return reply.code(400).send({ error: "Goal 会话必须同时填写 goal 与 completionBoundary" });
		}
		const goalOperationId = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
		if (requestedGoal && requestedBoundary && !goalOperationId) return reply.code(400).send({ error: "创建 Goal Session 需要 Idempotency-Key header" });
		if (requestedGoal && requestedBoundary && workStates) {
			const replay = await workStates.findGoalCreationOperation(goalOperationId);
			if (replay) {
				const owner = await teams.windowForSession(replay.sessionId);
				const samePayload = owner?.id === w.id && replay.goal === requestedGoal && replay.completionBoundary === requestedBoundary && replay.reviewMode === (req.body.reviewMode ?? "independent") && (replay.reviewerModel ?? "") === (req.body.reviewerModel?.trim() ?? "");
				if (!samePayload) return reply.code(409).send({ error: "同一 Idempotency-Key 被用于不同 Goal Session 请求", code: "idempotency_conflict" });
				const session = (await sessions.list()).find((item) => item.id === replay.sessionId);
				if (!session) return reply.code(409).send({ error: "幂等 Goal 已提交但 Session 不存在", code: "stale_goal_state" });
				return { session, workState: replay };
			}
		}
		if (requestedGoal && localFiles?.productSettings && (await localFiles.productSettings.get()).harness.goalActivation[w.type] === "disabled") {
			return reply.code(403).send({ error: `Harness 已禁用 ${w.type} Goal` });
		}
		let createdId: string | undefined;
		try {
			const created = await sessions.create(undefined, await contextFor(w));
			createdId = created.id;
			await teams.addWindowSession(req.params.id, created.id);
			const goal = requestedGoal;
			const completionBoundary = requestedBoundary;
			const workState = goal && completionBoundary && workStates
				? await workStates.create({
						sessionId: created.id,
						goal,
						completionBoundary,
						reviewMode: req.body.reviewMode,
						reviewerModel: req.body.reviewerModel,
						participantAgentIds: w.members,
						contractProvenance: { criteriaOrigin: "user_input", sourceMessageIds: [] },
						operationId: goalOperationId,
					})
				: null;
			return { session: created, workState };
		} catch (err) {
			if (createdId) {
				await teams.removeWindowSession(req.params.id, createdId).catch(() => undefined);
				await sessions.remove(createdId).catch(() => undefined);
			}
			if (err instanceof WorkStateOperationConflictError) return reply.code(409).send({ error: err.message, code: err.code });
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
			await invoker?.cancelManagerSession(req.params.sid);
			await sessions.remove(req.params.sid);
			await workStates?.removeSession(req.params.sid);
			return reply.code(204).send();
		},
	);

	/** 重命名窗口内的 session；名称写入 session 自身，不改变窗口名称。 */
	app.patch<{ Params: { id: string; sid: string }; Body: { name?: string } }>(
		"/api/rooms/:id/sessions/:sid",
		async (req, reply) => {
			const w = await teams.getWindow(req.params.id);
			if (!w) return reply.code(404).send({ error: "window not found" });
			const { sessions: sessionIds } = await teams.windowSessionList(w.id);
			if (!sessionIds.includes(req.params.sid)) {
				return reply.code(404).send({ error: "session not found in window" });
			}
			if (typeof req.body?.name !== "string") {
				return reply.code(400).send({ error: "body must be { name: string }" });
			}
			try {
				await sessions.rename(req.params.sid, req.body.name);
				const summary = await buildWindowSummary(sessions, teams, w);
				return { session: summary.sessions.find((item) => item.id === req.params.sid)! };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
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
