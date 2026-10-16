/**
 * 会话深链（docs/2026-10-16-会话深链交接方案.md §P3）。
 *
 * puddingteams://rooms/<roomId>/sessions/<sessionId> 映射为同源的
 * /chats?room=..&session=.. 页面 URL。只接受这一种形态：其余一律返回
 * undefined，避免把任意外部 URL 装进窗口。与 obsidian-uri 同理，解析规则
 * 收敛在一个纯模块里，便于单测。
 */

const DEEP_LINK_PATTERN = /^puddingteams:\/\/rooms\/([\w-]+)\/sessions\/([\w-]+)\/?$/;

export function deepLinkToAppUrl(raw: string, baseAppUrl: string): string | undefined {
	const [, roomId, sessionId] = DEEP_LINK_PATTERN.exec(raw) ?? [];
	if (!roomId || !sessionId) return undefined;
	const target = new URL("/chats", baseAppUrl);
	target.searchParams.set("room", roomId);
	target.searchParams.set("session", sessionId);
	return target.toString();
}
