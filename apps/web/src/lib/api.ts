import type { AgentConfig, ModelSummary, ProviderSummary, RoomSummary, SessionSummary, WorkerProbeResult } from "./types";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://127.0.0.1:8933";

export interface HealthInfo {
	ok: boolean;
	service: string;
	/** Bundled pi SDK version; omitted when the server cannot resolve it. */
	piVersion?: string;
}

export async function getHealth(): Promise<HealthInfo> {
	const res = await fetch(`${SERVER_URL}/api/health`);
	if (!res.ok) throw new Error(`health check failed: ${res.status}`);
	return (await res.json()) as HealthInfo;
}

export async function listSessions(): Promise<SessionSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/sessions`);
	if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
	return ((await res.json()) as { sessions: SessionSummary[] }).sessions;
}

export async function listModels(): Promise<ModelSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/models`);
	if (!res.ok) throw new Error(`list models failed: ${res.status}`);
	return ((await res.json()) as { models: ModelSummary[] }).models;
}

/** Full catalog models for one provider (no auth needed), matching its modelCount. */
export async function listProviderModels(providerId: string): Promise<ModelSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/providers/${providerId}/models`);
	if (!res.ok) throw new Error(`list provider models failed: ${res.status}`);
	return ((await res.json()) as { models: ModelSummary[] }).models;
}

export async function listProviders(): Promise<ProviderSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/providers`);
	if (!res.ok) throw new Error(`list providers failed: ${res.status}`);
	return ((await res.json()) as { providers: ProviderSummary[] }).providers;
}

export async function setProviderKey(providerId: string, apiKey: string): Promise<number> {
	const res = await fetch(`${SERVER_URL}/api/providers/${providerId}/key`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ apiKey }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `set api key failed: ${res.status}`);
	}
	return ((await res.json()) as { ok: boolean; availableCount: number }).availableCount;
}

export async function deleteProviderKey(providerId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/providers/${providerId}/key`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete api key failed: ${res.status}`);
}

/** Fired on window after provider keys change so the composer picker refetches. */
export const MODELS_CHANGED_EVENT = "puddingteams:models-changed";

export async function createSession(model?: string): Promise<SessionSummary> {
	const res = await fetch(`${SERVER_URL}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(model ? { model } : {}),
	});
	if (!res.ok) throw new Error(`create session failed: ${res.status}`);
	return ((await res.json()) as { session: SessionSummary }).session;
}

export async function deleteSession(sessionId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete session failed: ${res.status}`);
}

export async function setSessionModel(sessionId: string, model: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `set model failed: ${res.status}`);
	}
}

export async function fetchMessages(sessionId: string): Promise<unknown[]> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`);
	if (!res.ok) throw new Error(`fetch messages failed: ${res.status}`);
	return ((await res.json()) as { messages: unknown[] }).messages;
}

export async function sendMessage(sessionId: string, content: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content }),
	});
	if (!res.ok) throw new Error(`send message failed: ${res.status}`);
}

export async function abortSession(sessionId: string): Promise<void> {
	await fetch(`${SERVER_URL}/api/sessions/${sessionId}/abort`, { method: "POST" });
}

export function sessionWsUrl(sessionId: string): string {
	return `${SERVER_URL.replace(/^http/, "ws")}/api/sessions/${sessionId}/ws`;
}

export async function getSettings(): Promise<{
	defaultProvider?: string;
	defaultModel?: string;
}> {
	const res = await fetch(`${SERVER_URL}/api/settings`);
	if (!res.ok) throw new Error(`get settings failed: ${res.status}`);
	return (await res.json()) as { defaultProvider?: string; defaultModel?: string };
}

export async function setDefaultModel(provider: string, model: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/settings/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider, model }),
	});
	if (!res.ok) throw new Error(`set default model failed: ${res.status}`);
}

// ---- agents registry (teams.json) ----

export async function listAgents(): Promise<AgentConfig[]> {
	const res = await fetch(`${SERVER_URL}/api/agents`);
	if (!res.ok) throw new Error(`list agents failed: ${res.status}`);
	return ((await res.json()) as { agents: AgentConfig[] }).agents;
}

export async function createAgent(agent: AgentConfig): Promise<AgentConfig> {
	const res = await fetch(`${SERVER_URL}/api/agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(agent),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `create agent failed: ${res.status}`);
	}
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

export async function updateAgent(name: string, agent: AgentConfig): Promise<AgentConfig> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(agent),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `update agent failed: ${res.status}`);
	}
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

export async function deleteAgent(name: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete agent failed: ${res.status}`);
}

export async function probeAgent(name: string): Promise<WorkerProbeResult> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/probe`, { method: "POST" });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `probe failed: ${res.status}`);
	}
	return ((await res.json()) as { probe: WorkerProbeResult }).probe;
}

// ---- rooms ----

export async function listRooms(): Promise<RoomSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/rooms`);
	if (!res.ok) throw new Error(`list rooms failed: ${res.status}`);
	return ((await res.json()) as { rooms: RoomSummary[] }).rooms;
}

export async function getRoom(sessionId: string): Promise<RoomSummary> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${sessionId}`);
	if (!res.ok) throw new Error(`get room failed: ${res.status}`);
	return ((await res.json()) as { room: RoomSummary }).room;
}

export async function updateRoom(
	sessionId: string,
	patch: { name?: string; agents?: string[] },
): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${sessionId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`update room failed: ${res.status}`);
}

/** Create a new pi session inside a room and make it the active one. */
export async function createRoomSession(roomId: string): Promise<SessionSummary> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/sessions`, { method: "POST" });
	if (!res.ok) throw new Error(`create room session failed: ${res.status}`);
	return ((await res.json()) as { session: SessionSummary }).session;
}

/** Switch the active pi session of a room. */
export async function setActiveRoomSession(roomId: string, sessionId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/sessions/${sessionId}/activate`, {
		method: "POST",
	});
	if (!res.ok) throw new Error(`switch session failed: ${res.status}`);
}
