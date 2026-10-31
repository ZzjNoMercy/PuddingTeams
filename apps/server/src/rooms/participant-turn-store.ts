import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * ParticipantTurn / ParticipantInput 存储（方案 §18.2）。
 *
 * 每个 RoomSession 一个 turns.json（原子整文件）。它只描述公开回合、
 * 冻结的输入范围和公共投影状态，不复制 Delegation 私有执行事实。
 */

export type ParticipantTurnStatus =
	| "admitted"
	| "running"
	| "waiting_input"
	| "reconciling"
	| "unknown"
	| "interrupted_unknown"
	| "completed"
	| "failed"
	| "cancelled";

export type ParticipantInputDelivery = "normal" | "followUp";

export interface ParticipantInput {
	operationId: string;
	sourceRoomEventId: string;
	contextFromAfterRoomEventId?: string;
	contextThroughRoomEventId: string;
	inputHash: string;
	delivery: ParticipantInputDelivery;
	agentUserEntryId?: string;
	persistence: "pending" | "durable";
}

export type ParticipantTurnExecution =
	| { kind: "native_pi" }
	| { kind: "direct_chat"; delegationId: string };

export interface NewParticipantTurn {
	id: string;
	agentSessionId: string;
	sourceRoomEventId: string;
	contextFromAfterRoomEventId?: string;
	contextThroughRoomEventId: string;
	inputHash: string;
	operationId: string;
	bindingRevision: number;
	inputs?: ParticipantInput[];
	execution?: ParticipantTurnExecution;
	delegationIds?: string[];
}

export interface ParticipantTurn {
	id: string;
	agentSessionId: string;
	roomSessionId: string;
	sourceRoomEventId: string;
	contextFromAfterRoomEventId?: string;
	contextThroughRoomEventId: string;
	inputHash: string;
	operationId: string;
	/** 准入时冻结的 binding revision，用于审计与并发核对。 */
	bindingRevision: number;
	inputs: ParticipantInput[];
	execution?: ParticipantTurnExecution;
	delegationIds: string[];
	status: ParticipantTurnStatus;
	finalContent?: string;
	terminalReason?: string;
	publicProjectionState: "pending" | "projected" | "not_applicable";
	createdAt: string;
	updatedAt: string;
}

export class RoomTurnStoreRecoveryRequiredError extends Error {
	constructor(readonly roomSessionId: string, reason: string) {
		super(`room turn store requires recovery: ${roomSessionId}: ${reason}`);
		this.name = "RoomTurnStoreRecoveryRequiredError";
	}
}

export class RoomTurnNotFoundError extends Error {
	constructor(readonly roomSessionId: string, readonly turnId: string) {
		super(`participant turn not found: ${turnId}`);
		this.name = "RoomTurnNotFoundError";
	}
}

export class RoomTurnConflictError extends Error {
	constructor(readonly roomSessionId: string, message: string) {
		super(message);
		this.name = "RoomTurnConflictError";
	}
}

export class RoomTurnPersistenceUncertainError extends Error {
	constructor(readonly roomSessionId: string, message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "RoomTurnPersistenceUncertainError";
	}
}

const STATUSES: ReadonlySet<string> = new Set([
	"admitted", "running", "waiting_input", "reconciling", "unknown",
	"interrupted_unknown", "completed", "failed", "cancelled",
]);
const TERMINAL_STATUSES: ReadonlySet<ParticipantTurnStatus> = new Set(["completed", "failed", "cancelled", "interrupted_unknown"]);
const PROJECTION_STATES: ReadonlySet<string> = new Set(["pending", "projected", "not_applicable"]);
const DELIVERIES: ReadonlySet<string> = new Set(["normal", "followUp"]);
const SAFE_ROOM_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const HASH = /^[a-f0-9]{64}$/;

type TurnMap = Record<string, ParticipantTurn>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRoomSessionId(roomSessionId: string): void {
	if (!SAFE_ROOM_SESSION_ID.test(roomSessionId)) throw new RoomTurnConflictError(roomSessionId, "roomSessionId 无效");
}

function validInput(value: unknown): value is ParticipantInput {
	if (!isRecord(value)) return false;
	return typeof value.operationId === "string" && value.operationId.length > 0
		&& typeof value.sourceRoomEventId === "string" && value.sourceRoomEventId.length > 0
		&& (value.contextFromAfterRoomEventId === undefined || typeof value.contextFromAfterRoomEventId === "string" && value.contextFromAfterRoomEventId.length > 0)
		&& typeof value.contextThroughRoomEventId === "string" && value.contextThroughRoomEventId.length > 0
		&& typeof value.inputHash === "string" && value.inputHash.length > 0
		&& typeof value.delivery === "string" && DELIVERIES.has(value.delivery)
		&& (value.agentUserEntryId === undefined || typeof value.agentUserEntryId === "string" && value.agentUserEntryId.length > 0)
		&& (value.persistence === "pending" || value.persistence === "durable");
}

function validExecution(value: unknown): value is ParticipantTurnExecution {
	if (!isRecord(value)) return false;
	if (value.kind === "native_pi") return true;
	return value.kind === "direct_chat" && typeof value.delegationId === "string" && value.delegationId.length > 0;
}

function validateTurn(roomSessionId: string, turnId: string, raw: unknown): ParticipantTurn {
	if (!isRecord(raw)) throw new RoomTurnStoreRecoveryRequiredError(roomSessionId, `turn ${turnId} is not an object`);
	const fail = (reason: string): never => { throw new RoomTurnStoreRecoveryRequiredError(roomSessionId, `turn ${turnId}: ${reason}`); };
	if (raw.id !== turnId) fail("id mismatch");
	if (raw.roomSessionId !== roomSessionId) fail("roomSessionId mismatch");
	if (typeof raw.agentSessionId !== "string" || !raw.agentSessionId) fail("agentSessionId");
	if (typeof raw.sourceRoomEventId !== "string" || !raw.sourceRoomEventId) fail("sourceRoomEventId");
	if (raw.contextFromAfterRoomEventId !== undefined && (typeof raw.contextFromAfterRoomEventId !== "string" || !raw.contextFromAfterRoomEventId)) fail("contextFromAfterRoomEventId");
	if (typeof raw.contextThroughRoomEventId !== "string" || !raw.contextThroughRoomEventId) fail("contextThroughRoomEventId");
	if (typeof raw.inputHash !== "string" || !raw.inputHash) fail("inputHash");
	if (typeof raw.operationId !== "string" || !raw.operationId) fail("operationId");
	if (!Number.isSafeInteger(raw.bindingRevision) || (raw.bindingRevision as number) < 1) fail("bindingRevision");
	if (!Array.isArray(raw.inputs) || !raw.inputs.every(validInput)) fail("inputs");
	if (new Set((raw.inputs as ParticipantInput[]).map((input) => input.operationId)).size !== (raw.inputs as ParticipantInput[]).length) fail("duplicate input operationId");
	if (raw.execution !== undefined && !validExecution(raw.execution)) fail("execution");
	if (!Array.isArray(raw.delegationIds) || !raw.delegationIds.every((id: unknown) => typeof id === "string" && id.length > 0)) fail("delegationIds");
	if (new Set(raw.delegationIds as string[]).size !== (raw.delegationIds as string[]).length) fail("duplicate delegationId");
	if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) fail("status");
	if (raw.finalContent !== undefined && typeof raw.finalContent !== "string") fail("finalContent");
	if (raw.terminalReason !== undefined && typeof raw.terminalReason !== "string") fail("terminalReason");
	if (typeof raw.publicProjectionState !== "string" || !PROJECTION_STATES.has(raw.publicProjectionState)) fail("publicProjectionState");
	if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) fail("createdAt");
	if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) fail("updatedAt");
	if (TERMINAL_STATUSES.has(raw.status as ParticipantTurnStatus) && raw.publicProjectionState === "pending" && raw.finalContent === undefined && raw.terminalReason === undefined) {
		fail("terminal turn without finalContent/terminalReason must use not_applicable");
	}
	return {
		id: turnId,
		agentSessionId: raw.agentSessionId as string,
		roomSessionId,
		sourceRoomEventId: raw.sourceRoomEventId as string,
		...(raw.contextFromAfterRoomEventId ? { contextFromAfterRoomEventId: raw.contextFromAfterRoomEventId as string } : {}),
		contextThroughRoomEventId: raw.contextThroughRoomEventId as string,
		inputHash: raw.inputHash as string,
		operationId: raw.operationId as string,
		bindingRevision: raw.bindingRevision as number,
		inputs: (raw.inputs as ParticipantInput[]).map((input) => ({ ...input })),
		...(raw.execution ? { execution: raw.execution as ParticipantTurnExecution } : {}),
		delegationIds: [...(raw.delegationIds as string[])],
		status: raw.status as ParticipantTurnStatus,
		...(raw.finalContent !== undefined ? { finalContent: raw.finalContent as string } : {}),
		...(raw.terminalReason !== undefined ? { terminalReason: raw.terminalReason as string } : {}),
		publicProjectionState: raw.publicProjectionState as ParticipantTurn["publicProjectionState"],
		createdAt: raw.createdAt as string,
		updatedAt: raw.updatedAt as string,
	};
}

function validateMap(roomSessionId: string, parsed: unknown): TurnMap {
	if (!isRecord(parsed)) throw new RoomTurnStoreRecoveryRequiredError(roomSessionId, "turns.json is not an object");
	const turns: TurnMap = {};
	for (const [turnId, raw] of Object.entries(parsed)) {
		if (!turnId) throw new RoomTurnStoreRecoveryRequiredError(roomSessionId, "empty turn id");
		turns[turnId] = validateTurn(roomSessionId, turnId, raw);
	}
	return turns;
}

const ALLOWED_TRANSITIONS: Record<ParticipantTurnStatus, ReadonlySet<ParticipantTurnStatus>> = {
	admitted: new Set(["running", "waiting_input", "failed", "cancelled", "unknown", "interrupted_unknown"]),
	running: new Set(["waiting_input", "completed", "failed", "cancelled", "reconciling", "unknown"]),
	waiting_input: new Set(["running", "completed", "failed", "cancelled", "unknown"]),
	reconciling: new Set(["running", "completed", "failed", "cancelled", "unknown", "interrupted_unknown"]),
	unknown: new Set(["reconciling", "interrupted_unknown", "failed", "cancelled", "completed", "running"]),
	interrupted_unknown: new Set([]),
	completed: new Set([]),
	failed: new Set([]),
	cancelled: new Set([]),
};

export class ParticipantTurnStore {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly uncertain = new Set<string>();

	constructor(private readonly root: string) {}

	private file(roomSessionId: string): string {
		assertRoomSessionId(roomSessionId);
		return path.join(this.root, roomSessionId, "turns.json");
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

	private async readUnlocked(roomSessionId: string): Promise<TurnMap> {
		let text: string;
		try { text = await readFile(this.file(roomSessionId), "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		if (!text) return {};
		let parsed: unknown;
		try { parsed = JSON.parse(text); }
		catch { throw new RoomTurnStoreRecoveryRequiredError(roomSessionId, "turns.json is not valid JSON"); }
		return validateMap(roomSessionId, parsed);
	}

	private async save(roomSessionId: string, turns: TurnMap): Promise<void> {
		await mkdir(path.dirname(this.file(roomSessionId)), { recursive: true, mode: 0o700 });
		const temp = `${this.file(roomSessionId)}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let renamed = false;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(turns)}\n`);
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
		if (this.uncertain.has(roomSessionId)) throw new RoomTurnPersistenceUncertainError(roomSessionId, "turns.json 持久化结果不确定；需重启对账");
	}

	async list(roomSessionId: string): Promise<ParticipantTurn[]> {
		assertRoomSessionId(roomSessionId);
		return this.runExclusive(roomSessionId, async () => Object.values(await this.readUnlocked(roomSessionId)));
	}

	async get(roomSessionId: string, turnId: string): Promise<ParticipantTurn | undefined> {
		return this.runExclusive(roomSessionId, async () => (await this.readUnlocked(roomSessionId))[turnId]);
	}

	async findByOperation(roomSessionId: string, operationId: string): Promise<ParticipantTurn | undefined> {
		return this.runExclusive(roomSessionId, async () =>
			Object.values(await this.readUnlocked(roomSessionId)).find((turn) => turn.operationId === operationId));
	}

	/** 创建 admitted Turn；同 operationId 已存在时返回已有记录（幂等）。 */
	async admit(roomSessionId: string, turn: NewParticipantTurn): Promise<{ turn: ParticipantTurn; created: boolean }> {
		assertRoomSessionId(roomSessionId);
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const turns = await this.readUnlocked(roomSessionId);
			const existing = Object.values(turns).find((item) => item.operationId === turn.operationId);
			if (existing) {
				if (existing.id !== turn.id || existing.agentSessionId !== turn.agentSessionId || existing.sourceRoomEventId !== turn.sourceRoomEventId
					|| existing.inputHash !== turn.inputHash || existing.contextThroughRoomEventId !== turn.contextThroughRoomEventId) {
					throw new RoomTurnConflictError(roomSessionId, `操作 ${turn.operationId} 已绑定其他 Turn 或输入`);
				}
				return { turn: existing, created: false };
			}
			if (turns[turn.id]) throw new RoomTurnConflictError(roomSessionId, `turn ${turn.id} 已存在`);
			const now = new Date().toISOString();
			const created = validateTurn(roomSessionId, turn.id, {
				...turn,
				roomSessionId,
				status: "admitted",
				inputs: turn.inputs ?? [],
				delegationIds: turn.delegationIds ?? [],
				publicProjectionState: "pending",
				createdAt: now,
				updatedAt: now,
			});
			turns[created.id] = created;
			await this.save(roomSessionId, turns);
			return { turn: created, created: true };
		});
	}

	/** 追加 followUp 输入；同一 operationId 重复时返回既有输入。 */
	async appendInput(roomSessionId: string, turnId: string, input: ParticipantInput): Promise<{ input: ParticipantInput; created: boolean; turn: ParticipantTurn }> {
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const turns = await this.readUnlocked(roomSessionId);
			const turn = turns[turnId];
			if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
			const existing = turn.inputs.find((item) => item.operationId === input.operationId);
			if (existing) {
				if (existing.inputHash !== input.inputHash || existing.contextThroughRoomEventId !== input.contextThroughRoomEventId
					|| existing.sourceRoomEventId !== input.sourceRoomEventId) {
					throw new RoomTurnConflictError(roomSessionId, `输入 ${input.operationId} 已绑定其他内容`);
				}
				return { input: existing, created: false, turn };
			}
			if (TERMINAL_STATUSES.has(turn.status)) throw new RoomTurnConflictError(roomSessionId, `turn ${turnId} 已终态，不能追加输入`);
			if (turn.inputs.length === 0 && input.delivery !== "normal") {
				throw new RoomTurnConflictError(roomSessionId, "Turn 的首个输入必须是 normal");
			}
			turn.inputs = [...turn.inputs, { ...input }];
			turn.updatedAt = new Date().toISOString();
			await this.save(roomSessionId, turns);
			return { input: { ...input }, created: true, turn };
		});
	}

	/** 输入确认落盘/接单后，把对应 ParticipantInput 标为 durable。 */
	async markInputDurable(roomSessionId: string, turnId: string, operationId: string, agentUserEntryId?: string): Promise<ParticipantTurn> {
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const turns = await this.readUnlocked(roomSessionId);
			const turn = turns[turnId];
			if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
			const input = turn.inputs.find((item) => item.operationId === operationId);
			if (!input) throw new RoomTurnConflictError(roomSessionId, `输入 ${operationId} 不属于 turn ${turnId}`);
			if (input.persistence !== "durable") {
				input.persistence = "durable";
				if (agentUserEntryId) {
					if (input.agentUserEntryId && input.agentUserEntryId !== agentUserEntryId) throw new RoomTurnConflictError(roomSessionId, "输入已绑定其他 agentUserEntryId");
					input.agentUserEntryId = agentUserEntryId;
				}
				turn.updatedAt = new Date().toISOString();
				turns[turnId] = validateTurn(roomSessionId, turnId, turn);
				await this.save(roomSessionId, turns);
			}
			return turns[turnId]!;
		});
	}

	/** 执行结果不确定：不伪造 failed/cancelled，进入人工对账。 */
	async markUnknown(roomSessionId: string, turnId: string, reason: string): Promise<ParticipantTurn> {
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const turns = await this.readUnlocked(roomSessionId);
			const turn = turns[turnId];
			if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
			if (turn.status !== "unknown") {
				if (!ALLOWED_TRANSITIONS[turn.status].has("unknown")) throw new RoomTurnConflictError(roomSessionId, `非法状态迁移：${turn.status} → unknown`);
				turn.status = "unknown";
				turn.terminalReason = reason;
				turn.updatedAt = new Date().toISOString();
				turns[turnId] = validateTurn(roomSessionId, turnId, turn);
				await this.save(roomSessionId, turns);
			}
			return turns[turnId]!;
		});
	}

	/** 显式取消未 durable 的排队输入；已 durable 的输入不能回滚。 */
	async dropPendingInput(roomSessionId: string, turnId: string, operationId: string): Promise<ParticipantTurn> {
		return this.runExclusive(roomSessionId, async () => {
			const turns = await this.readUnlocked(roomSessionId);
			const turn = turns[turnId];
			if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
			const input = turn.inputs.find((item) => item.operationId === operationId);
			if (!input) throw new RoomTurnConflictError(roomSessionId, `输入不存在: ${operationId}`);
			if (input.persistence === "durable") throw new RoomTurnConflictError(roomSessionId, `输入已 durable，不能取消: ${operationId}`);
			turn.inputs = turn.inputs.filter((item) => item.operationId !== operationId);
			turn.updatedAt = new Date().toISOString();
			turns[turnId] = validateTurn(roomSessionId, turnId, turn);
			await this.save(roomSessionId, turns);
			return turns[turnId]!;
		});
	}

	/** 用户显式确认无 live Run 后解除公开回合锁。 */
	async closeUnknown(roomSessionId: string, turnId: string, reason: string): Promise<ParticipantTurn> {
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const turns = await this.readUnlocked(roomSessionId);
			const turn = turns[turnId];
			if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
			if (turn.status !== "unknown" && turn.status !== "reconciling") throw new RoomTurnConflictError(roomSessionId, `只有 unknown/reconciling 可 close-unknown: ${turn.status}`);
			turn.status = "interrupted_unknown";
			turn.terminalReason = reason;
			turn.updatedAt = new Date().toISOString();
			turns[turnId] = validateTurn(roomSessionId, turnId, turn);
			await this.save(roomSessionId, turns);
			return turns[turnId]!;
		});
	}

	async update(roomSessionId: string, turnId: string, patch: {
		status?: ParticipantTurnStatus;
		execution?: ParticipantTurnExecution;
		delegationIds?: string[];
		finalContent?: string;
		terminalReason?: string;
		publicProjectionState?: ParticipantTurn["publicProjectionState"];
	}): Promise<ParticipantTurn> {
		return this.runExclusive(roomSessionId, async () => {
			this.assertWritable(roomSessionId);
			const turns = await this.readUnlocked(roomSessionId);
			const turn = turns[turnId];
			if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
			if (patch.status && patch.status !== turn.status) {
				if (!ALLOWED_TRANSITIONS[turn.status].has(patch.status)) {
					throw new RoomTurnConflictError(roomSessionId, `非法状态迁移：${turn.status} → ${patch.status}`);
				}
				turn.status = patch.status;
			}
			if (patch.execution) turn.execution = patch.execution;
			if (patch.delegationIds) {
				const next = [...new Set([...turn.delegationIds, ...patch.delegationIds])];
				turn.delegationIds = next;
			}
			if (patch.finalContent !== undefined) turn.finalContent = patch.finalContent;
			if (patch.terminalReason !== undefined) turn.terminalReason = patch.terminalReason;
			if (patch.publicProjectionState) turn.publicProjectionState = patch.publicProjectionState;
			turn.updatedAt = new Date().toISOString();
			turns[turnId] = validateTurn(roomSessionId, turnId, turn);
			await this.save(roomSessionId, turns);
			return turns[turnId]!;
		});
	}

	async removeRoom(roomSessionId: string): Promise<void> {
		return this.runExclusive(roomSessionId, async () => {
			await rm(this.file(roomSessionId), { force: true });
		});
	}
}
