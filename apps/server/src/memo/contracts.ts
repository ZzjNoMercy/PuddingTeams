import { createHash } from "node:crypto";

/** 速记生命周期决定可编辑、可删除、可再次整理；审核/发布状态只作为显示投影。 */
export type MemoLifecycle = "unorganized" | "promoting" | "organized";
export type MemoPromotionPhase = "freezing" | "sources_frozen" | "job_created" | "failed";

export const MEMO_TEXT_LIMIT = 10_000;
export const MEMO_TAG_LIMIT = 16;
export const MEMO_TAG_LENGTH = 32;
export const MEMO_PAGE_LIMIT = 50;
export const MEMO_PROMOTE_LIMIT = 50;
const OPERATION_LIMIT = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface Memo {
	id: string;
	ownerId: string;
	/** 保存用户原文，只有校验使用 trim 后的结果。 */
	text: string;
	tags: string[];
	lifecycle: MemoLifecycle;
	createdAt: string;
	updatedAt: string;
	revision: number;
	deletedAt?: string;
	/** 当前 attempt；回到 unorganized 时清除，organized 保留用于结果回链。 */
	currentOperationId?: string;
	lastError?: string;
	outcome?: "published" | "no_changes";
}

export interface MemoPromotionItem {
	memoId: string;
	memoRevision: number;
	textSnapshot: string;
	tags: string[];
	sourceId?: string;
}

export interface MemoPromotion {
	operationId: string;
	requestHash: string;
	ownerId: string;
	bindingId: string;
	task: string;
	phase: MemoPromotionPhase;
	jobId?: string;
	lastError?: string;
	items: MemoPromotionItem[];
	createdAt: string;
	updatedAt: string;
}

export type MemoDisplayState =
	| "draft"
	| "queued"
	| "running"
	| "submitting"
	| "pending_review"
	| "approved"
	| "publishing"
	| "published"
	| "no_changes"
	| "rejected"
	| "returned"
	| "failed"
	| "cancelled"
	| "needs_attention"
	| "conflict"
	| "partial"
	| "candidate_registration_failed";

export interface MemoDisplay {
	state: MemoDisplayState;
	label: string;
	detail?: string;
	/** 整理中、审核中、发布中与异常待处理都不可再编辑或再次整理。 */
	locked: boolean;
	jobId?: string;
	batchId?: string;
	reviewUrl?: string;
	knowledgeUrl?: string;
}

export interface MemoDto {
	id: string;
	text: string;
	tags: string[];
	lifecycle: MemoLifecycle;
	createdAt: string;
	updatedAt: string;
	revision: number;
	lastError?: string;
	display: MemoDisplay;
}

export interface MemoListDto {
	items: MemoDto[];
	counts: { unorganized: number; promoting: number; organized: number; all: number };
	tags: Array<{ tag: string; count: number }>;
	nextBefore: string | null;
}

export class MemoError extends Error {
	constructor(
		readonly code: "invalid_input" | "not_found" | "conflict" | "unavailable",
		message: string,
	) {
		super(message);
		this.name = "MemoError";
	}
}

export function digestMemo(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requireOperationId(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > OPERATION_LIMIT || CONTROL.test(value)) {
		throw new MemoError("invalid_input", "operationId 无效");
	}
	return value;
}

export function requireMemoText(value: unknown): string {
	if (typeof value !== "string") throw new MemoError("invalid_input", "请输入速记内容");
	if (!value.trim()) throw new MemoError("invalid_input", "速记不能为空");
	if (Array.from(value).length > MEMO_TEXT_LIMIT) throw new MemoError("invalid_input", `速记最多 ${MEMO_TEXT_LIMIT} 字`);
	if (value.includes("\0")) throw new MemoError("invalid_input", "速记包含不可保存的字符");
	return value;
}

export function requireRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new MemoError("invalid_input", "版本号无效");
	return value;
}

const TAG = /#([\p{L}\p{N}_-]+)/gu;
const BOUNDARY = /[\s，。；、！？：""''（）【】《》,.;:!?()[\]{}<>|"'`~@#$%^&*+=/\\]/u;

/** 服务端权威标签解析；正文原样保留，只在展示与来源 hash 时使用规范化结果。 */
export function parseMemoTags(text: string): string[] {
	const tags: string[] = [];
	for (const match of text.matchAll(TAG)) {
		const start = match.index ?? 0;
		const before = start === 0 ? "" : Array.from(text.slice(0, start)).at(-1) ?? "";
		if (before && !BOUNDARY.test(before)) continue;
		pushTag(tags, match[1] ?? "");
	}
	return tags;
}

function pushTag(tags: string[], raw: string): void {
	const tag = raw.normalize("NFKC").trim().replace(/^#+/, "");
	if (!tag || Array.from(tag).length > MEMO_TAG_LENGTH || tags.length >= MEMO_TAG_LIMIT) return;
	if (!tags.includes(tag)) tags.push(tag);
}

/** Trusted server normalization for source evidence; never accepts model input. */
export function normalizeMemoTags(values: readonly string[]): string[] {
	const tags: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") throw new MemoError("invalid_input", "标签无效");
		pushTag(tags, value);
	}
	return tags;
}

export function sortedTags(tags: readonly string[]): string[] {
	return [...tags].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/** 来源身份 hash 与顺序无关：tags 先规范化再排序。 */
export function promoteRequestHash(input: {
	memoIds: string[];
	items: MemoSnapshot[];
	bindingId: string;
	task: string;
}): string {
	return digestMemo({
		kind: "memo.promote",
		memoIds: input.memoIds,
		items: input.items,
		bindingId: input.bindingId,
		task: input.task,
	});
}

export interface MemoSnapshot {
	memoId: string;
	revision: number;
	text: string;
	tags: string[];
}

export const DISPLAY_LABELS: Record<MemoDisplayState, string> = {
	draft: "未整理",
	queued: "整理中",
	running: "整理中",
	submitting: "整理中",
	pending_review: "待审核",
	approved: "等待发布",
	publishing: "发布中",
	published: "已发布",
	no_changes: "无需变更",
	rejected: "已拒绝",
	returned: "已退回，等待修订",
	failed: "整理失败",
	cancelled: "已取消",
	needs_attention: "待处理",
	conflict: "发布冲突",
	partial: "部分完成",
	candidate_registration_failed: "候选登记失败",
};

/** 显示投影只读事实源；这些状态保持锁定，不允许 fresh promote。 */
export const LOCKED_STATES: ReadonlySet<MemoDisplayState> = new Set([
	"queued", "running", "submitting", "pending_review", "approved", "publishing",
	"returned", "needs_attention", "conflict", "partial", "candidate_registration_failed",
]);

export function isLockedDisplay(state: MemoDisplayState): boolean {
	return LOCKED_STATES.has(state);
}
