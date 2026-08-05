import type { ModelSummary, ProviderSummary, SessionSummary } from "./types";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://127.0.0.1:8933";

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
