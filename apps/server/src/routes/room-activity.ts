import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export interface RoomActivity {
	lastActivityAt: string | null;
	lastMessagePreview: string;
	activitySessionId: string | null;
	activityRevision: number;
}

interface ActivityEvent {
	eventId: string;
	at: number;
	preview: string;
	sessionId: string;
	unreadEligible: boolean;
}

interface FileCheckpoint {
	fingerprint: string;
	events: ActivityEvent[];
}

interface SessionActivityState {
	unreadDigest: string;
	changedRevision: number;
	latestAt: number;
	latestPreview: string;
}

interface DurableRoomState {
	eventDigest: string;
	activityRevision: number;
	sessions: Record<string, SessionActivityState>;
	readByViewer?: Record<string, Record<string, number>>;
}

export interface RoomReadStatus {
	readRevision: number;
	hasUnreadActivity: boolean;
	unreadSessionId: string | null;
	unreadPreview: string | null;
}

const VISIBLE_CUSTOM = new Set([
	"pudding:user_message",
	"pudding:task_assign",
	"pudding:task_result",
	"pudding:interaction_required",
	"pudding:interaction_resolved",
	"pudding:decision_answered",
	"pudding:artifact_created",
	"pudding:goal_recovery",
	"pudding:goal_interrupted",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function isDurableRoomState(value: unknown): value is DurableRoomState {
	if (!isRecord(value) || !isDigest(value.eventDigest) || !isRevision(value.activityRevision) || !isRecord(value.sessions)) return false;
	const roomRevision = value.activityRevision;
	for (const session of Object.values(value.sessions)) {
		if (!isRecord(session) || !isDigest(session.unreadDigest) || !isRevision(session.changedRevision) ||
			!Number.isFinite(session.latestAt) || typeof session.latestPreview !== "string") return false;
		if (session.changedRevision > roomRevision) return false;
	}
	if (value.readByViewer !== undefined) {
		if (!isRecord(value.readByViewer)) return false;
		for (const reads of Object.values(value.readByViewer)) {
			if (!isRecord(reads) || Object.values(reads).some((revision) => !isRevision(revision) || revision > roomRevision)) return false;
		}
	}
	return true;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } =>
			Boolean(block && typeof block === "object" && block.type === "text" && typeof block.text === "string"))
		.map((block) => block.text)
		.join(" ");
}

function previewOf(content: unknown): string {
	return textContent(content).replace(/\s+/g, " ").trim().slice(0, 160);
}

/** A JSONL entry is an activity only if it records user-visible business content. */
export function activityFromEntry(sessionId: string, raw: unknown): ActivityEvent | null {
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Record<string, unknown>;
	if (typeof entry.id !== "string" || !entry.id) return null;
	const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
	if (!Number.isFinite(at)) return null;
	let preview = "";
	let unreadEligible = true;
	let eventId = `${sessionId}:${entry.id}`;
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "user" && message.role !== "assistant") return null;
		unreadEligible = message.role === "assistant";
		preview = previewOf(message.content);
	} else if (entry.type === "custom_message" && typeof entry.customType === "string" && VISIBLE_CUSTOM.has(entry.customType)) {
		if (entry.display === false) return null;
		// Human actions still belong in the activity timeline, but must not
		// immediately mark the user's own room unread. Later Worker progress does.
		unreadEligible = entry.customType !== "pudding:user_message" &&
			entry.customType !== "pudding:decision_answered" &&
			entry.customType !== "pudding:interaction_resolved";
		preview = previewOf(entry.content);
		if (!preview) preview = entry.customType === "pudding:interaction_required" ? "需要你处理审批" : "协作状态已更新";
		const details = isRecord(entry.details) ? entry.details : null;
		if (entry.customType === "pudding:task_assign" && typeof details?.taskId === "string" && details.taskId) {
			eventId = `${sessionId}:pudding:task_assign:${details.taskId}`;
		}
	} else {
		return null;
	}
	if (!preview) return null;
	return { eventId, at, preview, sessionId, unreadEligible };
}

function eventsFromJsonl(sessionId: string, content: string): ActivityEvent[] {
	const seen = new Set<string>();
	const events: ActivityEvent[] = [];
	const lines = content.split("\n");
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		let raw: unknown;
		try { raw = JSON.parse(line); }
		catch {
			if (index === lines.length - 1 && !content.endsWith("\n")) continue; // Incomplete append; retry after the file changes.
			throw new Error(`Session 历史 JSONL 第 ${index + 1} 行损坏：${sessionId}`);
		}
		const event = activityFromEntry(sessionId, raw);
		if (!event || seen.has(event.eventId)) continue;
		seen.add(event.eventId);
		events.push(event);
	}
	return events;
}

function digestEvents(events: readonly ActivityEvent[]): string {
	const hash = createHash("sha256");
	for (const event of [...events].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
		hash.update(JSON.stringify([event.eventId, event.at, event.preview, event.sessionId, event.unreadEligible])).update("\n");
	}
	return hash.digest("hex");
}

/**
 * JSONL is the source of truth. The file fingerprint is a read optimization,
 * never the activity timestamp. A process restart rebuilds from the same facts.
 */
export class RoomActivityProjector {
	private readonly checkpoints = new Map<string, FileCheckpoint>();
	private readonly projectedRooms = new Map<string, { signature: string; activity: RoomActivity }>();
	private readonly roomStates = new Map<string, DurableRoomState>();
	private loaded = false;
	private persistenceUncertain = false;
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly statePath?: string) {}

	private async load(): Promise<void> {
		if (this.persistenceUncertain) throw new Error("Room 活动状态持久化结果不确定；需重启后重放");
		if (this.loaded) return;
		if (!this.statePath) { this.loaded = true; return; }
		let content: string;
		try { content = await readFile(this.statePath, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.loaded = true;
			return;
		}
		let parsed: unknown;
		try { parsed = JSON.parse(content); }
		catch { throw new Error(`Room 活动状态文件无效：${this.statePath}`); }
		if (!isRecord(parsed) || Object.values(parsed).some((state) => !isDurableRoomState(state))) {
			throw new Error(`Room 活动状态文件无效：${this.statePath}`);
		}
		for (const [roomId, state] of Object.entries(parsed)) this.roomStates.set(roomId, state as DurableRoomState);
		this.loaded = true;
	}

	private async save(): Promise<void> {
		if (!this.statePath) return;
		if (this.persistenceUncertain) throw new Error("Room 活动状态持久化结果不确定；需重启后重放");
		await mkdir(path.dirname(this.statePath), { recursive: true });
		const temp = `${this.statePath}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let renamed = false;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(JSON.stringify(Object.fromEntries(this.roomStates)) + "\n");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temp, this.statePath);
			renamed = true;
			await this.syncDirectory();
		} catch (error) {
			if (renamed) this.persistenceUncertain = true;
			await handle?.close().catch(() => undefined);
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}

	private async syncDirectory(): Promise<void> {
		const directory = await open(path.dirname(this.statePath!), "r");
		try { await directory.sync(); }
		finally { await directory.close(); }
	}

	/** Acknowledge only the viewed Session up to the revision presented to this viewer. */
	markRead(roomId: string, viewerId: string, sessionId: string, observedRevision: number): Promise<number> {
		const run = this.queue.then(async () => {
			await this.load();
			return this.markReadUnlocked(roomId, viewerId, sessionId, observedRevision);
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async markReadUnlocked(roomId: string, viewerId: string, sessionId: string, observedRevision: number): Promise<number> {
		const state = this.roomStates.get(roomId);
		if (!state?.sessions[sessionId]) return 0;
		if (!Number.isSafeInteger(observedRevision) || observedRevision < 0 || observedRevision > state.activityRevision) {
			throw new Error("已读修订号无效或超出当前活动");
		}
		const previous = state.readByViewer?.[viewerId]?.[sessionId] ?? 0;
		const next = Math.max(previous, observedRevision);
		if (next === previous) return previous;
		const previousReadByViewer = state.readByViewer;
		state.readByViewer = { ...state.readByViewer, [viewerId]: { ...state.readByViewer?.[viewerId], [sessionId]: next } };
		try { await this.save(); }
		catch (error) {
			state.readByViewer = previousReadByViewer;
			throw error;
		}
		return next;
	}

	/** The acknowledgement response must use the same projector revision as its read state. */
	markReadWithStatus(roomId: string, viewerId: string, sessionId: string, observedRevision: number): Promise<{ activityRevision: number; read: RoomReadStatus }> {
		const run = this.queue.then(async () => {
			await this.load();
			await this.markReadUnlocked(roomId, viewerId, sessionId, observedRevision);
			return { activityRevision: this.roomStates.get(roomId)?.activityRevision ?? 0, read: this.readStatusUnlocked(roomId, viewerId) };
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	readStatus(roomId: string, viewerId: string): Promise<RoomReadStatus> {
		const run = this.queue.then(async () => {
			await this.load();
			return this.readStatusUnlocked(roomId, viewerId);
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private readStatusUnlocked(roomId: string, viewerId: string): RoomReadStatus {
		const state = this.roomStates.get(roomId);
		const reads = state?.readByViewer?.[viewerId] ?? {};
		const unread = Object.entries(state?.sessions ?? {})
			.filter(([sessionId, session]) => session.changedRevision > (reads[sessionId] ?? 0))
			.sort(([idA, a], [idB, b]) => b.changedRevision - a.changedRevision || b.latestAt - a.latestAt || idA.localeCompare(idB))[0];
		return {
			readRevision: Math.max(0, ...Object.values(reads)),
			hasUnreadActivity: Boolean(unread),
			unreadSessionId: unread?.[0] ?? null,
			unreadPreview: unread?.[1].latestPreview ?? null,
		};
	}

	/** Keep activity and viewer read state in one queue turn for a coherent Room summary. */
	projectWithReadStatus(roomId: string, sessions: readonly { id: string; sessionFile: string }[], viewerId: string): Promise<{ activity: RoomActivity; read: RoomReadStatus }> {
		const run = this.queue.then(async () => {
			const activity = await this.projectUnlocked(roomId, sessions);
			return { activity, read: this.readStatusUnlocked(roomId, viewerId) };
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	project(roomId: string, sessions: readonly { id: string; sessionFile: string }[]): Promise<RoomActivity> {
		const run = this.queue.then(() => this.projectUnlocked(roomId, sessions));
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async projectUnlocked(roomId: string, sessions: readonly { id: string; sessionFile: string }[]): Promise<RoomActivity> {
		await this.load();
		const previous = this.roomStates.get(roomId);
		const fingerprints: Array<readonly [string, string, string | null]> = [];
		const parsedFiles: FileCheckpoint[] = [];
		for (const session of sessions) {
			if (!session.sessionFile) {
				if (previous?.sessions[session.id]) throw new Error(`Session 历史文件不可读：${session.id}`);
				fingerprints.push([session.id, "", null]);
				continue; // A newly opened Session may not have its first JSONL file yet.
			}
			const fileStat = await stat(session.sessionFile);
			if (!fileStat.isFile()) throw new Error(`Session 历史不是普通文件：${session.id}`);
			const fingerprint = `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
			fingerprints.push([session.id, session.sessionFile, fingerprint]);
			const key = `${session.id}\0${session.sessionFile}`;
			let checkpoint = this.checkpoints.get(key);
			if (!checkpoint || checkpoint.fingerprint !== fingerprint) {
				const content = await readFile(session.sessionFile, "utf8");
				checkpoint = { fingerprint, events: eventsFromJsonl(session.id, content) };
				this.checkpoints.set(key, checkpoint);
			}
			parsedFiles.push(checkpoint);
		}
		const signature = JSON.stringify(fingerprints);
		const projected = this.projectedRooms.get(roomId);
		if (projected?.signature === signature) return { ...projected.activity };
		const events = parsedFiles.flatMap((checkpoint) => checkpoint.events);
		const unique = new Map(events.map((event) => [event.eventId, event]));
		const digest = digestEvents([...unique.values()]);
		const ordered = [...unique.values()].sort((a, b) => b.at - a.at || a.eventId.localeCompare(b.eventId));
		const latest = ordered[0];
		const changed = Boolean(previous && previous.eventDigest !== digest);
		const activityRevision = previous
			? previous.activityRevision + (changed ? 1 : 0)
			: unique.size > 0 ? 1 : 0;
		const bySession = new Map<string, ActivityEvent[]>();
		for (const event of unique.values()) bySession.set(event.sessionId, [...(bySession.get(event.sessionId) ?? []), event]);
		const sessionStates: Record<string, SessionActivityState> = {};
		for (const [sessionId, entries] of bySession) {
			const unreadEntries = entries.filter((entry) => entry.unreadEligible);
			const unreadDigest = digestEvents(unreadEntries);
			const previousSession = previous?.sessions[sessionId];
			// JSONL order is the order in which visible progress was recorded. A delayed
			// event may carry an older business timestamp but is still the new unread
			// item; using the timestamp winner here previews an already-read message.
			const newestRecorded = unreadEntries.at(-1);
			let latestAt = unreadEntries[0]?.at ?? 0;
			for (const entry of unreadEntries) latestAt = Math.max(latestAt, entry.at);
			sessionStates[sessionId] = {
				unreadDigest,
				changedRevision: unreadEntries.length === 0 ? 0 : previousSession?.unreadDigest === unreadDigest ? previousSession.changedRevision : activityRevision,
				latestAt,
				latestPreview: newestRecorded?.preview ?? "",
			};
		}
		if (!previous || changed) {
			this.roomStates.set(roomId, { eventDigest: digest, activityRevision, sessions: sessionStates, readByViewer: previous?.readByViewer });
			try {
				await this.save();
			} catch (error) {
				if (previous) this.roomStates.set(roomId, previous);
				else this.roomStates.delete(roomId);
				throw error;
			}
		}
		const activity = {
			lastActivityAt: latest ? new Date(latest.at).toISOString() : null,
			lastMessagePreview: latest?.preview ?? "",
			activitySessionId: latest?.sessionId ?? null,
			activityRevision,
		};
		this.projectedRooms.set(roomId, { signature, activity });
		return { ...activity };
	}
}

export function compareRoomActivity(
	a: { id: string; lastActivityAt: string | null; createdAt: string },
	b: { id: string; lastActivityAt: string | null; createdAt: string },
): number {
	const time = (room: typeof a) => {
		const at = room.lastActivityAt ? Date.parse(room.lastActivityAt) : NaN;
		const created = Date.parse(room.createdAt);
		return Number.isFinite(at) ? at : Number.isFinite(created) ? created : -Infinity;
	};
	return time(b) - time(a) || a.id.localeCompare(b.id);
}
