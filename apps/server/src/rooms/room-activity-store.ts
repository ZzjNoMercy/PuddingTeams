import { randomUUID } from "node:crypto";
import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * RoomSession 公共活动/未读投影。事实源是 RoomEvent 序号；本文件只是可重建
 * 的读模型，不参与回合准入。按 roomSessionId 记录 lastEventId/revision/read。
 */

export interface RoomSessionActivityEntry {
	revision: number;
	lastActivityAt: string;
	lastMessagePreview: string;
	lastEventId?: string;
}

interface ActivityState {
	version: 1;
	revisions: Record<string, RoomSessionActivityEntry>;
	reads: Record<string, { revision: number; readAt: string }>;
}

const EMPTY: ActivityState = { version: 1, revisions: {}, reads: {} };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export class RoomActivityStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly file: string) {}

	private async read(): Promise<ActivityState> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<ActivityState>;
			if (parsed.version !== 1 || !parsed.revisions || typeof parsed.revisions !== "object" || Array.isArray(parsed.revisions)
				|| !parsed.reads || typeof parsed.reads !== "object" || Array.isArray(parsed.reads)) throw new Error("invalid room activity state");
			return { version: 1, revisions: parsed.revisions, reads: parsed.reads };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revisions: {}, reads: {} };
			throw error;
		}
	}

	private async write(state: ActivityState): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(state) + "\n", { mode: 0o600 });
		await rename(temp, this.file);
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		this.queue = next.then(() => undefined, () => undefined);
		return next;
	}

	async record(roomSessionId: string, input: { eventId: string; at: string; preview: string; unread?: boolean }): Promise<RoomSessionActivityEntry> {
		if (!SAFE_ID.test(roomSessionId)) throw new Error("invalid room session id");
		return this.serialize(async () => {
			const state = await this.read();
			const previous = state.revisions[roomSessionId];
			const entry: RoomSessionActivityEntry = {
				revision: input.unread === false ? (previous?.revision ?? 0) : (previous?.revision ?? 0) + 1,
				lastActivityAt: input.at,
				lastMessagePreview: input.preview.slice(0, 200),
				lastEventId: input.eventId,
			};
			state.revisions[roomSessionId] = entry;
			await this.write(state);
			return entry;
		});
	}

	async removeRoom(roomSessionId: string): Promise<void> {
		if (!SAFE_ID.test(roomSessionId)) throw new Error("invalid room session id");
		await this.serialize(async () => {
			const state = await this.read();
			if (!Object.hasOwn(state.revisions, roomSessionId) && !Object.hasOwn(state.reads, roomSessionId)) return;
			delete state.revisions[roomSessionId];
			delete state.reads[roomSessionId];
			await this.write(state);
		});
	}

	async markRead(roomSessionId: string, expectedRevision?: number): Promise<{ readRevision: number; hasUnreadActivity: boolean; entry?: RoomSessionActivityEntry }> {
		if (!SAFE_ID.test(roomSessionId)) throw new Error("invalid room session id");
		return this.serialize(async () => {
			const state = await this.read();
			const entry = state.revisions[roomSessionId];
			const revision = entry?.revision ?? 0;
			if (expectedRevision !== undefined && revision > expectedRevision) throw new Error(`activity revision changed: expected ${expectedRevision}, actual ${revision}`);
			state.reads[roomSessionId] = { revision, readAt: new Date().toISOString() };
			await this.write(state);
			return { readRevision: revision, hasUnreadActivity: false, ...(entry ? { entry } : {}) };
		});
	}

	async status(roomSessionId: string): Promise<{ readRevision: number; hasUnreadActivity: boolean; entry?: RoomSessionActivityEntry }> {
		if (!SAFE_ID.test(roomSessionId)) throw new Error("invalid room session id");
		const state = await this.read();
		const entry = state.revisions[roomSessionId];
		const readRevision = state.reads[roomSessionId]?.revision ?? 0;
		return { readRevision, hasUnreadActivity: (entry?.revision ?? 0) > readRevision, ...(entry ? { entry } : {}) };
	}

	async statuses(roomSessionIds: string[]): Promise<Map<string, { readRevision: number; hasUnreadActivity: boolean; entry?: RoomSessionActivityEntry }>> {
		const state = await this.read();
		return new Map(roomSessionIds.map((roomSessionId) => {
			const entry = state.revisions[roomSessionId];
			const readRevision = state.reads[roomSessionId]?.revision ?? 0;
			return [roomSessionId, { readRevision, hasUnreadActivity: (entry?.revision ?? 0) > readRevision, ...(entry ? { entry } : {}) }];
		}));
	}
}
