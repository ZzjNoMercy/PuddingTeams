// Adapted from deer-flow (MIT). See docs/reference for the upstream note.
// Strips internal marker tags and caps pathological markdown nesting that would
// otherwise overflow marked's tokenizers during streaming render.

const INTERNAL_MARKER_TAGS = [
	"memory",
	"system-reminder",
	"context-reminder",
	"ip_reminder",
	"critical_reminder",
	"user_instruction",
	"hide_from_ui",
	"thinking_block",
	"reasoning_reminder",
];

const MAX_BLOCKQUOTE_DEPTH = 100;
const DEEP_BLOCKQUOTE_HINT_RE = new RegExp(
	`^(?:[ \\t]*>){${MAX_BLOCKQUOTE_DEPTH + 1}}`,
	"m",
);
const BLOCKQUOTE_PREFIX_RE = /^ {0,3}(?:[ \t]*>)+/;
const CODE_FENCE_RE = /^ {0,3}(?:```|~~~)/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

const MAX_LIST_INDENT = 200;
const DEEP_INDENT_HINT_RE = new RegExp(`^[ \\t]{${MAX_LIST_INDENT + 1},}`, "m");

export function capBlockquoteNesting(markdown: string): string {
	if (!DEEP_BLOCKQUOTE_HINT_RE.test(markdown)) {
		return markdown;
	}

	let insideFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (CODE_FENCE_RE.test(line)) {
				insideFence = !insideFence;
				return line;
			}
			if (insideFence || INDENTED_CODE_RE.test(line)) {
				return line;
			}
			const match = BLOCKQUOTE_PREFIX_RE.exec(line);
			if (!match) {
				return line;
			}
			const prefix = match[0];
			let depth = 0;
			for (let i = 0; i < prefix.length; i++) {
				if (prefix[i] === ">") {
					depth += 1;
					if (depth > MAX_BLOCKQUOTE_DEPTH) {
						return line.slice(0, i) + line.slice(prefix.length);
					}
				}
			}
			return line;
		})
		.join("\n");
}

export function capListNesting(markdown: string): string {
	if (!DEEP_INDENT_HINT_RE.test(markdown)) {
		return markdown;
	}

	let insideFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (CODE_FENCE_RE.test(line)) {
				insideFence = !insideFence;
				return line;
			}
			if (insideFence) {
				return line;
			}
			const whitespace = /^[ \t]*/.exec(line)![0];
			if (whitespace.length <= MAX_LIST_INDENT) {
				return line;
			}
			return " ".repeat(MAX_LIST_INDENT) + line.slice(whitespace.length);
		})
		.join("\n");
}

export function capMarkdownNesting(markdown: string): string {
	return capListNesting(capBlockquoteNesting(markdown));
}

const _INTERNAL_TAG_RE = new RegExp(
	`</?(?:${INTERNAL_MARKER_TAGS.join("|")})(?:\\s[^>]*)?/?>`,
	"g",
);

const FENCE_MARKER_RE = /^ {0,3}(`{3,}|~{3,})/;

export function stripLeakedSystemTags(markdown: string): string {
	const lines = markdown.split("\n");
	let fenceMarker: string | null = null;

	return lines
		.map((line) => {
			const fenceMatch = FENCE_MARKER_RE.exec(line);
			if (fenceMatch) {
				const marker = fenceMatch[1]!;
				if (fenceMarker === null) {
					fenceMarker = marker;
				} else if (
					marker.startsWith(fenceMarker.charAt(0)) &&
					marker.length >= fenceMarker.length
				) {
					fenceMarker = null;
				}
				return line;
			}
			if (fenceMarker !== null || INDENTED_CODE_RE.test(line)) {
				return line;
			}
			return line.replace(_INTERNAL_TAG_RE, "");
		})
		.join("\n");
}

export function preprocessStreamdownMarkdown(markdown: string): string {
	return capMarkdownNesting(stripLeakedSystemTags(markdown));
}
