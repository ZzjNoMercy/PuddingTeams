import type { Memo, MemoCounts, MemoList } from "./memos";

export interface MemoListState {
	items: Memo[];
	counts: MemoCounts;
	tags: Array<{ tag: string; count: number }>;
	nextBefore: string | null;
}

export const EMPTY_MEMO_COUNTS: MemoCounts = { unorganized: 0, promoting: 0, organized: 0, all: 0 };

/** 游标追加只对同一查询有效；首屏或筛选变化直接替换，避免旧页混入。 */
export function mergeMemoPage(previous: MemoListState | null, page: MemoList, cursor?: string): MemoListState {
	const items = cursor && previous ? [...previous.items, ...page.items] : page.items;
	const seen = new Set<string>();
	const deduped = items.filter((memo) => (seen.has(memo.id) ? false : (seen.add(memo.id), true)));
	return { items: deduped, counts: page.counts, tags: page.tags, nextBefore: page.nextBefore };
}

/** 刷新后剔除已不可选或已消失的选择，避免提交锁定条目。 */
export function pruneMemoSelection(selected: ReadonlySet<string>, items: readonly Memo[], selectable: (memo: Memo) => boolean): Set<string> {
	const byId = new Map(items.map((memo) => [memo.id, memo]));
	const next = new Set<string>();
	for (const id of selected) {
		const memo = byId.get(id);
		if (memo && selectable(memo)) next.add(id);
	}
	return next;
}

/**
 * 轮询/事件刷新：用第一页结果更新已有条目的状态并插入新条目，保留已加载的后续页。
 * 不做整体 replace，避免活动 attempt 期间把多页浏览打回第一页。
 */
export function mergeMemoStatus(previous: readonly Memo[], page: readonly Memo[]): Memo[] {
	const byId = new Map(page.map((memo) => [memo.id, memo]));
	const merged = previous.map((memo) => byId.get(memo.id) ?? memo);
	const seen = new Set(merged.map((memo) => memo.id));
	for (const memo of page) if (!seen.has(memo.id)) merged.push(memo);
	return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function selectedMemos(items: readonly Memo[], selected: ReadonlySet<string>): Memo[] {
	return items.filter((memo) => selected.has(memo.id));
}

const ACTIVE_STATES = new Set(["queued", "running", "submitting", "approved", "publishing"]);

/** pending_review 等人工终态不轮询；只有机器仍在推进的 attempt 才需要。 */
export function hasActiveAttempt(items: readonly Memo[]): boolean {
	return items.some((memo) => memo.lifecycle === "promoting" && ACTIVE_STATES.has(memo.display.state));
}
