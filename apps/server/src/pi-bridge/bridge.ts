import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * pi events are JSON-serializable in practice (message/tool data only), but
 * custom message types may embed non-serializable payloads. Guard every event
 * so one bad event can't kill the WS stream.
 */
export function serializePiEvent(event: AgentSessionEvent): string | null {
	try {
		return JSON.stringify(event);
	} catch {
		return null;
	}
}
