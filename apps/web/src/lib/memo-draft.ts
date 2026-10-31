export interface MemoDraft {
	text: string;
	operationId: string;
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 访问 sessionStorage 本身可能抛（Safari 严格模式 / 沙箱 iframe），草稿失败不能阻断捕获。 */
export function safeSessionStorage(): DraftStorage | null {
	try {
		return typeof window === "undefined" ? null : window.sessionStorage;
	} catch {
		return null;
	}
}

/** 草稿按 tenant/user 与场景隔离，避免切换身份后串写。 */
export function memoDraftKey(tenantId: string, userId: string): string {
	return `pudding:memo-draft:${tenantId}:${userId}:capture`;
}

export function parseMemoDraft(raw: string | null): MemoDraft | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { text?: unknown; operationId?: unknown };
		if (typeof parsed.text !== "string" || typeof parsed.operationId !== "string" || !parsed.operationId) return null;
		return { text: parsed.text, operationId: parsed.operationId };
	} catch {
		return null;
	}
}

export function readMemoDraft(storage: DraftStorage | null | undefined, key: string): MemoDraft | null {
	if (!storage) return null;
	try { return parseMemoDraft(storage.getItem(key)); } catch { return null; }
}

export function writeMemoDraft(storage: DraftStorage | null | undefined, key: string, draft: MemoDraft): void {
	if (!storage) return;
	try { storage.setItem(key, JSON.stringify(draft)); } catch { /* 存储被拒绝时仍可在本次输入中使用 */ }
}

/** 只有当前草稿仍是已提交版本时才删除；迟到响应不得清掉后来的输入。 */
export function clearMemoDraftIfMatches(storage: DraftStorage | null | undefined, key: string, submitted: { text: string; operationId: string }): boolean {
	if (!storage) return false;
	const current = readMemoDraft(storage, key);
	// 正文与 operationId 都相同才算「本次提交的草稿」；迟到响应不得删除后来输入。
	if (!current || current.text !== submitted.text || current.operationId !== submitted.operationId) return false;
	try { storage.removeItem(key); } catch { /* optional */ }
	return true;
}

export function operationIdFor(text: string, previous: MemoDraft | null | undefined): string {
	if (previous && previous.text === text) return previous.operationId;
	return crypto.randomUUID();
}

export function newMemoOperationId(): string {
	return crypto.randomUUID();
}
