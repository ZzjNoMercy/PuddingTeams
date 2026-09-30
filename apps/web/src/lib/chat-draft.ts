type DraftStorage = Pick<Storage, "getItem" | "setItem">;
const volatileDrafts = new Map<string, string>();
const volatileAttachments = new Map<string, Array<{ id: string; file: File }>>();

/** Keep per-Session drafts available across same-tab navigation when storage is denied. */
export function loadChatDraft(key: string, storage: () => DraftStorage): string {
	if (volatileDrafts.has(key)) return volatileDrafts.get(key)!;
	try {
		const saved = storage().getItem(key) ?? "";
		volatileDrafts.set(key, saved);
		return saved;
	} catch { return ""; }
}

export function saveChatDraft(key: string, content: string, storage: () => DraftStorage): void {
	volatileDrafts.set(key, content);
	try { storage().setItem(key, content); }
	catch { /* The in-memory copy remains authoritative in this tab. */ }
}

/** A confirmed send clears only the text that was actually submitted. */
export function clearSubmittedChatDraft(key: string, submitted: string, current: string, storage: () => DraftStorage): void {
	if (current === submitted) saveChatDraft(key, "", storage);
}

/** File objects survive same-tab navigation; object URLs are recreated by the input provider. */
export function loadChatAttachmentDraft(key: string): File[] {
	return (volatileAttachments.get(key) ?? []).map(({ file }) => file);
}

export function saveChatAttachmentDraft(key: string, files: Array<{ id: string; file?: File }>): void {
	const saved = files.flatMap(({ id, file }) => file ? [{ id, file }] : []);
	if (saved.length === 0) volatileAttachments.delete(key);
	else volatileAttachments.set(key, saved);
}

export function removeSubmittedChatAttachments(key: string, submittedFiles: File[], current: Array<{ id: string; file?: File }>): void {
	const submitted = new Set(submittedFiles);
	saveChatAttachmentDraft(key, current.filter(({ file }) => !file || !submitted.has(file)));
}
