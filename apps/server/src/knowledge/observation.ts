import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import { hashBufferSha256, MAX_HASH_BYTES } from "./hashing.js";
import { parseNoteFrontmatter, parseNoteFrontmatterFields, type KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeReadError } from "./reader.js";
import { isControlDocument } from "./note-paths.js";
import type { KnowledgeObjectStore } from "./objects.js";
import type { PublishJournal } from "./wiki/publish-journal.js";
import type { KnowledgeSearchIndex } from "./search-index.js";
import { withKnowledgeMutation } from "./mutation-lock.js";

const MAX_TREE_ITEMS = 10_000;
const MAX_DEPTH = 32;
const RESCAN_INTERVAL_MS = 30_000;
const ignoredDirectories = new Set([".git", ".pudding", ".puddingclaw", "node_modules"]);

export type ObservedNoteState = "current" | "publishing" | "unreadable" | "missing";

export interface ObservedNoteFile {
	path: string;
	hash: string;
	size: number;
	state: ObservedNoteState;
	declaredId?: string;
	title?: string;
	/** 库根的契约 / 首页 / 日志：进文件树，但不算笔记、不可采纳。 */
	control?: boolean;
	/** 本行可供当前来源读取的固定快照身份；不可读或缺失页不提供。 */
	acceptanceId?: string;
}

export interface ObservationRecord {
	scannedAt: string;
	files: Map<string, ObservedNoteFile>;
	duplicates: Array<{ declaredId: string; paths: string[] }>;
}

export function withinKnowledgeRoot(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** 与 reader.checkedRoot 同款：内容根未漂移、绑定根 identity 未变。 */
export async function checkedKnowledgeRoot(binding: KnowledgeBinding): Promise<string> {
	const root = binding.contentRoot;
	const [actual, info, bindingInfo] = await Promise.all([
		realpath(root).catch(() => ""),
		stat(root).catch(() => null),
		stat(binding.canonicalBindingRoot).catch(() => null),
	]);
	if (actual !== root || !info?.isDirectory() || !bindingInfo ||
		`${bindingInfo.dev}:${bindingInfo.ino}` !== binding.rootIdentity ||
		!withinKnowledgeRoot(binding.canonicalBindingRoot, root)) {
		throw new KnowledgeReadError("root_changed", "知识库目录已变化，请重新核对绑定");
	}
	return root;
}

/** 与 reader 同款的路径校验：拒绝绝对路径、反斜杠、空段、.、.. 与隐藏段，必须 .md 结尾。 */
export function assertValidNoteRelativePath(relativePath: string): void {
	if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0") ||
		path.posix.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
		!relativePath.toLowerCase().endsWith(".md")) {
		throw new KnowledgeReadError("invalid_path", "笔记路径非法");
	}
}

/** 逐段 lstat 解析笔记绝对路径：不跟符号链接、必须在内容根内。 */
export async function resolveNoteAbsolutePath(binding: KnowledgeBinding, relativePath: string): Promise<string> {
	const root = await checkedKnowledgeRoot(binding);
	assertValidNoteRelativePath(relativePath);
	let current = root;
	const parts = relativePath.split("/");
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const info = await lstat(current).catch(() => null);
		if (!info || info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
			throw new KnowledgeReadError("not_found", "笔记不存在或路径不可读取");
		}
	}
	if (!withinKnowledgeRoot(root, current) || await realpath(current) !== current) {
		throw new KnowledgeReadError("invalid_path", "笔记路径越界");
	}
	return current;
}

/** O_NOFOLLOW 有界读取，读后复核 dev/ino/size。 */
export async function readNoteBytes(absolutePath: string): Promise<Buffer> {
	const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
		throw new KnowledgeReadError("not_found", "笔记不存在或路径不可读取");
	});
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new KnowledgeReadError("not_found", "笔记不是普通文件");
		if (before.size > MAX_HASH_BYTES) throw new KnowledgeReadError("too_large", "笔记超过 2 MiB 阅读上限");
		const buffer = Buffer.alloc(before.size + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_HASH_BYTES) throw new KnowledgeReadError("too_large", "笔记超过 2 MiB 阅读上限");
		const after = await handle.stat();
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytesRead || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
			throw new KnowledgeReadError("root_changed", "笔记读取期间已变化，请重试");
		}
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function walkNotePaths(root: string): Promise<Array<{ relative: string; absolute: string }>> {
	let items = 0;
	const result: Array<{ relative: string; absolute: string }> = [];
	const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH) throw new KnowledgeReadError("too_large", "知识库目录层级超过上限");
		for (const entry of await readdir(absolute, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name) || entry.isSymbolicLink()) { if (entry.isSymbolicLink()) throw new KnowledgeReadError("root_changed", "扫描遇到符号链接，未同步删除"); continue; }
			const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
			const nextAbsolute = path.join(absolute, entry.name);
			const info = await lstat(nextAbsolute).catch(() => null);
			if (!info || info.isSymbolicLink()) throw new KnowledgeReadError("root_changed", "扫描路径已变化，未同步删除，请重试");
			if (info.isDirectory()) {
				await walk(nextAbsolute, nextRelative, depth + 1);
			} else if (info.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				if (++items > MAX_TREE_ITEMS) throw new KnowledgeReadError("too_large", "知识库笔记数超过上限");
				result.push({ relative: nextRelative, absolute: nextAbsolute });
			}
		}
	};
	await walk(root, "", 0);
	return result;
}

/**
 * 外部观察自动冻结当前快照；未完成发布残留隔离，不作为外部编辑生效。
 * 状态：current / publishing / unreadable / missing。
 * 不做 fs.watch；startAll 周期重扫可用绑定。
 */
export class KnowledgeObservationService {
	private readonly records = new Map<string, ObservationRecord>();
	private timer?: NodeJS.Timeout;

	constructor(private readonly acceptance: KnowledgeAcceptanceStore, private readonly deps: {
		objects: Pick<KnowledgeObjectStore, "put">; journal?: Pick<PublishJournal, "protectedCandidateHashes">;
		searchIndex?: Pick<KnowledgeSearchIndex, "load">;
	}) {}

	get(bindingId: string): ObservationRecord | undefined { return this.records.get(bindingId); }
	setPublicationJournal(journal: Pick<PublishJournal, "protectedCandidateHashes">): void { this.deps.journal = journal; }

	async scan(binding: KnowledgeBinding): Promise<ObservationRecord> {
		return withKnowledgeMutation(binding.id, async () => {
			const root = await checkedKnowledgeRoot(binding), diskPaths = await walkNotePaths(root);
			const guarded = await this.deps.journal?.protectedCandidateHashes(binding.id) ?? new Map<string, Set<string>>();
			const disk = new Map<string, { bytes: Buffer; hash: string; size: number; diskIdentity: string; declaredId?: string; title?: string }>();
			const unreadable: string[] = [], protectedPaths: string[] = [];
			for (const file of diskPaths) {
				try {
					await resolveNoteAbsolutePath(binding, file.relative);
					const before = await lstat(file.absolute), bytes = await readNoteBytes(file.absolute), after = await lstat(file.absolute);
					if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs) throw new Error("file changed");
					await resolveNoteAbsolutePath(binding, file.relative);
					const frontmatter = parseNoteFrontmatter(bytes.toString("utf8"));
					disk.set(file.relative, { bytes, hash: hashBufferSha256(bytes), size: bytes.length,
						diskIdentity: `${after.dev}:${after.ino}`, ...(frontmatter.id ? { declaredId: frontmatter.id } : {}), ...(frontmatter.title ? { title: frontmatter.title } : {}) });
				} catch { unreadable.push(file.relative); }
			}
			const pathsById = new Map<string, string[]>();
			for (const [relative, data] of disk) if (guarded.get(relative)?.has(data.hash)) protectedPaths.push(relative);
			for (const [relative, data] of disk) if (data.declaredId && !isControlDocument(relative)) pathsById.set(data.declaredId, [...(pathsById.get(data.declaredId) ?? []), relative]);
			const prior = await this.acceptance.getSnapshot(binding.id);
			for (const entry of Object.values(prior.entries)) if ((unreadable.includes(entry.relativePath) || protectedPaths.includes(entry.relativePath)) && entry.noteIdentity.declaredNoteId && entry.noteIdentity.declaredNoteId !== disk.get(entry.relativePath)?.declaredId) {
				const id = entry.noteIdentity.declaredNoteId; pathsById.set(id, [...(pathsById.get(id) ?? []), entry.relativePath]);
			}
			const duplicates = [...pathsById.entries()].filter(([, paths]) => paths.length > 1).map(([declaredId, paths]) => ({ declaredId, paths: paths.sort() }));
			const duplicateIds = new Set(duplicates.map(entry => entry.declaredId));
			const items = [];
			for (const [relativePath, data] of disk) {
				if (protectedPaths.includes(relativePath)) continue;
				const snapshot = await this.deps.objects.put(data.bytes), fields = parseNoteFrontmatterFields(data.bytes.toString("utf8"));
				items.push({ relativePath, contentHash: data.hash, snapshotRef: snapshot.hash, acceptedBy: "platform-observer", diskIdentity: data.diskIdentity,
					...(!duplicateIds.has(data.declaredId ?? "") && data.declaredId ? { declaredNoteId: data.declaredId } : {}), ...(data.title ? { title: data.title } : {}),
					sourceIds: Array.isArray(fields.sources) ? fields.sources.filter((id): id is string => typeof id === "string") : [] });
			}
			await checkedKnowledgeRoot(binding);
			for (const [relative, data] of disk) if (hashBufferSha256(await readNoteBytes(await resolveNoteAbsolutePath(binding, relative))) !== data.hash) throw new KnowledgeReadError("root_changed", "外部文件在同步期间变化，请重试");
			await this.acceptance.syncExternal(binding.id, items, diskPaths.map(file => file.relative), protectedPaths, unreadable);
			const ledger = await this.acceptance.getSnapshot(binding.id), files = new Map<string, ObservedNoteFile>();
			for (const file of diskPaths) {
				const data = disk.get(file.relative), entry = [...Object.values(ledger.entries), ...Object.values(ledger.controlEntries ?? {})].find(entry => entry.relativePath === file.relative);
				files.set(file.relative, { path: file.relative, hash: data?.hash ?? entry?.contentHash ?? "", size: data?.size ?? 0,
					state: protectedPaths.includes(file.relative) ? "publishing" : unreadable.includes(file.relative) ? "unreadable" : "current",
					...(data?.declaredId && !duplicateIds.has(data.declaredId) ? { declaredId: data.declaredId } : {}), ...(data?.title ? { title: data.title } : {}),
					...(entry?.availability === "current" ? { acceptanceId: entry.acceptanceId } : {}), ...(isControlDocument(file.relative) ? { control: true } : {}) });
			}
			for (const entry of [...Object.values(ledger.entries), ...Object.values(ledger.controlEntries ?? {})]) if (entry.availability === "missing" && !files.has(entry.relativePath)) files.set(entry.relativePath,
				{ path: entry.relativePath, hash: entry.contentHash, size: 0, state: "missing", ...(isControlDocument(entry.relativePath) ? { control: true } : {}), ...(entry.title ? { title: entry.title } : {}) });
			await this.deps.searchIndex?.load(binding.id, ledger);
			const record = { scannedAt: new Date().toISOString(), files, duplicates };
			this.records.set(binding.id, record); return record;
		});
	}

	/** 服务启动时全量扫描可用绑定，并每 30s 周期重扫（unref，不阻止退出）。 */
	async startAll(registry: Pick<KnowledgeBindingRegistry, "list">, ownerId: string): Promise<void> {
		const rescan = async (): Promise<void> => {
			const bindings = await registry.list(ownerId).catch(() => [] as KnowledgeBinding[]);
			for (const binding of bindings) {
				if (binding.availability !== "available") continue;
				await this.scan(binding).catch(() => undefined);
			}
		};
		await rescan();
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => { void rescan(); }, RESCAN_INTERVAL_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
