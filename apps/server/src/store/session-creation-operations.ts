import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface SessionCreationOperation {
	key: string;
	roomId: string;
	contextKey: string;
	contentHash?: string;
	sessionId: string;
	phase: "reserved" | "attached";
}

function validKey(key: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key);
}

function validRecords(value: unknown): value is Record<string, SessionCreationOperation> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).every(([key, raw]) => {
		if (!validKey(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		const record = raw as Record<string, unknown>;
		return record.key === key && typeof record.roomId === "string" && record.roomId.length > 0 &&
			typeof record.contextKey === "string" && record.contextKey.length > 0 &&
			typeof record.sessionId === "string" && record.sessionId.length > 0 &&
			(record.contentHash === undefined || typeof record.contentHash === "string" && /^[a-f0-9]{64}$/.test(record.contentHash)) &&
			(record.phase === "reserved" || record.phase === "attached");
	});
}

/** Durable reservation before Session creation; a retry can repair a crash between writes. */
export class SessionCreationOperations {
	private queue: Promise<void> = Promise.resolve();
	private persistenceUncertain = false;
	constructor(private readonly file: string) {}

	private async syncDirectory(): Promise<void> {
		const directory = await open(path.dirname(this.file), "r");
		try { await directory.sync(); }
		finally { await directory.close(); }
	}

	private async save(records: Record<string, SessionCreationOperation>): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let renamed = false;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(JSON.stringify(records) + "\n");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temp, this.file);
			renamed = true;
			await this.syncDirectory();
		} catch (error) {
			if (renamed) this.persistenceUncertain = true;
			await handle?.close().catch(() => undefined);
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}

	private async transact<T>(action: (records: Record<string, SessionCreationOperation>) => Promise<{ value: T; save: boolean }>): Promise<T> {
		const run = this.queue.then(async () => {
			if (this.persistenceUncertain) throw new Error("Session 创建操作账本持久化结果不确定；需重启后核对");
			let records: Record<string, SessionCreationOperation> = Object.create(null) as Record<string, SessionCreationOperation>;
			try {
				const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
				if (!validRecords(parsed)) throw new Error(`Session 创建操作账本无效：${this.file}`);
				records = parsed;
			}
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const result = await action(records);
			if (result.save) await this.save(records);
			return result.value;
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	async reserve(key: string, roomId: string, contextKey: string, preferredSessionId?: string, contentHash?: string): Promise<SessionCreationOperation> {
		if (!validKey(key)) throw new Error("Idempotency-Key 必须是 8–128 位字母、数字、点、下划线或连字符");
		if (contentHash && !/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("initialContentHash 必须是 SHA-256");
		return this.transact(async (records) => {
			const existing = Object.hasOwn(records, key) ? records[key] : undefined;
			if (existing) {
				if (existing.roomId !== roomId || existing.contextKey !== contextKey || (existing.contentHash ?? "") !== (contentHash ?? "")) {
					throw new Error("同一 Idempotency-Key 被用于不同房间、Workspace 或内容");
				}
				return { value: existing, save: false };
			}
			const preferredReserved = preferredSessionId && Object.values(records).some((record) => record.sessionId === preferredSessionId);
			const sessionId = preferredSessionId && !preferredReserved
				? preferredSessionId
				: `work-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
			const record: SessionCreationOperation = { key, roomId, contextKey, sessionId, ...(contentHash ? { contentHash } : {}), phase: "reserved" };
			records[key] = record;
			return { value: record, save: true };
		});
	}

	async markAttached(key: string, sessionId: string): Promise<void> {
		await this.transact(async (records) => {
			const record = Object.hasOwn(records, key) ? records[key] : undefined;
			if (!record || record.sessionId !== sessionId) throw new Error("Session 创建操作不存在或身份不匹配");
			if (record.phase === "attached") return { value: undefined, save: false };
			record.phase = "attached";
			return { value: undefined, save: true };
		});
	}
}
