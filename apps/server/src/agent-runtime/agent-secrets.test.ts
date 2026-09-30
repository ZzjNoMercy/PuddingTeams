import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedAgentSecrets } from "./agent-secrets.js";
import type { AgentConfig } from "../store/teams.js";

test("Connector/Capability 运行环境只接收当前绑定引用的密钥", () => {
	const agent = {
		name: "worker",
		description: "Connector worker",
		connector: { extensionId: "conn", connectorId: "conn", transport: "spawn", config: {}, secretRefs: { CONN_KEY: "CONN_KEY" } },
		capabilityExtensions: [
			{ id: "a", extensionId: "cap", capabilityId: "cap", enabled: true, config: {}, secretRefs: { SHARED_KEY: "SHARED_KEY" } },
			{ id: "b", extensionId: "cap", capabilityId: "cap", enabled: true, config: {}, secretRefs: { SHARED_KEY: "SHARED_KEY" } },
		],
	} as AgentConfig;
	const stored = { CONN_KEY: "connector", SHARED_KEY: "shared", REMOVED_KEY: "orphan" };
	assert.deepEqual(scopedAgentSecrets(agent, stored), { CONN_KEY: "connector", SHARED_KEY: "shared" });
	const withoutFirst = { ...agent, capabilityExtensions: agent.capabilityExtensions!.slice(1) };
	assert.deepEqual(scopedAgentSecrets(withoutFirst, stored), { CONN_KEY: "connector", SHARED_KEY: "shared" });
	const disabledFirst = { ...agent, capabilityExtensions: [{ ...agent.capabilityExtensions![0]!, enabled: false }, agent.capabilityExtensions![1]!] };
	assert.deepEqual(scopedAgentSecrets(disabledFirst, stored), { CONN_KEY: "connector", SHARED_KEY: "shared" });
	const disabledBoth = { ...agent, capabilityExtensions: agent.capabilityExtensions!.map((binding) => ({ ...binding, enabled: false })) };
	assert.deepEqual(scopedAgentSecrets(disabledBoth, stored), { CONN_KEY: "connector" });
	assert.deepEqual(scopedAgentSecrets({ ...agent, capabilityExtensions: [] }, stored), { CONN_KEY: "connector" });
});

test("legacy command Worker 的通用密钥仍可进入运行环境", () => {
	const agent = { name: "legacy", description: "Legacy command worker", invoke: { type: "command", command: "worker", runArgs: [] } } as AgentConfig;
	assert.deepEqual(scopedAgentSecrets(agent, { LEGACY_TOKEN: "token" }), { LEGACY_TOKEN: "token" });
});
