import path from "node:path";

export interface ParsedWikiLink {
	kind: "wiki";
	/** 原始 [[...]] 内部文本（不含括号），用于回显与 snippet 匹配。 */
	raw: string;
	/** 去掉锚点与别名后的目标。 */
	target: string;
	alias?: string;
	anchor?: string;
	/** 链接所在源行（裁剪后），反链 snippet 用。 */
	context: string;
}

export interface ParsedMarkdownLink {
	kind: "md";
	raw: string;
	target: string;
	text: string;
	anchor?: string;
	context: string;
}

export interface ParsedNoteLinks {
	wikiLinks: ParsedWikiLink[];
	mdLinks: ParsedMarkdownLink[];
	headings: string[];
}

const WIKI_LINK_PATTERN = /\[\[([^\[\]]+)\]\]/g;
const MD_LINK_PATTERN = /!?\[([^\]]*)\]\(([^)]+)\)/g;
const SKIPPED_MD_SCHEMES = /^(https?:|mailto:|#|\/|[A-Za-z]:[\\/])/i;

/** 去掉行内 code 反引号与首尾空白后的行文本（snippet 上限 200 字符）。 */
function contextOf(line: string): string {
	return line.trim().slice(0, 200);
}

/** 解析 wiki 链接 `[[target]]`/`[[target|alias]]`/`[[target#anchor]]`/`[[target#^block]]`。 */
export function splitWikiLinkTarget(inner: string): { target: string; alias?: string; anchor?: string } {
	const pipeIndex = inner.indexOf("|");
	const head = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
	const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() || undefined : undefined;
	const hashIndex = head.indexOf("#");
	const target = (hashIndex >= 0 ? head.slice(0, hashIndex) : head).trim();
	const anchor = hashIndex >= 0 ? head.slice(hashIndex + 1).trim() || undefined : undefined;
	return { target, ...(alias ? { alias } : {}), ...(anchor ? { anchor } : {}) };
}

/** 从 Markdown 文本解析 wiki 链接、行内 md 相对链接与标题锚点。 */
export function parseNoteLinks(content: string): ParsedNoteLinks {
	const wikiLinks: ParsedWikiLink[] = [];
	const mdLinks: ParsedMarkdownLink[] = [];
	const headings: string[] = [];
	for (const line of content.split("\n")) {
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.replace(/\r$/, ""));
		if (heading) headings.push(heading[2]!.trim());
		WIKI_LINK_PATTERN.lastIndex = 0;
		for (let match = WIKI_LINK_PATTERN.exec(line); match; match = WIKI_LINK_PATTERN.exec(line)) {
			const inner = match[1]!;
			const { target, alias, anchor } = splitWikiLinkTarget(inner);
			if (!target) continue;
			wikiLinks.push({ kind: "wiki", raw: inner, target, ...(alias ? { alias } : {}), ...(anchor ? { anchor } : {}), context: contextOf(line) });
		}
		MD_LINK_PATTERN.lastIndex = 0;
		for (let match = MD_LINK_PATTERN.exec(line); match; match = MD_LINK_PATTERN.exec(line)) {
			if (match[0]!.startsWith("!")) continue; // 图片走 asset，不是笔记链接
			let target = match[2]!.trim();
			const titleSplit = /\s+"[^"]*"$/.exec(target);
			if (titleSplit) target = target.slice(0, titleSplit.index).trim();
			if (!target || SKIPPED_MD_SCHEMES.test(target)) continue;
			let anchor: string | undefined;
			const hashIndex = target.indexOf("#");
			if (hashIndex >= 0) {
				anchor = target.slice(hashIndex + 1) || undefined;
				target = target.slice(0, hashIndex);
			}
			mdLinks.push({ kind: "md", raw: match[0]!, target, text: match[1]!, ...(anchor ? { anchor } : {}), context: contextOf(line) });
		}
	}
	return { wikiLinks, mdLinks, headings };
}

export type WikiLinkResolution =
	| { status: "ok"; path: string }
	| { status: "ambiguous"; candidates: string[] }
	| { status: "broken" };

function stripMarkdownSuffix(relativePath: string): string {
	return relativePath.toLowerCase().endsWith(".md") ? relativePath.slice(0, -3) : relativePath;
}

/**
 * wiki 链接解析：去 .md 后缀、规范化分隔符后先精确路径匹配，再 basename 匹配；
 * 0 个 broken、1 个 ok、多个 ambiguous。候选全集由调用方给定（磁盘当前文件清单）。
 */
export function resolveWikiLink(allPaths: string[], rawTarget: string): WikiLinkResolution {
	const normalized = stripMarkdownSuffix(rawTarget.replace(/\\/g, "/").replace(/^\/+/, "").trim());
	if (!normalized) return { status: "broken" };
	const byPath = new Map(allPaths.map((entry) => [stripMarkdownSuffix(entry), entry]));
	const exact = byPath.get(normalized);
	if (exact) return { status: "ok", path: exact };
	const wantedBase = path.posix.basename(normalized);
	const byBase = allPaths.filter((entry) => path.posix.basename(stripMarkdownSuffix(entry)) === wantedBase);
	if (byBase.length === 1) return { status: "ok", path: byBase[0]! };
	if (byBase.length > 1) return { status: "ambiguous", candidates: byBase.sort() };
	return { status: "broken" };
}

/** md 相对链接：相对 from 所在目录规范化；绝对路径或越出库根（.. 逃逸）返回 null。 */
export function resolveMarkdownLinkTarget(fromRelativePath: string, rawTarget: string): string | null {
	if (!rawTarget || rawTarget.includes("\0") || path.posix.isAbsolute(rawTarget) || /^[A-Za-z]:[\\/]/.test(rawTarget)) return null;
	const base = path.posix.dirname(fromRelativePath);
	const resolved = path.posix.normalize(path.posix.join(base, rawTarget));
	if (resolved === ".." || resolved.startsWith("../")) return null;
	return resolved;
}
