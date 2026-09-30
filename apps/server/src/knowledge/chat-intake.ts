import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StoredUpload } from "../store/uploads.js";
import type { KnowledgeSourceStore } from "./sources.js";

export interface ChatSourceRefs { operationId: string; sourceIds: string[]; }
interface Intake extends ChatSourceRefs { ownerId: string; sessionId: string; requestHash: string; userEntryId?: string; unsupportedNames: string[]; }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const textOf = (content: unknown): string => Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : typeof content === "string" ? content : "";

/** Host-only intake. Model text and disk paths are never interpreted as sources. */
export class ChatKnowledgeIntake {
	private readonly armed = new Map<string, { refs: ChatSourceRefs; prompt: string; priorUserIds: Set<string>; images: string[] }>();
	constructor(private readonly deps: { stateDir: string; sources: KnowledgeSourceStore }) {}
	private async database<T>(action: (db: DatabaseSync) => T): Promise<T> {
		await mkdir(this.deps.stateDir, { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(path.join(this.deps.stateDir, "chat-knowledge-intakes.sqlite"));
		try { db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS intakes (operation_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)"); return action(db); }
		finally { db.close(); }
	}
	private async get(operationId: string): Promise<Intake | undefined> {
		return this.database((db) => { const row = db.prepare("SELECT record_json FROM intakes WHERE operation_id=?").get(operationId) as { record_json: string } | undefined; return row && JSON.parse(row.record_json) as Intake; });
	}
	async prepare(input: { ownerId: string; sessionId: string; windowId: string; operationId: string; text: string; uploads: StoredUpload[] }): Promise<ChatSourceRefs> {
		const supported = input.uploads.filter((upload) => /^(text\/(plain|markdown)|image\/(png|jpeg|gif|webp)|application\/pdf)(;|$)/i.test(upload.mediaType) || /\.(md|txt|png|jpe?g|gif|webp|pdf)$/i.test(upload.name));
		const unsupportedNames = input.uploads.filter((upload) => !supported.includes(upload)).map((upload) => upload.name);
		const requestHash = hash(JSON.stringify([input.ownerId, input.sessionId, input.windowId, input.text, input.uploads.map((upload) => [upload.name, upload.mediaType, hash(upload.base64)])]));
		const previous = await this.get(input.operationId);
		if (previous) { if (previous.requestHash !== requestHash) throw new Error("消息素材 operationId 冲突"); return { operationId: previous.operationId, sourceIds: previous.sourceIds }; }
		const origin = { sessionId: input.sessionId, windowId: input.windowId, channel: "user_input" as const };
		const sources = input.text.trim() ? [await this.deps.sources.createText(input.ownerId, input.text, origin)] : [];
		// Use validated UploadStore bytes, never its filesystem path.
		sources.push(...await this.deps.sources.createUploads(input.ownerId, supported.map((upload) => ({ filename: upload.name, mediaType: upload.mediaType, data: upload.base64 })), origin));
		const record: Intake = { ownerId: input.ownerId, sessionId: input.sessionId, operationId: input.operationId, sourceIds: sources.map((source) => source.id), requestHash, unsupportedNames };
		return this.database((db) => {
			db.prepare("INSERT OR IGNORE INTO intakes VALUES (?,?)").run(input.operationId, JSON.stringify(record));
			const saved = JSON.parse((db.prepare("SELECT record_json FROM intakes WHERE operation_id=?").get(input.operationId) as { record_json: string }).record_json) as Intake;
			if (saved.requestHash !== requestHash) throw new Error("消息素材 operationId 冲突");
			return { operationId: saved.operationId, sourceIds: saved.sourceIds };
		});
	}
	armManager(session: AgentSession, refs: ChatSourceRefs, prompt: string, uploads: StoredUpload[]): (() => void) & { executionText(): string } {
		if (this.armed.has(session.sessionId)) throw new Error("本会话已有消息正在准入");
		const pending = { refs, prompt, priorUserIds: new Set(session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => entry.id)), images: uploads.filter((item) => item.mediaType.startsWith("image/")).map((item) => hash(item.base64)) };
		this.armed.set(session.sessionId, pending);
		return Object.assign(() => { if (this.armed.get(session.sessionId) === pending) this.armed.delete(session.sessionId); }, { executionText: () => pending.prompt });
	}
	/** SDK input/skill/template expansion is execution context, never new facts. */
	observeExecution(sessionId: string, prompt: string, images: readonly { data: string }[] = []): void {
		const pending = this.armed.get(sessionId); if (!pending) return;
		pending.prompt = prompt; pending.images = images.map((image) => hash(image.data));
	}
	private durableEntry(session: AgentSession, entryId: string): void {
		if (!session.sessionFile) throw new Error("聊天素材对应消息未落盘");
		const actual = session.sessionManager.getBranch().find((entry) => entry.id === entryId);
		const descriptor = openSync(session.sessionFile, "r");
		try { fsyncSync(descriptor); if (!actual || !readFileSync(session.sessionFile, "utf8").split("\n").some((line) => { try { return JSON.stringify(JSON.parse(line)) === JSON.stringify(actual); } catch { return false; } })) throw new Error("聊天素材对应消息未落盘"); }
		finally { closeSync(descriptor); }
	}
	private async bind(session: AgentSession, refs: ChatSourceRefs, entryId: string): Promise<void> {
		this.durableEntry(session, entryId);
		await this.database((db) => {
			const row = db.prepare("SELECT record_json FROM intakes WHERE operation_id=?").get(refs.operationId) as { record_json: string } | undefined;
			const record = row && JSON.parse(row.record_json) as Intake | undefined;
			if (!record || record.sessionId !== session.sessionId || JSON.stringify(record.sourceIds) !== JSON.stringify(refs.sourceIds) || (record.userEntryId && record.userEntryId !== entryId)) throw new Error("消息素材关联无效");
			record.userEntryId = entryId; db.prepare("UPDATE intakes SET record_json=? WHERE operation_id=?").run(JSON.stringify(record), refs.operationId);
		});
	}
	/** Runs in the real stream fence, after SDK user persistence, before provider I/O. */
	async admitManager(session: AgentSession): Promise<void> {
		const pending = this.armed.get(session.sessionId); if (!pending) return;
		const entry = [...session.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
		if (entry?.type !== "message" || entry.message.role !== "user" || pending.priorUserIds.has(entry.id) || textOf(entry.message.content) !== pending.prompt) throw new Error("本轮用户消息与聊天素材不匹配");
		const images = Array.isArray(entry.message.content) ? entry.message.content.filter((block) => block.type === "image").map((block) => hash(block.data)) : [];
		if (JSON.stringify(images) !== JSON.stringify(pending.images)) throw new Error("本轮用户附件与聊天素材不匹配");
		await this.bind(session, pending.refs, entry.id);
	}
	async admitDirect(session: AgentSession, refs: ChatSourceRefs): Promise<void> {
		const entries = session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pudding:user_message" && (entry.details as { operationId?: string; sourceRefs?: ChatSourceRefs } | undefined)?.operationId === refs.operationId &&
			JSON.stringify((entry.details as { sourceRefs?: ChatSourceRefs }).sourceRefs) === JSON.stringify(refs));
		if (entries.length !== 1) throw new Error("direct 用户消息素材关联不唯一");
		await this.bind(session, refs, entries[0]!.id);
	}
	async resolve(session: AgentSession, ownerId: string, selector: { operationId?: string; toolCallId?: string }): Promise<ChatSourceRefs> {
		const branch = session.sessionManager.getBranch();
		let entryId: string | undefined;
		if (selector.operationId) {
			const entries = branch.filter((entry) => entry.type === "custom_message" && entry.customType === "pudding:user_message" && (entry.details as ChatSourceRefs | undefined)?.operationId === selector.operationId);
			if (entries.length === 1) entryId = entries[0]!.id;
		} else if (selector.toolCallId) {
			const matches = branch.flatMap((entry, index) => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.filter((block) => block.type === "toolCall" && block.id === selector.toolCallId).map(() => index) : []);
			if (matches.length !== 1) throw new Error("本轮工具调用与用户素材关联缺失或不唯一");
			entryId = branch.slice(0, matches[0]!).reverse().find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
		}
		if (!entryId) throw new Error("本轮没有获准的用户素材，请从聊天重新提交");
		const record = await this.database((db) => (db.prepare("SELECT record_json FROM intakes").all() as { record_json: string }[]).map((row) => JSON.parse(row.record_json) as Intake).find((record) => record.userEntryId === entryId && record.sessionId === session.sessionId && record.ownerId === ownerId));
		if (!record) throw new Error("本轮没有可整理的用户素材");
		if (record.unsupportedNames.length) throw new Error(`附件尚不支持知识整理：${record.unsupportedNames.join("、")}；请提供 Markdown、文字、图片或 PDF。`);
		if (!record.sourceIds.length) throw new Error("本轮没有可整理的用户素材");
		return { operationId: record.operationId, sourceIds: [...record.sourceIds] };
	}
}
