import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcceptedNoteVersion } from "./contracts.js";
import { isControlDocument } from "./note-paths.js";
import type { KnowledgeHistoryStore, NoteHistoryEvent } from "./history-store.js";

export class KnowledgeAcceptanceError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "stale_revision", message: string) {
		super(message);
	}
}

/** 账本条目在 wire 合约之外附带平台缓存的相对路径与标题（跳转/索引用）。 */
export interface StoredAcceptedNoteVersion extends AcceptedNoteVersion {
	diskIdentity?: string;
	noteId?: string;
	relativePath: string;
	title?: string;
}

export interface StoredAcceptedControlVersion extends StoredAcceptedNoteVersion {
	controlKind: "index" | "log";
}

export interface AcceptanceLedger {
	version: 1;
	bindingId: string;
	acceptanceRevision: number;
	entries: Record<string, StoredAcceptedNoteVersion>;
	/** Reviewed navigation/log snapshots are separate from notes and cannot be normal compile sources. */
	controlEntries?: Record<string, StoredAcceptedControlVersion>;
	historyOutbox?: NoteHistoryEvent[];
}

export interface AdoptNoteItem {
	diskIdentity?: string;
	summary?: string;
	sourceIds?: string[];
	relativePath: string;
	declaredNoteId?: string;
	title?: string;
	contentHash: string;
	snapshotRef: string;
	acceptedBy: string;
}

export interface AcceptanceHistoryContext {
	operationId?: string; channel?: NoteHistoryEvent["channel"]; batchId?: string; batchRevision?: number; decisionId?: string;
}

export interface AdoptedNote {
	path: string;
	identityKey: string;
	contentHash: string;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function noteIdentityKey(identity: { declaredNoteId?: string; normalizedRelativePath: string }): string {
	return identity.declaredNoteId ? `id:${identity.declaredNoteId}` : `path:${identity.normalizedRelativePath}`;
}

/** 最小 frontmatter 解析：仅当内容以 --- 行开头，扫描到下一个 --- 行，行级提取 id: 与 title:（去引号 trim）。 */
export function parseNoteFrontmatter(content: string): { id?: string; title?: string } {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return {};
	const lines = content.split("\n");
	const result: { id?: string; title?: string } = {};
	for (let index = 1; index < lines.length && index <= 100; index++) {
		const line = lines[index]!.replace(/\r$/, "");
		if (line.trim() === "---") return result;
		const match = /^(id|title)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1] as "id" | "title";
		if (result[key] !== undefined) continue;
		let value = match[2]!.trim();
		if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
			value = value.slice(1, -1).trim();
		}
		if (value) result[key] = value;
	}
	return {};
}

/**
 * 通用 frontmatter 字段提取（影响预览/结构校验用）：标量去引号、
 * 支持 `[a, b]` 行内列表与 `- item` 缩进列表；值一律按字符串处理，
 * 未知字段原样保留在结果中，不做任何丢弃。
 */
export function parseNoteFrontmatterFields(content: string): Record<string, unknown> {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return {};
	const lines = content.split("\n");
	const fields: Record<string, unknown> = {};
	const seen = new Set<string>();
	let listKey: string | undefined;
	for (let index = 1; index < lines.length && index <= 200; index++) {
		const line = lines[index]!.replace(/\r$/, "");
		if (line.trim() === "---") return fields;
		const listItem = /^\s*-\s+(.*)$/.exec(line);
		if (listItem && listKey) {
			const existing = fields[listKey];
			const list = Array.isArray(existing) ? existing : [];
			list.push(unquote(listItem[1]!.trim()));
			fields[listKey] = list;
			continue;
		}
		const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (!match || seen.has(match[1]!)) {
			listKey = undefined;
			continue;
		}
		const key = match[1]!;
		seen.add(key);
		const raw = match[2]!.trim();
		if (raw === "") {
			listKey = key;
			continue;
		}
		listKey = undefined;
		if (raw.startsWith("[") && raw.endsWith("]")) {
			fields[key] = raw.slice(1, -1).split(",").map((item) => unquote(item.trim())).filter((item) => item.length > 0);
		} else {
			fields[key] = unquote(raw);
		}
	}
	return fields;
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1).trim();
	}
	return value;
}

/**
 * 采纳账本：每绑定一个 JSON 文件（信封 version:1），identityKey =
 * id:<declaredNoteId> 或 path:<normalizedRelativePath>。写路径按绑定串行，
 * tmp + rename 原子替换（与 bindings.json 同款）。
 */
export class KnowledgeAcceptanceStore {
	private readonly pending = new Map<string, Promise<void>>();
	private readonly cache = new Map<string, AcceptanceLedger>();

	constructor(private readonly directory: string, private readonly history?: KnowledgeHistoryStore) {}

	private async flushLedgerHistory(bindingId: string, ledger: AcceptanceLedger): Promise<void> {
		if (!this.history || !ledger.historyOutbox?.length) return;
		await this.history.append(ledger.historyOutbox);
		const clean = { ...ledger, historyOutbox: [] }; await this.save(bindingId, clean); this.cache.set(bindingId, clean);
	}
	async flushHistory(bindingId: string): Promise<void> { await this.serial(bindingId, async () => this.flushLedgerHistory(bindingId, await this.load(bindingId))); }
	async recoverHistory(): Promise<void> {
		const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
		for (const file of files.filter((file) => file.endsWith(".json"))) await this.flushHistory(file.slice(0, -5));
	}

	private fileFor(bindingId: string): string {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bindingId)) {
			throw new KnowledgeAcceptanceError("invalid_input", "绑定标识非法");
		}
		return path.join(this.directory, `${bindingId}.json`);
	}

	private async load(bindingId: string): Promise<AcceptanceLedger> {
		const cached = this.cache.get(bindingId);
		if (cached) return cached;
		const raw = await readFile(this.fileFor(bindingId), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		let ledger: AcceptanceLedger;
		if (raw === null) {
			ledger = { version: 1, bindingId, acceptanceRevision: 0, entries: {} };
		} else {
			const parsed: unknown = JSON.parse(raw);
			const candidate = parsed as AcceptanceLedger;
			if (!candidate || typeof candidate !== "object" || candidate.version !== 1 || candidate.bindingId !== bindingId ||
				!Number.isSafeInteger(candidate.acceptanceRevision) || candidate.acceptanceRevision < 0 ||
				!candidate.entries || typeof candidate.entries !== "object") {
				throw new Error("invalid knowledge acceptance ledger");
			}
			ledger = candidate;
		}
		this.cache.set(bindingId, ledger);
		return ledger;
	}

	private async save(bindingId: string, ledger: AcceptanceLedger): Promise<void> {
		await mkdir(this.directory, { recursive: true });
		const file = this.fileFor(bindingId);
		const temp = `${file}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, file);
	}

	private serial<T>(bindingId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.pending.get(bindingId) ?? Promise.resolve();
		const result = previous.then(action);
		this.pending.set(bindingId, result.then(() => undefined, () => undefined));
		return result;
	}

	/** Detached snapshot: callers cannot mutate acceptance or its durable outbox. */
	async getSnapshot(bindingId: string): Promise<AcceptanceLedger> {
		const ledger = structuredClone(await this.load(bindingId));
		return Object.freeze({ ...ledger, entries: Object.freeze({ ...ledger.entries }),
			controlEntries: Object.freeze({ ...ledger.controlEntries }) });
	}

	async adopt(bindingId: string, items: AdoptNoteItem[], expectedRevision: number, context: AcceptanceHistoryContext = {}): Promise<{ acceptanceRevision: number; adopted: AdoptedNote[] }> {
		return this.adoptBatch(bindingId, items, expectedRevision, false, context);
	}

	/** Publisher-only: commit notes and reviewed index/log snapshots in one ledger revision. */
	async adoptPublished(bindingId: string, items: AdoptNoteItem[], expectedRevision: number, context: AcceptanceHistoryContext = {}): Promise<{ acceptanceRevision: number; adopted: AdoptedNote[] }> {
		return this.adoptBatch(bindingId, items, expectedRevision, true, context);
	}

	/** Replace current external observations atomically; this is never a human approval. */
	async syncExternal(bindingId: string, items: AdoptNoteItem[], presentPaths: string[], protectedPaths: string[], unreadablePaths: string[]): Promise<void> {
		await this.serial(bindingId, async () => {
			const prior = await this.load(bindingId), ledger = structuredClone(prior);
			ledger.controlEntries ??= {}; ledger.historyOutbox ??= [];
			const allPrior = [...Object.values(prior.entries), ...Object.values(prior.controlEntries ?? {})];
			const retained = new Set([...protectedPaths, ...unreadablePaths]), present = new Set(presentPaths), claimed = new Set<string>();
			const entries: typeof ledger.entries = {}, controls: NonNullable<typeof ledger.controlEntries> = {};
			let changed = false; const observedAt = new Date().toISOString();
			for (const item of items) {
				const control = isControlDocument(item.relativePath);
				if (control && !["index.md", "log.md"].includes(path.posix.basename(item.relativePath).toLowerCase())) continue;
				const key = control ? `path:${item.relativePath}` : noteIdentityKey({ declaredNoteId: item.declaredNoteId, normalizedRelativePath: item.relativePath });
				let previous = allPrior.find(entry => entry.relativePath === item.relativePath && !claimed.has(entry.acceptanceId));
				if (!previous && !control) {
					const candidates = allPrior.filter(entry => !isControlDocument(entry.relativePath) && !present.has(entry.relativePath) && !retained.has(entry.relativePath) && !claimed.has(entry.acceptanceId) &&
						((item.declaredNoteId && entry.noteIdentity.declaredNoteId === item.declaredNoteId) || (item.diskIdentity && entry.diskIdentity === item.diskIdentity)));
					if (candidates.length === 1) previous = candidates[0];
					if (!previous) {
						const byHash = allPrior.filter(entry => !isControlDocument(entry.relativePath) && !present.has(entry.relativePath) && !retained.has(entry.relativePath) && !claimed.has(entry.acceptanceId) && entry.contentHash === item.contentHash);
						if (byHash.length === 1 && items.filter(other => other.contentHash === item.contentHash).length === 1) previous = byHash[0];
					}
				}
				if (previous) claimed.add(previous.acceptanceId);
				const identity = item.declaredNoteId && !control ? { bindingId, declaredNoteId: item.declaredNoteId } : { bindingId, normalizedRelativePath: item.relativePath };
				const same = previous?.availability === "current" && previous.contentHash === item.contentHash && previous.relativePath === item.relativePath && JSON.stringify(previous.noteIdentity) === JSON.stringify(identity);
				const record: StoredAcceptedNoteVersion = same ? { ...previous!, diskIdentity: item.diskIdentity } : {
					noteId: previous?.noteId ?? randomUUID(), noteIdentity: identity, relativePath: item.relativePath, title: item.title,
					contentHash: item.contentHash, snapshotRef: item.snapshotRef, acceptedBy: "platform-observer", acceptedAt: observedAt,
					acceptanceId: randomUUID(), sourceRefs: item.sourceIds ?? [], availability: "current", diskIdentity: item.diskIdentity,
				};
				if (!same) {
					changed = true;
					if (!control) ledger.historyOutbox.push({ id: record.acceptanceId, bindingId, noteId: record.noteId!, relativePath: record.relativePath,
						...(previous ? { previousPath: previous.relativePath, previousHash: previous.contentHash, previousSnapshotRef: previous.snapshotRef } : {}),
						contentHash: record.contentHash, snapshotRef: record.snapshotRef, actorId: "platform-observer", channel: "external_sync",
						changeKind: !previous ? "create" : previous.relativePath !== record.relativePath ? "rename" : "update", acceptedAt: observedAt,
						operationId: record.acceptanceId, summary: "平台观察外部文件变化（非人工确认）", sourceIds: record.sourceRefs });
				}
				if (control) {
					if (["index.md", "log.md"].includes(path.posix.basename(item.relativePath).toLowerCase())) controls[key] = { ...record, controlKind: path.posix.basename(item.relativePath).toLowerCase() === "index.md" ? "index" : "log" };
				} else entries[key] = record;
			}
			for (const [key, entry] of Object.entries({ ...prior.entries, ...prior.controlEntries })) {
				if (claimed.has(entry.acceptanceId)) continue;
				const control = isControlDocument(entry.relativePath), target = control ? controls : entries;
				// A newly unique declared id may have moved to a different current page.
				// Keep the old path's tombstone without replacing that current identity.
				const retainedKey = target[key] && target[key]!.relativePath !== entry.relativePath ? `path:${entry.relativePath}` : key;
				const retainedEntry = retainedKey === key ? entry : { ...entry, noteIdentity: { bindingId, normalizedRelativePath: entry.relativePath } };
				if (protectedPaths.includes(entry.relativePath)) target[retainedKey] = retainedEntry as StoredAcceptedControlVersion;
				else if (unreadablePaths.includes(entry.relativePath)) {
					target[retainedKey] = { ...retainedEntry, availability: "changed" } as StoredAcceptedControlVersion;
					if (entry.availability === "current") changed = true;
				} else if (!present.has(entry.relativePath)) {
					if (entry.availability !== "missing" && entry.availability !== "revoked") {
						changed = true;
						if (!control) { const id = randomUUID(); ledger.historyOutbox.push({ id, bindingId, noteId: entry.noteId!, relativePath: entry.relativePath, contentHash: entry.contentHash, snapshotRef: entry.snapshotRef, previousHash: entry.contentHash, previousSnapshotRef: entry.snapshotRef,
							actorId: "platform-observer", channel: "external_sync", changeKind: "delete", deleted: true, acceptedAt: observedAt, operationId: id, summary: "平台观察到文件已删除（非人工确认）", sourceIds: entry.sourceRefs }); }
					}
					target[retainedKey] = { ...retainedEntry, availability: "missing" } as StoredAcceptedControlVersion;
				}
			}
			ledger.entries = entries; ledger.controlEntries = controls;
			if (changed) ledger.acceptanceRevision += 1;
			await this.save(bindingId, ledger); this.cache.set(bindingId, ledger);
			await this.flushLedgerHistory(bindingId, ledger).catch(() => undefined);
		});
	}

	private async adoptBatch(bindingId: string, items: AdoptNoteItem[], expectedRevision: number, published: boolean, context: AcceptanceHistoryContext): Promise<{ acceptanceRevision: number; adopted: AdoptedNote[] }> {
		if (!Array.isArray(items) || items.length === 0) throw new KnowledgeAcceptanceError("invalid_input", "采纳列表不能为空");
		for (const item of items) {
			if (!item.relativePath || !HASH_PATTERN.test(item.contentHash) || !HASH_PATTERN.test(item.snapshotRef)) {
				throw new KnowledgeAcceptanceError("invalid_input", "采纳条目缺少路径或哈希");
			}
			// 普通采纳拒绝控制文档；已审核发布的 index/log 独立入 controlEntries，仍不得当笔记来源。
			if (isControlDocument(item.relativePath) && (!published || !["index.md", "log.md"].includes(path.posix.basename(item.relativePath).toLowerCase()))) {
				throw new KnowledgeAcceptanceError("invalid_input", "操作契约、首页与日志不是笔记，不能采纳");
			}
		}
		return this.serial(bindingId, async () => {
			const current = await this.load(bindingId);
			const ledger: AcceptanceLedger = { ...current, entries: { ...current.entries }, controlEntries: { ...current.controlEntries }, historyOutbox: [...(current.historyOutbox ?? [])] };
			if (ledger.acceptanceRevision !== expectedRevision) {
				throw new KnowledgeAcceptanceError("stale_revision", "采纳修订号已变化，请刷新后重试");
			}
			const acceptedAt = new Date().toISOString();
			const adopted: AdoptedNote[] = [];
			for (const item of items) {
				const control = isControlDocument(item.relativePath);
				const identityKey = control ? `path:${item.relativePath}` : noteIdentityKey({ declaredNoteId: item.declaredNoteId, normalizedRelativePath: item.relativePath });
				const entries = control ? ledger.controlEntries! : ledger.entries;
				const previous = entries[identityKey] ?? Object.values(entries).find((entry) => entry.relativePath === item.relativePath);
				// 同一路径的身份键发生变化（新增/移除 frontmatter id）时，旧键条目被替换。
				for (const [key, entry] of Object.entries(entries)) {
					if (key !== identityKey && entry.relativePath === item.relativePath) delete entries[key];
				}
				const noteIdentity = !control && item.declaredNoteId
					? { bindingId, declaredNoteId: item.declaredNoteId }
					: { bindingId, normalizedRelativePath: item.relativePath };
				const record: StoredAcceptedNoteVersion = {
					noteId: previous?.noteId ?? randomUUID(),
					noteIdentity,
					relativePath: item.relativePath,
					...(item.title ? { title: item.title } : {}),
					contentHash: item.contentHash,
					snapshotRef: item.snapshotRef,
					acceptedBy: item.acceptedBy,
					acceptedAt,
					acceptanceId: randomUUID(),
					sourceRefs: item.sourceIds ?? (previous?.contentHash === item.contentHash ? previous.sourceRefs : []),
					availability: "current",
				};
				// Explicit adoption renews acceptance authority even for identical bytes.
				// Only a changed effective page version belongs in history.
				if (!previous || previous.contentHash !== record.contentHash || previous.relativePath !== record.relativePath) ledger.historyOutbox!.push({ id: record.acceptanceId, bindingId, noteId: record.noteId!, relativePath: record.relativePath,
					...(previous ? { previousPath: previous.relativePath, previousHash: previous.contentHash, previousSnapshotRef: previous.snapshotRef } : {}),
					contentHash: record.contentHash, snapshotRef: record.snapshotRef, actorId: item.acceptedBy,
					channel: context.channel ?? "initial", acceptedAt, operationId: context.operationId ?? record.acceptanceId,
					...(context.batchId ? { batchId: context.batchId, batchRevision: context.batchRevision, decisionId: context.decisionId } : {}),
					summary: item.summary ?? "内部初始化快照", sourceIds: record.sourceRefs });
				if (control) ledger.controlEntries![identityKey] = { ...record, controlKind: path.posix.basename(item.relativePath).toLowerCase() === "index.md" ? "index" : "log" };
				else entries[identityKey] = record;
				adopted.push({ path: item.relativePath, identityKey, contentHash: item.contentHash });
			}
			ledger.acceptanceRevision += 1;
			await this.save(bindingId, ledger);
			this.cache.set(bindingId, ledger);
			// The acceptance and its recovery outbox are already atomically durable.
			// Projection failures leave the outbox for startup/query repair.
			await this.flushLedgerHistory(bindingId, ledger).catch(() => undefined);
			return { acceptanceRevision: ledger.acceptanceRevision, adopted };
		});
	}

	/** 内部用：按键移除条目并推进修订号（索引缓存随之失效）。 */
	async removeEntries(bindingId: string, identityKeys: string[]): Promise<void> {
		await this.serial(bindingId, async () => {
			const ledger = await this.load(bindingId);
			let changed = false;
			for (const key of identityKeys) {
				if (key in ledger.entries) {
					delete ledger.entries[key];
					changed = true;
				}
			}
			if (changed) {
				ledger.acceptanceRevision += 1;
				await this.save(bindingId, ledger);
			}
		});
	}
}
