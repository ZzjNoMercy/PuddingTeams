import type { AgentConfig } from "../store/teams.js";

/** Connector/Capability workers receive only secrets named by their current bindings. */
export function scopedAgentSecrets(agent: AgentConfig, stored: Record<string, string>): Record<string, string> {
	// Legacy command workers use the Agent-level Secrets editor rather than binding refs.
	if (!agent.connector && agent.invoke?.type === "command") return stored;
	const allowed = new Set<string>(Object.keys(agent.connector?.secretRefs ?? {}));
	for (const binding of agent.capabilityExtensions ?? []) {
		if (!binding.enabled) continue;
		for (const key of Object.keys(binding.secretRefs ?? {})) allowed.add(key);
	}
	return Object.fromEntries(Object.entries(stored).filter(([key]) => allowed.has(key)));
}
