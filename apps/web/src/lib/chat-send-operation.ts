import type { MessageAttachmentInput } from "./api.js";

interface SendOperation { requestHash: string; key: string }
type OperationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const volatileOperations = new Map<string, SendOperation | null>();

export class ChatSendIntentChangedError extends Error {
	constructor(readonly key: string) {
		super("旧消息的结果仍未确认；请先刷新并核对历史，再明确发起新消息");
		this.name = "ChatSendIntentChangedError";
	}
}

function storageKey(sessionId: string): string {
	return `puddingteams:message-operation:v1:${sessionId}`;
}

async function requestHash(content: string, attachments: MessageAttachmentInput[]): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify({ content, attachments }));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The same tab retries an uncertain send with its original operation key. */
export async function reserveChatSendOperation(
	sessionId: string,
	content: string,
	attachments: MessageAttachmentInput[],
	storage: () => OperationStorage = () => sessionStorage,
): Promise<string> {
	const hash = await requestHash(content, attachments);
	let existing = volatileOperations.get(sessionId);
	if (existing === undefined) {
		try {
			const raw = storage().getItem(storageKey(sessionId));
			const parsed: unknown = raw ? JSON.parse(raw) : null;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const record = parsed as Record<string, unknown>;
				if (typeof record.requestHash === "string" && /^[a-f0-9]{64}$/.test(record.requestHash) &&
					typeof record.key === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(record.key)) {
					existing = { requestHash: record.requestHash, key: record.key };
				}
			}
		} catch { /* Keep a volatile operation if browser storage is unavailable. */ }
	}
	if (existing) {
		// A page reload restores only sessionStorage. Keep that operation in memory
		// so either a confirmed replay or an explicit new-intent choice can clear it.
		volatileOperations.set(sessionId, existing);
		if (existing.requestHash !== hash) throw new ChatSendIntentChangedError(existing.key);
		return existing.key;
	}
	const operation = { requestHash: hash, key: crypto.randomUUID() };
	volatileOperations.set(sessionId, operation);
	try { storage().setItem(storageKey(sessionId), JSON.stringify(operation)); }
	catch { /* This tab still reuses the volatile key until it closes. */ }
	return operation.key;
}

export function clearChatSendOperation(sessionId: string, key: string, storage: () => OperationStorage = () => sessionStorage): void {
	const current = volatileOperations.get(sessionId);
	if (!current || current.key !== key) return;
	volatileOperations.set(sessionId, null);
	try {
		const slot = storage();
		const raw = slot.getItem(storageKey(sessionId));
		if (raw && (JSON.parse(raw) as { key?: string }).key === key) {
			try { slot.removeItem(storageKey(sessionId)); }
			catch { slot.setItem(storageKey(sessionId), JSON.stringify({ discardedKey: key })); }
		}
	} catch { /* A confirmed send must not become a failed send due to storage denial. */ }
}
