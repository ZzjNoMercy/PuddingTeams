import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseNoteFrontmatter, type AcceptanceLedger } from "./acceptance.js";
import { parseNoteLinks, resolveMarkdownLinkTarget, resolveWikiLink } from "./links.js";
import { KnowledgeObjectStore } from "./objects.js";

export interface IndexedOutLink {
	kind: "wiki" | "md";
	raw: string;
	target: string;
	anchor?: string;
	resolvedPath?: string;
	context: string;
}

export interface IndexedNote {
	identityKey: string;
	path: string;
	declaredId?: string;
	title: string;
	headings: string[];
	text: string;
	outLinks: IndexedOutLink[];
	contentHash: string;
}

export interface KnowledgeBacklink {
	sourcePath: string;
	sourceTitle: string;
	kind: "wiki" | "md";
	snippet: string;
}

export interface BuiltKnowledgeIndex {
	bindingId: string;
	acceptanceRevision: number;
	notes: Map<string, IndexedNote>;
	notesByPath: Map<string, IndexedNote>;
	backlinks: Map<string, KnowledgeBacklink[]>;
	diagnostics: string[];
	fromCache: boolean;
}

interface IndexCacheFile {
	version: 1;
	bindingId: string;
	acceptanceRevision: number;
	entries: Array<[string, string]>;
	notes: Record<string, IndexedNote>;
}

/** 去掉 frontmatter 块后的正文。 */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
	const lines = content.split("\n");
	for (let index = 1; index < lines.length && index <= 100; index++) {
		if (lines[index]!.trim() === "---") return lines.slice(index + 1).join("\n");
	}
	return content;
}

function extractIndexedNote(identityKey: string, relativePath: string, declaredId: string | undefined, content: string, contentHash: string): IndexedNote {
	const frontmatter = parseNoteFrontmatter(content);
	const { wikiLinks, mdLinks, headings } = parseNoteLinks(content);
	const filename = path.posix.basename(relativePath).replace(/\.md$/i, "");
	const title = frontmatter.title ?? headings[0] ?? filename;
	const outLinks: IndexedOutLink[] = [
		...wikiLinks.map((link): IndexedOutLink => ({
			kind: "wiki", raw: link.raw, target: link.target,
			...(link.anchor ? { anchor: link.anchor } : {}), context: link.context,
		})),
		...mdLinks.map((link): IndexedOutLink => ({
			kind: "md", raw: link.raw, target: link.target,
			...(link.anchor ? { anchor: link.anchor } : {}), context: link.context,
		})),
	];
	return {
		identityKey, path: relativePath,
		...(declaredId ? { declaredId } : {}),
		title, headings, text: stripFrontmatter(content), outLinks, contentHash,
	};
}

function ledgerEntryList(ledger: AcceptanceLedger): Array<[string, string]> {
	return Object.entries(ledger.entries)
		.filter(([, entry]) => entry.availability === "current")
		.map(([key, entry]): [string, string] => [key, entry.contentHash])
		.sort(([a], [b]) => a.localeCompare(b));
}

function sameEntries(a: Array<[string, string]>, b: Array<[string, string]>): boolean {
	return a.length === b.length && a.every(([key, hash], index) => key === b[index]?.[0] && hash === b[index]?.[1]);
}

/**
 * 检索索引：只从账本（availability=current 条目）+ objects 快照构建，
 * 绝不读磁盘当前版（K09）。缓存 revision 与条目哈希清单完全匹配才复用。
 */
export class KnowledgeSearchIndex {
	constructor(private readonly cacheDir: string, private readonly objects: KnowledgeObjectStore) {}

	private fileFor(bindingId: string): string {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bindingId)) throw new Error("invalid binding id");
		return path.join(this.cacheDir, `${bindingId}-index.json`);
	}

	private async readCache(bindingId: string): Promise<IndexCacheFile | null> {
		const raw = await readFile(this.fileFor(bindingId), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (raw === null) return null;
		try {
			const parsed = JSON.parse(raw) as IndexCacheFile;
			if (parsed?.version !== 1 || parsed.bindingId !== bindingId || !Array.isArray(parsed.entries) || !parsed.notes) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	private async writeCache(data: IndexCacheFile): Promise<void> {
		await mkdir(this.cacheDir, { recursive: true });
		const file = this.fileFor(data.bindingId);
		const temp = `${file}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
		await rename(temp, file);
	}

	private assemble(bindingId: string, acceptanceRevision: number, noteList: IndexedNote[], diagnostics: string[], fromCache: boolean): BuiltKnowledgeIndex {
		const notes = new Map<string, IndexedNote>();
		const notesByPath = new Map<string, IndexedNote>();
		for (const note of noteList) {
			notes.set(note.identityKey, note);
			notesByPath.set(note.path, note);
		}
		const allPaths = [...notesByPath.keys()];
		for (const note of notes.values()) {
			for (const link of note.outLinks) {
				if (link.kind === "wiki") {
					const resolution = resolveWikiLink(allPaths, link.target);
					if (resolution.status === "ok") link.resolvedPath = resolution.path;
				} else {
					const resolved = resolveMarkdownLinkTarget(note.path, link.target);
					if (resolved) link.resolvedPath = resolved;
				}
			}
		}
		const backlinks = new Map<string, KnowledgeBacklink[]>();
		for (const note of notes.values()) {
			// 同一源笔记对同一目标的多次提及只计一条反链（保留首次出现的 snippet）。
			const seenTargets = new Set<string>();
			for (const link of note.outLinks) {
				if (!link.resolvedPath || seenTargets.has(link.resolvedPath)) continue;
				seenTargets.add(link.resolvedPath);
				const list = backlinks.get(link.resolvedPath) ?? [];
				list.push({ sourcePath: note.path, sourceTitle: note.title, kind: link.kind, snippet: link.context });
				backlinks.set(link.resolvedPath, list);
			}
		}
		return { bindingId, acceptanceRevision, notes, notesByPath, backlinks, diagnostics, fromCache };
	}

	async load(bindingId: string, ledger: AcceptanceLedger): Promise<BuiltKnowledgeIndex> {
		const wanted = ledgerEntryList(ledger);
		const cached = await this.readCache(bindingId);
		if (cached && cached.acceptanceRevision === ledger.acceptanceRevision && sameEntries(cached.entries, wanted)) {
			return this.assemble(bindingId, cached.acceptanceRevision, Object.values(cached.notes), [], true);
		}
		const diagnostics: string[] = [];
		const notes: IndexedNote[] = [];
		for (const [identityKey, entry] of Object.entries(ledger.entries)) {
			if (entry.availability !== "current") continue;
			const snapshot = await this.objects.get(entry.contentHash).catch(() => null);
			if (!snapshot) {
				diagnostics.push(`missing_snapshot:${identityKey}`);
				continue;
			}
			const declaredId = entry.noteIdentity.declaredNoteId;
			notes.push(extractIndexedNote(identityKey, entry.relativePath, declaredId, snapshot.toString("utf8"), entry.contentHash));
		}
		const cache: IndexCacheFile = {
			version: 1, bindingId, acceptanceRevision: ledger.acceptanceRevision, entries: wanted,
			notes: Object.fromEntries(notes.map((note) => [note.identityKey, note])),
		};
		await this.writeCache(cache).catch(() => undefined);
		return this.assemble(bindingId, ledger.acceptanceRevision, notes, diagnostics, false);
	}
}

export interface SearchHit {
	path: string;
	title: string;
	snippet: string;
	score: number;
}

function snippetAround(text: string, index: number, length: number): string {
	const from = Math.max(0, index - 60);
	const to = Math.min(text.length, index + length + 60);
	return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

/** 单词命中评分：title > path > heading > body。返回 null 表示未命中。 */
function locateTerm(note: IndexedNote, term: string): { snippet: string; score: number } | null {
	if (note.title.toLowerCase().includes(term)) return { snippet: note.title, score: 100 };
	if (note.path.toLowerCase().includes(term)) return { snippet: note.path, score: 60 };
	const heading = note.headings.find((entry) => entry.toLowerCase().includes(term));
	if (heading) return { snippet: heading, score: 40 };
	const at = note.text.toLowerCase().indexOf(term);
	if (at >= 0) return { snippet: snippetAround(note.text, at, term.length), score: 20 };
	return null;
}

/**
 * 字面检索：整串优先（连续短语给最高档），否则按空白分词做 OR 匹配——
 * 命中词越多、命中位置越靠 title 得分越高。snippet 取该笔记最高分的命中词。
 */
export function searchBuiltIndex(index: BuiltKnowledgeIndex, query: string, limit: number): { results: SearchHit[]; truncated: boolean } {
	const needle = query.toLowerCase().trim();
	const terms = needle.split(/\s+/).filter(Boolean);
	const hits: SearchHit[] = [];
	for (const note of index.notes.values()) {
		let hit: SearchHit | null = null;
		const phrase = terms.length > 1 ? locateTerm(note, needle) : null;
		if (phrase) {
			hit = { path: note.path, title: note.title, snippet: phrase.snippet, score: 1000 + phrase.score };
		} else {
			const matched = terms.map((term) => locateTerm(note, term)).filter((entry): entry is { snippet: string; score: number } => entry !== null);
			if (matched.length > 0) {
				const best = matched.reduce((a, b) => (b.score > a.score ? b : a));
				hit = { path: note.path, title: note.title, snippet: best.snippet, score: matched.reduce((sum, entry) => sum + entry.score, 0) };
			}
		}
		if (hit) hits.push(hit);
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return { results: hits.slice(0, limit), truncated: hits.length > limit };
}
