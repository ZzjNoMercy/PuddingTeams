export type McpSelectionDraft = {
	selected: string[];
	revision: number;
	status: "draft" | "unconfirmed" | "conflict";
};

const volatileDrafts = new Map<string, McpSelectionDraft>();
const keyFor = (agentName: string) => `puddingteams:mcp-selection-draft:${agentName}`;

export function loadMcpSelectionDraft(agentName: string): McpSelectionDraft | null {
	const cached = volatileDrafts.get(agentName);
	if (cached) return cached;
	try {
		const raw = sessionStorage.getItem(keyFor(agentName));
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object") return null;
		const draft = value as Partial<McpSelectionDraft>;
		if (!Array.isArray(draft.selected) || !draft.selected.every((id) => typeof id === "string") ||
			typeof draft.revision !== "number" || !Number.isSafeInteger(draft.revision) || !["draft", "unconfirmed", "conflict"].includes(draft.status ?? "")) return null;
		const valid = draft as McpSelectionDraft;
		volatileDrafts.set(agentName, valid);
		return valid;
	} catch { return null; }
}

export function saveMcpSelectionDraft(agentName: string, draft: McpSelectionDraft): void {
	volatileDrafts.set(agentName, draft);
	try { sessionStorage.setItem(keyFor(agentName), JSON.stringify(draft)); }
	catch { /* Same-tab navigation still uses the in-memory copy. */ }
}

export function clearMcpSelectionDraft(agentName: string): void {
	volatileDrafts.delete(agentName);
	try { sessionStorage.removeItem(keyFor(agentName)); }
	catch { /* The in-memory copy was already cleared. */ }
}
