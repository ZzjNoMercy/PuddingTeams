export interface AgentCreateAttempt {
	scope: string;
	digest: string;
	key: string;
}

interface AttemptStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

// Separate pending requests so an unrelated failed create cannot discard an earlier retry key.
const storageKey = (scope: string, digest: string) => `puddingteams:agent-create-attempt:v1:${scope}:${digest}`;
const validKey = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key);

/** Persist only a request digest and operation key; the Agent body stays in the form. */
export function acquireAgentCreateAttempt(
	scope: string,
	digest: string,
	current: AgentCreateAttempt | null,
	storage: AttemptStorage | null,
	newKey: () => string,
): AgentCreateAttempt {
	if (current?.scope === scope && current.digest === digest) return current;
	let persisted: Partial<AgentCreateAttempt> | null = null;
	try { persisted = JSON.parse(storage?.getItem(storageKey(scope, digest)) ?? "null") as Partial<AgentCreateAttempt> | null; }
	catch { /* Storage is optional for retries within the mounted dialog. */ }
	const key = persisted?.scope === scope && persisted.digest === digest && validKey(persisted.key) ? persisted.key : newKey();
	const attempt = { scope, digest, key };
	try { storage?.setItem(storageKey(scope, digest), JSON.stringify(attempt)); }
	catch { /* The in-memory attempt still covers retries in this tab. */ }
	return attempt;
}

export function clearAgentCreateAttempt(attempt: AgentCreateAttempt | null, storage: AttemptStorage | null): void {
	if (!attempt) return;
	try {
		const key = storageKey(attempt.scope, attempt.digest);
		const saved = JSON.parse(storage?.getItem(key) ?? "null") as Partial<AgentCreateAttempt> | null;
		if (saved?.key === attempt.key && saved.digest === attempt.digest) storage?.removeItem(key);
	} catch { /* Storage cleanup must not turn a completed create into an error. */ }
}

export async function agentCreateDigest(body: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
