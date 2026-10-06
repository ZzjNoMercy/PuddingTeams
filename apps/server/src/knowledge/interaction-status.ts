import { randomUUID } from "node:crypto";
import type { CalendarEvent } from "./contracts.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import type { KnowledgeAcceptanceStore } from "./acceptance.js";
import { parseNoteFrontmatterFields } from "./acceptance.js";
import { hashBufferSha256 } from "./hashing.js";
import { readNoteBytes, resolveNoteAbsolutePath, type KnowledgeObservationService } from "./observation.js";
import { writeKnowledgeNote } from "./note-write.js";

export type InteractionStatus = "planned" | "done" | "cancelled";
export type CalendarSyncOutcome =
	| { ok: true; eventId: string; status: CalendarEvent["status"]; changed: boolean }
	| { ok: false; eventId: string; error: string };

export class InteractionStatusError extends Error {
	constructor(readonly code: "invalid_input" | "not_found", message: string) { super(message); }
}

/** Structural slice of CalendarService; the concrete wiring lives in index.ts to avoid import cycles. */
export interface CalendarStatusSync {
	get(ownerId: string, eventId: string): Promise<{ revision: number; status: CalendarEvent["status"] }>;
	setStatus(ownerId: string, eventId: string, operationId: string, expectedRevision: number, status: CalendarEvent["status"], options: { source: "wiki" }): Promise<unknown>;
}

export interface InteractionStatusDeps {
	bindings: KnowledgeBindingRegistry;
	observation: KnowledgeObservationService;
	acceptance: KnowledgeAcceptanceStore;
	calendar?: CalendarStatusSync;
}

export interface InteractionStatusInput {
	ownerId: string;
	bindingId: string;
	path: string;
	status: InteractionStatus;
	occurredAt?: string;
}

export interface InteractionStatusResult {
	note: { path: string; status: InteractionStatus; occurredAt?: string; contentHash: string };
	changed: boolean;
	calendarSync?: CalendarSyncOutcome;
}

const CALENDAR_STATUS: Record<InteractionStatus, CalendarEvent["status"]> = { planned: "confirmed", done: "done", cancelled: "cancelled" };

function normalizeOccurredAt(value: string): string {
	const parsed = Date.parse(value);
	if (typeof value !== "string" || !value.trim() || !Number.isFinite(parsed)) throw new InteractionStatusError("invalid_input", "发生日期无效，请提供明确时间");
	return new Date(parsed).toISOString();
}

/** Surgical single-line scalar rewrite preserving each field's existing quote style and line endings. */
export function rewriteInteractionFrontmatter(content: string, patch: { status: string; updated: string; occurredAt?: string }): string {
	const lines = content.split("\n");
	if (lines[0]?.replace(/\r$/, "") !== "---") throw new InteractionStatusError("invalid_input", "笔记缺少 frontmatter，不支持状态标记");
	let end = -1;
	for (let index = 1; index < lines.length && index <= 200; index++) {
		if (lines[index]!.replace(/\r$/, "").trim() === "---") { end = index; break; }
	}
	if (end < 0) throw new InteractionStatusError("invalid_input", "笔记 frontmatter 未闭合，不支持状态标记");
	const rewrite = (line: string, key: string, value: string): string => {
		const cr = line.endsWith("\r") ? "\r" : "";
		const body = cr ? line.slice(0, -1) : line;
		const match = new RegExp(`^(${key})(\\s*:\\s*)(.*)$`).exec(body);
		if (!match) return line;
		const raw = match[3]!.trim();
		const next = raw.startsWith("\"") ? JSON.stringify(value) : raw.startsWith("'") ? `'${value}'` : value;
		return `${match[1]}${match[2]}${next}${cr}`;
	};
	let statusDone = false, updatedDone = false, occurredAtDone = patch.occurredAt === undefined, statusIndex = -1;
	for (let index = 1; index < end; index++) {
		const body = lines[index]!.replace(/\r$/, "");
		if (/^\s/.test(body)) continue;
		const key = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(body)?.[1];
		if (key === "status") { lines[index] = rewrite(lines[index]!, "status", patch.status); statusDone = true; statusIndex = index; }
		else if (key === "updated") { lines[index] = rewrite(lines[index]!, "updated", patch.updated); updatedDone = true; }
		else if (key === "occurredAt" && patch.occurredAt !== undefined) { lines[index] = rewrite(lines[index]!, "occurredAt", patch.occurredAt); occurredAtDone = true; }
	}
	if (!statusDone) throw new InteractionStatusError("invalid_input", "笔记缺少 status 字段，不支持状态标记");
	const cr = lines[statusIndex]!.endsWith("\r") ? "\r" : "";
	const inserts: string[] = [];
	if (!updatedDone) inserts.push(`updated: ${JSON.stringify(patch.updated)}${cr}`);
	if (!occurredAtDone) inserts.push(`occurredAt: ${JSON.stringify(patch.occurredAt)}${cr}`);
	if (inserts.length) lines.splice(statusIndex + 1, 0, ...inserts);
	return lines.join("\n");
}

/**
 * Direct, user-authorized status write: wiki note frontmatter surgery plus
 * one-hop calendar sync. Never creates an Agent review candidate; failures on
 * the linked side are reported, never rolled back. `source` breaks the
 * wiki ↔ calendar recursion so sync always travels exactly one hop.
 */
export async function setInteractionStatus(deps: InteractionStatusDeps, input: InteractionStatusInput, options?: { source?: "calendar" }): Promise<InteractionStatusResult> {
	if (!input || typeof input.bindingId !== "string" || !input.bindingId || typeof input.path !== "string" || !input.path ||
		(input.status !== "planned" && input.status !== "done" && input.status !== "cancelled")) {
		throw new InteractionStatusError("invalid_input", "需提供人脉库、笔记路径与目标状态（planned/done/cancelled）");
	}
	const occurredAt = input.occurredAt !== undefined ? normalizeOccurredAt(input.occurredAt) : undefined;
	const binding = await deps.bindings.requireUsable(input.ownerId, input.bindingId);
	const target = await resolveNoteAbsolutePath(binding, input.path);
	const bytes = await readNoteBytes(target);
	const content = bytes.toString("utf8");
	const fields = parseNoteFrontmatterFields(content);
	if (fields.type !== "interaction") throw new InteractionStatusError("invalid_input", "仅往来（interaction）笔记支持状态标记");
	const currentOccurredAt = typeof fields.occurredAt === "string" && fields.occurredAt ? normalizeOccurredAt(fields.occurredAt) : undefined;
	if (input.status === "done" && !occurredAt && !currentOccurredAt) {
		throw new InteractionStatusError("invalid_input", "标记已完成需要发生日期（occurredAt），请提供实际发生时间");
	}
	let changed = false, contentHash = hashBufferSha256(bytes);
	const occurredAtChanged = occurredAt !== undefined && occurredAt !== currentOccurredAt;
	if (fields.status !== input.status || occurredAtChanged) {
		const rewritten = rewriteInteractionFrontmatter(content, {
			status: input.status, updated: new Date().toISOString(),
			...(occurredAt !== undefined ? { occurredAt } : {}),
		});
		const written = await writeKnowledgeNote(deps.bindings, deps.observation, deps.acceptance, input.ownerId, input.bindingId,
			{ path: input.path, content: rewritten, expectedHash: contentHash });
		contentHash = written.note.contentHash;
		changed = true;
	}
	let calendarSync: CalendarSyncOutcome | undefined;
	const eventId = typeof fields.calendarEventId === "string" && fields.calendarEventId ? fields.calendarEventId : undefined;
	if (eventId && deps.calendar && options?.source !== "calendar") {
		const wanted = CALENDAR_STATUS[input.status];
		try {
			const current = await deps.calendar.get(input.ownerId, eventId);
			if (current.status === wanted) {
				calendarSync = { ok: true, eventId, status: wanted, changed: false };
			} else {
				try {
					await deps.calendar.setStatus(input.ownerId, eventId, `wiki-${randomUUID()}`, current.revision, wanted, { source: "wiki" });
					calendarSync = { ok: true, eventId, status: wanted, changed: true };
				} catch (error) {
					// A concurrent transition may have landed first; converge instead of failing.
					const latest = await deps.calendar.get(input.ownerId, eventId).catch(() => undefined);
					if ((error as { code?: unknown })?.code === "revision_conflict" && latest?.status === wanted) calendarSync = { ok: true, eventId, status: wanted, changed: true };
					else throw error;
				}
			}
		} catch (error) {
			calendarSync = { ok: false, eventId, error: error instanceof Error ? error.message : "日程状态同步失败" };
		}
	}
	return {
		note: { path: input.path, status: input.status, ...(occurredAt ?? currentOccurredAt ? { occurredAt: occurredAt ?? currentOccurredAt } : {}), contentHash },
		changed,
		...(calendarSync ? { calendarSync } : {}),
	};
}
