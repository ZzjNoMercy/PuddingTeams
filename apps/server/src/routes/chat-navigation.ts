import type { FastifyInstance } from "fastify";
import { agentDisplayName, type TeamsStore } from "../store/teams.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import { ChatNavigationStore } from "../store/chat-navigation.js";

export function registerChatNavigationRoutes(app: FastifyInstance, deps: { teams: TeamsStore; sessions: Pick<PiSessionStore, "list">; statePath: string }): void {
 const metadata = new ChatNavigationStore(deps.statePath);
 app.get("/api/chat-navigation", async () => {
  const [windows, listed, workspaces, agents, state] = await Promise.all([deps.teams.listWindows(), deps.sessions.list(), deps.teams.workspaces.list(), deps.teams.listAgents(), metadata.read()]);
  const byId = new Map(listed.map(session => [session.id, session]));
  const projects = new Map(workspaces.map(workspace => [workspace.id, workspace]));
  const items = [];
  for (const room of windows) {
   const contexts = [{ workspaceId: room.workspaceId, cwdSnapshot: room.cwdSnapshot, sessions: room.sessions, contextActive: true },
    ...Object.values(room.parkedContexts).map(context => ({ ...context, contextActive: false }))];
   const seen = new Set<string>();
   for (const context of contexts) for (const sessionId of context.sessions) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const session = byId.get(sessionId);
    if (!session) continue;
    const ref = await deps.teams.sessionRef(sessionId);
    if (!ref) continue;
    const agent = agents.find(item => item.name === ref.ownerAgentId);
    const workspace = context.workspaceId ? projects.get(context.workspaceId) : undefined;
    const flags = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : undefined;
    items.push({ roomId: room.id, sessionId, ownerAgentId: ref.ownerAgentId,
     agentName: ref.ownerAgentId === "manager" ? "Manager" : agent ? agentDisplayName(agent) : ref.ownerAgentId,
     agentEnabled: agent?.enabled !== false, roomType: room.type, roomName: room.name ?? "",
     title: session.name ?? "", firstMessage: session.firstMessage, modifiedAt: session.modifiedAt,
     workspaceId: context.workspaceId ?? null, workspaceName: workspace?.name ?? (context.workspaceId ? "已移除项目" : "默认工作目录"),
     cwdSnapshot: context.cwdSnapshot, contextActive: context.contextActive,
     sourceSnapshotId: ref.sourceSnapshotId, pinned: flags?.pinned ?? false, archived: flags?.archived ?? false });
   }
  }
  return { items, revision: state.revision };
 });
 app.patch<{ Params: { roomId: string; sessionId: string }; Body: { pinned?: boolean; archived?: boolean } }>("/api/chat-navigation/:roomId/:sessionId", async (request, reply) => {
  const patch = request.body;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0
   || Object.entries(patch).some(([key, value]) => !["pinned", "archived"].includes(key) || typeof value !== "boolean")) return reply.code(400).send({ error: "只接受 pinned / archived 布尔值" });
  const context = await deps.teams.contextForSession(request.params.sessionId);
  if (!context || context.window.id !== request.params.roomId) return reply.code(404).send({ error: "会话不存在或不属于当前对话" });
  return metadata.update(request.params.sessionId, patch);
 });
}
