import type { AgentConfig, AgentConnectorBinding } from "@/lib/types";

export interface InitialConnectorSecrets {
	extensionId: string;
	connectorId: string;
	transport: AgentConnectorBinding["transport"];
	config: Record<string, unknown>;
	secrets: Record<string, string>;
}

export class AgentSetupUnconfirmedError extends Error {
	constructor(readonly agent: AgentConfig, readonly stage: "configure" | "enable", cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "AgentSetupUnconfirmedError";
	}
}

/** Keep a new Worker disabled until its separately stored secrets are confirmed. */
export async function createAgentWithInitialSecrets(
	agent: AgentConfig,
	secretInput: InitialConnectorSecrets | null,
	ports: {
		create: (input: AgentConfig) => Promise<AgentConfig>;
		configure: (name: string, input: InitialConnectorSecrets, expectedRevision: number) => Promise<{ revision: number }>;
		enable: (name: string, expectedRevision: number) => Promise<unknown>;
	},
): Promise<AgentConfig> {
	const created = await ports.create(secretInput ? { ...agent, enabled: false } : agent);
	if (!secretInput) return created;
	let configuredRevision: number;
	try {
		const configured = await ports.configure(created.name, secretInput, created.extensionRevision ?? 0);
		configuredRevision = configured.revision;
	} catch (cause) {
		throw new AgentSetupUnconfirmedError(created, "configure", cause);
	}
	if (agent.enabled !== false) {
		try { await ports.enable(created.name, configuredRevision); }
		catch (cause) { throw new AgentSetupUnconfirmedError(created, "enable", cause); }
	}
	return created;
}
