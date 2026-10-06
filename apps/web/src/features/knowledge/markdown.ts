/**
 * 知识库 Markdown 阅读层的纯函数：frontmatter 拆分、[[wiki 链接]] 改写、
 * 标题 slug、相对资源路径解析。渲染组件见 note-markdown.tsx。
 */

import { parseDocument } from "yaml";

/** 渲染层用带哨兵的 href 承载 wiki 链接目标，a 组件据此接管点击。 */
export const WIKI_LINK_PREFIX = "#pudding-wiki:";

export function splitFrontmatter(content: string): { body: string; properties: Array<[string, string]> } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) return { body: content, properties: [] };
	try {
		const document = parseDocument(match[1]!, { schema: "failsafe" });
		if (document.errors.length) throw new Error("invalid frontmatter");
		const fields: unknown = document.toJS({ maxAliasCount: 100 });
		if (fields && typeof fields === "object" && !Array.isArray(fields)) {
			return { body: content.slice(match[0].length), properties: Object.entries(fields).map(([key, value]) => [key, propertyText(value)]) };
		}
	} catch { /* malformed metadata remains visible; never change source bytes */ }
	const properties: Array<[string, string]> = [];
	for (const line of match[1]!.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator > 0) properties.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
	}
	return { body: content.slice(match[0].length), properties };
}

function propertyText(value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	if (Array.isArray(value)) return value.length ? value.map(propertyText).join("、") : "—";
	if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}：${propertyText(item)}`).join("；");
	return String(value);
}

export function formatPropertyValue(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return value;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const propertyLabels: Record<string, string> = { id: "编号", type: "类型", title: "标题", created: "创建时间", updated: "更新时间", sources: "来源", phone: "电话", birthday: "出生年份", location: "所在地", occurredAt: "开始时间", endsAt: "结束时间", timeZone: "时区", calendarEventId: "关联日程", calendarRevision: "日程版本" };
export const propertyLabel = (key: string): string => propertyLabels[key] ?? key;

const IMAGE_EMBED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);

function escapeLinkLabel(label: string): string {
	return label.replace(/([\\[\]`])/g, "\\$1");
}

function splitWikiInner(inner: string): { target: string; label: string } {
	const pipe = inner.indexOf("|");
	const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
	const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim();
	return { target, label: label || target };
}

function isImageEmbedTarget(target: string): boolean {
	const clean = target.split("#")[0] ?? "";
	const extension = clean.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_EMBED_EXTENSIONS.has(extension);
}

function rewriteWikiLineSegment(segment: string): string {
	// ![[...]] 嵌入：图片扩展按相对图片处理，其余按普通 wiki 链接。
	let out = segment.replace(/!\[\[([^\]\n]+)\]\]/g, (_match, inner: string) => {
		const { target, label } = splitWikiInner(inner);
		if (!target) return _match;
		if (isImageEmbedTarget(target)) return `![${escapeLinkLabel(label)}](${target.replace(/ /g, "%20")})`;
		return `[${escapeLinkLabel(label)}](${WIKI_LINK_PREFIX}${encodeURIComponent(target)})`;
	});
	out = out.replace(/\[\[([^\]\n]+)\]\]/g, (_match, inner: string) => {
		const { target, label } = splitWikiInner(inner);
		if (!target) return _match;
		return `[${escapeLinkLabel(label)}](${WIKI_LINK_PREFIX}${encodeURIComponent(target)})`;
	});
	return out;
}

const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /`+[^`]*?`+/g;

function rewriteOutsideInlineCode(line: string): string {
	let result = "";
	let last = 0;
	for (const match of line.matchAll(INLINE_CODE_RE)) {
		result += rewriteWikiLineSegment(line.slice(last, match.index));
		result += match[0];
		last = match.index + match[0].length;
	}
	return result + rewriteWikiLineSegment(line.slice(last));
}

/** 把 Obsidian 风格 [[target]] / [[target|label]] 改写为哨兵链接；跳过围栏代码块与行内代码。 */
export function rewriteWikiLinks(markdown: string): string {
	const lines = markdown.split("\n");
	let fence: { char: string; length: number } | null = null;
	return lines.map((line) => {
		const fenceMatch = CODE_FENCE_RE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (!fence) {
				fence = { char: marker[0]!, length: marker.length };
			} else if (marker[0] === fence.char && marker.length >= fence.length) {
				fence = null;
			}
			return line;
		}
		if (fence) return line;
		return rewriteOutsideInlineCode(line);
	}).join("\n");
}

/** A visual diff block still needs the reference definitions from its own full snapshot. */
export function markdownReferenceDefinitions(markdown: string): string {
	const definitions: string[] = [];
	let fence: { char: string; length: number } | null = null;
	const lines = markdown.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const match = CODE_FENCE_RE.exec(line);
		if (match) {
			const marker = match[1]!;
			if (!fence) fence = { char: marker[0]!, length: marker.length };
			else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
			continue;
		}
		if (fence) continue;
		if (/^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*\S/.test(line)) definitions.push(line);
		else if (/^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*$/.test(line) && /^[ \t]*\S/.test(lines[index + 1] ?? "")) {
			// CommonMark also permits the destination on the next line.
			definitions.push(`${line}\n${lines[++index]}`);
		}
	}
	return definitions.join("\n");
}

/** GitHub 风格标题 slug：小写、去标点、空白转连字符（CJK 保留）。 */
export function slugifyHeading(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-");
}

export function parseWikiLinkHref(href: string | undefined): string | null {
	if (!href || !href.startsWith(WIKI_LINK_PREFIX)) return null;
	const encoded = href.slice(WIKI_LINK_PREFIX.length);
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

export type KnowledgeAssetRef =
	| { kind: "asset"; path: string }
	| { kind: "remote"; url: string }
	| { kind: "blocked" };

/** 相对当前笔记目录解析图片路径；绝对路径、越界（.. 超出内容根）与隐藏段一律不请求。 */
export function resolveKnowledgeAssetRef(notePath: string, rawSrc: string): KnowledgeAssetRef {
	if (/^https?:\/\//i.test(rawSrc)) return { kind: "remote", url: rawSrc };
	const withoutSuffix = rawSrc.split(/[?#]/)[0] ?? "";
	let decoded = withoutSuffix;
	try {
		decoded = decodeURIComponent(withoutSuffix);
	} catch {
		// 保留原始写法
	}
	if (!decoded || decoded.startsWith("/") || decoded.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(decoded)) {
		return { kind: "blocked" };
	}
	const base = notePath.split("/").slice(0, -1);
	const normalized: string[] = [];
	for (const segment of [...base, ...decoded.split("/")]) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (normalized.length === 0) return { kind: "blocked" };
			normalized.pop();
			continue;
		}
		if (segment.startsWith(".")) return { kind: "blocked" };
		normalized.push(segment);
	}
	if (normalized.length === 0) return { kind: "blocked" };
	return { kind: "asset", path: normalized.join("/") };
}
