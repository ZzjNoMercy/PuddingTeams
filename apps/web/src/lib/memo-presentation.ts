import type { Memo, MemoDisplayState } from "./memos";

const TAG = /#([\p{L}\p{N}_-]+)/gu;
const BOUNDARY = /[\s，。；、！？：""''（）【】《》,.;:!?()[\]{}<>|"'`~@#$%^&*+=/\\]/u;

/** 只用于预览提示；服务端解析结果才是权威。 */
export function parseMemoTags(text: string): string[] {
	const tags: string[] = [];
	for (const match of text.matchAll(TAG)) {
		const start = match.index ?? 0;
		const before = start === 0 ? "" : Array.from(text.slice(0, start)).at(-1) ?? "";
		if (before && !BOUNDARY.test(before)) continue;
		const tag = (match[1] ?? "").normalize("NFKC").replace(/^#+/, "");
		if (!tag || Array.from(tag).length > 32 || tags.length >= 16) continue;
		if (!tags.includes(tag)) tags.push(tag);
	}
	return tags;
}

export function memoDayKey(iso: string): string {
	const date = new Date(iso);
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function memoDayLabel(iso: string, now = new Date()): string {
	const date = new Date(iso);
	const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
	const diff = Math.round((startOf(now) - startOf(date)) / 86_400_000);
	if (diff === 0) return "今天";
	if (diff === 1) return "昨天";
	return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatMemoTime(iso: string): string {
	const date = new Date(iso);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface MemoDayGroup {
	key: string;
	label: string;
	items: Memo[];
}

export function groupMemosByDay(memos: readonly Memo[], now = new Date()): MemoDayGroup[] {
	const groups: MemoDayGroup[] = [];
	for (const memo of memos) {
		const key = memoDayKey(memo.createdAt);
		const existing = groups.at(-1);
		if (existing?.key === key) existing.items.push(memo);
		else groups.push({ key, label: memoDayLabel(memo.createdAt, now), items: [memo] });
	}
	return groups;
}

export type MemoStatusTone = "neutral" | "busy" | "review" | "done" | "danger";

const TONES: Record<MemoDisplayState, MemoStatusTone> = {
	draft: "neutral",
	queued: "busy", running: "busy", submitting: "busy",
	pending_review: "review", approved: "review", publishing: "review", returned: "review",
	published: "done", no_changes: "done",
	rejected: "danger", failed: "danger", cancelled: "danger", conflict: "danger", partial: "danger",
	needs_attention: "danger", candidate_registration_failed: "danger",
};

export function memoStatusTone(state: MemoDisplayState): MemoStatusTone {
	return TONES[state];
}

/** 只有未整理且未被投影锁定的条目可以编辑或提交整理。 */
export function canEditMemo(memo: Memo): boolean {
	return memo.lifecycle === "unorganized" && !memo.display.locked;
}

export function canSelectMemo(memo: Memo): boolean {
	return canEditMemo(memo);
}

export function sortMemosByCreatedAt(memos: readonly Memo[]): Memo[] {
	return [...memos].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
