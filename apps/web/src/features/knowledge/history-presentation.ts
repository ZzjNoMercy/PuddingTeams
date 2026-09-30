interface HistoryIdentity {
	channel: string;
	actorId: string;
	actorName?: string;
	createdAt: string;
	acceptedAt: string;
}

/** The platform observer is a recorder, never evidence of the external file's actual author. */
export function historyActor(version: HistoryIdentity): string {
	return version.channel === "external_sync" ? "实际作者未知 · 平台观察" : version.actorName || version.actorId;
}

export function historyRecordedAt(version: HistoryIdentity): string {
	return version.channel === "external_sync" ? version.createdAt : version.acceptedAt;
}
