import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * RoomSession 公共事件存储（方案 §18.2/§18.3）。
 *
 * - 每个 RoomSession 一个目录：events.jsonl 是唯一公共历史事实源；
 * - 进程内按 roomSessionId 串行，跨进程依赖 Home 单写者门禁；
 * - seq 连续、event id 唯一；完整坏行/重复/不连续一律 fail-closed 到
 *   recovery_required，保留原字节，不静默截断或跳过；
 * - 追加写完整一行后 fsync；创建文件同时 fsync 父目录。
 */

export type RoomEventKind = "message" | "terminal" | "artifact";
export type RoomActor =
	| { kind: "user" }
	| { kind: "agent"; agentId: string }
	| { kind: "system" };

export interface RoomAttachmentRef {
	name: string;
	path: string;
	mediaType: string;
	size: number;
	sha256: string;
	kind: "file" | "image";
}

export interface RoomArtifactRef {
	name: string;
	path: string;
	kind?: string;
}

export interface RoomEvent {
	id: string;
	roomSessionId: string;
	seq: number;
	kind: RoomEventKind;
	actor: RoomActor;
	content: string;
	mentions: string[];
	attachments?: RoomAttachmentRef[];
	artifactRefs?: RoomArtifactRef[];
	sourceParticipantTurnId?: string;
	replyToEventId?: string;
	createdAt: string;
}

/** 由调用方生成 id/createdAt；seq 与 roomSessionId 由 store 分配/绑定。 */
export type RoomEventDraft = Omit<RoomEvent, "seq" | "roomSessionId">;

export class RoomSessionNotFoundError extends Error {
	constructor(readonly roomSessionId: string) {
		super(`room session not found: ${roomSessionId}`, { cause: undefined });
		this.name = "RoomSessionNotFoundError";
	}
}

export class RoomSessionRecoveryRequiredError extends Error {
	constructor(readonly roomSessionId: string, readonly reason: string) {
		super(`room session requires recovery: ${roomSessionId}: ${reason}`);
		this.name = "RoomSessionRecoveryRequiredError";
	}
}

export class RoomEventConflictError extends Error {
	constructor(readonly roomSessionId: string, message: string) {
		super(message);
		this.name = "RoomEventConflictError";
	}
}

export class RoomPersistenceUncertainError extends Error {
	constructor(readonly roomSessionId: string, message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "RoomPersistenceUncertainError";
	}
}

const EVENT_KINDS: ReadonlySet<string> = new Set(["message", "terminal", "artifact"]);
const ACTOR_KINDS: ReadonlySet<string> = new Set(["user", "agent", "system"]);
const SAFE_ROOM_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function assertRoomSessionId(roomSessionId: string): void {
	if (!SAFE_ROOM_SESSION_ID.test(roomSessionId)) throw new RoomSessionNotFoundError(roomSessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validMentions(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) && new Set(value).size === value.length;
}

function validAttachments(value: unknown): value is RoomAttachmentRef[] {
	return Array.isArray(value) && value.every((item) => {
		if (!isRecord(item)) return false;
		return typeof item.name === "string" && item.name.length > 0
			&& typeof item.path === "string" && item.path.length > 0
			&& typeof item.mediaType === "string" && item.mediaType.length > 0
			&& Number.isSafeInteger(item.size) && (item.size as number) >= 0
			&& typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256)
			&& (item.kind === "file" || item.kind === "image");
	});
}

function validArtifactRefs(value: unknown): value is RoomArtifactRef[] {
	return Array.isArray(value) && value.every((item) => {
		if (!isRecord(item)) return false;
		return typeof item.name === "string" && item.name.length > 0
			&& typeof item.path === "string" && item.path.length > 0
			&& (item.kind === undefined || typeof item.kind === "string");
	});
}

function validActor(value: unknown): value is RoomActor {
	if (!isRecord(value) || typeof value.kind !== "string" || !ACTOR_KINDS.has(value.kind)) return false;
	if (value.kind === "agent") return typeof value.agentId === "string" && value.agentId.length > 0;
	return value.agentId === undefined;
}

/** 校验一条已持久事件；不合法即 recovery_required。 */
function parseEvent(roomSessionId: string, raw: unknown, expectedSeq: number): RoomEvent {
	if (!isRecord(raw)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} is not an object`);
	if (typeof raw.id !== "string" || !raw.id) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has no id`);
	if (raw.roomSessionId !== roomSessionId) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} belongs to another room`);
	if (raw.seq !== expectedSeq) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} expected, got ${String(raw.seq)}`);
	if (typeof raw.kind !== "string" || !EVENT_KINDS.has(raw.kind)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid kind`);
	if (!validActor(raw.actor)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid actor`);
	if (typeof raw.content !== "string") throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid content`);
	if (!validMentions(raw.mentions)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid mentions`);
	if (raw.attachments !== undefined && !validAttachments(raw.attachments)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid attachments`);
	if (raw.artifactRefs !== undefined && !validArtifactRefs(raw.artifactRefs)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid artifactRefs`);
	if (raw.sourceParticipantTurnId !== undefined && (typeof raw.sourceParticipantTurnId !== "string" || !raw.sourceParticipantTurnId)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid sourceParticipantTurnId`);
	if (raw.replyToEventId !== undefined && (typeof raw.replyToEventId !== "string" || !raw.replyToEventId)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid replyToEventId`);
	if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${expectedSeq} has invalid createdAt`);
	return {
		id: raw.id,
		roomSessionId,
		seq: expectedSeq,
		kind: raw.kind as RoomEventKind,
		actor: raw.actor.kind === "agent" ? { kind: "agent", agentId: raw.actor.agentId } : { kind: raw.actor.kind },
		content: raw.content,
		mentions: [...raw.mentions],
		...(raw.attachments ? { attachments: raw.attachments } : {}),
		...(raw.artifactRefs ? { artifactRefs: raw.artifactRefs } : {}),
		...(raw.sourceParticipantTurnId ? { sourceParticipantTurnId: raw.sourceParticipantTurnId } : {}),
		...(raw.replyToEventId ? { replyToEventId: raw.replyToEventId } : {}),
		createdAt: raw.createdAt,
	};
}

function validateDraft(roomSessionId: string, draft: RoomEventDraft): void {
	if (!draft.id) throw new RoomEventConflictError(roomSessionId, "RoomEvent 缺少 id");
	if (!EVENT_KINDS.has(draft.kind)) throw new RoomEventConflictError(roomSessionId, "RoomEvent kind 无效");
	if (!validActor(draft.actor)) throw new RoomEventConflictError(roomSessionId, "RoomEvent actor 无效");
	if (typeof draft.content !== "string") throw new RoomEventConflictError(roomSessionId, "RoomEvent content 无效");
	if (!validMentions(draft.mentions)) throw new RoomEventConflictError(roomSessionId, "RoomEvent mentions 无效");
	if (draft.attachments !== undefined && !validAttachments(draft.attachments)) throw new RoomEventConflictError(roomSessionId, "RoomEvent attachments 无效");
	if (draft.artifactRefs !== undefined && !validArtifactRefs(draft.artifactRefs)) throw new RoomEventConflictError(roomSessionId, "RoomEvent artifactRefs 无效");
	if (!Number.isFinite(Date.parse(draft.createdAt))) throw new RoomEventConflictError(roomSessionId, "RoomEvent createdAt 无效");
}

function sameProjection(left: RoomEvent, right: RoomEventDraft, opts: { ignoreId?: boolean } = {}): boolean {
	return (opts.ignoreId || left.id === right.id)
		&& left.kind === right.kind
		&& JSON.stringify(left.actor) === JSON.stringify(right.actor)
		&& left.content === right.content
		&& JSON.stringify(left.mentions) === JSON.stringify(right.mentions)
		&& JSON.stringify(left.attachments ?? null) === JSON.stringify(right.attachments ?? null)
		&& JSON.stringify(left.artifactRefs ?? null) === JSON.stringify(right.artifactRefs ?? null)
		&& (left.sourceParticipantTurnId ?? null) === (right.sourceParticipantTurnId ?? null)
		&& (left.replyToEventId ?? null) === (right.replyToEventId ?? null);
}

export class RoomEventStore {
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(private readonly root: string) {}

	eventsPath(roomSessionId: string): string {
		assertRoomSessionId(roomSessionId);
		return path.join(this.root, roomSessionId, "events.jsonl");
	}

	private sessionDir(roomSessionId: string): string {
		return path.join(this.root, roomSessionId);
	}

	private async runExclusive<T>(roomSessionId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(roomSessionId) ?? Promise.resolve();
		const run = previous.then(action, action);
		const tail = run.then(() => undefined, () => undefined);
		this.queues.set(roomSessionId, tail);
		try {
			return await run;
		} finally {
			if (this.queues.get(roomSessionId) === tail) this.queues.delete(roomSessionId);
		}
	}

	private async syncDirectory(directory: string): Promise<void> {
		const handle = await open(directory, "r");
		try { await handle.sync(); }
		finally { await handle.close(); }
	}

	/** 创建空的公共事件文件；已存在时返回 false。 */
	async create(roomSessionId: string): Promise<{ created: boolean; path: string }> {
		assertRoomSessionId(roomSessionId);
		const file = this.eventsPath(roomSessionId);
		return this.runExclusive(roomSessionId, async () => {
			try {
				await stat(file);
				return { created: false, path: file };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const directory = this.sessionDir(roomSessionId);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const handle = await open(file, "wx", 0o600);
			try { await handle.sync(); }
			finally { await handle.close(); }
			try {
				await this.syncDirectory(directory);
			} catch (error) {
				throw new RoomPersistenceUncertainError(roomSessionId, "RoomEvent 文件创建后目录同步失败；需启动对账", error);
			}
			return { created: true, path: file };
		});
	}

	async exists(roomSessionId: string): Promise<boolean> {
		try {
			await readFile(this.eventsPath(roomSessionId), "utf8");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/**
	 * 读取并完整校验；任何完整坏行/重复 id/不连续 seq 都进入 recovery_required。
	 * 末行没有换行符视为未完成的追加，同样 fail-closed（不静默截断）。
	 */
	async read(roomSessionId: string): Promise<RoomEvent[]> {
		assertRoomSessionId(roomSessionId);
		return this.runExclusive(roomSessionId, () => this.readUnlocked(roomSessionId));
	}

	private async readUnlocked(roomSessionId: string): Promise<RoomEvent[]> {
		let text: string;
		try {
			text = await readFile(this.eventsPath(roomSessionId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RoomSessionNotFoundError(roomSessionId);
			throw error;
		}
		if (!text) return [];
		const lines = text.split("\n");
		const trailing = lines.pop();
		if (text.endsWith("\n")) {
			if (trailing !== "") throw new RoomSessionRecoveryRequiredError(roomSessionId, "events 文件尾部格式无效");
		} else if (trailing && trailing.length > 0) {
			throw new RoomSessionRecoveryRequiredError(roomSessionId, "events 文件存在未完成的追加行");
		}
		const events: RoomEvent[] = [];
		const seen = new Set<string>();
		for (const [index, line] of lines.entries()) {
			if (!line) throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${index + 1} is empty`);
			let parsed: unknown;
			try { parsed = JSON.parse(line); }
			catch { throw new RoomSessionRecoveryRequiredError(roomSessionId, `seq ${index + 1} is not valid JSON`); }
			const event = parseEvent(roomSessionId, parsed, index + 1);
			if (seen.has(event.id)) throw new RoomSessionRecoveryRequiredError(roomSessionId, `duplicate event id: ${event.id}`);
			seen.add(event.id);
			events.push(event);
		}
		return events;
	}

	/** 按 seq 增量读取（afterSeq 为已见尾部，不含）。 */
	async snapshot(roomSessionId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<{ events: RoomEvent[]; throughSeq: number; nextSeq?: number }> {
		const all = await this.read(roomSessionId);
		const after = opts.afterSeq ?? 0;
		if (!Number.isSafeInteger(after) || after < 0 || after > all.length) throw new RoomEventConflictError(roomSessionId, `afterSeq 越界: ${after}`);
		const limit = opts.limit === undefined ? all.length : Math.max(1, Math.min(opts.limit, 500));
		const remaining = all.slice(after);
		const events = remaining.slice(0, limit);
		const throughSeq = events.at(-1)?.seq ?? after;
		return { events, throughSeq, ...(after + events.length < all.length ? { nextSeq: after + events.length } : {}) };
	}

	async append(roomSessionId: string, draft: RoomEventDraft): Promise<RoomEvent> {
		assertRoomSessionId(roomSessionId);
		validateDraft(roomSessionId, draft);
		return this.runExclusive(roomSessionId, async () => {
			const events = await this.readUnlocked(roomSessionId);
			if (events.some((event) => event.id === draft.id)) throw new RoomEventConflictError(roomSessionId, `event ${draft.id} 已存在`);
			return this.appendUnlocked(roomSessionId, events, draft);
		});
	}

	/**
	 * 幂等投影：同一 sourceParticipantTurnId 只发布一次（§8.2）；显式 event id
	 * 已存在时同内容回放、不同内容冲突。
	 */
	async appendIdempotent(roomSessionId: string, draft: RoomEventDraft): Promise<{ event: RoomEvent; created: boolean }> {
		assertRoomSessionId(roomSessionId);
		validateDraft(roomSessionId, draft);
		return this.runExclusive(roomSessionId, async () => {
			const events = await this.readUnlocked(roomSessionId);
			const byId = events.find((event) => event.id === draft.id);
			if (byId) {
				if (!sameProjection(byId, draft)) throw new RoomEventConflictError(roomSessionId, `event ${draft.id} 已存在且内容不同`);
				return { event: byId, created: false };
			}
			if (draft.sourceParticipantTurnId) {
				const byTurn = events.find((event) => event.sourceParticipantTurnId === draft.sourceParticipantTurnId);
				if (byTurn) {
					if (!sameProjection(byTurn, draft, { ignoreId: true })) throw new RoomEventConflictError(roomSessionId, `turn ${draft.sourceParticipantTurnId} 的公共投影已存在且内容不同`);
					return { event: byTurn, created: false };
				}
			}
			return { event: await this.appendUnlocked(roomSessionId, events, draft), created: true };
		});
	}

	private async appendUnlocked(roomSessionId: string, events: RoomEvent[], draft: RoomEventDraft): Promise<RoomEvent> {
		const seq = events.length + 1;
		const event: RoomEvent = {
			id: draft.id,
			roomSessionId,
			seq,
			kind: draft.kind,
			actor: draft.actor,
			content: draft.content,
			mentions: [...draft.mentions],
			...(draft.attachments ? { attachments: draft.attachments } : {}),
			...(draft.artifactRefs ? { artifactRefs: draft.artifactRefs } : {}),
			...(draft.sourceParticipantTurnId ? { sourceParticipantTurnId: draft.sourceParticipantTurnId } : {}),
			...(draft.replyToEventId ? { replyToEventId: draft.replyToEventId } : {}),
			createdAt: draft.createdAt,
		};
		const file = this.eventsPath(roomSessionId);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(file, "a", 0o600);
			await handle.writeFile(`${JSON.stringify(event)}\n`);
			await handle.sync();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RoomSessionNotFoundError(roomSessionId);
			throw new RoomPersistenceUncertainError(roomSessionId, "RoomEvent 追加写盘失败；需启动对账", error);
		} finally {
			await handle?.close().catch(() => undefined);
		}
		return event;
	}

	/** 删除整个 RoomSession 公共目录（仅由 §21.4 删除事务调用）。 */
	async remove(roomSessionId: string): Promise<void> {
		assertRoomSessionId(roomSessionId);
		await this.runExclusive(roomSessionId, async () => {
			await rm(this.sessionDir(roomSessionId), { recursive: true, force: true });
			await this.syncDirectory(this.root).catch((error) => {
				throw new RoomPersistenceUncertainError(roomSessionId, "RoomSession 删除后目录同步失败", error);
			});
		});
	}

	/** 为 Fork 复制到新 roomSessionId；调用方负责生成新 id。 */
	async fork(sourceRoomSessionId: string, targetRoomSessionId: string, opts: { throughSeq?: number } = {}): Promise<RoomEvent[]> {
		assertRoomSessionId(targetRoomSessionId);
		const events = await this.read(sourceRoomSessionId);
		const through = opts.throughSeq ?? events.length;
		if (!Number.isSafeInteger(through) || through < 0 || through > events.length) throw new RoomEventConflictError(sourceRoomSessionId, `throughSeq 越界: ${through}`);
		const creation = await this.create(targetRoomSessionId);
		if (!creation.created) {
			const existing = await this.read(targetRoomSessionId);
			if (existing.length > 0) throw new RoomEventConflictError(sourceRoomSessionId, `fork target 已有公共事件: ${targetRoomSessionId}`);
		}
		const copied: RoomEvent[] = [];
		for (const event of events.slice(0, through)) {
			copied.push(await this.append(targetRoomSessionId, {
				id: randomUUID(),
				kind: event.kind,
				actor: event.actor,
				content: event.content,
				mentions: event.mentions,
				...(event.attachments ? { attachments: event.attachments } : {}),
				...(event.artifactRefs ? { artifactRefs: event.artifactRefs } : {}),
				...(event.sourceParticipantTurnId ? { sourceParticipantTurnId: event.sourceParticipantTurnId } : {}),
				...(event.replyToEventId ? { replyToEventId: event.replyToEventId } : {}),
				createdAt: event.createdAt,
			}));
		}
		return copied;
	}
}
