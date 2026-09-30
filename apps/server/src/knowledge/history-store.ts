import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export interface NoteHistoryEvent {
	id: string; bindingId: string; noteId: string; relativePath: string; previousPath?: string;
	contentHash: string; snapshotRef: string; previousHash?: string; previousSnapshotRef?: string;
	actorId: string; channel: "initial" | "agent_publish" | "external_sync";
	changeKind?: "create" | "update" | "rename" | "delete";
	deleted?: boolean;
	acceptedAt: string; operationId: string; batchId?: string; batchRevision?: number; decisionId?: string;
	summary: string; sourceIds: string[];
}
export interface NoteHistoryVersion extends NoteHistoryEvent { revision: number; createdAt: string; current: boolean; previousVersionId?: string; actorName?: string }

/** Projection of committed acceptance outbox entries; candidate state never enters here. */
export class KnowledgeHistoryStore {
	constructor(private readonly stateDir: string) {}
	private async db<T>(fn: (db: DatabaseSync) => T): Promise<T> {
		await mkdir(this.stateDir, { recursive: true, mode: 0o700 }); const db = new DatabaseSync(path.join(this.stateDir, "history.sqlite"));
		try {
			db.exec("PRAGMA busy_timeout=5000");
			db.exec("CREATE TABLE IF NOT EXISTS note_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, binding_id TEXT NOT NULL, note_id TEXT NOT NULL, operation_id TEXT NOT NULL, path TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(binding_id,note_id,operation_id))");
			return fn(db);
		} finally { db.close(); }
	}
	async append(events: NoteHistoryEvent[]): Promise<void> {
		await this.db((db) => {
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const event of events) {
					if (!event.id || !event.noteId || !event.bindingId || !event.actorId || !event.operationId || !/^[a-f0-9]{64}$/.test(event.contentHash) || event.snapshotRef !== event.contentHash || !Number.isFinite(Date.parse(event.acceptedAt))) throw new Error("invalid committed history event");
					const prior = db.prepare("SELECT record_json FROM note_history WHERE id=? OR (binding_id=? AND note_id=? AND operation_id=?)").get(event.id, event.bindingId, event.noteId, event.operationId) as { record_json: string } | undefined;
					if (prior) { if (prior.record_json !== JSON.stringify(event)) throw new Error("history operation conflicts with committed bytes"); continue; }
					db.prepare("INSERT INTO note_history(id,binding_id,note_id,operation_id,path,record_json) VALUES(?,?,?,?,?,?)").run(event.id, event.bindingId, event.noteId, event.operationId, event.relativePath, JSON.stringify(event));
				}
				db.exec("COMMIT");
			} catch (error) { db.exec("ROLLBACK"); throw error; }
		});
	}
	private versions(rows: Array<{ record_json: string }>): NoteHistoryVersion[] {
		return rows.map((row, index) => ({ ...JSON.parse(row.record_json) as NoteHistoryEvent, revision: index + 1,
			...((JSON.parse(row.record_json) as NoteHistoryEvent).channel === "external_sync" ? { actorName: "平台观察" } : {}),
			createdAt: (JSON.parse(row.record_json) as NoteHistoryEvent).acceptedAt, current: index === rows.length - 1 && !(JSON.parse(row.record_json) as NoteHistoryEvent).deleted,
			...(index ? { previousVersionId: (JSON.parse(rows[index - 1]!.record_json) as NoteHistoryEvent).id } : {}) })).reverse();
	}
	async list(bindingId: string, relativePath: string): Promise<{ noteId: string | null; currentVersionId: string | null; versions: NoteHistoryVersion[] }> {
		return this.db((db) => {
			const found = db.prepare("SELECT note_id FROM note_history WHERE binding_id=? AND path=? ORDER BY seq DESC LIMIT 1").get(bindingId, relativePath) as { note_id: string } | undefined;
			if (!found) return { noteId: null, currentVersionId: null, versions: [] };
			const rows = db.prepare("SELECT record_json FROM note_history WHERE binding_id=? AND note_id=? ORDER BY seq").all(bindingId, found.note_id) as unknown as Array<{ record_json: string }>;
			const versions = this.versions(rows); return { noteId: found.note_id, currentVersionId: versions[0]?.deleted ? null : versions[0]?.id ?? null, versions };
		});
	}
	async get(bindingId: string, id: string): Promise<NoteHistoryVersion | undefined> {
		return this.db((db) => {
			const found = db.prepare("SELECT note_id FROM note_history WHERE binding_id=? AND id=?").get(bindingId, id) as { note_id: string } | undefined;
			if (!found) return undefined;
			return this.versions(db.prepare("SELECT record_json FROM note_history WHERE binding_id=? AND note_id=? ORDER BY seq").all(bindingId, found.note_id) as unknown as Array<{ record_json: string }>).find((version) => version.id === id);
		});
	}
}
