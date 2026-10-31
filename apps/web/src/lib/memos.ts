import { KnowledgeApiError, SERVER_URL } from "./api";

export type MemoLifecycle = "unorganized" | "promoting" | "organized";
export type MemoDisplayState =
	| "draft" | "queued" | "running" | "submitting" | "pending_review" | "approved" | "publishing"
	| "published" | "no_changes" | "rejected" | "returned" | "failed" | "cancelled" | "needs_attention"
	| "conflict" | "partial" | "candidate_registration_failed";

export interface MemoDisplay {
	state: MemoDisplayState;
	label: string;
	detail?: string;
	locked: boolean;
	jobId?: string;
	batchId?: string;
	reviewUrl?: string;
	knowledgeUrl?: string;
}

export interface Memo {
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

export interface MemoCounts {
	unorganized: number;
	promoting: number;
	organized: number;
	all: number;
}

export interface MemoList {
	items: Memo[];
	counts: MemoCounts;
	tags: Array<{ tag: string; count: number }>;
	nextBefore: string | null;
}

export interface MemoListQuery {
	filter?: string;
	tag?: string;
	q?: string;
	before?: string;
	limit?: number;
}

export interface PromoteMemoResult {
	operationId: string;
	phase: string;
	bindingId: string;
	jobId: string;
	jobStatus: string;
	replayed: boolean;
	memos: Memo[];
}

async function memoResponse<T>(response: Response): Promise<T> {
	const body = await response.json().catch(() => ({})) as T & { error?: string; code?: string; details?: unknown };
	if (!response.ok) {
		throw new KnowledgeApiError(body.error ?? `速记请求失败：${response.status}`, response.status, body.code, body.details);
	}
	return body;
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
	return fetch(`${SERVER_URL}/api/memos${path}`, { cache: "no-store", ...init }).then(memoResponse<T>);
}

function json(method: string, payload: unknown): RequestInit {
	return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export function listMemos(query: MemoListQuery = {}, signal?: AbortSignal): Promise<MemoList> {
	const params = new URLSearchParams();
	if (query.filter) params.set("filter", query.filter);
	if (query.tag) params.set("tag", query.tag);
	if (query.q) params.set("q", query.q);
	if (query.before) params.set("before", query.before);
	if (query.limit !== undefined) params.set("limit", String(query.limit));
	return request<MemoList>(`?${params}`, signal ? { signal } : undefined);
}

export function createMemo(input: { operationId: string; text: string }): Promise<{ memo: Memo; replayed: boolean }> {
	return request("", json("POST", input));
}

export function updateMemo(id: string, input: { text: string; expectedRevision: number }): Promise<{ memo: Memo }> {
	return request(`/${encodeURIComponent(id)}`, json("PATCH", input));
}

export function deleteMemo(id: string, input: { operationId: string; expectedRevision: number }): Promise<{ id: string; revision: number; deletedAt?: string; replayed: boolean }> {
	return request(`/${encodeURIComponent(id)}`, json("DELETE", input));
}

export function restoreMemo(id: string, input: { operationId: string }): Promise<{ memo: Memo; replayed: boolean }> {
	return request(`/${encodeURIComponent(id)}/restore`, json("POST", input));
}

export function promoteMemos(input: { operationId: string; memoIds: string[]; bindingId: string; task: string }): Promise<PromoteMemoResult> {
	return request("/promote", json("POST", input));
}
