interface HistoryIdentity {
	channel: string;
	actorId: string;
	actorName?: string;
	createdAt: string;
	acceptedAt: string;
}

/** The platform observer is a recorder, never evidence of the external file's actual author. */
export function historyActor(version: HistoryIdentity): string {
	if (version.channel === "external_sync") return "实际作者未知 · 平台观察";
	const name = version.actorName || (version.actorId.startsWith("local:") ? "你" : version.actorId);
	return version.channel === "agent_publish" ? `${name}（确认发布）` : name;
}

export function historyRecordedAt(version: HistoryIdentity): string {
	return version.channel === "external_sync" ? version.createdAt : version.acceptedAt;
}
