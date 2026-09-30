export interface ManagerWorkDraft {
	content: string;
	operationId: string;
	modelRef?: string;
	/** 会话级思考强度（§10.6）；与 modelRef 同为预约身份的一部分。 */
	thinkingLevel?: string;
	attachmentCount?: number;
	pendingSubmission?: ManagerWorkPendingSubmission;
}

export interface ManagerWorkPendingSubmission {
	operationId: string;
	content: string;
	modelRef: string;
	thinkingLevel: string;
	attachmentCount: number;
	attachmentFingerprints?: string[];
}

type ManagerWorkIdentity = Pick<ManagerWorkDraft, "content" | "modelRef" | "thinkingLevel" | "attachmentCount">;

export function pendingManagerWorkMatches(draft: ManagerWorkIdentity, pending: ManagerWorkPendingSubmission): boolean {
	return draft.content.trim() === pending.content
		&& (draft.modelRef ?? "") === pending.modelRef
		&& (draft.thinkingLevel ?? "") === pending.thinkingLevel
		&& (draft.attachmentCount ?? 0) === pending.attachmentCount;
}

export function managerWorkSubmissionDecision(
	draft: ManagerWorkIdentity,
	pending: ManagerWorkPendingSubmission | null,
	options: { forceNewKey: boolean; historyReviewed: boolean; originalDeleted: boolean; sameAttachments: boolean },
): "new" | "retry" | "review_required" {
	if (!pending) return "new";
	if (options.forceNewKey) return options.historyReviewed ? "new" : "review_required";
	return !options.originalDeleted && options.sameAttachments && pendingManagerWorkMatches(draft, pending) ? "retry" : "review_required";
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const volatileDrafts = new Map<string, ManagerWorkDraft | null>();
const persistedVersions = new Map<string, string | null>();
const unpersistedDrafts = new Set<string>();

/** An unsent new work belongs to one tab; reloads in that tab retain its draft. */
export function managerWorkStorage(): DraftStorage {
	return sessionStorage;
}

function parseDraft(raw: string | null): ManagerWorkDraft | null {
	try {
		const parsed: unknown = JSON.parse(raw ?? "null");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			return {
				content: typeof record.content === "string" ? record.content : "",
				operationId: typeof record.operationId === "string" ? record.operationId : "",
				...(typeof record.modelRef === "string" ? { modelRef: record.modelRef } : {}),
				...(typeof record.thinkingLevel === "string" ? { thinkingLevel: record.thinkingLevel } : {}),
				...(typeof record.attachmentCount === "number" && Number.isSafeInteger(record.attachmentCount) && record.attachmentCount >= 0 ? { attachmentCount: record.attachmentCount } : {}),
				...(record.pendingSubmission && typeof record.pendingSubmission === "object" && !Array.isArray(record.pendingSubmission) &&
					typeof (record.pendingSubmission as Record<string, unknown>).operationId === "string" &&
					typeof (record.pendingSubmission as Record<string, unknown>).content === "string" &&
					typeof (record.pendingSubmission as Record<string, unknown>).modelRef === "string" &&
					typeof (record.pendingSubmission as Record<string, unknown>).thinkingLevel === "string" &&
					typeof (record.pendingSubmission as Record<string, unknown>).attachmentCount === "number" &&
					Number.isSafeInteger((record.pendingSubmission as Record<string, unknown>).attachmentCount) &&
					((record.pendingSubmission as Record<string, unknown>).attachmentCount as number) >= 0
					? { pendingSubmission: {
						operationId: (record.pendingSubmission as ManagerWorkPendingSubmission).operationId,
						content: (record.pendingSubmission as ManagerWorkPendingSubmission).content,
						modelRef: (record.pendingSubmission as ManagerWorkPendingSubmission).modelRef,
						thinkingLevel: (record.pendingSubmission as ManagerWorkPendingSubmission).thinkingLevel,
						attachmentCount: (record.pendingSubmission as ManagerWorkPendingSubmission).attachmentCount,
						...(Array.isArray((record.pendingSubmission as Record<string, unknown>).attachmentFingerprints) &&
							((record.pendingSubmission as Record<string, unknown>).attachmentFingerprints as unknown[]).length === (record.pendingSubmission as ManagerWorkPendingSubmission).attachmentCount &&
							((record.pendingSubmission as Record<string, unknown>).attachmentFingerprints as unknown[]).every((value) => typeof value === "string" && (/^[a-f0-9]{64}$/.test(value) || /^fnv64-[a-f0-9]{16}$/.test(value)))
							? { attachmentFingerprints: (record.pendingSubmission as ManagerWorkPendingSubmission).attachmentFingerprints } : {}),
					} } : {}),
			};
		}
	} catch { /* A malformed browser draft is not a usable draft. */ }
	return null;
}

/** Keep same-tab drafts usable when browser storage access or writes fail. */
export function loadManagerWorkDraft(key: string, storage: () => DraftStorage): ManagerWorkDraft {
	if (volatileDrafts.has(key)) {
		if (!unpersistedDrafts.has(key) && persistedVersions.has(key)) {
			try {
				const raw = storage().getItem(key);
				if (raw !== persistedVersions.get(key)) {
					const external = parseDraft(raw);
					volatileDrafts.set(key, external);
					persistedVersions.set(key, raw);
				}
			} catch { /* Retain this tab's copy when storage cannot be read. */ }
		}
		const inMemory = volatileDrafts.get(key);
		return inMemory ? { ...inMemory } : { content: "", operationId: "" };
	}
	try {
		const raw = storage().getItem(key);
		const draft = parseDraft(raw);
		if (draft) {
			volatileDrafts.set(key, draft);
			persistedVersions.set(key, raw);
			unpersistedDrafts.delete(key);
			return { ...draft };
		}
	} catch { /* Storage can be unavailable or contain a malformed draft. */ }
	return { content: "", operationId: "" };
}

export function saveManagerWorkDraft(key: string, draft: ManagerWorkDraft, storage: () => DraftStorage): void {
	volatileDrafts.set(key, { ...draft });
	const raw = JSON.stringify(draft);
	try { storage().setItem(key, raw); persistedVersions.set(key, raw); unpersistedDrafts.delete(key); }
	catch { unpersistedDrafts.add(key); /* In-memory copy supports same-tab context changes and retries. */ }
}

export function clearManagerWorkDraft(key: string, storage: () => DraftStorage, expected?: ManagerWorkDraft): boolean {
	if (expected) {
		const current = loadManagerWorkDraft(key, storage);
		if (current.content !== expected.content || current.operationId !== expected.operationId || (current.modelRef ?? "") !== (expected.modelRef ?? "") || (current.thinkingLevel ?? "") !== (expected.thinkingLevel ?? "") || (current.attachmentCount ?? 0) !== (expected.attachmentCount ?? 0) || current.pendingSubmission?.operationId !== expected.pendingSubmission?.operationId) return false;
		const expectedRaw = JSON.stringify(expected);
		try {
			const storedRaw = storage().getItem(key);
			if (persistedVersions.get(key) === expectedRaw && storedRaw !== expectedRaw) {
				volatileDrafts.set(key, parseDraft(storedRaw));
				persistedVersions.set(key, storedRaw);
				unpersistedDrafts.delete(key);
				return storedRaw === null;
			}
			if (persistedVersions.get(key) !== expectedRaw && storedRaw !== expectedRaw) {
				// The last write failed: keep a local tombstone without deleting another tab's copy.
				volatileDrafts.set(key, null);
				unpersistedDrafts.delete(key);
				return true;
			}
		} catch { /* Storage denial still permits an in-memory completion tombstone. */ }
	}
	// A failed removeItem must not resurrect the submitted draft on same-tab navigation.
	volatileDrafts.set(key, null);
	unpersistedDrafts.delete(key);
	try { storage().removeItem(key); persistedVersions.set(key, null); }
	catch { /* A completed send must not be reported as failed. */ }
	return true;
}
