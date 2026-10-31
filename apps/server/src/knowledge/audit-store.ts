import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * 入库审计账本（append-only）。
 *
 * 它不是第二套业务事实源：候选、审核决定与发布回执仍分别以 CuratorJob、
 * ReviewStore 与 PublishJournal 为准。这里把“谁在什么时候，通过哪个通道，
 * 对哪个库/批次做了什么”收敛成一条可查询的证据链，供对话内确认、审核页
 * 与排障共用。写入失败不得反向改写业务事实；调用方决定是否提示重试。
 */
export type KnowledgeAuditKind =
	| "candidate.submitted"
	| "review.approved"
	| "review.rejected"
	| "review.returned"
	| "publication.settled";

/** chat = 用户在会话内确认；review_page = 独立审核页；host = 后台/宿主动作。 */
export type KnowledgeAuditChannel = "chat" | "review_page" | "host";
export type KnowledgeAuditActorKind = "user" | "agent" | "host";

export interface KnowledgeAuditFile {
	path: string;
	operation: string;
	candidateHash?: string | null;
	baselineHash?: string | null;
}

export interface KnowledgeAuditEvent {
	/** 单调序列，只由账本分配。 */
	seq: number;
	id: string;
	at: string;
	kind: KnowledgeAuditKind;
	ownerId: string;
	actorId: string;
	actorKind: KnowledgeAuditActorKind;
	channel: KnowledgeAuditChannel;
	bindingId?: string;
	sessionId?: string;
	windowId?: string;
	jobId?: string;
	batchId?: string;
	publicationId?: string;
	sourceIds?: string[];
	manifestHash?: string;
	decision?: "approve" | "reject" | "return";
	reviewedFiles?: string[];
	files?: KnowledgeAuditFile[];
	publication?: { state: string; fileCount: number; committedGroups: number };
	summary: string;
	/** 幂等键；同键同负载重放返回既有事件，同键不同负载拒绝。 */
	dedupeKey: string;
	details?: Record<string, unknown>;
}

export interface KnowledgeAuditInput extends Omit<KnowledgeAuditEvent, "seq" | "at" | "id"> {
	id?: string;
	at?: string;
}

export interface KnowledgeAuditQuery {
	ownerId: string;
	bindingId?: string;
	batchId?: string;
	jobId?: string;
	kind?: KnowledgeAuditKind;
	limit: number;
	offset: number;
}

export class KnowledgeAuditError extends Error {
	constructor(readonly code: "invalid_input" | "dedupe_conflict" | "not_found", message: string) {
		super(message);
	}
}

const KINDS: ReadonlySet<string> = new Set(["candidate.submitted", "review.approved", "review.rejected", "review.returned", "publication.settled"]);
const CHANNELS: ReadonlySet<string> = new Set(["chat", "review_page", "host"]);
const ACTOR_KINDS: ReadonlySet<string> = new Set(["user", "agent", "host"]);
const MAX_TEXT = 2_000;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_FILES = 500;
const MAX_REVIEWED_FILES = 500;

const optionalText = (value: unknown, field: string, max = MAX_TEXT): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new KnowledgeAuditError("invalid_input", `${field} 无效`);
	return value;
};

const requiredText = (value: unknown, field: string, max = MAX_TEXT): string => optionalText(value, field, max)!;

function assertInput(input: KnowledgeAuditInput, at: string): void {
	if (!KINDS.has(input.kind)) throw new KnowledgeAuditError("invalid_input", "审计事件类型无效");
	if (!CHANNELS.has(input.channel)) throw new KnowledgeAuditError("invalid_input", "审计通道无效");
	if (!ACTOR_KINDS.has(input.actorKind)) throw new KnowledgeAuditError("invalid_input", "审计操作者类型无效");
	requiredText(input.ownerId, "ownerId", 200);
	requiredText(input.actorId, "actorId", 200);
	requiredText(input.summary, "summary");
	requiredText(input.dedupeKey, "dedupeKey", 500);
	if (!Number.isFinite(Date.parse(at))) throw new KnowledgeAuditError("invalid_input", "审计时间无效");
	for (const key of ["bindingId", "sessionId", "windowId", "jobId", "batchId", "publicationId"] as const)
		optionalText(input[key], key, 200);
	if (input.manifestHash !== undefined && !/^[a-f0-9]{64}$/.test(input.manifestHash)) throw new KnowledgeAuditError("invalid_input", "manifestHash 无效");
	if (input.decision !== undefined && !["approve", "reject", "return"].includes(input.decision)) throw new KnowledgeAuditError("invalid_input", "审计决定无效");
	if (input.sourceIds && (input.sourceIds.length > MAX_FILES || input.sourceIds.some((id) => typeof id !== "string" || !id || id.length > 200)))
		throw new KnowledgeAuditError("invalid_input", "sourceIds 无效");
	if (input.reviewedFiles && (input.reviewedFiles.length > MAX_REVIEWED_FILES || input.reviewedFiles.some((file) => typeof file !== "string" || !file || file.length > 1_024)))
		throw new KnowledgeAuditError("invalid_input", "reviewedFiles 无效");
	if (input.files) {
		if (input.files.length > MAX_FILES) throw new KnowledgeAuditError("invalid_input", "审计文件清单过长");
		for (const file of input.files) {
			if (typeof file?.path !== "string" || !file.path || file.path.length > 1_024 || typeof file.operation !== "string" || !file.operation)
				throw new KnowledgeAuditError("invalid_input", "审计文件条目无效");
			for (const hash of [file.candidateHash, file.baselineHash]) if (hash && !/^[a-f0-9]{64}$/.test(hash)) throw new KnowledgeAuditError("invalid_input", "文件哈希无效");
		}
	}
}

export class KnowledgeAuditStore {
	constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

	private async db<T>(action: (db: DatabaseSync) => T): Promise<T> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(path.join(this.stateDir, "audit.sqlite"));
		try {
			db.exec("PRAGMA busy_timeout=5000");
			db.exec(`CREATE TABLE IF NOT EXISTS knowledge_audit_events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				dedupe_key TEXT NOT NULL UNIQUE,
				owner_id TEXT NOT NULL,
				binding_id TEXT,
				batch_id TEXT,
				job_id TEXT,
				kind TEXT NOT NULL,
				created_at TEXT NOT NULL,
				record_json TEXT NOT NULL
			)`);
			db.exec("CREATE INDEX IF NOT EXISTS knowledge_audit_owner ON knowledge_audit_events(owner_id, seq DESC)");
			db.exec("CREATE INDEX IF NOT EXISTS knowledge_audit_batch ON knowledge_audit_events(batch_id, seq DESC)");
			return action(db);
		} finally {
			db.close();
		}
	}

	/** 幂等追加：同 dedupeKey 同负载返回已落盘事件；同键不同负载拒绝，绝不覆盖历史。 */
	async append(input: KnowledgeAuditInput): Promise<KnowledgeAuditEvent> {
		const at = input.at ?? new Date(this.now()).toISOString();
		assertInput(input, at);
		const event: Omit<KnowledgeAuditEvent, "seq"> = {
			...input,
			id: input.id ?? randomUUID(),
			at,
			...(input.sourceIds ? { sourceIds: [...new Set(input.sourceIds)] } : {}),
			...(input.reviewedFiles ? { reviewedFiles: [...new Set(input.reviewedFiles)] } : {}),
		};
		const record = JSON.stringify(event);
		if (Buffer.byteLength(record) > MAX_RECORD_BYTES) throw new KnowledgeAuditError("invalid_input", "审计事件过大");
		return this.db((db) => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const prior = db.prepare("SELECT seq, record_json FROM knowledge_audit_events WHERE dedupe_key=?").get(event.dedupeKey) as { seq: number; record_json: string } | undefined;
				if (prior) {
					const stored = JSON.parse(prior.record_json) as Omit<KnowledgeAuditEvent, "seq">;
					// 时间与自动 id 不参与幂等比较：同一业务事实的重放可以来自不同请求时点。
					const stable = (value: Omit<KnowledgeAuditEvent, "seq">) => JSON.stringify({ ...value, id: undefined, at: undefined });
					if (stable(stored) !== stable(event)) throw new KnowledgeAuditError("dedupe_conflict", "审计幂等键已用于不同事件");
					db.exec("COMMIT");
					return { ...stored, seq: prior.seq };
				}
				db.prepare("INSERT INTO knowledge_audit_events(id,dedupe_key,owner_id,binding_id,batch_id,job_id,kind,created_at,record_json) VALUES(?,?,?,?,?,?,?,?,?)")
					.run(event.id, event.dedupeKey, event.ownerId, event.bindingId ?? null, event.batchId ?? null, event.jobId ?? null, event.kind, at, record);
				db.exec("COMMIT");
				const row = db.prepare("SELECT seq FROM knowledge_audit_events WHERE id=?").get(event.id) as { seq: number };
				return { ...event, seq: row.seq };
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
	}

	async get(ownerId: string, id: string): Promise<KnowledgeAuditEvent | undefined> {
		if (!ownerId || !id) throw new KnowledgeAuditError("invalid_input", "查询参数无效");
		return this.db((db) => {
			const row = db.prepare("SELECT seq, record_json FROM knowledge_audit_events WHERE id=? AND owner_id=?").get(id, ownerId) as { seq: number; record_json: string } | undefined;
			return row ? { ...JSON.parse(row.record_json) as Omit<KnowledgeAuditEvent, "seq">, seq: row.seq } : undefined;
		});
	}

	/** 新到旧；limit/offset 由路由校验，这里只做有界查询。 */
	async list(query: KnowledgeAuditQuery): Promise<{ events: KnowledgeAuditEvent[]; total: number }> {
		if (!query.ownerId) throw new KnowledgeAuditError("invalid_input", "ownerId 必填");
		if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) throw new KnowledgeAuditError("invalid_input", "limit 无效");
		if (!Number.isSafeInteger(query.offset) || query.offset < 0) throw new KnowledgeAuditError("invalid_input", "offset 无效");
		if (query.kind && !KINDS.has(query.kind)) throw new KnowledgeAuditError("invalid_input", "审计事件类型无效");
		const clauses = ["owner_id=?"];
		const values: string[] = [query.ownerId];
		for (const [column, value] of [["binding_id", query.bindingId], ["batch_id", query.batchId], ["job_id", query.jobId]] as const) {
			if (value === undefined) continue;
			clauses.push(`${column}=?`);
			values.push(value);
		}
		if (query.kind) { clauses.push("kind=?"); values.push(query.kind); }
		const where = clauses.join(" AND ");
		return this.db((db) => {
			const total = (db.prepare(`SELECT COUNT(*) AS count FROM knowledge_audit_events WHERE ${where}`).get(...values) as { count: number }).count;
			const rows = db.prepare(`SELECT seq, record_json FROM knowledge_audit_events WHERE ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`)
				.all(...values, query.limit, query.offset) as unknown as Array<{ seq: number; record_json: string }>;
			return { total, events: rows.map((row) => ({ ...JSON.parse(row.record_json) as Omit<KnowledgeAuditEvent, "seq">, seq: row.seq })) };
		});
	}
}
