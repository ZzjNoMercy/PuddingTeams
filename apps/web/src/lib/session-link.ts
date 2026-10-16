import { getDesktopBridge } from "./desktop";

/**
 * 会话分享链接（docs/2026-10-16-会话深链交接方案.md §2）：
 * - 桌面端：puddingteams://rooms/<roomId>/sessions/<sessionId>，点击可拉起客户端；
 * - 浏览器：同源 /chats?room=..&session=.. 查询串。
 * 两种形态都在 session_read 的识别范围内，贴给 Agent 都能回读。
 */
export function sessionShareLink(roomId: string, sessionId: string): string {
	if (getDesktopBridge()?.isDesktop) {
		return `puddingteams://rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}`;
	}
	return `${window.location.origin}/chats?room=${encodeURIComponent(roomId)}&session=${encodeURIComponent(sessionId)}`;
}
