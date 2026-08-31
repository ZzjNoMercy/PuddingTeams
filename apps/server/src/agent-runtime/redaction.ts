const SECRET_KEY = /api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|private[_-]?key/i;

/** Redact credential-shaped text before it crosses a public or persistence boundary. */
export function redactText(value: string): string {
	return value
		// Authorization is one public field: redact the complete credential and
		// collapse previously-redacted/repeated forms so the operation is idempotent.
		.replace(/\b(Authorization)\s*:\s*(?:Bearer\s+)?(?:\[redacted\][\]]*|[A-Za-z0-9._~+\/-]+=*)(?:\s+\[redacted\][\]]*)*/gi, "$1: [redacted]")
		.replace(/\b(Bearer)\s+(?!\[redacted\])([A-Za-z0-9._~+\/-]+=*)/gi, "$1 [redacted]")
		.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, "[redacted]")
		.replace(/((?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|COOKIE|CREDENTIAL|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[=:]\s*)(?!\[redacted\])([^\s,;\]}"'`]+)/gi, "$1[redacted]")
		.replace(/("[^"]*(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|private[_-]?key)[^"]*"\s*:\s*")(?!\[redacted\]")[^"]*(")/gi, "$1[redacted]$2")
		.replace(/\[redacted\][\]]+/g, "[redacted]");
}

/** Recursively redact strings and values under credential-shaped keys. */
export function redactValue<T>(value: T, key?: string): T {
	if (key && SECRET_KEY.test(key)) return "[redacted]" as T;
	if (typeof value === "string") return redactText(value) as T;
	if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactValue(child, childKey)]),
		) as T;
	}
	return value;
}
