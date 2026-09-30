import type { FastifyInstance } from "fastify";
import { TeamsStore, WindowSessionCleanupError, RoomCreationOperationConflictError, RoomCreationOperationGoneError, RoomWorkerUnavailableError, RoomWorkspaceUnavailableError, RoomSourceUnavailableError, RoomSourceChangedError, agentDisplayName, type AgentConfig, type RoomSourceSnapshot, type WindowConfig, type WindowType } from "../store/teams.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { isWorkspaceDirectoryAvailable, type WorkspaceSummary } from "../store/workspaces.js";
import type { WorkerBinding } from "../store/teams.js";
import { WorkStateOperationConflictError, type WorkStateStore } from "../store/work-state.js";
import type { ProductSettingsStore } from "../store/product-settings.js";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNativeFile } from "../platform/native-file-opener.js";
import { compareRoomActivity, RoomActivityProjector } from "./room-activity.js";
import { SessionCreationOperations } from "../store/session-creation-operations.js";
import { createHash } from "node:crypto";
import { localViewerIdentity } from "./identity.js";
import { identifyUploads, type FirstMessagePathReference, type UploadInput, type UploadStore } from "../store/uploads.js";
import { internalFirstWorkFreezeToken, isWithin, localPathReferences } from "./chat.js";

class FirstWorkMessageConflictError extends Error {
	constructor() {
		super("此操作预约的 Session 已有不同的首条用户消息；请核对原工作，不能自动重发");
		this.name = "FirstWorkMessageConflictError";
	}
}

class DeletedWorkSessionError extends Error {
	constructor(readonly sessionId: string) {
		super("此操作原先预约的 Session 已删除；如需继续，请明确作为新工作发起");
		this.name = "DeletedWorkSessionError";
	}
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: string; text: string } =>
		Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"))
		.map((part) => part.text).join("\n").trim();
}

async function durableUserMessageText(sessionFile: string | undefined, entryId: string): Promise<string | null> {
	if (!sessionFile) return null;
	try {
		for (const line of (await readFile(sessionFile, "utf8")).split("\n")) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as { id?: string; type?: string; message?: { role?: string; content?: unknown } };
				if (entry.id === entryId) return entry.type === "message" && entry.message?.role === "user" ? userMessageText(entry.message.content) : null;
			} catch { /* Ignore an incomplete final JSONL line. */ }
		}
	} catch { /* Missing or unreadable Session file is not evidence of acceptance. */ }
	return null;
}

export interface RoomSessionSummary {
	id: string;
	/** LLM-generated title, else the first message text. */
	name: string;
	firstMessage: string;
	modifiedAt: string;
	active: boolean;
	/** 会话当前模型 ref（`${provider}/${modelId}`），composer 选择器的真值来源。 */
	model?: string;
	/** 会话当前 thinking level（§10.6），composer 选择器的真值来源。 */
	thinkingLevel?: string;
}

export interface RoomSummary {
	id: string;
	type: WindowType;
	name: string;
	firstMessage: string;
	modifiedAt: string;
	lastActivityAt: string | null;
	lastMessagePreview: string;
	activitySessionId: string | null;
	activityRevision: number;
	readRevision: number;
	hasUnreadActivity: boolean;
	members: AgentConfig[];
	sessions: RoomSessionSummary[];
	activeSession: string;
	pinned: boolean;
	/** Active room Session's per-worker continuation handles. */
	workerBindings: Record<string, WorkerBinding>;
	/** 群聊协作提示词（仅 Group 可编辑；Direct 固定 relay，写入会被拒绝）。 */
	prompt: string;
	/** Window 创建时冻结的实际运行目录；无项目模式也有。 */
	cwdSnapshot: string;
	contextAvailable: boolean;
	/** null means the intentional default-cwd chat mode. */
	workspace: WorkspaceSummary | null;
}

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
	projector = new RoomActivityProjector(),
): Promise<RoomSummary> {
	const list = await sessions.list();
	const byId = new Map(list.map((s) => [s.id, s]));
	const { sessions: ids, active } = await teams.windowSessionList(w.id);
	// 房间摘要展示的是窗口已配置的成员，而不是当前可委托 roster。
	// windowMembers() 会按 enabled 过滤；停用 direct 房间唯一 worker 后，
	// 如果复用它，前端会拿到空 members 并丢失房间的身份展示。
	const configuredAgents = await teams.listAgents();
	const members = w.members
		.map((member) => configuredAgents.find((agent) => agent.name === member))
		.filter((agent): agent is AgentConfig => Boolean(agent));
	const workspace = w.workspaceId
		? (await teams.workspaces.list()).find((item) => item.id === w.workspaceId)
		: undefined;
	if (w.workspaceId && !workspace) throw new Error(`workspace not found: ${w.workspaceId}`);
	const { activity, read } = await projector.projectWithReadStatus(w.id, ids.map((id) => ({ id, sessionFile: byId.get(id)?.sessionFile ?? "" })), localViewerIdentity().user.id);
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
		modifiedAt: activity.lastActivityAt ?? w.createdAt,
		...activity,
		activitySessionId: read.unreadSessionId ?? activity.activitySessionId,
		lastMessagePreview: read.unreadPreview ?? activity.lastMessagePreview,
		readRevision: read.readRevision,
		hasUnreadActivity: read.hasUnreadActivity,
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
				thinkingLevel: info?.thinkingLevel,
			};
		}),
		activeSession: active,
		pinned: Boolean(w.pinned),
		workerBindings: w.workerBindings?.[active] ?? {},
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
		/** Platform attachment root; access is narrowed to this window's Session subdirectories. */
		attachmentRoot?: string;
		uploads?: UploadStore;
		productSettings?: ProductSettingsStore;
		activityStatePath?: string;
		sessionCreationStatePath?: string;
	},
): void {
	const activityProjector = new RoomActivityProjector(localFiles?.activityStatePath);
	const sessionCreationOperations = localFiles?.sessionCreationStatePath
		? new SessionCreationOperations(localFiles.sessionCreationStatePath) : null;
	const pendingSessionCreations = new Map<string, Promise<Awaited<ReturnType<PiSessionStore["create"]>>>>();
	const pendingNewWork = new Map<string, Promise<{ sessionId: string; accepted: boolean }>>();
	const openLocalFile = localFiles?.open ?? openNativeFile;
	const additionalFileRoots = localFiles?.additionalRoots ?? [];
	const attachmentRoot = localFiles?.attachmentRoot;
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
		for (const w of windows) rooms.push(await buildWindowSummary(sessions, teams, w, activityProjector));
		const created = new Map(windows.map((w) => [w.id, w.createdAt]));
		rooms.sort((a, b) => compareRoomActivity(
			{ id: a.id, lastActivityAt: a.lastActivityAt, createdAt: created.get(a.id) ?? "" },
			{ id: b.id, lastActivityAt: b.lastActivityAt, createdAt: created.get(b.id) ?? "" },
		));
		return { rooms, defaultCwdSnapshot: teams.defaultContextCwd() };
	});

	app.get<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		await ensureWindowAlive(w);
		return { room: await buildWindowSummary(sessions, teams, w, activityProjector) };
	});

	/** M1 search includes durable Manager work parked under other Workspaces. */
	app.get<{ Params: { id: string } }>("/api/rooms/:id/work-index", async (req, reply) => {
		if (req.params.id === "solo") await ensureSolo();
		const room = await teams.getWindow(req.params.id);
		if (!room || room.type !== "solo") return reply.code(404).send({ error: "Manager 工作台不存在" });
		const [listed, workspaces] = await Promise.all([sessions.list(), teams.workspaces.list()]);
		const byId = new Map(listed.map((session) => [session.id, session]));
		const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
		const contexts = [
			{ workspaceId: room.workspaceId, sessions: room.sessions, active: true },
			...Object.values(room.parkedContexts).map((context) => ({ workspaceId: context.workspaceId, sessions: context.sessions, active: false })),
		];
		const works = contexts.flatMap((context) => context.sessions.flatMap((id) => {
			const session = byId.get(id);
			const firstMessage = session?.firstMessage.trim();
			if (!session || !firstMessage || firstMessage === "(no messages)" || firstMessage === "新对话") return [];
			const name = session.name?.trim();
			const title = name && name !== "(no messages)" && name !== "新对话" ? name : firstMessage;
			return [{
				sessionId: id,
				title,
				firstMessage,
				workspaceId: context.workspaceId ?? null,
				workspaceName: context.workspaceId ? workspaceNames.get(context.workspaceId) ?? "已移除项目" : "默认工作目录",
				modifiedAt: session.modifiedAt,
				active: context.active,
			}];
		}));
		works.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || a.sessionId.localeCompare(b.sessionId));
		return { works };
	});

	app.put<{ Params: { id: string }; Body: { activityRevision?: number; sessionId?: string } }>("/api/rooms/:id/read-watermark", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		if (!Number.isSafeInteger(req.body?.activityRevision) || (req.body?.activityRevision ?? -1) < 0) {
			return reply.code(400).send({ error: "activityRevision 必须是非负整数" });
		}
		if (typeof req.body?.sessionId !== "string" || !w.sessions.includes(req.body.sessionId)) {
			return reply.code(400).send({ error: "sessionId 必须属于该房间" });
		}
		try {
			await buildWindowSummary(sessions, teams, w, activityProjector);
			const { activityRevision, read } = await activityProjector.markReadWithStatus(w.id, localViewerIdentity().user.id, req.body.sessionId, req.body.activityRevision!);
			return { readRevision: read.readRevision, activityRevision, hasUnreadActivity: read.hasUnreadActivity };
		} catch (error) {
			return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
		}
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
				const attachmentRoots = attachmentRoot
					? await Promise.all([window.activeSession].map((sessionId) =>
						realpath(path.join(attachmentRoot, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"))).catch(() => undefined),
					))
					: [];
				const allowedRoots = [
					workspaceRoot,
					...extraRoots.filter((root): root is string => Boolean(root)),
					...attachmentRoots.filter((root): root is string => Boolean(root)),
				];
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
			const rawOperationKey = req.headers["idempotency-key"];
			if (type === "group" && (typeof rawOperationKey !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(rawOperationKey))) {
				return reply.code(400).send({ error: "创建群聊需要有效的 Idempotency-Key", code: "room_operation_invalid" });
			}
			const creationOperation = type === "group" && typeof rawOperationKey === "string"
				? { key: rawOperationKey, requestHash: createHash("sha256").update(JSON.stringify({
					type, members: [...members].sort(), workspaceId: workspaceId ?? null,
					name: req.body?.name?.trim() || null, prompt: req.body?.prompt?.trim() || null,
				})).digest("hex") }
				: undefined;
			if (creationOperation) {
				try {
					const previous = await teams.findGroupByCreationOperation(creationOperation.key, creationOperation.requestHash);
					if (previous) return { room: await buildWindowSummary(sessions, teams, previous, activityProjector), existed: true };
				} catch (err) {
					if (err instanceof RoomCreationOperationConflictError) return reply.code(409).send({ error: err.message, code: "room_operation_conflict" });
					if (err instanceof RoomCreationOperationGoneError) return reply.code(409).send({ error: err.message, code: "room_operation_gone" });
					if (teams.durabilityUncertain()) return reply.code(409).send({ error: "房间创建结果未确认；请重启服务并回读房间列表，勿直接重复发起", code: "room_creation_uncertain" });
					throw err;
				}
			}
			if (workspaceId) {
				try {
					await teams.workspaces.require(workspaceId);
				} catch (err) {
					return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code: "workspace_unavailable" });
				}
			}
			let context: Awaited<ReturnType<typeof teams.contextForWorkspace>>;
			try { context = await teams.contextForWorkspace(workspaceId); }
			catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), code: "workspace_unavailable" }); }
			if (type !== "direct" && type !== "group") {
				return reply
					.code(400)
					.send({ error: 'type 必须是 "direct"（单聊）或 "group"（群聊）；solo 是置顶单例，不能手动创建' });
			}
			if (type === "direct" && members.length !== 1) {
				return reply.code(400).send({ error: "单聊需要恰好 1 个 worker" });
			}
			if (type === "group" && members.length < 2) {
				return reply.code(400).send({ error: "群聊至少需要 2 个 worker" });
			}
			const agents = await teams.listAgents();
			const byName = new Map(agents.map((agent) => [agent.name, agent]));
			for (const m of members) {
				const agent = byName.get(m);
				if (!agent) return reply.code(400).send({ error: `worker not found: ${m}`, code: "worker_unavailable" });
				if (agent.pinned) return reply.code(400).send({ error: `「${m}」是内置 manager，不能作为窗口成员` });
				if (agent.enabled === false) return reply.code(409).send({ error: `worker「${m}」已停用，不能发起新对话`, code: "worker_disabled" });
			}
			try {
				if (type === "direct") {
					let createdHere = false;
					const w = await teams.ensureDirectWindow(members[0]!, workspaceId, async (reservedId) => {
						createdHere = true;
						return sessions.create(undefined, {
							type,
							members,
							prompt: req.body?.prompt,
							workspaceId,
							cwd: context.cwdSnapshot,
						}, reservedId);
					}, { name: req.body?.name, prompt: req.body?.prompt, cwdSnapshot: context.cwdSnapshot, requireEnabledMember: true, rollbackSession: (id) => sessions.remove(id), journalSession: true });
					return { room: await buildWindowSummary(sessions, teams, w, activityProjector), existed: !createdHere };
				}
				let createdHere = false;
				const w = await teams.createWindow({
					type,
					members,
					workspaceId,
					cwdSnapshot: context.cwdSnapshot,
					name: req.body?.name,
					prompt: req.body?.prompt,
					requireEnabledMembers: true,
					journalSession: true,
					creationOperation,
					createSession: (reservedId) => { createdHere = true; return sessions.create(undefined, {
						type,
						members,
						prompt: req.body?.prompt,
						workspaceId,
						cwd: context.cwdSnapshot,
					}, reservedId); },
					rollbackSession: (id) => sessions.remove(id),
				});
				return { room: await buildWindowSummary(sessions, teams, w, activityProjector), existed: !createdHere };
			} catch (err) {
				if (err instanceof RoomCreationOperationConflictError) return reply.code(409).send({ error: err.message, code: "room_operation_conflict" });
				if (err instanceof RoomCreationOperationGoneError) return reply.code(409).send({ error: err.message, code: "room_operation_gone" });
				if (teams.durabilityUncertain()) {
					return reply.code(409).send({ error: "房间创建结果未确认；请重启服务并回读房间列表，勿直接重复发起", code: "room_creation_uncertain" });
				}
				if (err instanceof WindowSessionCleanupError) {
					app.log.error({ err, sessionId: err.sessionId }, "room creation Session cleanup failed");
					return reply.code(500).send({ error: err.message, code: "room_session_cleanup_failed" });
				}
				if (err instanceof RoomWorkerUnavailableError) return reply.code(400).send({ error: err.message, code: "worker_unavailable" });
				if (err instanceof RoomWorkspaceUnavailableError) return reply.code(400).send({ error: err.message, code: "workspace_unavailable" });
				const message = err instanceof Error ? err.message : String(err);
				return reply.code(message.includes("已停用") ? 409 : 400).send({ error: message, ...(message.includes("已停用") ? { code: "worker_disabled" } : {}) });
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
				return { room: await buildWindowSummary(sessions, teams, w, activityProjector) };
			} catch (err) {
				if (teams.durabilityUncertain()) {
					return reply.code(409).send({ error: "房间修改结果未确认；请重启服务并回读房间列表，勿直接重复修改", code: "room_update_uncertain" });
				}
				const message = err instanceof Error ? err.message : String(err);
				return reply.code(message.includes("已停用") ? 409 : 400).send({ error: message, ...(message.includes("已停用") ? { code: "worker_disabled" } : {}) });
			}
		},
	);

	/** direct/group 切项目创建或打开独立窗口；仅 solo 原地停放/恢复 Workspace context。 */
	app.post<{ Params: { id: string }; Body: { workspaceId?: string | null; mode?: "new_window" | "in_place"; source?: { type: WindowType; name: string; members: string[]; prompt: string; workspaceId: string | null; cwdSnapshot: string } } }>(
		"/api/rooms/:id/switch-workspace",
		async (req, reply) => {
			if (!req.body || !("workspaceId" in req.body)) {
				return reply.code(400).send({ error: "workspaceId is required; use null for no workspace" });
			}
			const rawWorkspaceId = req.body.workspaceId;
			if (rawWorkspaceId !== null && (typeof rawWorkspaceId !== "string" || !rawWorkspaceId.trim())) {
				return reply.code(400).send({ error: "workspaceId must be a non-empty string or null" });
			}
			const workspaceId = rawWorkspaceId === null ? undefined : rawWorkspaceId!.trim();
			const rawOperationKey = req.headers["idempotency-key"];
			if (rawOperationKey !== undefined && (typeof rawOperationKey !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(rawOperationKey))) {
				return reply.code(400).send({ error: "群聊 Idempotency-Key 格式无效", code: "room_operation_invalid" });
			}
			const creationOperation = req.body.mode !== "in_place" && typeof rawOperationKey === "string"
				? { key: rawOperationKey, requestHash: createHash("sha256").update(JSON.stringify({
					operation: "group-workspace-switch", sourceId: req.params.id, workspaceId: workspaceId ?? null, source: req.body.source ?? null,
				})).digest("hex") }
				: undefined;
			if (creationOperation) {
				try {
					const previous = await teams.findGroupByCreationOperation(creationOperation.key, creationOperation.requestHash);
					if (previous) return { room: await buildWindowSummary(sessions, teams, previous, activityProjector), existed: true, restored: true };
				} catch (err) {
					if (err instanceof RoomCreationOperationConflictError) return reply.code(409).send({ error: err.message, code: "room_operation_conflict" });
					if (err instanceof RoomCreationOperationGoneError) return reply.code(409).send({ error: err.message, code: "room_operation_gone" });
					if (teams.durabilityUncertain()) return reply.code(409).send({ error: "房间切换结果未确认；请重启服务并回读房间列表，勿直接重复发起", code: "room_switch_uncertain" });
					throw err;
			}
			}
			const sourceWindow = await teams.getWindow(req.params.id);
			if (!sourceWindow) return reply.code(404).send({ error: "window not found", code: "room_source_unavailable" });
			const source = structuredClone(sourceWindow);
			let sourceSnapshot: RoomSourceSnapshot | undefined;
			if (source.type !== "solo" && req.body.mode !== "in_place") {
				const supplied = req.body.source;
				if (!supplied || (supplied.type !== "direct" && supplied.type !== "group") || typeof supplied.name !== "string" ||
					!Array.isArray(supplied.members) || supplied.members.some((member) => typeof member !== "string") ||
					typeof supplied.prompt !== "string" || (supplied.workspaceId !== null && typeof supplied.workspaceId !== "string") ||
					typeof supplied.cwdSnapshot !== "string") {
					return reply.code(400).send({ error: "跨项目发起需要来源房间快照", code: "room_source_invalid" });
				}
				const configuredAgents = await teams.listAgents();
				const displayMembers = source.members.map((member) => configuredAgents.find((agent) => agent.name === member)).filter((agent): agent is AgentConfig => Boolean(agent));
				const actualName = source.name || autoTitle(source, displayMembers);
				if (supplied.type !== source.type || supplied.name !== actualName || supplied.prompt !== (source.prompt ?? "") ||
					supplied.workspaceId !== (source.workspaceId ?? null) || supplied.cwdSnapshot !== source.cwdSnapshot ||
					supplied.members.length !== source.members.length || supplied.members.some((member, index) => member !== source.members[index])) {
					return reply.code(409).send({ error: "来源房间配置已变化；请刷新房间后重新发起", code: "room_source_changed" });
				}
				sourceSnapshot = { id: source.id, type: source.type, name: source.name, members: [...source.members], prompt: source.prompt, workspaceId: source.workspaceId, cwdSnapshot: source.cwdSnapshot };
			}
			if (source.type === "group" && req.body.mode !== "in_place" && !creationOperation) {
				return reply.code(400).send({ error: "跨项目新建群聊需要 Idempotency-Key", code: "room_operation_invalid" });
			}
			let target;
			try {
				target = await teams.contextForWorkspace(workspaceId);
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err), ...(err instanceof RoomWorkspaceUnavailableError ? { code: "workspace_unavailable" } : {}) });
			}
			if (workspaceId === source.workspaceId && target.cwdSnapshot === source.cwdSnapshot) {
				return { room: await buildWindowSummary(sessions, teams, source, activityProjector), existed: true, restored: true };
			}
			if (req.body?.mode === "in_place" && source.type !== "solo") {
				return reply.code(400).send({ error: "单聊和群聊按项目使用独立窗口，不能替换当前窗口的 Workspace" });
			}
			if (req.body?.mode !== "in_place" && source.type !== "solo") {
				const agents = new Map((await teams.listAgents()).map((agent) => [agent.name, agent]));
				for (const member of source.members) {
					const agent = agents.get(member);
					if (!agent) return reply.code(400).send({ error: `worker not found: ${member}`, code: "worker_unavailable" });
					if (agent.enabled === false) return reply.code(409).send({ error: `worker「${member}」已停用，不能发起新对话`, code: "worker_disabled" });
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
						let createdHere = false;
						const next = await teams.ensureDirectWindow(
							source.members[0]!,
							workspaceId,
							(reservedId) => {
								createdHere = true;
								return sessions.create(undefined, ctx, reservedId);
							},
							{ name: source.name, prompt: source.prompt, cwdSnapshot: target.cwdSnapshot, requireEnabledMember: true, rollbackSession: (id) => sessions.remove(id), journalSession: true, sourceSnapshot },
						);
						return { room: await buildWindowSummary(sessions, teams, next, activityProjector), existed: !createdHere, restored: !createdHere };
					}
					if (source.type === "solo") {
						return reply.code(400).send({ error: "solo 项目切换必须使用 in_place" });
					}
					let createdHere = false;
					const next = await teams.createWindow({
						type: source.type,
						members: source.members,
						name: source.name,
						prompt: source.prompt,
						workspaceId,
						cwdSnapshot: target.cwdSnapshot,
						requireEnabledMembers: true,
						journalSession: true,
						creationOperation,
						sourceSnapshot,
						createSession: (reservedId) => { createdHere = true; return sessions.create(undefined, ctx, reservedId); },
						rollbackSession: (id) => sessions.remove(id),
					});
					return { room: await buildWindowSummary(sessions, teams, next, activityProjector), existed: !createdHere, restored: !createdHere };
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
					(id) => sessions.prepareForParking(id),
					(id) => sessions.validateStoredContext(id),
					(id) => sessions.suspend(id),
					(id) => sessions.remove(id),
				);
				await ensureWindowAlive(switched.window).catch((error) => {
					app.log.warn({ error, windowId: switched.window.id }, "post-switch Session cleanup failed");
				});
				const current = (await teams.getWindow(source.id)) ?? switched.window;
				if (switched.restored && workStates && localFiles?.productSettings) {
					const state = await workStates.getActive(current.activeSession);
					const recovery = (await localFiles.productSettings.get()).harness.goalRecovery;
					if (state?.execution.status === "interrupted" && recovery.mode === "safe_auto") {
						await invoker.withActiveSessionLifecycle(current.activeSession, () =>
							workStates.resumeGoal(
								current.activeSession,
								state.revision,
								{ ownerId: "workspace-reactivation", leaseMs: recovery.resumeLeaseMs },
								`context-reactivated:${state.goalId}:${state.execution.epoch}`,
								state.goalId,
							),
						).catch(() => undefined);
					}
				}
				return { room: await buildWindowSummary(sessions, teams, current, activityProjector), existed: switched.existed, restored: switched.restored };
			} catch (err) {
				if (err instanceof RoomCreationOperationConflictError) return reply.code(409).send({ error: err.message, code: "room_operation_conflict" });
				if (err instanceof RoomCreationOperationGoneError) return reply.code(409).send({ error: err.message, code: "room_operation_gone" });
				if (teams.durabilityUncertain()) {
					return reply.code(409).send({ error: "房间切换结果未确认；请重启服务并回读房间列表，勿直接重复发起", code: "room_switch_uncertain" });
				}
				if (err instanceof WindowSessionCleanupError) {
					app.log.error({ err, sessionId: err.sessionId }, "workspace switch Session cleanup failed");
					return reply.code(500).send({ error: err.message, code: "room_session_cleanup_failed" });
				}
				if (err instanceof RoomWorkerUnavailableError) return reply.code(400).send({ error: err.message, code: "worker_unavailable" });
				if (err instanceof RoomWorkspaceUnavailableError) return reply.code(400).send({ error: err.message, code: "workspace_unavailable" });
				if (err instanceof RoomSourceUnavailableError) return reply.code(404).send({ error: err.message, code: "room_source_unavailable" });
				if (err instanceof RoomSourceChangedError) return reply.code(409).send({ error: err.message, code: "room_source_changed" });
				const message = err instanceof Error ? err.message : String(err);
				return reply.code(message.includes("已停用") ? 409 : 400).send({ error: message, ...(message.includes("已停用") ? { code: "worker_disabled" } : {}) });
			}
		},
	);

	/** 删除窗口（级联删除其全部 pi session）。solo 拒绝（405）。 */
	app.delete<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		if (w.pinned) return reply.code(405).send({ error: "solo 窗口不可删除" });
		try {
			const remove = async () => {
				const sessionIds = await teams.removeWindow(req.params.id);
				for (const sid of sessionIds) {
					await sessions.remove(sid);
					await workStates?.removeSession(sid);
				}
			};
			if (invoker) {
				await invoker.closeWindow(
					req.params.id,
					async () => {
						const current = await teams.getWindow(req.params.id);
						if (!current) throw new Error("window not found");
						if (current.pinned) throw new Error("solo 窗口不可删除");
					},
					remove,
				);
			} else {
				await remove();
			}
			return reply.code(204).send();
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.get<{ Params: { id: string } }>("/api/rooms/:id/sessions", async (req, reply) => {
		const w = await teams.getWindow(req.params.id);
		if (!w) return reply.code(404).send({ error: "window not found" });
		const summary = await buildWindowSummary(sessions, teams, w, activityProjector);
		return { sessions: summary.sessions, active: summary.activeSession };
	});

	/** Resolve a Manager deep link without treating a parked Session as active. */
	app.get<{ Params: { id: string; sid: string } }>("/api/rooms/:id/sessions/:sid/location", async (req, reply) => {
		const room = await teams.getWindow(req.params.id);
		if (!room || room.type !== "solo") return reply.code(404).send({ error: "Manager 工作台不存在" });
		const context = await teams.contextForSession(req.params.sid);
		if (!context || context.window.id !== room.id) return reply.code(404).send({ error: "目标工作记录不存在或不属于 Manager" });
		return { roomId: room.id, sessionId: req.params.sid, workspaceId: context.workspaceId ?? null, active: context.active };
	});

	/** 窗口内新建一个 pi session 并激活。 */
	app.post<{ Params: { id: string }; Body: { goal?: string; completionBoundary?: string; reviewMode?: "manager" | "independent"; reviewerModel?: string; initialContentHash?: string; expectedWorkspaceId?: string | null; expectedCwdSnapshot?: string } }>("/api/rooms/:id/sessions", async (req, reply) => {
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
		if (!requestedGoal && goalOperationId) {
			if (!sessionCreationOperations) return reply.code(503).send({ error: "Session 幂等存储未配置" });
			if ("expectedWorkspaceId" in (req.body ?? {}) && (req.body.expectedWorkspaceId !== (w.workspaceId ?? null)
				|| req.body.expectedCwdSnapshot !== w.cwdSnapshot)) {
				return reply.code(409).send({ error: "Manager 已切换项目，请回到原项目后重试", code: "workspace_context_changed" });
			}
			try {
				const contextKey = JSON.stringify([w.workspaceId ?? null, w.cwdSnapshot]);
				const current = await buildWindowSummary(sessions, teams, w, activityProjector);
				const idleCandidate = w.type === "solo" && w.sessions.length === 1 && !current.lastActivityAt
					? await sessions.open(w.activeSession).catch(() => undefined) : undefined;
				const preferredSessionId = idleCandidate?.messages.length === 0 ? w.activeSession : undefined;
				const operation = await sessionCreationOperations.reserve(goalOperationId, w.id, contextKey, preferredSessionId, req.body?.initialContentHash);
				let pending = pendingSessionCreations.get(goalOperationId);
				if (!pending) {
					pending = (async () => {
						const listed = (await sessions.list()).find((item) => item.id === operation.sessionId);
						const owner = await teams.windowForSession(operation.sessionId);
						if (operation.phase === "attached" && !listed && !owner) throw new DeletedWorkSessionError(operation.sessionId);
						if (operation.phase === "attached" && (!listed || owner?.id !== w.id)) {
							throw new Error("幂等 Session 已提交但不存在或归属改变");
						}
						if (owner && owner.id !== w.id) throw new Error("幂等 Session 属于其他房间");
						if (!listed && operation.phase === "reserved") await sessions.create(undefined, await contextFor(w), operation.sessionId);
						if (operation.phase === "reserved") await teams.addWindowSession(w.id, operation.sessionId);
						await sessionCreationOperations.markAttached(goalOperationId, operation.sessionId);
						const session = (await sessions.list()).find((item) => item.id === operation.sessionId);
						if (!session) throw new Error("幂等 Session 创建后不可读取");
						return session;
					})();
					pendingSessionCreations.set(goalOperationId, pending);
					void pending.finally(() => {
						if (pendingSessionCreations.get(goalOperationId) === pending) pendingSessionCreations.delete(goalOperationId);
					}).catch(() => undefined);
				}
				return { session: await pending, workState: null };
			} catch (err) {
				return reply.code(409).send({
					error: err instanceof Error ? err.message : String(err),
					code: err instanceof DeletedWorkSessionError ? "session_creation_deleted" : "idempotent_session_conflict",
					...(err instanceof DeletedWorkSessionError ? { sessionId: err.sessionId } : {}),
				});
			}
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

	/** First Manager send owns one durable Session identity across HTTP retries. */
	app.post<{ Params: { id: string }; Body: { content?: string; modelRef?: string; thinkingLevel?: string; attachments?: UploadInput[]; workspaceId?: string | null; cwdSnapshot?: string } }>("/api/rooms/:id/new-work", { bodyLimit: 28 * 1024 * 1024 }, async (req, reply) => {
		const room = await teams.getWindow(req.params.id);
		if (!room || room.type !== "solo") return reply.code(404).send({ error: "Manager 工作台不存在" });
		if (!req.body || !("workspaceId" in req.body) || typeof req.body.cwdSnapshot !== "string") {
			return reply.code(400).send({ error: "新工作必须指定发起时的 Workspace context" });
		}
		if (req.body.workspaceId !== (room.workspaceId ?? null) || req.body.cwdSnapshot !== room.cwdSnapshot) {
			return reply.code(409).send({ error: "Manager 已切换项目，请回到原项目后重试", code: "workspace_context_changed" });
		}
		const content = req.body?.content?.trim();
		if (!content || content.length > 100_000) return reply.code(400).send({ error: "新工作内容必须为 1–100000 字符" });
		if (req.body.modelRef !== undefined && (typeof req.body.modelRef !== "string" || !req.body.modelRef.trim() || req.body.modelRef.length > 512)) {
			return reply.code(400).send({ error: "新工作模型引用无效" });
		}
		const modelRef = req.body.modelRef?.trim();
		// 思考强度与模型同为预约身份的一部分（§10.6）：改档位等同改模型，须换操作键。
		if (req.body.thinkingLevel !== undefined && (typeof req.body.thinkingLevel !== "string" || !req.body.thinkingLevel.trim() || req.body.thinkingLevel.length > 32)) {
			return reply.code(400).send({ error: "新工作思考强度无效" });
		}
		const thinkingLevel = req.body.thinkingLevel?.trim();
		let attachmentIdentities;
		try { attachmentIdentities = identifyUploads(req.body.attachments ?? []); }
		catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
		if (attachmentIdentities.length && !localFiles?.uploads) return reply.code(400).send({ error: "平台未启用会话附件冻结" });
		const key = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
		if (!key) return reply.code(400).send({ error: "新工作需要 Idempotency-Key" });
		const contentHash = createHash("sha256").update(JSON.stringify([content, modelRef ?? null, thinkingLevel ?? null, attachmentIdentities])).digest("hex");
		const freezeId = createHash("sha256").update(JSON.stringify([key, contentHash])).digest("hex");
		const creation = await app.inject({
			method: "POST",
			url: `/api/rooms/${encodeURIComponent(room.id)}/sessions`,
			headers: { "idempotency-key": key },
			payload: { initialContentHash: contentHash, expectedWorkspaceId: req.body.workspaceId, expectedCwdSnapshot: req.body.cwdSnapshot },
		});
		if (creation.statusCode !== 200) return reply.code(creation.statusCode).send(creation.json());
		const sessionId = (creation.json() as { session: { id: string } }).session.id;
		const sessionContext = await teams.contextForSession(sessionId);
		if (!sessionContext || sessionContext.window.id !== room.id || sessionContext.workspaceId !== (req.body.workspaceId ?? undefined)
			|| sessionContext.cwdSnapshot !== req.body.cwdSnapshot || !sessionContext.active) {
			return reply.code(409).send({ error: "Manager 项目在创建期间发生变化，请回到原项目后重试", code: "workspace_context_changed" });
		}
		let pending = pendingNewWork.get(key);
		if (!pending) {
			pending = (async () => {
				const session = await sessions.open(sessionId);
				const firstUserEntry = session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
				if (firstUserEntry || session.messages.some((message) => message.role === "user")) {
					if (firstUserEntry?.type !== "message" || firstUserEntry.message.role !== "user") {
						throw new Error("首次发送尚未写入会话记录，请保留原操作键重试");
					}
					const message = await durableUserMessageText(session.sessionFile, firstUserEntry.id);
					if (message === null) throw new Error("首次发送尚未写入会话记录，请保留原操作键重试");
					const workspaceRoot = await realpath(room.cwdSnapshot).catch(() => path.resolve(room.cwdSnapshot));
					const workspacePath = path.resolve(room.cwdSnapshot);
					const pathReferences = (await Promise.all(localPathReferences(content).map(async (reference): Promise<FirstMessagePathReference | null> => {
						const lexical = path.resolve(reference.absolutePath);
						const canonical = await realpath(reference.absolutePath).catch(() => undefined);
						if (canonical) return isWithin(canonical, workspaceRoot) ? null : { token: reference.token, required: true };
						const definitelyExternal = !isWithin(lexical, workspaceRoot) && !isWithin(lexical, workspacePath);
						return { token: reference.token, required: definitelyExternal };
					}))).filter((reference): reference is FirstMessagePathReference => reference !== null);
					const matches = localFiles?.uploads
						? await localFiles.uploads.matchesFirstMessage(sessionId, message, content, attachmentIdentities, pathReferences)
						: pathReferences.every((reference) => !reference.required) && attachmentIdentities.length === 0 && message === content;
					if (!matches) throw new FirstWorkMessageConflictError();
				}
				if (!firstUserEntry && !session.messages.some((message) => message.role === "user")) {
					if (sessions.isRunning(sessionId)) throw new Error("首次发送仍在处理，请保留原操作键稍后重试");
					if (session.sessionManager.getBranch().some((entry) => entry.type === "message")) throw new FirstWorkMessageConflictError();
					await localFiles?.uploads?.discardUnacceptedFirstWork(sessionId, freezeId);
					const selectedModel = modelRef ? await sessions.setModel(sessionId, modelRef) : session.model;
					if (!selectedModel || !(await sessions.hasModelAuth(selectedModel.provider))) {
						throw new Error("请先为 Manager 配置模型；新工作草稿和 Session 已保留，可重试发送");
					}
					// 档位与模型同样在首发前落到预约 Session；非法值由 store 拒绝。
					if (thinkingLevel) await sessions.setThinkingLevel(sessionId, thinkingLevel);
					const sent = await app.inject({
						method: "POST",
						url: `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
						headers: { "x-puddingteams-await-preflight": "1", "x-puddingteams-first-work-freeze-id": freezeId, "x-puddingteams-first-work-token": internalFirstWorkFreezeToken },
						payload: { content, attachments: req.body.attachments ?? [] },
					});
					if (sent.statusCode !== 200) throw new Error((sent.json() as { error?: string }).error ?? `首次发送失败：${sent.statusCode}`);
				}
				return { sessionId, accepted: true };
			})();
			pendingNewWork.set(key, pending);
			void pending.finally(() => {
				if (pendingNewWork.get(key) === pending) pendingNewWork.delete(key);
			}).catch(() => undefined);
		}
		try { return await pending; }
		catch (err) {
			return reply.code(err instanceof FirstWorkMessageConflictError ? 409 : 400).send({
				error: err instanceof Error ? err.message : String(err),
				sessionId,
				...(err instanceof FirstWorkMessageConflictError ? { code: "first_message_conflict" } : {}),
			});
		}
	});

	/** 窗口内删除一个 pi session（最后一个受保护）。 */
	app.delete<{ Params: { id: string; sid: string } }>(
		"/api/rooms/:id/sessions/:sid",
		async (req, reply) => {
			try {
				const remove = async () => {
					const { removed, blocked } = await teams.removeWindowSession(req.params.id, req.params.sid);
					if (blocked) throw new Error(blocked);
					if (!removed) throw new Error("session not found in window");
					await sessions.remove(req.params.sid);
					await workStates?.removeSession(req.params.sid);
				};
				const preflight = async () => {
					const current = await teams.getWindow(req.params.id);
					if (!current?.sessions.includes(req.params.sid)) throw new Error("session not found in window");
					if (current.sessions.length <= 1) throw new Error("窗口至少要保留一个会话");
				};
				if (invoker) await invoker.closeManagerSession(req.params.sid, preflight, remove);
				else {
					await preflight();
					await remove();
				}
				return reply.code(204).send();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return reply.code(message === "session not found in window" ? 404 : 400).send({ error: message });
			}
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
				const summary = await buildWindowSummary(sessions, teams, w, activityProjector);
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
