import type { ChatNavigationItem } from "./types";

export type ChatNavigationView = "agent" | "project";
export interface NewChatTarget { agentId?: string; workspaceId?: string | null; }
export interface ChatNavigationGroup { id: string; name: string; detail: string; agentId?: string; agentEnabled?: boolean; workspaceId?: string | null; items: ChatNavigationItem[]; }
export function navigationTitle(item: Pick<ChatNavigationItem, "title" | "firstMessage">): string {
 const meaningful = (text: string) => text.trim() && !["新对话", "(no messages)"].includes(text.trim());
 return (meaningful(item.title) ? item.title.trim() : meaningful(item.firstMessage) ? item.firstMessage.trim().split("\n")[0]! : "新聊天");
}
export function groupChatNavigation(items: readonly ChatNavigationItem[], view: ChatNavigationView, query: string, archived: boolean): ChatNavigationGroup[] {
 const groups = new Map<string, ChatNavigationGroup>();
 const needle = query.trim().toLocaleLowerCase();
 for (const item of items) {
  if (item.archived !== archived || (needle && ![navigationTitle(item), item.firstMessage, item.agentName, item.workspaceName, item.cwdSnapshot, item.roomName].join(" ").toLocaleLowerCase().includes(needle))) continue;
  const id = view === "agent" ? `agent:${item.ownerAgentId}` : item.workspaceId ? `project:${item.workspaceId}` : `cwd:${item.cwdSnapshot}`;
  if (!groups.has(id)) groups.set(id, { id, name: view === "agent" ? item.agentName : item.workspaceName, detail: view === "agent" ? item.agentName : item.cwdSnapshot,
   ...(view === "agent" ? { agentId: item.ownerAgentId, agentEnabled: item.agentEnabled } : { workspaceId: item.workspaceId }), items: [] });
  groups.get(id)!.items.push(item);
 }
 const time = (item: ChatNavigationItem) => Date.parse(item.modifiedAt) || 0;
 const result = [...groups.values()];
 for (const group of result) group.items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || time(b) - time(a) || a.sessionId.localeCompare(b.sessionId));
 return result.sort((a, b) => (view === "agent" ? Number(b.agentId === "manager") - Number(a.agentId === "manager") : 0)
  || Math.max(...b.items.map(time)) - Math.max(...a.items.map(time)) || a.id.localeCompare(b.id));
}
