import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ReadLaterError,
  cleanTags,
  cleanText,
  expectedRevision,
  operationId,
  type ArticleVersion,
  type CaptureJob,
  type Promotion,
  type ReadLaterCreate,
  type ReadLaterItem,
  type ReadLaterUpdate,
  type MarkReadInput,
} from "./contracts.js";
import { canonicalizeUrl } from "./public-fetch.js";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
type Row = {
  record_json: string;
};
export class ReadLaterStore {
  constructor(readonly directory: string) {}
  private db<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(this.directory, "read-later.sqlite"));
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,url TEXT NOT NULL,deleted INTEGER NOT NULL,record_json TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS unique_live_url ON items(owner_id,url) WHERE deleted=0;
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,record_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS operations(owner_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT,item_id TEXT NOT NULL,job_id TEXT,PRIMARY KEY(owner_id,id));
   CREATE TABLE IF NOT EXISTS promotions(owner_id TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(owner_id,id));`);
      // operations.hash 曾 NOT NULL；retry 行不再携带 hash，旧库需重建该表去掉约束。
      const hashColumn = (db.prepare("PRAGMA table_info(operations)").all() as { name: string; notnull: number }[]).find(c => c.name === "hash");
      if (hashColumn?.notnull) db.exec(`BEGIN;
   CREATE TABLE operations_migrated(owner_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT,item_id TEXT NOT NULL,job_id TEXT,PRIMARY KEY(owner_id,id));
   INSERT INTO operations_migrated SELECT owner_id,id,hash,item_id,job_id FROM operations;
   DROP TABLE operations;
   ALTER TABLE operations_migrated RENAME TO operations;
   COMMIT;`);
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
  private item(
    db: DatabaseSync,
    owner: string,
    id: string,
    deleted = false,
  ): ReadLaterItem {
    const row = db
      .prepare(
        `SELECT record_json FROM items WHERE id=? AND owner_id=? ${deleted ? "" : "AND deleted=0"}`,
      )
      .get(id, owner) as Row | undefined;
    if (!row) throw new ReadLaterError("not_found", "收藏不存在");
    return JSON.parse(row.record_json);
  }
  private save(db: DatabaseSync, item: ReadLaterItem) {
    db.prepare("INSERT OR REPLACE INTO items VALUES(?,?,?,?,?)").run(
      item.id,
      item.ownerId,
      item.canonicalUrl,
      item.deletedAt ? 1 : 0,
      JSON.stringify(item),
    );
  }
  private saveJob(db: DatabaseSync, job: CaptureJob) {
    db.prepare("INSERT OR REPLACE INTO jobs VALUES(?,?)").run(
      job.id,
      JSON.stringify(job),
    );
  }
  private jobs(db: DatabaseSync): CaptureJob[] {
    return (db.prepare("SELECT record_json FROM jobs").all() as Row[]).map(
      (row) => JSON.parse(row.record_json),
    );
  }
  get(owner: string, id: string) {
    return this.db((db) => this.item(db, owner, id));
  }
  version(
    owner: string,
    itemId: string,
    id?: string,
  ): ArticleVersion | undefined {
    return this.db((db) => {
      const item = this.item(db, owner, itemId);
      const row = db
        .prepare("SELECT record_json FROM versions WHERE id=? AND item_id=?")
        .get(id ?? item.activeVersionId ?? "", itemId) as Row | undefined;
      return row ? JSON.parse(row.record_json) : undefined;
    });
  }
  job(owner: string, id: string): CaptureJob {
    return this.db((db) => {
      const row = db
        .prepare("SELECT record_json FROM jobs WHERE id=?")
        .get(id) as Row | undefined;
      const job = row ? (JSON.parse(row.record_json) as CaptureJob) : undefined;
      if (!job || job.ownerId !== owner)
        throw new ReadLaterError("not_found", "采集任务不存在");
      return job;
    });
  }
  listJobs(owner: string, options: { filter?: string; page?: number; limit?: number } = {}) {
    const filter = options.filter ?? "all", limit = options.limit ?? 20, requestedPage = options.page ?? 1;
    if (!["all", "active", "problem"].includes(filter) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(requestedPage) || requestedPage < 1)
      throw new ReadLaterError("invalid_input", "任务筛选或分页参数无效");
    return this.db((db) => {
      const ownerSql = "json_extract(record_json,'$.ownerId')=?";
      const activeSql = "json_extract(record_json,'$.status') IN ('queued','running')";
      const problemSql = "(json_extract(record_json,'$.status')='failed' OR (json_extract(record_json,'$.status')='succeeded' AND coalesce(json_extract(record_json,'$.errorMessage'),'')<>''))";
      const counts = db.prepare(`SELECT count(*) AS "all", coalesce(sum(CASE WHEN ${activeSql} THEN 1 ELSE 0 END),0) AS active, coalesce(sum(CASE WHEN ${problemSql} THEN 1 ELSE 0 END),0) AS problem FROM jobs WHERE ${ownerSql}`).get(owner) as { all: number; active: number; problem: number };
      const total = counts[filter as keyof typeof counts], pages = Math.max(1, Math.ceil(total / limit)), page = Math.min(requestedPage, pages);
      const filterSql = filter === "active" ? ` AND ${activeSql}` : filter === "problem" ? ` AND ${problemSql}` : "";
      const rows = db.prepare(`SELECT record_json FROM jobs WHERE ${ownerSql}${filterSql} ORDER BY json_extract(record_json,'$.createdAt') DESC,id DESC LIMIT ? OFFSET ?`).all(owner, limit, (page - 1) * limit) as Row[];
      const itemQuery = db.prepare("SELECT record_json FROM items WHERE id=? AND owner_id=?");
      const jobs = rows.map((row) => {
        const job = JSON.parse(row.record_json) as CaptureJob;
        const itemRow = itemQuery.get(job.itemId, owner) as Row | undefined;
        const item = itemRow ? JSON.parse(itemRow.record_json) as ReadLaterItem : undefined;
        return { ...job, title: item?.title ?? "收藏已删除", source: item?.siteName ?? "", itemAvailable: !!item && !item.deletedAt };
      });
      return { jobs, total, counts, page, pages, limit };
    });
  }
  list(
    owner: string,
    options: {
      q?: string;
      source?: string;
      filter?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    return this.db((db) => {
      const query = cleanText(options.q ?? "", 500, "搜索").toLocaleLowerCase();
      const all = (
        db
          .prepare(
            "SELECT record_json FROM items WHERE owner_id=? AND deleted=0",
          )
          .all(owner) as Row[]
      )
        .map((row) => JSON.parse(row.record_json) as ReadLaterItem)
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
      const sources = [...new Set(all.map((i) => i.siteName))].sort();
      const scoped = all
        .filter((i) => !options.source || i.siteName === options.source)
        .filter((i) => {
          if (!query) return true;
          const row = db
            .prepare("SELECT record_json FROM versions WHERE id=?")
            .get(i.activeVersionId ?? "") as Row | undefined;
          const text = row
            ? (JSON.parse(row.record_json) as ArticleVersion).content
            : "";
          return [
            i.title,
            i.siteName,
            i.author,
            i.description,
            i.note,
            i.originalUrl,
            ...i.tags,
            text,
          ]
            .join("\n")
            .toLocaleLowerCase()
            .includes(query);
        });
      const matches = (i: ReadLaterItem, filter: string) =>
        filter === "all"
          ? i.readingStatus !== "archived"
          : filter === "link_only"
            ? i.parseStatus === "link_only" && i.readingStatus !== "archived"
            : filter === "pending"
              ? ["queued", "processing", "failed"].includes(i.parseStatus) &&
                i.readingStatus !== "archived"
              : i.readingStatus === filter;
      const counts = Object.fromEntries(
        ["all", "unread", "read", "link_only", "pending", "archived"].map(
          (f) => [f, scoped.filter((i) => matches(i, f)).length],
        ),
      );
      const filter = options.filter ?? "all";
      if (!Object.hasOwn(counts, filter))
        throw new ReadLaterError("invalid_input", "筛选状态无效");
      const filtered = scoped.filter((i) => matches(i, filter));
      let start = 0;
      if (options.cursor) {
        const index = filtered.findIndex(
          (i) => `${i.createdAt}|${i.id}` === options.cursor,
        );
        if (index < 0)
          throw new ReadLaterError("conflict", "列表已变化，请重新加载");
        start = index + 1;
      }
      if (
        options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1)
      )
        throw new ReadLaterError("invalid_input", "分页数量无效");
      const limit = Math.max(1, Math.min(100, options.limit ?? 50)),
        items = filtered.slice(start, start + limit),
        last = items.at(-1);
      return {
        items: items.map((item) => {
          const row = db
            .prepare("SELECT record_json FROM versions WHERE id=? AND item_id=?")
            .get(item.activeVersionId ?? "", item.id) as Row | undefined;
          const version = row ? JSON.parse(row.record_json) as ArticleVersion : undefined;
          const asset = version?.assets.find((asset) => asset.id === version.coverAssetId)
            ?? version?.assets.find((asset) => asset.role === "cover")
            ?? version?.assets[0];
          return {
            ...item,
            thumbnail: version && asset
              ? { versionId: version.id, assetId: asset.id, alt: asset.alt }
              : undefined,
          };
        }),
        total: filtered.length,
        counts,
        sources,
        nextCursor:
          start + items.length < filtered.length && last
            ? `${last.createdAt}|${last.id}`
            : null,
      };
    });
  }
  create(owner: string, input: ReadLaterCreate) {
    const op = operationId(input.operationId),
      url = canonicalizeUrl(cleanText(input.url, 1800, "链接")),
      title =
        input.title === undefined
          ? undefined
          : cleanText(input.title, 300, "标题"),
      note = cleanText(input.note ?? "", 10000, "笔记"),
      tags = cleanTags(input.tags ?? []),
      hash = digest({ url, title, note, tags });
    return this.db((db) => {
      const previous = db
        .prepare(
          "SELECT hash,item_id,job_id FROM operations WHERE owner_id=? AND id=?",
        )
        .get(owner, `save:${op}`) as
        | {
            hash: string;
            item_id: string;
            job_id: string;
          }
        | undefined;
      if (previous) {
        if (previous.hash !== hash)
          throw new ReadLaterError(
            "conflict",
            "operationId 已用于不同收藏请求",
          );
        return {
          item: this.item(db, owner, previous.item_id),
          job: this.jobs(db).find((j) => j.id === previous.job_id)!,
          replayed: true,
          duplicate: false,
        };
      }
      const row = db
        .prepare(
          "SELECT record_json FROM items WHERE owner_id=? AND url=? AND deleted=0",
        )
        .get(owner, url) as Row | undefined;
      let item: ReadLaterItem, job: CaptureJob;
      if (row) {
        item = JSON.parse(row.record_json);
        job = this.jobs(db).find((j) => j.id === item.latestJobId)!;
      } else {
        const time = now();
        job = {
          id: randomUUID(),
          itemId: randomUUID(),
          ownerId: owner,
          generation: 1,
          status: "queued",
          step: "等待采集",
          progress: 0,
          createdAt: time,
          updatedAt: time,
        };
        item = {
          id: job.itemId,
          ownerId: owner,
          originalUrl: input.url.trim(),
          canonicalUrl: url,
          title: title || new URL(url).hostname,
          ...(title ? { userTitle: title } : {}),
          siteName: new URL(url).hostname,
          author: "",
          description: "",
          readingStatus: "unread",
          parseStatus: "queued",
          latestJobId: job.id,
          tags,
          note,
          revision: 1,
          generation: 1,
          createdAt: time,
          updatedAt: time,
        };
        this.save(db, item);
        this.saveJob(db, job);
      }
      db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)").run(
        owner,
        `save:${op}`,
        hash,
        item.id,
        job.id,
      );
      return { item, job, replayed: false, duplicate: !!row };
    });
  }
  update(owner: string, id: string, input: ReadLaterUpdate) {
    return this.db((db) => {
      const item = this.item(db, owner, id);
      if (item.revision !== expectedRevision(input.expectedRevision))
        throw new ReadLaterError("conflict", "收藏已变化，请刷新后重试");
      if (input.title !== undefined) {
        item.userTitle = cleanText(input.title, 300, "标题") || undefined;
        item.title =
          item.userTitle ??
          item.extractedTitle ??
          new URL(item.canonicalUrl).hostname;
      }
      if (input.note !== undefined)
        item.note = cleanText(input.note, 10000, "笔记");
      if (input.tags !== undefined) item.tags = cleanTags(input.tags);
      if (input.readingStatus !== undefined) {
        if (!["unread", "read", "archived"].includes(input.readingStatus))
          throw new ReadLaterError("invalid_input", "阅读状态无效");
        item.readingStatus = input.readingStatus;
        if (input.readingStatus === "read") item.readAt = now();
      }
      item.revision++;
      item.updatedAt = now();
      this.save(db, item);
      return item;
    });
  }
  markRead(owner: string, input: MarkReadInput) {
    if (!input || !["all", "selected"].includes(input.scope))
      throw new ReadLaterError("invalid_input", "请选择全部或选中的收藏");
    return this.db((db) => {
      let items: ReadLaterItem[];
      if (input.scope === "selected") {
        if (
          !Array.isArray(input.items) || !input.items.length || input.items.length > 100 ||
          input.items.some((ref) => !ref || typeof ref.id !== "string") ||
          new Set(input.items.map((ref) => ref.id)).size !== input.items.length
        ) throw new ReadLaterError("invalid_input", "请选择 1–100 篇不同的收藏");
        items = input.items.map((ref) => {
          const item = this.item(db, owner, ref.id);
          if (item.revision !== expectedRevision(ref.expectedRevision))
            throw new ReadLaterError("conflict", "收藏已变化，请重新选择后重试");
          return item;
        });
      } else {
        items = (db.prepare("SELECT record_json FROM items WHERE owner_id=? AND deleted=0").all(owner) as Row[])
          .map((row) => JSON.parse(row.record_json) as ReadLaterItem);
      }
      const timestamp = now();
      let changed = 0;
      for (const item of items) {
        if (item.readingStatus !== "unread") continue;
        item.readingStatus = "read";
        item.readAt = timestamp;
        item.updatedAt = timestamp;
        item.revision++;
        this.save(db, item);
        changed++;
      }
      return { changed };
    });
  }
  retry(owner: string, id: string, revision: number, op: string) {
    return this.db((db) => {
      operationId(op);
      const previous = db
        .prepare(
          "SELECT item_id,job_id FROM operations WHERE owner_id=? AND id=?",
        )
        .get(owner, `retry:${op}`) as
        | {
            item_id: string;
            job_id: string;
          }
        | undefined;
      if (previous) {
        if (previous.item_id !== id)
          throw new ReadLaterError("conflict", "重试标识已用于另一条收藏");
        return {
          item: this.item(db, owner, id),
          job: this.jobs(db).find((j) => j.id === previous.job_id)!,
          replayed: true,
        };
      }
      const item = this.item(db, owner, id);
      if (item.revision !== expectedRevision(revision))
        throw new ReadLaterError("conflict", "收藏已变化，请刷新");
      if (["queued", "processing"].includes(item.parseStatus))
        throw new ReadLaterError("conflict", "该收藏已在采集中");
      const time = now(),
        job: CaptureJob = {
          id: randomUUID(),
          itemId: id,
          ownerId: owner,
          generation: ++item.generation,
          status: "queued",
          step: "等待采集",
          progress: 0,
          createdAt: time,
          updatedAt: time,
        };
      item.latestJobId = job.id;
      item.parseStatus = "queued";
      item.errorMessage = undefined;
      item.revision++;
      item.updatedAt = time;
      this.save(db, item);
      this.saveJob(db, job);
      db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)").run(
        owner,
        `retry:${op}`,
        null,
        id,
        job.id,
      );
      return { item, job, replayed: false };
    });
  }
  importVersion(owner: string, id: string, revision: number, op: string, hash: string,
    metadata: Pick<ReadLaterItem, "title" | "siteName" | "author" | "description">, version: ArticleVersion) {
    operationId(op);
    return this.db(db => {
      const item = this.item(db, owner, id);
      const previous = db.prepare("SELECT hash,item_id,job_id FROM operations WHERE owner_id=? AND id=?").get(owner, `import:${op}`) as { hash: string; item_id: string; job_id: string } | undefined;
      if (previous) {
        if (previous.hash !== hash || previous.item_id !== id) throw new ReadLaterError("conflict", "导入标识已用于不同内容");
        return { item, job: this.jobs(db).find(job => job.id === previous.job_id)!, replayed: true };
      }
      if (item.revision !== expectedRevision(revision)) throw new ReadLaterError("conflict", "收藏已变化，请刷新后重新导入");
      if (version.itemId !== id) throw new ReadLaterError("invalid_input", "正文归属无效");
      for (const job of this.jobs(db).filter(job => job.itemId === id && ["queued", "running"].includes(job.status))) {
        this.saveJob(db, { ...job, status: "cancelled", step: "已由网页导入替代", updatedAt: now(), leaseExpiresAt: undefined });
      }
      const timestamp = now(), job: CaptureJob = {
        id: randomUUID(), itemId: id, ownerId: owner, generation: ++item.generation,
        status: "succeeded", step: "网页正文已导入", progress: 100, createdAt: timestamp, updatedAt: timestamp,
      };
      db.prepare("INSERT INTO versions VALUES(?,?,?)").run(version.id, id, JSON.stringify(version));
      Object.assign(item, metadata);
      item.extractedTitle = metadata.title;
      item.title = item.userTitle || metadata.title;
      item.activeVersionId = version.id;
      item.latestJobId = job.id;
      item.parseStatus = "ready";
      item.errorMessage = undefined;
      item.fetchedUrl = undefined; // This version came from a supplied file, not a network response.
      item.fetchedAt = version.capturedAt;
      item.revision++;
      item.updatedAt = timestamp;
      this.save(db, item); this.saveJob(db, job);
      db.prepare("INSERT INTO operations VALUES(?,?,?,?,?)").run(owner, `import:${op}`, hash, id, job.id);
      return { item, job, replayed: false };
    });
  }
  remove(owner: string, id: string, revision: number) {
    return this.db((db) => {
      const item = this.item(db, owner, id, true);
      if (item.deletedAt) return item;
      if (item.revision !== expectedRevision(revision))
        throw new ReadLaterError("conflict", "收藏已变化，请刷新");
      item.deletedAt = now();
      item.cleanupPending = true;
      item.generation++;
      item.revision++;
      this.save(db, item);
      for (const job of this.jobs(db).filter(
        (j) => j.itemId === id && ["queued", "running"].includes(j.status),
      ))
        this.saveJob(db, {
          ...job,
          status: "cancelled",
          step: "已取消",
          updatedAt: now(),
        });
      db.prepare("DELETE FROM versions WHERE item_id=?").run(id);
      return item;
    });
  }
  cleanupItems(): ReadLaterItem[] {
    return this.db((db) =>
      (
        db
          .prepare("SELECT record_json FROM items WHERE deleted=1")
          .all() as Row[]
      )
        .map((row) => JSON.parse(row.record_json) as ReadLaterItem)
        .filter((i) => i.cleanupPending),
    );
  }
  cleaned(item: ReadLaterItem) {
    this.db((db) => {
      const current = this.item(db, item.ownerId, item.id, true);
      current.cleanupPending = false;
      this.save(db, current);
    });
  }
  claim(worker: string, leaseMs = 30000): CaptureJob | undefined {
    return this.db((db) => {
      for (const job of this.jobs(db).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )) {
        if (
          job.status !== "queued" &&
          !(job.status === "running" && (job.leaseExpiresAt ?? "") < now())
        )
          continue;
        const item = this.item(db, job.ownerId, job.itemId, true);
        if (item.deletedAt || item.generation !== job.generation) {
          this.saveJob(db, { ...job, status: "cancelled" });
          continue;
        }
        job.status = "running";
        job.leaseOwner = worker;
        job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
        job.updatedAt = now();
        this.saveJob(db, job);
        item.parseStatus = "processing";
        this.save(db, item);
        return job;
      }
      return undefined;
    });
  }
  // Omitting the stage renews the lease without rewinding displayed progress.
  progress(job: CaptureJob, step?: string, progress?: number): boolean {
    return this.db((db) => {
      const current = this.jobs(db).find((j) => j.id === job.id);
      if (
        !current ||
        current.status !== "running" ||
        current.leaseOwner !== job.leaseOwner
      )
        return false;
      if (step !== undefined) current.step = step;
      if (progress !== undefined) current.progress = progress;
      current.updatedAt = now();
      current.leaseExpiresAt = new Date(Date.now() + 30000).toISOString();
      this.saveJob(db, current);
      return true;
    });
  }
  complete(
    job: CaptureJob,
    result: {
      version?: ArticleVersion;
      metadata?: Partial<
        Pick<
          ReadLaterItem,
          "title" | "siteName" | "author" | "description" | "fetchedUrl"
        >
      >;
      error?: string;
      failed?: boolean;
    },
  ): boolean {
    return this.db((db) => {
      const current = this.jobs(db).find((j) => j.id === job.id),
        item = this.item(db, job.ownerId, job.itemId, true);
      if (
        !current ||
        current.status !== "running" ||
        current.leaseOwner !== job.leaseOwner ||
        item.deletedAt ||
        item.generation !== job.generation
      )
        return false;
      if (result.version) {
        db.prepare("INSERT INTO versions VALUES(?,?,?)").run(
          result.version.id,
          item.id,
          JSON.stringify(result.version),
        );
        item.activeVersionId = result.version.id;
        item.fetchedAt = result.version.capturedAt;
      }
      if (result.version || !item.activeVersionId) {
        if (result.metadata?.title) item.extractedTitle = result.metadata.title;
        Object.assign(item, result.metadata);
      }
      if (item.userTitle) item.title = item.userTitle;
      item.parseStatus =
        result.version || item.activeVersionId
          ? "ready"
          : result.failed
            ? "failed"
            : "link_only";
      item.errorMessage = result.error;
      item.updatedAt = now();
      item.revision++;
      this.save(db, item);
      this.saveJob(db, {
        ...current,
        status: result.failed ? "failed" : "succeeded",
        step: result.version ? "正文已归档" : (result.error ?? "仅保存链接"),
        progress: 100,
        errorMessage: result.error,
        updatedAt: now(),
        leaseExpiresAt: undefined,
      });
      return true;
    });
  }
  promotion(owner: string, id: string): Promotion | undefined {
    return this.db((db) => {
      const row = db
        .prepare("SELECT record_json FROM promotions WHERE owner_id=? AND id=?")
        .get(owner, id) as Row | undefined;
      return row ? JSON.parse(row.record_json) : undefined;
    });
  }
  savePromotion(p: Promotion) {
    return this.db((db) => {
      const row = db
        .prepare("SELECT record_json FROM promotions WHERE owner_id=? AND id=?")
        .get(p.ownerId, p.operationId) as Row | undefined;
      if (row) {
        const old = JSON.parse(row.record_json) as Promotion;
        if (old.requestHash !== p.requestHash)
          throw new ReadLaterError(
            "conflict",
            "operationId 已用于不同整理请求",
          );
        if (old.jobId) return old;
        if (p.sourceIds.length === 0) return old;
      }
      db.prepare("INSERT OR REPLACE INTO promotions VALUES(?,?,?)").run(
        p.ownerId,
        p.operationId,
        JSON.stringify(p),
      );
      return p;
    });
  }
  promotions(owner: string) {
    return this.db((db) =>
      (
        db
          .prepare("SELECT record_json FROM promotions WHERE owner_id=?")
          .all(owner) as Row[]
      ).map((row) => JSON.parse(row.record_json) as Promotion),
    );
  }
}
