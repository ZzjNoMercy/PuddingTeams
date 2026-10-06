import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { CalendarEvent } from "../knowledge/contracts.js";

export type CalendarInput = {
	title: string; description: string; location: string; kind: "event" | "focus";
	timeZone: string; busy: boolean;
	participants?: NonNullable<CalendarEvent["participants"]>;
	interaction?: CalendarEvent["interaction"];
} & ({ allDay: true; startDate: string; endDateExclusive: string } | { allDay: false; start: string; end: string });
export class CalendarError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "revision_conflict" | "operation_conflict", message: string) { super(message); }
}
export function validDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1900-01-01" && value <= "9999-12-31" &&
		Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function textField(value: unknown, name: string, max: number, required = false): string {
	if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new CalendarError("invalid_input", `${name}无效`);
	return value.trim();
}
function instant(value: unknown): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validDate(value.slice(0, 10)) || +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || !Number.isFinite(Date.parse(value))) {
		throw new CalendarError("invalid_input", "定时日程须包含明确时间点与 UTC 偏移");
	}
	return new Date(value).toISOString();
}
export function normalizeCalendarInput(value: unknown): CalendarInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new CalendarError("invalid_input", "日程输入无效");
	const v = value as Record<string, unknown>;
	const title = textField(v.title, "标题", 200, true), description = textField(v.description ?? "", "描述", 10_000), location = textField(v.location ?? "", "地点", 500);
	const timeZone = textField(v.timeZone, "时区", 100, true);
	try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { throw new CalendarError("invalid_input", "请选择有效 IANA 时区"); }
	if (typeof v.busy !== "boolean" || (v.kind !== "event" && v.kind !== "focus")) throw new CalendarError("invalid_input", "日程类型或忙闲状态无效");
	const participants = v.participants ?? [];
	if (!Array.isArray(participants) || participants.length > 50 || participants.some(p => !p || typeof p !== "object" || typeof p.bindingId !== "string" || !p.bindingId || typeof p.personId !== "string" || !/^[a-f0-9]{64}$/.test(p.personId)) || new Set(participants.map(p => JSON.stringify([p.bindingId, p.personId]))).size !== participants.length) throw new CalendarError("invalid_input", "请选择有效且不重复的参与人（最多 50 位）");
	const interaction = v.interaction as CalendarInput["interaction"];
	if (interaction !== undefined && (!interaction || typeof interaction !== "object" || typeof interaction.bindingId !== "string" || !interaction.bindingId || !["in_person", "call", "message", "email", "meal", "event", "other"].includes(interaction.kind) || v.allDay !== false || v.kind !== "event" || !participants.length || participants.some(p => p.bindingId !== interaction.bindingId))) throw new CalendarError("invalid_input", "记录往来需要定时日程，并从同一人脉库选择参与人");
	const common = { title, description, location, timeZone, busy: v.busy, kind: v.kind as "event" | "focus", participants: participants.map(p => ({ bindingId: p.bindingId as string, personId: p.personId as string })), ...(interaction ? { interaction: { bindingId: interaction.bindingId, kind: interaction.kind } } : {}) };
	if (v.allDay === true) {
		if (!validDate(v.startDate) || !validDate(v.endDateExclusive) || v.endDateExclusive <= v.startDate || v.start !== undefined || v.end !== undefined) throw new CalendarError("invalid_input", "全天日程须使用有效日期，结束日期不包含在日程内");
		return { ...common, allDay: true, startDate: v.startDate, endDateExclusive: v.endDateExclusive };
	}
	if (v.allDay !== false || v.startDate !== undefined || v.endDateExclusive !== undefined) throw new CalendarError("invalid_input", "日程时间类型无效");
	const start = instant(v.start), end = instant(v.end);
	if (end <= start) throw new CalendarError("invalid_input", "结束时间必须晚于开始时间");
	return { ...common, allDay: false, start, end };
}

interface StoredEvent { ownerId: string; event: CalendarEvent }
interface CalendarFile {
	version: 1; events: Record<string, StoredEvent>;
	operations: Record<string, { fingerprint: string; result: CalendarEvent }>;
}
/** One process queue; event and replay receipt are committed in the same atomic file. */
export class CalendarStore {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private readonly root: string) {}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result;
	}
	private async read(): Promise<CalendarFile> {
		try {
			const file = JSON.parse(await readFile(path.join(this.root, "events.json"), "utf8")) as CalendarFile;
			if (file.version !== 1 || !file.events || !file.operations) throw new Error("日历存储格式无效");
			return file;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, events: {}, operations: {} }; throw error; }
	}
	private async write(file: CalendarFile): Promise<void> {
		await mkdir(this.root, { recursive: true });
		const temporary = path.join(this.root, `${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(JSON.stringify(file)); await handle.sync(); } finally { await handle.close(); }
			await rename(temporary, path.join(this.root, "events.json"));
		} finally { await rm(temporary, { force: true }); }
	}
	/** Cancelled and done events stay visible; clients render the status. */
	list(ownerId: string): Promise<CalendarEvent[]> {
		return this.serial(async () => Object.values((await this.read()).events).filter((v) => v.ownerId === ownerId).map((v) => v.event));
	}
	get(ownerId: string, id: string): Promise<CalendarEvent> {
		return this.serial(async () => {
			const record = (await this.read()).events[id];
			if (!record || record.ownerId !== ownerId) throw new CalendarError("not_found", "日程不存在");
			return record.event;
		});
	}
	private fingerprint(action: "create" | "update" | "cancel", id: string | undefined, expectedRevision: unknown, input?: unknown) {
		const normalized = action === "cancel" ? undefined : normalizeCalendarInput(input);
		return { normalized, fingerprint: createHash("sha256").update(JSON.stringify([action, id ?? null, expectedRevision, normalized ?? null])).digest("hex") };
	}
	/** Durable receipts survive changes to live participant pages. */
	replay(ownerId: string, action: "create" | "update" | "cancel", id: string | undefined, operationId: unknown, expectedRevision: unknown, input?: unknown): Promise<CalendarEvent | undefined> {
		return this.serial(async () => {
			if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId) || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new CalendarError("invalid_input", "须提供 operationId 与 expectedRevision");
			const { fingerprint } = this.fingerprint(action, id, expectedRevision, input);
			const old = (await this.read()).operations[JSON.stringify([ownerId, operationId])];
			if (!old) return undefined;
			if (old.fingerprint !== fingerprint) throw new CalendarError("operation_conflict", "同一操作不能用于不同日程内容，请核对后再创建新操作");
			return old.result;
		});
	}
	/** Status transitions (confirmed ↔ done ↔ cancelled) never regenerate interaction candidates. */
	setStatus(ownerId: string, id: string, operationId: unknown, expectedRevision: unknown, status: CalendarEvent["status"], guard?: () => Promise<void>): Promise<CalendarEvent> {
		return this.serial(async () => {
			if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId) || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new CalendarError("invalid_input", "须提供 operationId 与 expectedRevision");
			const fingerprint = createHash("sha256").update(JSON.stringify(["status", id, expectedRevision, status])).digest("hex");
			const file = await this.read(), key = JSON.stringify([ownerId, operationId]), old = file.operations[key];
			if (old) {
				if (old.fingerprint !== fingerprint) throw new CalendarError("operation_conflict", "同一操作不能用于不同日程内容，请核对后再创建新操作");
				return old.result;
			}
			const record = file.events[id];
			if (!record || record.ownerId !== ownerId) throw new CalendarError("not_found", "日程不存在");
			if (record.event.revision !== expectedRevision) throw new CalendarError("revision_conflict", "日程已变化，请核对最新版本");
			const event: CalendarEvent = { ...record.event, status, revision: record.event.revision + 1, operationId };
			file.events[event.id] = { ownerId, event }; file.operations[key] = { fingerprint, result: event };
			await guard?.();
			await this.write(file); return event;
		});
	}
	mutate(ownerId: string, action: "create" | "update" | "cancel", id: string | undefined, operationId: unknown, expectedRevision: unknown, input?: unknown, guard?: () => Promise<void>): Promise<CalendarEvent> {
		return this.serial(async () => {
			if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId) || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new CalendarError("invalid_input", "须提供 operationId 与 expectedRevision");
			const { normalized, fingerprint } = this.fingerprint(action, id, expectedRevision, input);
			const file = await this.read(), key = JSON.stringify([ownerId, operationId]), old = file.operations[key];
			if (old) {
				if (old.fingerprint !== fingerprint) throw new CalendarError("operation_conflict", "同一操作不能用于不同日程内容，请核对后再创建新操作");
				return old.result;
			}
			let event: CalendarEvent;
			if (action === "create") {
				if (expectedRevision !== 0) throw new CalendarError("revision_conflict", "新日程 expectedRevision 必须为 0");
				event = { ...normalized!, id: randomUUID(), sourceId: "platform", status: "confirmed", noteRefs: [], revision: 1, operationId };
			} else {
				const record = id ? file.events[id] : undefined;
				if (!record || record.ownerId !== ownerId) throw new CalendarError("not_found", "日程不存在");
				if (record.event.revision !== expectedRevision || record.event.status !== "confirmed") throw new CalendarError("revision_conflict", "日程已变化或取消，请核对最新版本");
				event = action === "cancel" ? { ...record.event, status: "cancelled", revision: record.event.revision + 1, operationId } :
					{ ...normalized!, id: record.event.id, sourceId: "platform", status: "confirmed", noteRefs: record.event.noteRefs, revision: record.event.revision + 1, operationId };
			}
			file.events[event.id] = { ownerId, event }; file.operations[key] = { fingerprint, result: event };
			await guard?.();
			await this.write(file); return event;
		});
	}
}
