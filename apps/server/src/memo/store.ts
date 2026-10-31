import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	MEMO_PAGE_LIMIT,
	MEMO_PROMOTE_LIMIT,
	MemoError,
	digestMemo,
	parseMemoTags,
	promoteRequestHash,
	requireMemoText,
	requireOperationId,
	requireRevision,
	type Memo,
	type MemoLifecycle,
	type MemoPromotion,
	type MemoPromotionItem,
	type MemoPromotionPhase,
} from "./contracts.js";

type Row = { record_json: string };
const now = () => new Date().toISOString();
const LIFECYCLES: MemoLifecycle[] = ["unorganized", "promoting", "organized"];

export interface MemoListInput {
	filter?: string;
	tag?: string;
	q?: string;
	before?: string;
	limit?: number;
}

export interface MemoCounts {
	unorganized: number;
	promoting: number;
	organized: number;
	all: number;
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function encodeCursor(memo: { createdAt: string; id: string }): string {
	return Buffer.from(JSON.stringify([memo.createdAt, memo.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
			throw new Error("bad cursor");
		}
		return { createdAt: parsed[0], id: parsed[1] };
	} catch {
		throw new MemoError("invalid_input", "分页游标无效");
	}
}

/** 速记自有 sqlite：所有写操作走 BEGIN IMMEDIATE，owner 隔离在 SQL 条件里。 */
export class MemoStore {
	constructor(readonly directory: string) {}

	private db<T>(fn: (db: DatabaseSync) => T): T {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(path.join(this.directory, "memo.sqlite"));
		try {
			db.exec(`PRAGMA busy_timeout=5000;
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS memos(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, deleted INTEGER NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memos_timeline ON memos(owner_id, deleted, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS operations(owner_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT, PRIMARY KEY(owner_id, id));
CREATE TABLE IF NOT EXISTS memo_promotions(owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, binding_id TEXT NOT NULL,
  task TEXT NOT NULL, phase TEXT NOT NULL, job_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, operation_id));
CREATE TABLE IF NOT EXISTS memo_promotion_items(owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, position INTEGER NOT NULL, memo_id TEXT NOT NULL,
  memo_revision INTEGER NOT NULL, text_snapshot TEXT NOT NULL, tags_json TEXT NOT NULL, source_id TEXT,
  PRIMARY KEY(owner_id, operation_id, position), UNIQUE(owner_id, operation_id, memo_id));
CREATE INDEX IF NOT EXISTS memo_promotions_phase ON memo_promotions(owner_id, phase);
CREATE INDEX IF NOT EXISTS memo_promotion_items_memo ON memo_promotion_items(owner_id, memo_id, operation_id);`);
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} finally {
			db.close();
		}
	}

	private read(db: DatabaseSync, owner: string, id: string, includeDeleted = false): Memo {
		const row = db.prepare(
			`SELECT record_json FROM memos WHERE id=? AND owner_id=?${includeDeleted ? "" : " AND deleted=0"}`,
		).get(id, owner) as Row | undefined;
		if (!row) throw new MemoError("not_found", "速记不存在");
		return JSON.parse(row.record_json) as Memo;
	}

	private save(db: DatabaseSync, memo: Memo): void {
		db.prepare("UPDATE memos SET deleted=?,record_json=? WHERE id=? AND owner_id=?")
			.run(memo.deletedAt ? 1 : 0, JSON.stringify(memo), memo.id, memo.ownerId);
	}

	private readPromotion(db: DatabaseSync, owner: string, operationId: string): MemoPromotion | undefined {
		const row = db.prepare(
			"SELECT operation_id,request_hash,binding_id,task,phase,job_id,last_error,created_at,updated_at FROM memo_promotions WHERE owner_id=? AND operation_id=?",
		).get(owner, operationId) as {
			operation_id: string; request_hash: string; binding_id: string; task: string; phase: string;
			job_id: string | null; last_error: string | null; created_at: string; updated_at: string;
		} | undefined;
		if (!row) return undefined;
		const items = db.prepare(
			"SELECT memo_id,memo_revision,text_snapshot,tags_json,source_id FROM memo_promotion_items WHERE owner_id=? AND operation_id=? ORDER BY position ASC",
		).all(owner, operationId) as Array<{
			memo_id: string; memo_revision: number; text_snapshot: string; tags_json: string; source_id: string | null;
		}>;
		return {
			operationId: row.operation_id, requestHash: row.request_hash, ownerId: owner,
			bindingId: row.binding_id, task: row.task, phase: row.phase as MemoPromotionPhase,
			...(row.job_id ? { jobId: row.job_id } : {}), ...(row.last_error ? { lastError: row.last_error } : {}),
			createdAt: row.created_at, updatedAt: row.updated_at,
			items: items.map((item) => ({
				memoId: item.memo_id, memoRevision: item.memo_revision, textSnapshot: item.text_snapshot,
				tags: JSON.parse(item.tags_json) as string[], ...(item.source_id ? { sourceId: item.source_id } : {}),
			})),
		};
	}

	get(owner: string, id: string, includeDeleted = false): Memo {
		return this.db((db) => this.read(db, owner, id, includeDeleted));
	}

	create(owner: string, input: { operationId: unknown; text: unknown }): { memo: Memo; replayed: boolean } {
		const operationId = requireOperationId(input.operationId);
		const text = requireMemoText(input.text);
		const tags = parseMemoTags(text);
		const requestHash = digestMemo({ kind: "memo.create", text });
		return this.db((db) => {
			const previous = db.prepare("SELECT kind,request_hash,result_json FROM operations WHERE owner_id=? AND id=?")
				.get(owner, operationId) as { kind: string; request_hash: string; result_json: string | null } | undefined;
			if (previous) {
				if (previous.kind !== "create" || previous.request_hash !== requestHash || !previous.result_json) {
					throw new MemoError("conflict", "operationId 已用于其他请求");
				}
				const { memoId } = JSON.parse(previous.result_json) as { memoId: string };
				// 创建重放必须返回同一条记录，即使它随后被软删除；不能让重试变成 404。
				return { memo: this.read(db, owner, memoId, true), replayed: true };
			}
			const time = now();
			const memo: Memo = {
				id: randomUUID(), ownerId: owner, text, tags, lifecycle: "unorganized",
				createdAt: time, updatedAt: time, revision: 1,
			};
			db.prepare("INSERT INTO memos VALUES(?,?,?,?,?)").run(memo.id, owner, 0, time, JSON.stringify(memo));
			db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
				.run(owner, operationId, "create", requestHash, JSON.stringify({ memoId: memo.id }));
			return { memo, replayed: false };
		});
	}

	update(owner: string, id: string, input: { text: unknown; expectedRevision: unknown }): Memo {
		const text = requireMemoText(input.text);
		const expectedRevision = requireRevision(input.expectedRevision);
		return this.db((db) => {
			const memo = this.read(db, owner, id);
			if (memo.lifecycle !== "unorganized") throw new MemoError("conflict", "整理中的速记不能修改");
			if (memo.revision !== expectedRevision) throw new MemoError("conflict", "速记已变化，请刷新后重试");
			memo.text = text;
			memo.tags = parseMemoTags(text);
			memo.revision += 1;
			memo.updatedAt = now();
			memo.lastError = undefined;
			this.save(db, memo);
			return memo;
		});
	}

	remove(owner: string, id: string, input: { operationId: unknown; expectedRevision: unknown }): { memo: Memo; replayed: boolean } {
		const operationId = requireOperationId(input.operationId);
		const expectedRevision = requireRevision(input.expectedRevision);
		const requestHash = digestMemo({ kind: "memo.delete", id, revision: expectedRevision });
		return this.db((db) => {
			const previous = db.prepare("SELECT kind,request_hash FROM operations WHERE owner_id=? AND id=?")
				.get(owner, operationId) as { kind: string; request_hash: string } | undefined;
			if (previous) {
				if (previous.kind !== "delete" || previous.request_hash !== requestHash) {
					throw new MemoError("conflict", "operationId 已用于其他请求");
				}
				return { memo: this.read(db, owner, id, true), replayed: true };
			}
			const memo = this.read(db, owner, id, true);
			if (memo.deletedAt) throw new MemoError("conflict", "速记已删除");
			if (memo.lifecycle === "promoting") throw new MemoError("conflict", "整理中的速记不能删除");
			if (memo.revision !== expectedRevision) throw new MemoError("conflict", "速记已变化，请刷新后重试");
			memo.deletedAt = now();
			memo.revision += 1;
			memo.updatedAt = memo.deletedAt;
			this.save(db, memo);
			db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
				.run(owner, operationId, "delete", requestHash, JSON.stringify({ memoId: memo.id }));
			return { memo, replayed: false };
		});
	}

	restore(owner: string, id: string, input: { operationId: unknown }): { memo: Memo; replayed: boolean } {
		const operationId = requireOperationId(input.operationId);
		const requestHash = digestMemo({ kind: "memo.restore", id });
		return this.db((db) => {
			const previous = db.prepare("SELECT kind,request_hash FROM operations WHERE owner_id=? AND id=?")
				.get(owner, operationId) as { kind: string; request_hash: string } | undefined;
			if (previous) {
				if (previous.kind !== "restore" || previous.request_hash !== requestHash) {
					throw new MemoError("conflict", "operationId 已用于其他请求");
				}
				// 重放返回当前状态，不把后来又删除的记录再次复活。
				return { memo: this.read(db, owner, id, true), replayed: true };
			}
			const memo = this.read(db, owner, id, true);
			if (!memo.deletedAt) throw new MemoError("conflict", "速记未被删除");
			memo.deletedAt = undefined;
			memo.revision += 1;
			memo.updatedAt = now();
			this.save(db, memo);
			db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
				.run(owner, operationId, "restore", requestHash, JSON.stringify({ memoId: memo.id }));
			return { memo, replayed: false };
		});
	}

	list(owner: string, input: MemoListInput = {}): { items: Memo[]; counts: MemoCounts; tags: Array<{ tag: string; count: number }>; nextBefore: string | null } {
		const filter = input.filter ?? "unorganized";
		if (!["unorganized", "promoting", "organized", "all"].includes(filter)) throw new MemoError("invalid_input", "筛选条件无效");
		const limit = input.limit ?? MEMO_PAGE_LIMIT;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMO_PAGE_LIMIT) throw new MemoError("invalid_input", "分页数量无效");
		const tag = typeof input.tag === "string" ? input.tag.trim().normalize("NFKC") : "";
		const q = typeof input.q === "string" ? input.q.trim().slice(0, 200) : "";
		const cursor = decodeCursor(input.before);
		return this.db((db) => {
			const counts: MemoCounts = { unorganized: 0, promoting: 0, organized: 0, all: 0 };
			for (const row of db.prepare(
				"SELECT json_extract(record_json,'$.lifecycle') AS lifecycle, count(*) AS n FROM memos WHERE owner_id=? AND deleted=0 GROUP BY lifecycle",
			).all(owner) as Array<{ lifecycle: string; n: number }>) {
				if (!(LIFECYCLES as string[]).includes(row.lifecycle)) continue;
				counts[row.lifecycle as MemoLifecycle] = row.n;
				counts.all += row.n;
			}
			const tags = (db.prepare(
				`SELECT je.value AS tag, count(*) AS n FROM memos m, json_each(json_extract(m.record_json,'$.tags')) je
				 WHERE m.owner_id=? AND m.deleted=0 GROUP BY je.value ORDER BY n DESC, tag ASC`,
			).all(owner) as Array<{ tag: string; n: number }>).map((row) => ({ tag: row.tag, count: row.n }));

			const where = ["m.owner_id=?", "m.deleted=0"];
			const params: Array<string | number> = [owner];
			if (filter !== "all") {
				where.push("json_extract(m.record_json,'$.lifecycle')=?");
				params.push(filter);
			}
			if (tag) {
				where.push("EXISTS (SELECT 1 FROM json_each(json_extract(m.record_json,'$.tags')) je WHERE je.value=?)");
				params.push(tag);
			}
			if (q) {
				where.push("lower(json_extract(m.record_json,'$.text')) LIKE ? ESCAPE '\\'");
				params.push(`%${escapeLike(q.toLocaleLowerCase())}%`);
			}
			if (cursor) {
				where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
				params.push(cursor.createdAt, cursor.createdAt, cursor.id);
			}
			params.push(limit);
			const rows = db.prepare(
				`SELECT m.created_at AS created_at, m.record_json FROM memos m WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
			).all(...params) as Array<{ created_at: string; record_json: string }>;
			// 游标与排序都以列值为准，避免记录内时间被外部改写后分页漂移。
			const items = rows.map((row) => ({ ...(JSON.parse(row.record_json) as Memo), createdAt: row.created_at }));
			const last = rows.at(-1);
			const nextBefore = rows.length === limit && last ? encodeCursor({ createdAt: last.created_at, id: items.at(-1)!.id }) : null;
			return { items, counts, tags, nextBefore };
		});
	}

	byLifecycle(owner: string, lifecycle: MemoLifecycle): Memo[] {
		return this.db((db) => (db.prepare(
			"SELECT record_json FROM memos WHERE owner_id=? AND deleted=0 AND json_extract(record_json,'$.lifecycle')=?",
		).all(owner, lifecycle) as Row[]).map((row) => JSON.parse(row.record_json) as Memo));
	}

	promotion(owner: string, operationId: string): MemoPromotion | undefined {
		return this.db((db) => this.readPromotion(db, owner, requireOperationId(operationId)));
	}

	/** 整批锁定必须一次事务完成：任一条件失败则零副作用。 */
	reservePromotion(owner: string, input: { operationId: unknown; memoIds: unknown; bindingId: unknown; task: unknown }): { promotion: MemoPromotion; replayed: boolean } {
		const operationId = requireOperationId(input.operationId);
		const bindingId = input.bindingId;
		const task = input.task;
		if (typeof bindingId !== "string" || !bindingId.trim() || bindingId.length > 200) throw new MemoError("invalid_input", "请选择目标知识库");
		if (typeof task !== "string" || !task.trim() || task.length > 20_000) throw new MemoError("invalid_input", "请填写整理要求");
		if (!Array.isArray(input.memoIds) || input.memoIds.length < 1 || input.memoIds.length > MEMO_PROMOTE_LIMIT) {
			throw new MemoError("invalid_input", `请选择 1–${MEMO_PROMOTE_LIMIT} 条速记`);
		}
		const memoIds = input.memoIds as unknown[];
		if (memoIds.some((id) => typeof id !== "string" || !id) || new Set(memoIds).size !== memoIds.length) {
			throw new MemoError("invalid_input", "速记 ID 无效或重复");
		}
		return this.db((db) => {
			const existing = this.readPromotion(db, owner, operationId);
			if (existing) return { promotion: existing, replayed: true };
			const memos = (memoIds as string[]).map((id) => this.read(db, owner, id));
			for (const memo of memos) {
				if (memo.lifecycle !== "unorganized") throw new MemoError("conflict", "所选速记已进入整理，请刷新后重试");
			}
			const items: MemoPromotionItem[] = memos.map((memo) => ({
				memoId: memo.id, memoRevision: memo.revision, textSnapshot: memo.text, tags: [...memo.tags],
			}));
			const normalizedTask = task.trim();
			const requestHash = promoteRequestHash({ memoIds: memoIds as string[], bindingId, task: normalizedTask,
				items: items.map((item) => ({ memoId: item.memoId, revision: item.memoRevision, text: item.textSnapshot, tags: item.tags })) });
			const registered = db.prepare("SELECT kind,request_hash FROM operations WHERE owner_id=? AND id=?")
				.get(owner, operationId) as { kind: string; request_hash: string } | undefined;
			if (registered && (registered.kind !== "promote" || registered.request_hash !== requestHash)) {
				throw new MemoError("conflict", "operationId 已用于其他请求");
			}
			const time = now();
			db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
				.run(owner, operationId, "promote", requestHash, JSON.stringify({ operationId }));
			db.prepare("INSERT INTO memo_promotions VALUES(?,?,?,?,?,?,?,?,?,?)")
				.run(owner, operationId, requestHash, bindingId, normalizedTask, "freezing", null, null, time, time);
			const insertItem = db.prepare("INSERT INTO memo_promotion_items VALUES(?,?,?,?,?,?,?,?)");
			for (const [position, item] of items.entries()) {
				insertItem.run(owner, operationId, position, item.memoId, item.memoRevision, item.textSnapshot, JSON.stringify(item.tags), null);
			}
			for (const memo of memos) {
				memo.lifecycle = "promoting";
				memo.currentOperationId = operationId;
				memo.lastError = undefined;
				memo.outcome = undefined;
				memo.updatedAt = time;
				this.save(db, memo);
			}
			return { promotion: this.readPromotion(db, owner, operationId)!, replayed: false };
		});
	}

	recordSource(owner: string, operationId: string, memoId: string, sourceId: string): void {
		this.db((db) => {
			const changed = db.prepare(
				"UPDATE memo_promotion_items SET source_id=? WHERE owner_id=? AND operation_id=? AND memo_id=?",
			).run(sourceId, owner, operationId, memoId);
			if (changed.changes !== 1) throw new MemoError("not_found", "整理批次缺少该速记");
		});
	}

	advancePhase(owner: string, operationId: string, from: MemoPromotionPhase[], phase: MemoPromotionPhase, patch: { jobId?: string; lastError?: string } = {}): MemoPromotion {
		return this.db((db) => {
			const promotion = this.readPromotion(db, owner, operationId);
			if (!promotion) throw new MemoError("not_found", "整理批次不存在");
			if (!from.includes(promotion.phase)) return promotion;
			db.prepare("UPDATE memo_promotions SET phase=?,job_id=?,last_error=?,updated_at=? WHERE owner_id=? AND operation_id=?")
				.run(phase, patch.jobId ?? promotion.jobId ?? null,
					patch.lastError !== undefined ? patch.lastError : null, now(), owner, operationId);
			return this.readPromotion(db, owner, operationId)!;
		});
	}

	/** 失败 attempt 的单一事务收尾：写 phase=failed 与释放 memos 同进同退，避免中间态锁死。 */
	failPromotion(owner: string, operationId: string, message: string): void {
		this.db((db) => {
			const promotion = this.readPromotion(db, owner, operationId);
			if (!promotion || promotion.phase === "job_created") return;
			db.prepare("UPDATE memo_promotions SET phase='failed',last_error=?,updated_at=? WHERE owner_id=? AND operation_id=?")
				.run(message.slice(0, 500), now(), owner, operationId);
			for (const item of promotion.items) {
				const memo = this.read(db, owner, item.memoId, true);
				if (memo.lifecycle !== "promoting") continue;
				memo.lifecycle = "unorganized";
				memo.currentOperationId = undefined;
				memo.outcome = undefined;
				memo.lastError = message.slice(0, 500);
				memo.updatedAt = now();
				this.save(db, memo);
			}
		});
	}

	/** 认领「Job 已创建但 checkpoint 未写回」的 attempt，并把速记重新锁定。 */
	adoptJob(owner: string, operationId: string, jobId: string): MemoPromotion {
		return this.db((db) => {
			const promotion = this.readPromotion(db, owner, operationId);
			if (!promotion) throw new MemoError("not_found", "整理批次不存在");
			if (promotion.phase === "job_created" && promotion.jobId === jobId) return promotion;
			// 整批先校验归属：不能抢走更新的 attempt、已整理条目，或已被编辑后释放的速记。
			const memos = promotion.items.map((item) => ({ item, memo: this.read(db, owner, item.memoId, true) }));
			for (const { item, memo } of memos) {
				if (memo.deletedAt) throw new MemoError("conflict", "速记已删除，无法续接原整理");
				if (memo.lifecycle === "promoting") {
					if (memo.currentOperationId !== operationId) throw new MemoError("conflict", "速记已进入新的整理，请刷新");
					continue;
				}
				if (memo.lifecycle === "unorganized" && memo.revision === item.memoRevision) continue;
				throw new MemoError("conflict", "速记已变化，请用新的整理请求重新提交");
			}
			db.prepare("UPDATE memo_promotions SET phase='job_created',job_id=?,last_error=NULL,updated_at=? WHERE owner_id=? AND operation_id=?")
				.run(jobId, now(), owner, operationId);
			for (const { memo } of memos) {
				memo.lifecycle = "promoting";
				memo.currentOperationId = operationId;
				memo.lastError = undefined;
				memo.outcome = undefined;
				memo.updatedAt = now();
				this.save(db, memo);
			}
			return this.readPromotion(db, owner, operationId)!;
		});
	}

	setPromotionError(owner: string, operationId: string, message: string): void {
		this.db((db) => {
			db.prepare("UPDATE memo_promotions SET last_error=?,updated_at=? WHERE owner_id=? AND operation_id=?")
				.run(message.slice(0, 500), now(), owner, operationId);
		});
	}

	/** 回到未整理：清除当前指针，旧 attempt 保留。 */
	releaseMemos(owner: string, memoIds: string[], expectedOperationId: string, lastError?: string): void {
		this.db((db) => {
			for (const id of memoIds) {
				const memo = this.read(db, owner, id, true);
				if (memo.lifecycle !== "promoting" || memo.currentOperationId !== expectedOperationId) continue;
				memo.lifecycle = "unorganized";
				memo.currentOperationId = undefined;
				memo.outcome = undefined;
				if (lastError) memo.lastError = lastError.slice(0, 500);
				memo.updatedAt = now();
				this.save(db, memo);
			}
		});
	}

	/** 已发布/无需变更：保留 currentOperationId 供结果回链。 */
	completeMemos(owner: string, memoIds: string[], expectedOperationId: string, outcome: "published" | "no_changes"): void {
		this.db((db) => {
			for (const id of memoIds) {
				const memo = this.read(db, owner, id, true);
				if (memo.lifecycle !== "promoting" || memo.currentOperationId !== expectedOperationId) continue;
				memo.lifecycle = "organized";
				memo.outcome = outcome;
				memo.lastError = undefined;
				memo.updatedAt = now();
				this.save(db, memo);
			}
		});
	}

	recoverable(): Array<{ ownerId: string; promotion: MemoPromotion }> {
		return this.db((db) => {
			const rows = db.prepare(
				"SELECT owner_id,operation_id FROM memo_promotions WHERE phase IN ('freezing','sources_frozen') OR phase='job_created'",
			).all() as Array<{ owner_id: string; operation_id: string }>;
			return rows.map((row) => ({ ownerId: row.owner_id, promotion: this.readPromotion(db, row.owner_id, row.operation_id)! }));
		});
	}
}
