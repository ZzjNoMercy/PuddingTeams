import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { PublicationBatch, PublishOperation } from "../contracts.js";

export type PublishOperationState = "queued" | "running" | "published" | "partial" | "conflict" | "unknown";
export type PublishFileStatus = "pending" | "applied" | "failed" | "conflict" | "uncertain" | "rejected" | "rolled_back";

export class PublishJournalError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "conflict", message: string) {
		super(message);
	}
}

/** 单步回执：每步落盘成功后才允许进行下一步（P09 对账的事实源）。 */
export interface PublishReceipt {
	step: "preflight" | "before_image" | "write" | "verify" | "rollback" | "reconcile";
	at: string;
	detail?: string;
}

/** 每文件对账粒度：路径、操作、候选/基线哈希、before-image 引用、回执链与结果态。 */
export interface PublishFileRecord {
	kind?: "image";
	targetPath: string;
	operation: "create" | "update" | "delete";
	candidateHash: string | null;
	baselineHash: string | null;
	beforeImageRef: string | null;
	status: PublishFileStatus;
	receipts: PublishReceipt[];
	error?: string;
}

export interface StoredPublishOperation {
	id: string;
	batchId: string;
	bindingId: string;
	ownerId: string;
	reviewId: string;
	/** 审核执行者（账本回写 acceptedBy 用；对账补提交时同样需要）。 */
	actorId: string;
	idempotencyKey: string;
	manifestHash: string;
	journalRef: string;
	state: PublishOperationState;
	files: PublishFileRecord[];
	/** 已完成账本回写的依赖组（启动对账据此决定补提交还是回滚）。 */
	committedGroups: string[][];
	createdAt: string;
	updatedAt: string;
	finishedAt?: string;
	/** Durable batch-level reason, including failures before any per-file receipt exists. */
	stopReason?: string;
}

interface StoredOperationRow { record_json: string }

function sameMembers(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && new Set(actual).size === actual.length &&
		actual.every((item) => expected.includes(item));
}

const TERMINAL_STATES: ReadonlySet<PublishOperationState> = new Set(["published", "partial", "conflict"]);

/** 把账本记录投影成 wire 合约形状（routes 呈现用）。 */
export function toPublishOperation(record: StoredPublishOperation): PublishOperation {
	return {
		id: record.id,
		batchId: record.batchId,
		reviewId: record.reviewId,
		idempotencyKey: record.idempotencyKey,
		journalRef: record.journalRef,
		state: record.state,
		results: record.files.map((file) => ({
			path: file.targetPath,
			beforeHash: file.baselineHash,
			afterHash: file.status === "applied" ? file.candidateHash : null,
			status: file.status,
			...(file.receipts.length > 0 ? { receiptRef: `${record.journalRef}#${file.targetPath}` } : {}),
		})),
	};
}

/**
 * 发布操作日志（T42）：PublishOperation + 逐项 receipt + journalRef 持久化，
 * operationId（= 审核决定 id）幂等——同键重放复用既有记录，不双写（P07）。
 * 与 compile-jobs/review-store 同款：内置 SQLite、BEGIN IMMEDIATE 事务为权威边界。
 */
export class PublishJournal {
	private readonly file: string;

	constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {
		this.file = path.join(stateDir, "operations.sqlite");
	}

	/** Frozen candidates are not external edits while an uncommitted platform effect remains. */
	async protectedCandidateHashes(bindingId: string): Promise<Map<string, Set<string>>> {
		const protectedHashes = new Map<string, Set<string>>();
		for (const operation of await this.list()) {
			if (operation.bindingId !== bindingId) continue;
			const committed = new Set(operation.committedGroups.flat());
			for (const file of operation.files) {
				if (committed.has(file.targetPath) || !file.candidateHash || ["rolled_back", "rejected"].includes(file.status)) continue;
				const effect = ["applied", "uncertain"].includes(file.status) || file.receipts.some(receipt => receipt.step === "write" || receipt.step === "verify") ||
					(file.status === "pending" && ["running", "unknown"].includes(operation.state));
				if (effect) protectedHashes.set(file.targetPath, new Set([...(protectedHashes.get(file.targetPath) ?? []), file.candidateHash]));
			}
		}
		return protectedHashes;
	}

	private async withDatabase<T>(action: (db: DatabaseSync) => T): Promise<T> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.file);
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec(`CREATE TABLE IF NOT EXISTS publish_operations (
				id TEXT PRIMARY KEY,
				batch_id TEXT NOT NULL,
				binding_id TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				idempotency_key TEXT NOT NULL UNIQUE,
				state TEXT NOT NULL,
				record_json TEXT NOT NULL
			)`);
			return action(db);
		} finally {
			db.close();
		}
	}

	private transaction<T>(db: DatabaseSync, action: () => T): T {
		db.exec("BEGIN IMMEDIATE");
		try {
			const value = action();
			db.exec("COMMIT");
			return value;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	private parse(row: StoredOperationRow): StoredPublishOperation {
		const record = JSON.parse(row.record_json) as StoredPublishOperation;
		if (!record.id || !record.batchId || !record.idempotencyKey || !Array.isArray(record.files) ||
			!Array.isArray(record.committedGroups) || !record.journalRef || !record.createdAt) {
			throw new Error("invalid publish operation record");
		}
		return record;
	}

	private read(db: DatabaseSync, id: string): StoredPublishOperation | undefined {
		const row = db.prepare("SELECT record_json FROM publish_operations WHERE id = ?").get(id) as StoredOperationRow | undefined;
		return row ? this.parse(row) : undefined;
	}

	private replace(db: DatabaseSync, record: StoredPublishOperation): void {
		const changed = db.prepare("UPDATE publish_operations SET state = ?, record_json = ? WHERE id = ?")
			.run(record.state, JSON.stringify(record), record.id).changes;
		if (changed !== 1) throw new Error("publish operation disappeared during transition");
	}

	/** 登记发布操作：同 idempotencyKey 同批次 → 幂等回放；同键不同批次 → conflict（P07）。 */
	async begin(input: { batch: PublicationBatch; ownerId: string; actorId: string; reviewId: string; idempotencyKey: string }):
		Promise<{ record: StoredPublishOperation; replayed: boolean }> {
		const { batch } = input;
		if (!input.ownerId || !input.actorId || !input.reviewId || !input.idempotencyKey || !batch.id || !/^[a-f0-9]{64}$/.test(batch.manifestHash)) {
			throw new PublishJournalError("invalid_input", "invalid publish operation input");
		}
		const nowIso = new Date(this.now()).toISOString();
		return this.withDatabase((db) => this.transaction(db, () => {
			const existing = db.prepare("SELECT record_json FROM publish_operations WHERE idempotency_key = ?")
				.get(input.idempotencyKey) as StoredOperationRow | undefined;
			if (existing) {
				const record = this.parse(existing);
				if (record.batchId !== batch.id || record.manifestHash !== batch.manifestHash) {
					throw new PublishJournalError("conflict", "publish idempotency key is bound to a different batch");
				}
				return { record, replayed: true };
			}
			const id = randomUUID();
			const record: StoredPublishOperation = {
				id,
				batchId: batch.id,
				bindingId: batch.bindingId,
				ownerId: input.ownerId,
				reviewId: input.reviewId,
				actorId: input.actorId,
				idempotencyKey: input.idempotencyKey,
				manifestHash: batch.manifestHash,
				journalRef: `publish-journal:${id}`,
				state: "queued",
				files: batch.files.map((file) => ({
					...(file.kind === "image" ? { kind: "image" as const } : {}),
					targetPath: file.targetPath,
					operation: file.operation,
					candidateHash: file.candidateHash,
					baselineHash: file.expectedHashOrAbsent,
					beforeImageRef: null,
					status: "pending",
					receipts: [],
				})),
				committedGroups: [],
				createdAt: nowIso,
				updatedAt: nowIso,
			};
			db.prepare("INSERT INTO publish_operations (id, batch_id, binding_id, owner_id, idempotency_key, state, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.run(record.id, record.batchId, record.bindingId, record.ownerId, record.idempotencyKey, record.state, JSON.stringify(record));
			return { record, replayed: false };
		}));
	}

	async get(id: string): Promise<StoredPublishOperation | undefined> {
		return this.withDatabase((db) => this.transaction(db, () => this.read(db, id)));
	}

	async list(): Promise<StoredPublishOperation[]> {
		return this.withDatabase((db) => this.transaction(db, () =>
			(db.prepare("SELECT record_json FROM publish_operations").all() as unknown as StoredOperationRow[])
				.map((row) => this.parse(row))
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
	}

	/** 启动对账扫描面：崩溃/中断只会留下 queued / running / unknown 的操作。 */
	async listInterrupted(): Promise<StoredPublishOperation[]> {
		return (await this.list()).filter((record) => record.state === "queued" || record.state === "running" || record.state === "unknown");
	}

	async setRunning(id: string): Promise<StoredPublishOperation> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const record = this.read(db, id);
			if (!record) throw new PublishJournalError("not_found", "publish operation not found");
			if (record.state !== "queued") throw new PublishJournalError("conflict", "only a queued operation can start running");
			const next: StoredPublishOperation = { ...record, state: "running", updatedAt: new Date(this.now()).toISOString() };
			this.replace(db, next);
			return next;
		}));
	}

	private mutateFile(db: DatabaseSync, id: string, targetPath: string,
		mutate: (file: PublishFileRecord, record: StoredPublishOperation) => void): StoredPublishOperation {
		const record = this.read(db, id);
		if (!record) throw new PublishJournalError("not_found", "publish operation not found");
		const file = record.files.find((entry) => entry.targetPath === targetPath);
		if (!file) throw new PublishJournalError("not_found", "publish file not found");
		mutate(file, record);
		record.updatedAt = new Date(this.now()).toISOString();
		this.replace(db, record);
		return record;
	}

	/** 追加单步回执（可同时推进文件状态）；回执落盘成功后才允许下一步副作用。 */
	async appendReceipt(id: string, targetPath: string, receipt: Omit<PublishReceipt, "at">,
		patch?: Partial<Pick<PublishFileRecord, "status" | "beforeImageRef" | "error">>): Promise<StoredPublishOperation> {
		return this.withDatabase((db) => this.transaction(db, () =>
			this.mutateFile(db, id, targetPath, (file) => {
				file.receipts.push({ ...receipt, at: new Date(this.now()).toISOString() });
				Object.assign(file, patch);
			})));
	}

	async updateFile(id: string, targetPath: string,
		patch: Partial<Pick<PublishFileRecord, "status" | "beforeImageRef" | "error">>): Promise<StoredPublishOperation> {
		return this.withDatabase((db) => this.transaction(db, () =>
			this.mutateFile(db, id, targetPath, (file) => Object.assign(file, patch))));
	}

	/** 依赖组账本回写完成登记（幂等：同组成员一致即跳过）。 */
	async markGroupCommitted(id: string, group: string[]): Promise<StoredPublishOperation> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const record = this.read(db, id);
			if (!record) throw new PublishJournalError("not_found", "publish operation not found");
			if (!record.committedGroups.some((committed) => sameMembers(committed, group))) {
				record.committedGroups.push([...group]);
				record.updatedAt = new Date(this.now()).toISOString();
				this.replace(db, record);
			}
			return record;
		}));
	}

	/** 收敛操作状态；terminal 态（published/partial/conflict）记录 finishedAt。 */
	async settle(id: string, state: PublishOperationState, stopReason?: string): Promise<StoredPublishOperation> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const record = this.read(db, id);
			if (!record) throw new PublishJournalError("not_found", "publish operation not found");
			const nowIso = new Date(this.now()).toISOString();
			const next: StoredPublishOperation = {
				...record, state, updatedAt: nowIso,
				...(stopReason ? { stopReason } : {}),
				...(TERMINAL_STATES.has(state) ? { finishedAt: nowIso } : {}),
			};
			this.replace(db, next);
			return next;
		}));
	}
}
