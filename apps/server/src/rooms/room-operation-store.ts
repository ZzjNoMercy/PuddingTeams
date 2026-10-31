import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * RoomSession 操作账本（方案 §18.4）。
 *
 * 每个 RoomSession 一个 operations.json，原子整文件：
 * - creation：建房/新建 RoomSession 的预留守门；
 * - messages：公开消息从 reserved 到 accepted 的阶段；
 * - 投影状态保留在 ParticipantTurn，不在这里复制第二份事实。
 */

export type RoomCreationPhase = "reserved" | "event_file_created" | "manager_created" | "manager_bound" | "attached";
export type RoomMessagePhase = "reserved" | "user_event_appended" | "participant_bound" | "participant_input_durable" | "accepted";

export interface RoomCreationOperation {
	key: string;
	requestHash: string;
	managerAgentSessionId: string;
	phase: RoomCreationPhase;
	createdAt: string;
	updatedAt: string;
}

export interface RoomMessageOperation {
	key: string;
	requestHash: string;
	phase: RoomMessagePhase;
	roomEventId?: string;
	participantTurnId?: string;
	agentSessionId?: string;
	createdAt: string;
	updatedAt: string;
}

interface OperationsFile {
	version: 1;
	creation: Record<string, RoomCreationOperation>;
	messages: Record<string, RoomMessageOperation>;
}

export class RoomOperationConflictError extends Error {
	constructor(readonly roomSessionId: string, message: string) {
		super(message);
		this.name = "RoomOperationConflictError";
	}
}

export class RoomOperationRecoveryRequiredError extends Error {
	constructor(readonly roomSessionId: string, reason: string) {
		super(`room operations require recovery: ${roomSessionId}: ${reason}`);
		this.name = "RoomOperationRecoveryRequiredError";
	}
}

export class RoomOperationPersistenceUncertainError extends Error {
	constructor(readonly roomSessionId: string, message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "RoomOperationPersistenceUncertainError";
	}
}

const CREATION_PHASES: RoomCreationPhase[] = ["reserved", "event_file_created", "manager_created", "manager_bound", "attached"];
const MESSAGE_PHASES: RoomMessagePhase[] = ["reserved", "user_event_appended", "participant_bound", "participant_input_durable", "accepted"];
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SAFE_ROOM_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateCreation(roomSessionId: string, key: string, raw: unknown): RoomCreationOperation {
	if (!isRecord(raw)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `creation ${key} is not an object`);
	if (raw.key !== key) throw new RoomOperationRecoveryRequiredError(roomSessionId, `creation ${key} key mismatch`);
	if (typeof raw.requestHash !== "string" || !raw.requestHash) throw new RoomOperationRecoveryRequiredError(roomSessionId, `creation ${key} requestHash`);
	if (typeof raw.managerAgentSessionId !== "string" || !raw.managerAgentSessionId) throw new RoomOperationRecoveryRequiredError(roomSessionId, `creation ${key} managerAgentSessionId`);
	if (typeof raw.phase !== "string" || !CREATION_PHASES.includes(raw.phase as RoomCreationPhase)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `creation ${key} phase`);
	if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `creation ${key} timestamps`);
	return raw as unknown as RoomCreationOperation;
}

function validateMessage(roomSessionId: string, key: string, raw: unknown): RoomMessageOperation {
	if (!isRecord(raw)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `message ${key} is not an object`);
	if (raw.key !== key) throw new RoomOperationRecoveryRequiredError(roomSessionId, `message ${key} key mismatch`);
	if (typeof raw.requestHash !== "string" || !raw.requestHash) throw new RoomOperationRecoveryRequiredError(roomSessionId, `message ${key} requestHash`);
	if (typeof raw.phase !== "string" || !MESSAGE_PHASES.includes(raw.phase as RoomMessagePhase)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `message ${key} phase`);
	for (const field of ["roomEventId", "participantTurnId", "agentSessionId"] as const) {
		if (raw[field] !== undefined && (typeof raw[field] !== "string" || !(raw[field] as string).length)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `message ${key} ${field}`);
	}
	if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `message ${key} timestamps`);
	return raw as unknown as RoomMessageOperation;
}

function validateFile(roomSessionId: string, parsed: unknown): OperationsFile {
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.creation) || !isRecord(parsed.messages)) {
		throw new RoomOperationRecoveryRequiredError(roomSessionId, "operations.json shape");
	}
	const creation: Record<string, RoomCreationOperation> = {};
	for (const [key, raw] of Object.entries(parsed.creation)) {
		if (!SAFE_KEY.test(key)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `creation key ${key}`);
		creation[key] = validateCreation(roomSessionId, key, raw);
	}
	const messages: Record<string, RoomMessageOperation> = {};
	for (const [key, raw] of Object.entries(parsed.messages)) {
		if (!SAFE_KEY.test(key)) throw new RoomOperationRecoveryRequiredError(roomSessionId, `message key ${key}`);
		messages[key] = validateMessage(roomSessionId, key, raw);
	}
	return { version: 1, creation, messages };
}

function emptyFile(): OperationsFile {
	return { version: 1, creation: {}, messages: {} };
}

export class RoomOperationStore {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly uncertain = new Set<string>();

	constructor(private readonly root: string) {}

	private file(roomSessionId: string): string {
		if (!SAFE_ROOM_SESSION_ID.test(roomSessionId)) throw new RoomOperationConflictError(roomSessionId, "roomSessionId 无效");
		return path.join(this.root, roomSessionId, "operations.json");
	}

	private async runExclusive<T>(roomSessionId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(roomSessionId) ?? Promise.resolve();
		const run = previous.then(action, action);
		const tail = run.then(() => undefined, () => undefined);
		this.queues.set(roomSessionId, tail);
		try { return await run; }
		finally { if (this.queues.get(roomSessionId) === tail) this.queues.delete(roomSessionId); }
	}

	private async syncDirectory(directory: string): Promise<void> {
		const handle = await open(directory, "r");
		try { await handle.sync(); }
		finally { await handle.close(); }
	}

	private async readUnlocked(roomSessionId: string): Promise<OperationsFile> {
		let text: string;
		try { text = await readFile(this.file(roomSessionId), "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
			throw error;
		}
		if (!text) return emptyFile();
		let parsed: unknown;
		try { parsed = JSON.parse(text); }
		catch { throw new RoomOperationRecoveryRequiredError(roomSessionId, "operations.json is not valid JSON"); }
		return validateFile(roomSessionId, parsed);
	}

	private async save(roomSessionId: string, data: OperationsFile): Promise<void> {
		await mkdir(path.dirname(this.file(roomSessionId)), { recursive: true, mode: 0o700 });
		const temp = `${this.file(roomSessionId)}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let renamed = false;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(data)}\n`);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temp, this.file(roomSessionId));
			renamed = true;
			await this.syncDirectory(path.dirname(this.file(roomSessionId)));
		} catch (error) {
			if (renamed) this.uncertain.add(roomSessionId);
			await handle?.close().catch(() => undefined);
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}

	private assertWritable(roomSessionId: string): void {
		if (this.uncertain.has(roomSessionId)) throw new RoomOperationPersistenceUncertainError(roomSessionId, "operations.json 持久化结果不确定；需重启对账");
	}

	async getCreation(roomSessionId: string, key: string): Promise<RoomCreationOperation | undefined> {
		return this.runExclusive(roomSessionId, async () => (await this.readUnlocked(roomSessionId)).creation[key]);
	}

	async getMessage(roomSessionId: string, key: string): Promise<RoomMessageOperation | undefined> {
		return this.runExclusive(roomSessionId, async () => (await this.readUnlocked(roomSessionId)).messages[key]);
	}

	async listMessages(roomSessionId: string): Promise<RoomMessageOperation[]> {
		return this.runExclusive(roomSessionId, async () => Object.values((await this.readUnlocked(roomSessionId)).messages));
	}

	async reserveCreation(roomSessionId: string, input: { key: string; requestHash: string; managerAgentSessionId: string }): Promise<{ operation: RoomCreationOperation; created: boolean }> {
		if (!SAFE_KEY.test(input.key)) throw new RoomOperationConflictError(roomSessionId, "creation key 无效");
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const data = await this.readUnlocked(roomSessionId);
			const existing = data.creation[input.key];
			if (existing) {
				if (existing.requestHash !== input.requestHash || existing.managerAgentSessionId !== input.managerAgentSessionId) {
					throw new RoomOperationConflictError(roomSessionId, "同一创建键已用于不同请求");
				}
				return { operation: existing, created: false };
			}
			const now = new Date().toISOString();
			const operation: RoomCreationOperation = { ...input, phase: "reserved", createdAt: now, updatedAt: now };
			data.creation[input.key] = operation;
			await this.save(roomSessionId, data);
			return { operation, created: true };
		});
	}

	async advanceCreation(roomSessionId: string, key: string, to: RoomCreationPhase, patch: Partial<Pick<RoomCreationOperation, "managerAgentSessionId">> = {}): Promise<RoomCreationOperation> {
		return await this.advance(roomSessionId, "creation", key, to, CREATION_PHASES, patch) as RoomCreationOperation;
	}

	async reserveMessage(roomSessionId: string, input: { key: string; requestHash: string }): Promise<{ operation: RoomMessageOperation; created: boolean }> {
		if (!SAFE_KEY.test(input.key)) throw new RoomOperationConflictError(roomSessionId, "message key 无效");
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const data = await this.readUnlocked(roomSessionId);
			const existing = data.messages[input.key];
			if (existing) {
				if (existing.requestHash !== input.requestHash) throw new RoomOperationConflictError(roomSessionId, "同一消息键已用于不同请求");
				return { operation: existing, created: false };
			}
			const now = new Date().toISOString();
			const operation: RoomMessageOperation = { ...input, phase: "reserved", createdAt: now, updatedAt: now };
			data.messages[input.key] = operation;
			await this.save(roomSessionId, data);
			return { operation, created: true };
		});
	}

	async advanceMessage(roomSessionId: string, key: string, to: RoomMessagePhase, patch: Partial<Pick<RoomMessageOperation, "roomEventId" | "participantTurnId" | "agentSessionId">> = {}): Promise<RoomMessageOperation> {
		return await this.advance(roomSessionId, "message", key, to, MESSAGE_PHASES, patch) as RoomMessageOperation;
	}

	private async advance<T extends RoomCreationPhase | RoomMessagePhase>(
		roomSessionId: string,
		kind: "creation" | "message",
		key: string,
		to: T,
		order: readonly T[],
		patch: Record<string, string | undefined>,
	): Promise<RoomCreationOperation | RoomMessageOperation> {
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const data = await this.readUnlocked(roomSessionId);
			const table = kind === "creation" ? data.creation : data.messages;
			const current = table[key] as RoomCreationOperation | RoomMessageOperation | undefined;
			if (!current) throw new RoomOperationConflictError(roomSessionId, `${kind} ${key} 尚未 reserve`);
			if (current.phase === to) return current;
			const currentIndex = order.indexOf(current.phase as T);
			const targetIndex = order.indexOf(to);
			if (targetIndex !== currentIndex + 1) {
				throw new RoomOperationConflictError(roomSessionId, `${kind} ${key} 阶段不能从 ${current.phase} 跳到 ${to}`);
			}
			const next = { ...current, ...patch, phase: to, updatedAt: new Date().toISOString() } as RoomCreationOperation | RoomMessageOperation;
			(table as Record<string, RoomCreationOperation | RoomMessageOperation>)[key] = next;
			await this.save(roomSessionId, data);
			return next;
		});
	}

	async removeRoom(roomSessionId: string): Promise<void> {
		await this.runExclusive(roomSessionId, async () => {
			await rm(this.file(roomSessionId), { force: true });
		});
	}
}
