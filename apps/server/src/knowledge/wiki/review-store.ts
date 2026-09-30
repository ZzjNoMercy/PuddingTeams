import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
	assertPublicationBatchShape,
	assertReviewMatchesBatch,
	publicationManifestHash,
	type PublicationBatch,
	type PublicationBatchStatus,
	type ReviewDecision,
} from "../contracts.js";

/** 审核窗口：从进入 pending_review 起算，超期批次转入 conflict，必须重新编译/复审。 */
export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 审核策略版本：政策存储未落地前固定为 1，随批次与决定一同入证。 */
export const REVIEW_POLICY_REVISION = 1;

export class ReviewStoreError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "conflict" | "expired", message: string) {
		super(message);
	}
}

/** 转正后的批次账本记录：批次快照为权威（compile cache 目录视为可重建），
 *  宿主状态机与批次自带的 status 字段保持同步（status 不参与 manifestHash）。 */
export interface StoredReviewBatch {
	conflictClosure?: { operationId: string; actorId: string; closedAt: string };
	returnRequest?: { operationId: string; feedback: string; actorId: string; reviewedFiles: string[]; createdAt: string; jobId?: string; newBatchId?: string };
	ownerId: string;
	batch: PublicationBatch;
	status: PublicationBatchStatus;
	/** 批次内容代际：manifest 任何变化 → +1，旧代际上的全部确认自然失效（P03）。 */
	revision: number;
	enteredReviewAt: string;
	decidedAt?: string;
	decisionId?: string;
	publishRequestedAt?: string;
	/** conflict 的由来：审核窗超期或发布链各阶段失败；W3 发布对账只报告不改写。 */
	conflictReason?: "review_window_expired" | "publish_rejected" | "publish_preflight" | "publish_interrupted" | "publish_external" | "publish_uncertain";
	createdAt: string;
	updatedAt: string;
}

export interface ReturnRevisionInput {
	batchId: string; operationId: string; actorId: string; feedback: string;
	manifestHash: string; expectedBatchRevision: number; reviewedFiles: string[];
}

export interface ReviewDecisionInput {
	batchId: string;
	/** 幂等键：同键同负载重放返回既有决定；同键不同负载或批次已有其他决定 → 拒绝。 */
	operationId: string;
	actorId: string;
	decision: "approve" | "reject";
	manifestHash: string;
	expectedBatchRevision: number;
	reviewedFiles: string[];
}

interface StoredBatchRow { record_json: string }
interface StoredDecisionRow { record_json: string }

function sameMembers(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && new Set(actual).size === actual.length &&
		actual.every((item) => expected.includes(item));
}

/**
 * 人工审核账本（T33）：批次从 compile candidate 转正为 pending_review，
 * approve/reject 决定绑定 (batchId, revision, manifestHash) 三元组。
 * 与 compile-jobs 同款：内置 SQLite、BEGIN IMMEDIATE 事务为权威边界。
 */
export class ReviewStore {
	private readonly file: string;

	constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {
		this.file = path.join(stateDir, "reviews.sqlite");
	}

	private async withDatabase<T>(action: (db: DatabaseSync) => T): Promise<T> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.file);
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec(`CREATE TABLE IF NOT EXISTS review_batches (
				batch_id TEXT PRIMARY KEY,
				owner_id TEXT NOT NULL,
				binding_id TEXT NOT NULL,
				status TEXT NOT NULL,
				revision INTEGER NOT NULL,
				manifest_hash TEXT NOT NULL,
				record_json TEXT NOT NULL
			)`);
			db.exec(`CREATE TABLE IF NOT EXISTS review_decisions (
				id TEXT PRIMARY KEY,
				batch_id TEXT NOT NULL,
				operation_id TEXT NOT NULL UNIQUE,
				record_json TEXT NOT NULL
			)`);
			db.exec("CREATE TABLE IF NOT EXISTS review_returns (operation_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL)");
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

	private parseBatch(row: StoredBatchRow): StoredReviewBatch {
		const record = JSON.parse(row.record_json) as StoredReviewBatch;
		assertPublicationBatchShape(record.batch);
		if (record.batch.manifestHash !== publicationManifestHash(record.batch) ||
			!Number.isSafeInteger(record.revision) || record.revision < 1 || !record.enteredReviewAt) {
			throw new Error("invalid review batch record");
		}
		return record;
	}

	private parseDecision(row: StoredDecisionRow): ReviewDecision {
		return JSON.parse(row.record_json) as ReviewDecision;
	}

	private readBatch(db: DatabaseSync, batchId: string): StoredReviewBatch | undefined {
		const row = db.prepare("SELECT record_json FROM review_batches WHERE batch_id = ?").get(batchId) as StoredBatchRow | undefined;
		return row ? this.parseBatch(row) : undefined;
	}

	private replaceBatch(db: DatabaseSync, record: StoredReviewBatch): void {
		const changed = db.prepare("UPDATE review_batches SET status = ?, revision = ?, manifest_hash = ?, record_json = ? WHERE batch_id = ?")
			.run(record.status, record.revision, record.batch.manifestHash, JSON.stringify(record), record.batch.id).changes;
		if (changed !== 1) throw new Error("review batch disappeared during transition");
	}

	/** 超期判定在事务内完成并立即落盘：pending_review 超窗 → conflict。 */
	private expireIfOverdue(db: DatabaseSync, record: StoredReviewBatch): StoredReviewBatch {
		if (record.status !== "pending_review") return record;
		if (this.now() - Date.parse(record.enteredReviewAt) <= REVIEW_WINDOW_MS) return record;
		const next: StoredReviewBatch = {
			...record,
			batch: { ...record.batch, status: "conflict" },
			status: "conflict",
			conflictReason: "review_window_expired",
			updatedAt: new Date(this.now()).toISOString(),
		};
		this.replaceBatch(db, next);
		return next;
	}

	/**
	 * 候选批次转正：首次注册进入 pending_review（revision 1）；同 id 同
	 * manifestHash 幂等返回；同 id 不同 manifestHash → revision+1、状态与
	 * 审核窗口重置，旧代际上的全部确认因三元组不匹配而自然失效。
	 */
	async registerCandidate(batch: PublicationBatch, ownerId: string): Promise<{ record: StoredReviewBatch; replayed: boolean }> {
		assertPublicationBatchShape(batch);
		if (batch.manifestHash !== publicationManifestHash(batch)) throw new Error("review batch manifest hash mismatch");
		if (!ownerId) throw new Error("review batch owner is required");
		const nowIso = new Date(this.now()).toISOString();
		return this.withDatabase((db) => this.transaction(db, () => {
			const existing = this.readBatch(db, batch.id);
			if (existing && (existing.ownerId !== ownerId || existing.batch.bindingId !== batch.bindingId)) {
				throw new ReviewStoreError("conflict", "batch identity cannot change owner or binding");
			}
			if (existing && existing.batch.manifestHash === batch.manifestHash) {
				return { record: existing, replayed: true };
			}
			if (existing) {
				if (existing.conflictClosure || (existing.status !== "pending_review" && existing.status !== "rejected" &&
					!(existing.status === "conflict" && existing.conflictReason === "review_window_expired"))) {
					throw new ReviewStoreError("conflict", "approved publication content is immutable; use a new batch");
				}
				const next: StoredReviewBatch = {
					...existing,
					batch: { ...batch, status: "pending_review" },
					status: "pending_review",
					revision: existing.revision + 1,
					enteredReviewAt: nowIso,
					decidedAt: undefined,
					decisionId: undefined,
					publishRequestedAt: undefined,
					conflictReason: undefined,
					updatedAt: nowIso,
				};
				this.replaceBatch(db, next);
				return { record: next, replayed: false };
			}
			const record: StoredReviewBatch = {
				ownerId,
				batch: { ...batch, status: "pending_review" },
				status: "pending_review",
				revision: 1,
				enteredReviewAt: nowIso,
				createdAt: nowIso,
				updatedAt: nowIso,
			};
			db.prepare("INSERT INTO review_batches (batch_id, owner_id, binding_id, status, revision, manifest_hash, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.run(record.batch.id, ownerId, record.batch.bindingId, record.status, record.revision, record.batch.manifestHash, JSON.stringify(record));
			return { record, replayed: false };
		}));
	}

	async get(batchId: string): Promise<StoredReviewBatch | undefined> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const record = this.readBatch(db, batchId);
			return record ? this.expireIfOverdue(db, record) : undefined;
		}));
	}

	async list(): Promise<StoredReviewBatch[]> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const rows = db.prepare("SELECT record_json FROM review_batches").all() as unknown as StoredBatchRow[];
			return rows.map((row) => this.expireIfOverdue(db, this.parseBatch(row)));
		}));
	}

	/** Return is an independent durable CAS decision, never a publication approval. */
	async returnForRevision(input: ReturnRevisionInput, allowResolvedConflict = false): Promise<{ record: StoredReviewBatch; replayed: boolean }> {
		if (!input.operationId?.trim() || input.operationId.length > 200 || !input.actorId || !input.feedback?.trim() || input.feedback.length > 20_000 ||
			!Number.isSafeInteger(input.expectedBatchRevision) || input.expectedBatchRevision < 1 || !/^[a-f0-9]{64}$/.test(input.manifestHash) ||
			!Array.isArray(input.reviewedFiles) || input.reviewedFiles.some((path) => typeof path !== "string") || new Set(input.reviewedFiles).size !== input.reviewedFiles.length)
			throw new ReviewStoreError("invalid_input", "退回修改参数无效");
		return this.withDatabase((db) => this.transaction(db, () => {
			const replay = db.prepare("SELECT input_json FROM review_returns WHERE operation_id=?").get(input.operationId) as { input_json: string } | undefined;
			const record = this.readBatch(db, input.batchId);
			if (!record) throw new ReviewStoreError("not_found", "审核批次不存在");
			if (replay) {
				if (replay.input_json !== JSON.stringify(input) || record.returnRequest?.operationId !== input.operationId) throw new ReviewStoreError("conflict", "operationId 已用于不同退回请求");
				return { record, replayed: true };
			}
			if (db.prepare("SELECT id FROM review_decisions WHERE operation_id=?").get(input.operationId)) throw new ReviewStoreError("conflict", "operationId 已用于审核决定");
			if (record.conflictClosure || !(record.status === "pending_review" || (allowResolvedConflict && record.status === "conflict")) ||
				(record.status === "pending_review" && this.now() - Date.parse(record.enteredReviewAt) > REVIEW_WINDOW_MS) ||
				record.revision !== input.expectedBatchRevision || record.batch.manifestHash !== input.manifestHash || record.ownerId !== input.actorId ||
				input.reviewedFiles.some((target) => !record.batch.files.some((file) => file.targetPath === target)))
				throw new ReviewStoreError("conflict", "批次已变化，不能退回修改");
			const now = new Date(this.now()).toISOString();
			const next: StoredReviewBatch = { ...record, status: "returned", batch: { ...record.batch, status: "returned" }, updatedAt: now,
				returnRequest: { operationId: input.operationId, feedback: input.feedback, actorId: input.actorId, reviewedFiles: input.reviewedFiles, createdAt: now } };
			db.prepare("INSERT INTO review_returns VALUES (?,?,?)").run(input.operationId, input.batchId, JSON.stringify(input)); this.replaceBatch(db, next);
			return { record: next, replayed: false };
		}));
	}

	/** Closing a conflict records disposition, preserving the original review and publish evidence. */
	async closeConflict(input: { batchId: string; operationId: string; actorId: string; manifestHash: string; expectedBatchRevision: number }): Promise<StoredReviewBatch> {
		if (!input.operationId?.trim() || input.operationId.length > 200 || !input.actorId) throw new ReviewStoreError("invalid_input", "关闭冲突参数无效");
		return this.withDatabase(db => this.transaction(db, () => {
			const record = this.readBatch(db, input.batchId);
			if (!record || record.ownerId !== input.actorId) throw new ReviewStoreError("not_found", "审核批次不存在");
			if (record.status !== "conflict" || record.revision !== input.expectedBatchRevision || record.batch.manifestHash !== input.manifestHash) throw new ReviewStoreError("conflict", "批次已变化，请刷新后再处理");
			if (record.conflictClosure) {
				if (record.conflictClosure.operationId !== input.operationId) throw new ReviewStoreError("conflict", "此冲突已经关闭");
				return record;
			}
			const now = new Date(this.now()).toISOString();
			const next = { ...record, conflictClosure: { operationId: input.operationId, actorId: input.actorId, closedAt: now }, updatedAt: now };
			this.replaceBatch(db, next);
			return next;
		}));
	}

	async attachRevisionJob(batchId: string, operationId: string, jobId: string, newBatchId?: string): Promise<void> {
		await this.withDatabase((db) => this.transaction(db, () => {
			const record = this.readBatch(db, batchId);
			if (!record?.returnRequest || record.returnRequest.operationId !== operationId || record.status !== "returned" ||
				(record.returnRequest.jobId && record.returnRequest.jobId !== jobId)) throw new ReviewStoreError("conflict", "退回任务关联已变化");
			this.replaceBatch(db, { ...record, returnRequest: { ...record.returnRequest, jobId, ...(newBatchId ? { newBatchId } : {}) }, updatedAt: new Date(this.now()).toISOString() });
		}));
	}

	/**
	 * 提交审核决定。全部校验在事务内完成：幂等键回放（负载一致性以
	 * manifestHash 为准）→ 批次存在 → 未超期 → pending_review →
	 * (expectedBatchRevision ↔ 账本代际, manifestHash ↔ 内容) 双重匹配 →
	 * approve reviewedFiles 恰好覆盖全部 targets；reject 只记录真实已阅的唯一目标子集（approve 走 contracts 的
	 * assertReviewMatchesBatch）。落账的 ReviewDecision.revision 取批次号
	 * （contracts 语义），账本代际只做并发栅栏、不写入决定。
	 */
	async decide(input: ReviewDecisionInput): Promise<{ record: StoredReviewBatch; decision: ReviewDecision; replayed: boolean }> {
		if (!input.operationId || !input.actorId || (input.decision !== "approve" && input.decision !== "reject") ||
			!/^[a-f0-9]{64}$/.test(input.manifestHash) ||
			!Number.isSafeInteger(input.expectedBatchRevision) || input.expectedBatchRevision < 1 ||
			!Array.isArray(input.reviewedFiles) || input.reviewedFiles.some((file) => typeof file !== "string")) {
			throw new ReviewStoreError("invalid_input", "invalid review decision input");
		}
		const nowIso = new Date(this.now()).toISOString();
		const outcome = await this.withDatabase((db) => this.transaction(db, () => {
			const replay = db.prepare("SELECT record_json FROM review_decisions WHERE operation_id = ?")
				.get(input.operationId) as StoredDecisionRow | undefined;
			if (replay) {
				const decision = this.parseDecision(replay);
				// 负载一致性以 manifestHash 为准（内容代际不同必然哈希不同）；
				// decision.revision 是批次号，不能与客户端的账本代际 expectedBatchRevision 混比。
				if (decision.batchId !== input.batchId || decision.actorId !== input.actorId || decision.decision !== input.decision ||
					decision.manifestHash !== input.manifestHash ||
					!sameMembers(decision.reviewedFiles, input.reviewedFiles)) {
					throw new ReviewStoreError("conflict", "review operation id is bound to a different decision");
				}
				const record = this.readBatch(db, input.batchId);
				if (!record) throw new ReviewStoreError("not_found", "review batch not found");
				if (record.decisionId === decision.id && record.revision !== input.expectedBatchRevision) {
					throw new ReviewStoreError("conflict", "review operation revision does not match its decision");
				}
				return { record: this.expireIfOverdue(db, record), decision, replayed: true };
			}
			if (db.prepare("SELECT operation_id FROM review_returns WHERE operation_id=?").get(input.operationId)) throw new ReviewStoreError("conflict", "operationId 已用于退回修改");
			const existing = this.readBatch(db, input.batchId);
			if (!existing) throw new ReviewStoreError("not_found", "review batch not found");
			if (existing.status === "pending_review" && this.now() - Date.parse(existing.enteredReviewAt) > REVIEW_WINDOW_MS) {
				this.expireIfOverdue(db, existing);
				return { expired: true as const };
			}
			const record = this.expireIfOverdue(db, existing);
			if (record.status !== "pending_review") {
				// 批次可能在本事务之前就被 get/list 懒过期落盘为 conflict；
				// 用 conflictReason 还原语义，路由才能稳定给出 expired 提示。
				if (record.status === "conflict" && record.conflictReason === "review_window_expired") {
					throw new ReviewStoreError("expired", "review window has expired; recompile and review again");
				}
				throw new ReviewStoreError("conflict", "review batch is not pending review");
			}
			if (input.manifestHash !== record.batch.manifestHash || input.expectedBatchRevision !== record.revision) {
				throw new ReviewStoreError("conflict", "review does not match the current batch revision");
			}
			const targets = record.batch.files.map((file) => file.targetPath);
			// ReviewDecision.revision 绑定的是批次的批次号（contracts 语义：
			// assertReviewMatchesBatch 要求 review.revision === batch.revision）；
			// 账本代际 record.revision 的乐观并发栅栏由上面的 expectedBatchRevision 校验承担。
			const decision: ReviewDecision = {
				id: randomUUID(),
				batchId: record.batch.id,
				revision: record.batch.revision,
				manifestHash: record.batch.manifestHash,
				actorId: input.actorId,
				decidedAt: nowIso,
				decision: input.decision,
				reviewedFiles: [...input.reviewedFiles],
				expectedTargets: targets,
				policyRevision: REVIEW_POLICY_REVISION,
			};
			try {
				if (input.decision === "approve") {
					assertReviewMatchesBatch(record.batch, decision);
				} else if (new Set(input.reviewedFiles).size !== input.reviewedFiles.length || input.reviewedFiles.some((file) => !targets.includes(file))) {
					throw new Error("review does not cover every distinct target");
				}
			} catch {
				throw new ReviewStoreError("conflict", "review does not cover the frozen batch exactly");
			}
			db.prepare("INSERT INTO review_decisions (id, batch_id, operation_id, record_json) VALUES (?, ?, ?, ?)")
				.run(decision.id, decision.batchId, input.operationId, JSON.stringify(decision));
			const status: PublicationBatchStatus = input.decision === "approve" ? "approved" : "rejected";
			const next: StoredReviewBatch = {
				...record,
				batch: { ...record.batch, status },
				status,
				decidedAt: nowIso,
				decisionId: decision.id,
				updatedAt: nowIso,
			};
			this.replaceBatch(db, next);
			return { record: next, decision, replayed: false };
		}));
		if ("expired" in outcome) throw new ReviewStoreError("expired", "review window has expired; recompile and review again");
		return outcome;
	}

	/** 发布挂载点（W3）：approve 后由路由在决定落账后调用；仅登记受理时刻，不改状态机。 */
	async markPublishRequested(batchId: string): Promise<StoredReviewBatch> {
		const nowIso = new Date(this.now()).toISOString();
		return this.withDatabase((db) => this.transaction(db, () => {
			const record = this.readBatch(db, batchId);
			if (!record) throw new ReviewStoreError("not_found", "review batch not found");
			if (record.status !== "approved") throw new ReviewStoreError("conflict", "only an approved batch can enter the publish queue");
			if (record.publishRequestedAt) return record;
			const next: StoredReviewBatch = { ...record, publishRequestedAt: nowIso, updatedAt: nowIso };
			this.replaceBatch(db, next);
			return next;
		}));
	}

	/** 发布开始：approved → publishing。仅 publisher 调用；其他状态一律 conflict。 */
	async markPublishing(batchId: string): Promise<StoredReviewBatch> {
		const nowIso = new Date(this.now()).toISOString();
		return this.withDatabase((db) => this.transaction(db, () => {
			const record = this.readBatch(db, batchId);
			if (!record) throw new ReviewStoreError("not_found", "review batch not found");
			if (record.status !== "approved") throw new ReviewStoreError("conflict", "only an approved batch can start publishing");
			const next: StoredReviewBatch = {
				...record,
				batch: { ...record.batch, status: "publishing" },
				status: "publishing",
				updatedAt: nowIso,
			};
			this.replaceBatch(db, next);
			return next;
		}));
	}

	/** 发布收敛：publishing → published / partial / conflict；启动对账可修复 publish_uncertain 的冲突态。 */
	async settlePublish(batchId: string, outcome: "published" | "partial" | "conflict",
		conflictReason?: StoredReviewBatch["conflictReason"], reconcileUncertain = false): Promise<StoredReviewBatch> {
		if (outcome === "conflict" && !conflictReason) throw new ReviewStoreError("invalid_input", "conflict outcome requires a reason");
		const nowIso = new Date(this.now()).toISOString();
		return this.withDatabase((db) => this.transaction(db, () => {
			const record = this.readBatch(db, batchId);
			if (!record) throw new ReviewStoreError("not_found", "review batch not found");
			if (record.status !== "publishing" && !(reconcileUncertain && record.status === "conflict" && record.conflictReason === "publish_uncertain")) throw new ReviewStoreError("conflict", "only a publishing or reconciled uncertain batch can settle");
			const next: StoredReviewBatch = {
				...record,
				batch: { ...record.batch, status: outcome },
				status: outcome,
				conflictReason: outcome === "conflict" ? conflictReason : undefined,
				updatedAt: nowIso,
			};
			this.replaceBatch(db, next);
			return next;
		}));
	}

	async decisionsFor(batchId: string): Promise<ReviewDecision[]> {
		return this.withDatabase((db) =>
			(db.prepare("SELECT record_json FROM review_decisions WHERE batch_id = ?").all(batchId) as unknown as StoredDecisionRow[])
				.map((row) => this.parseDecision(row)));
	}
}
