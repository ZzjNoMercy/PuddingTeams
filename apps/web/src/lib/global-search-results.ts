import { agentDisplayName, type AgentConfig, type ManagerWorkIndexItem, type RoomSummary } from "./types";

export type SearchResult = { id: string; title: string; description: string; href: string; kind: "work" | "chat" | "agent"; haystack: string };

export function sessionTitle(name: string | undefined, firstMessage: string): string | null {
	return [name, firstMessage]
		.map((value) => value?.trim())
		.find((title) => title && title !== "新对话" && title !== "(no messages)") ?? null;
}

export function roomResults(rooms: RoomSummary[]): SearchResult[] {
	return rooms.flatMap<SearchResult>((room) => {
		const workspace = room.workspace?.name ?? "默认工作目录";
		if (room.type === "solo") return room.sessions.flatMap((session) => {
			if (!sessionTitle(undefined, session.firstMessage)) return [];
			const title = sessionTitle(session.name, session.firstMessage);
			return title ? [{ id: `work:${session.id}`, title, description: `Manager 工作 · ${workspace}${session.firstMessage !== title ? ` · ${session.firstMessage}` : ""}`, href: `/?session=${encodeURIComponent(session.id)}`, kind: "work" as const, haystack: `${title} ${session.firstMessage} ${workspace}` }] : [];
		});
		const title = room.name?.trim() || room.members.map(agentDisplayName).join("、") || "对话";
		const description = `${room.type === "group" ? "群聊" : "单聊"} · ${workspace}${room.lastMessagePreview ? ` · ${room.lastMessagePreview}` : ""}`;
		const roomRow: SearchResult = { id: `chat:${room.id}`, title, description, href: `/chats?room=${encodeURIComponent(room.id)}`, kind: "chat", haystack: `${title} ${description} ${room.members.map(agentDisplayName).join(" ")}` };
		const sessions = room.sessions.flatMap((session) => {
			const label = sessionTitle(session.name, session.firstMessage);
			return label ? [{ id: `chat:${room.id}:${session.id}`, title: label, description: `${title} · ${workspace} · 历史会话${session.firstMessage !== label ? ` · ${session.firstMessage}` : ""}`, href: `/chats?room=${encodeURIComponent(room.id)}&session=${encodeURIComponent(session.id)}`, kind: "chat" as const, haystack: `${label} ${session.firstMessage} ${title} ${workspace}` }] : [];
		});
		return [roomRow, ...sessions];
	});
}

export function managerWorkResults(works: ManagerWorkIndexItem[]): SearchResult[] {
	return works.map((work) => ({
		id: `work:${work.sessionId}`,
		title: work.title,
		description: `Manager 工作 · ${work.workspaceName}${work.firstMessage !== work.title ? ` · ${work.firstMessage}` : ""}`,
		href: `/?session=${encodeURIComponent(work.sessionId)}`,
		kind: "work",
		haystack: `${work.title} ${work.firstMessage} ${work.workspaceName}`,
	}));
}

export function agentResults(agents: AgentConfig[]): SearchResult[] {
	return agents.map((agent) => ({
		id: `agent:${agent.name}`,
		title: agentDisplayName(agent),
		description: `智能体 · ${agent.description || agent.name}`,
		href: `/agents/config?name=${encodeURIComponent(agent.name)}`,
		kind: "agent",
		haystack: `${agent.name} ${agentDisplayName(agent)} ${agent.description}`,
	}));
}

export function filterSearchResults(items: SearchResult[], query: string): SearchResult[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return items.slice(0, 20);
	return items.flatMap((item, index) => {
		if (!item.haystack.toLocaleLowerCase().includes(needle)) return [];
		const title = item.title.toLocaleLowerCase();
		const rank = title === needle ? 0 : title.startsWith(needle) ? 1 : title.includes(needle) ? 2 : 3;
		return [{ item, index, rank }];
	}).sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, 20).map(({ item }) => item);
}

/** Keep the Manager return target when search switches between Worker chats. */
export function withManagerReturn(href: string, returnSessionId: string | null): string {
	if (!returnSessionId || !href.startsWith("/chats?")) return href;
	const params = new URLSearchParams(href.slice("/chats?".length));
	params.set("returnSession", returnSessionId);
	return `/chats?${params.toString()}`;
}
