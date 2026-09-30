const PREFIX = "puddingteams:pending-group-creation:";
const memory = new Map<string, string>();

export function groupCreationFingerprint(members: readonly string[], workspaceId: string): string {
	return JSON.stringify({ members: [...new Set(members)].sort(), workspaceId: workspaceId || null });
}

export function groupWorkspaceSwitchFingerprint(sourceRoomId: string, workspaceId: string | null): string {
	return JSON.stringify({ operation: "group-workspace-switch", sourceRoomId, workspaceId });
}

function storageKey(fingerprint: string): string {
	return PREFIX + fingerprint;
}

/** Keep an uncertain create identity across retries and reloads in this tab. */
export function reserveGroupCreationOperation(fingerprint: string, storage: Pick<Storage, "getItem" | "setItem"> | null): string {
	const cached = memory.get(fingerprint);
	if (cached) return cached;
	let stored: string | null = null;
	try { stored = storage?.getItem(storageKey(fingerprint)) ?? null; } catch { /* Memory remains usable. */ }
	const key = stored && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(stored) ? stored : crypto.randomUUID();
	memory.set(fingerprint, key);
	try { storage?.setItem(storageKey(fingerprint), key); } catch { /* Memory remains usable. */ }
	return key;
}

export function clearGroupCreationOperation(fingerprint: string, key: string, storage: Pick<Storage, "getItem" | "removeItem"> | null): void {
	if (memory.get(fingerprint) === key) memory.delete(fingerprint);
	try {
		if (storage?.getItem(storageKey(fingerprint)) === key) storage.removeItem(storageKey(fingerprint));
	} catch { /* A successful request has already been acknowledged. */ }
}
