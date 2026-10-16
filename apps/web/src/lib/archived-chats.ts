import { groupChatNavigation } from "./chat-navigation";
import type { ChatNavigationItem } from "./types";

export function archiveProjectKey(item: Pick<ChatNavigationItem, "workspaceId" | "cwdSnapshot">): string {
 return item.workspaceId ? `project:${item.workspaceId}` : `cwd:${item.cwdSnapshot}`;
}

export function archivedChatGroups(items: readonly ChatNavigationItem[], query: string, agentId: string, projectId: string) {
 const filtered = items.filter(item => (!agentId || item.ownerAgentId === agentId) && (!projectId || archiveProjectKey(item) === projectId));
 return groupChatNavigation(filtered, "project", query, true).map(group => ({ ...group, items: [...group.items].sort((a, b) => (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0) || a.sessionId.localeCompare(b.sessionId)) }));
}

/** Archive navigation can return only to the chat route, never an external URL. */
export function archivedReturnHref(value: string | null): string {
 if (!value || !value.startsWith("/chats")) return "/chats";
 try {
  const url = new URL(value, "https://teams.invalid");
  if (url.origin !== "https://teams.invalid" || url.pathname !== "/chats") return "/chats";
  const query = new URLSearchParams();
  for (const key of ["room", "session", "returnSession"]) { const entry = url.searchParams.get(key); if (entry) query.set(key, entry); }
  return query.size ? `/chats?${query}` : "/chats";
 } catch { return "/chats"; }
}
