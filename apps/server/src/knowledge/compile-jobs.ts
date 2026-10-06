import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { CompileJob, CompileJobStatus } from "./contracts.js";
import { fingerprintCompileSnapshot } from "./compile-snapshot.js";

export type NewCompileJob = Omit<CompileJob,
	"id" | "status" | "revision" | "createdAt" | "updatedAt" | "delegationId" | "candidateBatchId" | "failureCode" | "sourceSnapshotHash">;

interface StoredRow { record_json: string }

/** One SQLite transaction is the authority boundary, including across server
 * instances. A Job's staging/private roots are unique for its full lifetime. */
export class CompileJobStore {
	private readonly file: string;

	constructor(private readonly stateDir: string) {
		this.file = path.join(stateDir, "compile-jobs.sqlite");
	}

	private async withDatabase<T>(action: (db: DatabaseSync) => T): Promise<T> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.file);
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec(`CREATE TABLE IF NOT EXISTS compile_jobs (
				id TEXT PRIMARY KEY,
				operation_id TEXT NOT NULL UNIQUE,
				staging_root TEXT NOT NULL UNIQUE,
				private_root TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL,
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

	private parseRow(row: StoredRow): CompileJob {
		const job = JSON.parse(row.record_json) as CompileJob;
		if (!/^[a-f0-9]{64}$/.test(job.sourceSnapshotHash)) throw new Error("CompileJob source snapshot hash is missing");
		return job;
	}

	private read(db: DatabaseSync, id: string): CompileJob | undefined {
		const row = db.prepare("SELECT record_json FROM compile_jobs WHERE id = ?").get(id) as StoredRow | undefined;
		if (!row) return undefined;
		return this.parseRow(row);
	}

	private replace(db: DatabaseSync, job: CompileJob): void {
		const changed = db.prepare("UPDATE compile_jobs SET status = ?, record_json = ? WHERE id = ?")
			.run(job.status, JSON.stringify(job), job.id).changes;
		if (changed !== 1) throw new Error("CompileJob disappeared during transition");
	}

	async create(input: NewCompileJob): Promise<CompileJob> {
		for (const key of ["id", "status", "revision", "createdAt", "updatedAt", "delegationId", "candidateBatchId", "failureCode", "sourceSnapshotHash"]) {
			if (Object.hasOwn(input, key)) throw new Error(`CompileJob caller cannot supply ${key}`);
		}
		if (!input.operationId || !input.ownerId || !input.targetBindingId || !input.rootIdentity ||
			!input.compilerRef || !input.agentId || !input.task.trim() || !input.sourceSnapshotRefs.length ||
			!Array.isArray(input.sourceAcceptanceIds) || input.sourceAcceptanceIds.length !== input.sourceSnapshotRefs.length ||
			input.sourceAcceptanceIds.some((id) => typeof id !== "string" || !id.trim()) ||
			new Set(input.sourceAcceptanceIds).size !== input.sourceAcceptanceIds.length ||
			!Number.isSafeInteger(input.agentRevision) || input.agentRevision < 1 ||
			!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 1 ||
			!Number.isSafeInteger(input.trustRevision) || input.trustRevision < 1 ||
			![input.compilerPackageSha256, input.commandSha256].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
			![input.sourceSnapshotRoot, input.stagingRoot, input.privateRoot, input.commandPath].every(path.isAbsolute)) {
			throw new Error("invalid CompileJob authority");
		}
		const roots = [input.sourceSnapshotRoot, input.stagingRoot, input.privateRoot];
		for (const root of roots) {
			if (await realpath(root) !== root) throw new Error("CompileJob roots must be canonical");
		}
		for (let left = 0; left < roots.length; left++) for (let right = left + 1; right < roots.length; right++) {
			if (roots[left] === roots[right] || roots[left]!.startsWith(`${roots[right]}${path.sep}`) || roots[right]!.startsWith(`${roots[left]}${path.sep}`)) {
				throw new Error("CompileJob roots must be disjoint");
			}
		}
		const sourceSnapshotHash = await fingerprintCompileSnapshot(input.sourceSnapshotRoot);
		const frozenInput = { ...input, sourceSnapshotHash };
		return this.withDatabase((db) => this.transaction(db, () => {
			const row = db.prepare("SELECT record_json FROM compile_jobs WHERE operation_id = ?")
				.get(input.operationId) as StoredRow | undefined;
			if (row) {
				const existing = JSON.parse(row.record_json) as CompileJob;
				const { id: _id, status: _status, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
					delegationId: _delegationId, candidateBatchId: _candidateBatchId, failureCode: _failureCode, ...frozen } = existing;
				if (JSON.stringify(frozen) !== JSON.stringify(frozenInput)) throw new Error("CompileJob operation conflict");
				return existing;
			}
			const used = db.prepare("SELECT id FROM compile_jobs WHERE staging_root IN (?, ?) OR private_root IN (?, ?)")
				.get(input.stagingRoot, input.privateRoot, input.stagingRoot, input.privateRoot);
			if (used) throw new Error("CompileJob staging/private root was already used");
			const now = new Date().toISOString();
			const job: CompileJob = { ...frozenInput, id: randomUUID(), status: "queued", revision: 0, createdAt: now, updatedAt: now };
			db.prepare("INSERT INTO compile_jobs (id, operation_id, staging_root, private_root, status, record_json) VALUES (?, ?, ?, ?, ?, ?)")
				.run(job.id, job.operationId, job.stagingRoot, job.privateRoot, job.status, JSON.stringify(job));
			return job;
		}));
	}

	async get(id: string): Promise<CompileJob | undefined> {
		return this.withDatabase((db) => this.read(db, id));
	}

	/** 路由级幂等：同键重放先按 operationId 找已冻结的 Job（各 Job 目录唯一，
	 *  store 级幂等只对完全相同的冻结输入生效，路由需自行做语义比对）。 */
	async findByOperationId(operationId: string): Promise<CompileJob | undefined> {
		return this.withDatabase((db) => {
			const row = db.prepare("SELECT record_json FROM compile_jobs WHERE operation_id = ?")
				.get(operationId) as StoredRow | undefined;
			if (!row) return undefined;
			return this.parseRow(row);
		});
	}

	async list(): Promise<CompileJob[]> {
		return this.withDatabase((db) =>
			(db.prepare("SELECT record_json FROM compile_jobs").all() as unknown as StoredRow[]).map((row) => this.parseRow(row)));
	}

	/** BEGIN IMMEDIATE makes this a single claim even across separate processes. */
	async claim(id: string): Promise<CompileJob> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const job = this.read(db, id);
			if (!job || job.status !== "queued") throw new Error("CompileJob is not queued");
			const next: CompileJob = { ...job, status: "running", revision: job.revision + 1, updatedAt: new Date().toISOString() };
			this.replace(db, next);
			return next;
		}));
	}

	async bindDelegation(id: string, delegationId: string): Promise<CompileJob> {
		if (!delegationId) throw new Error("CompileJob delegation id is required");
		return this.withDatabase((db) => this.transaction(db, () => {
			const job = this.read(db, id);
			if (!job || job.status !== "running" || (job.delegationId && job.delegationId !== delegationId)) {
				throw new Error("CompileJob delegation binding conflict");
			}
			if (job.delegationId === delegationId) return job;
			const next: CompileJob = { ...job, delegationId, revision: job.revision + 1, updatedAt: new Date().toISOString() };
			this.replace(db, next);
			return next;
		}));
	}

	async finish(id: string, status: Extract<CompileJobStatus, "candidate_ready" | "failed" | "cancelled">,
		outcome: { candidateBatchId?: string; failureCode?: string } = {}): Promise<CompileJob> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const job = this.read(db, id);
			if (!job || job.status !== "running") throw new Error("CompileJob is not running");
			if (status === "candidate_ready" && (!job.delegationId || !outcome.candidateBatchId)) {
				throw new Error("CompileJob candidate requires a bound Delegation and validated batch");
			}
			if (status !== "candidate_ready" && !outcome.failureCode) throw new Error("CompileJob failure code is required");
			const next: CompileJob = { ...job, status, revision: job.revision + 1, updatedAt: new Date().toISOString(),
				...(status === "candidate_ready" ? { candidateBatchId: outcome.candidateBatchId } : { failureCode: outcome.failureCode }) };
			this.replace(db, next);
			return next;
		}));
	}

	/** 取消先行：queued/running 直接收敛为 cancelled，再由调用方去停执行面。
	 *  候选验证完成与否不改变账本终态——finish 只接受 running。 */
	async cancel(id: string): Promise<CompileJob> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const job = this.read(db, id);
			if (!job || (job.status !== "queued" && job.status !== "running")) throw new Error("CompileJob is not cancellable");
			const next: CompileJob = { ...job, status: "cancelled", failureCode: "cancelled", revision: job.revision + 1, updatedAt: new Date().toISOString() };
			this.replace(db, next);
			return next;
		}));
	}

	/** Previous local processes are not reattached. A failed Job never reuses staging. */
	async failInterrupted(): Promise<CompileJob[]> {
		return this.withDatabase((db) => this.transaction(db, () => {
			const rows = db.prepare("SELECT record_json FROM compile_jobs WHERE status = 'running'").all() as unknown as StoredRow[];
			const now = new Date().toISOString();
			const failed = rows.map(({ record_json }): CompileJob => {
				const job = JSON.parse(record_json) as CompileJob;
				return { ...job, status: "failed", failureCode: "server_restart", revision: job.revision + 1, updatedAt: now };
			});
			for (const job of failed) this.replace(db, job);
			return failed;
		}));
	}
}
