import { deleteRoom, deleteRoomSession, getRoom, listChatNavigation, updateChatNavigation } from "./api";
import type { ChatNavigationItem } from "./types";

type ArchiveDependencies = { list: typeof listChatNavigation; room: typeof getRoom; removeRoom: typeof deleteRoom; removeSession: typeof deleteRoomSession; update: typeof updateChatNavigation };
const api: ArchiveDependencies = { list: listChatNavigation, room: getRoom, removeRoom: deleteRoom, removeSession: deleteRoomSession, update: updateChatNavigation };

/** Re-read membership before destructive work; a last direct Session needs an atomic room guard. */
export async function applyArchivedChatAction(item: ChatNavigationItem, action: "restore" | "delete", deps: ArchiveDependencies = api): Promise<void> {
 const latest = (await deps.list()).items.find(current => current.roomId === item.roomId && current.sessionId === item.sessionId);
 if (!latest) throw new Error("聊天已移除，请刷新列表");
 if (!latest.archived) {
  if (action === "restore") return;
  throw new Error("聊天已在其他窗口恢复，已跳过删除");
 }
 if (action === "restore") { await deps.update(item.roomId, item.sessionId, { archived: false }); return; }
 const room = await deps.room(item.roomId);
 if (!room.pinned && room.sessions.length === 1 && room.sessions[0]?.id === item.sessionId) await deps.removeRoom(item.roomId, item.sessionId);
 else await deps.removeSession(item.roomId, item.sessionId);
}
