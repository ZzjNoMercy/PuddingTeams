import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSetupUnconfirmedError, createAgentWithInitialSecrets, type InitialConnectorSecrets } from "./create-agent-flow.js";
import type { AgentConfig } from "../../lib/types.js";

const agent = { name: "worker", enabled: true, extensionRevision: 1 } as AgentConfig;
const secretInput = { extensionId: "connector", connectorId: "driver", transport: "spawn" as const, config: {}, secrets: { TOKEN: "secret" } };

test("凭证提交失败后新 Worker 保持停用并暴露已创建身份", async () => {
	const calls: string[] = [];
	await assert.rejects(
		createAgentWithInitialSecrets(agent, secretInput, {
			create: async (input) => { calls.push(`create:${input.enabled}`); return input; },
			configure: async () => { calls.push("configure"); throw new Error("credential store unavailable"); },
			enable: async () => { calls.push("enable"); },
		}),
		(error: unknown) => error instanceof AgentSetupUnconfirmedError && error.agent.name === "worker" && error.stage === "configure" && error.message === "credential store unavailable",
	);
	assert.deepEqual(calls, ["create:false", "configure"]);
});

test("有凭证时只在配置完成后启用；无凭证时直接按用户选择创建", async () => {
	const calls: string[] = [];
	const ports = {
		create: async (input: AgentConfig) => { calls.push(`create:${input.enabled}`); return input; },
		configure: async (_name: string, _input: InitialConnectorSecrets, revision: number) => { calls.push(`configure:${revision}`); return { revision: 2 }; },
		enable: async (_name: string, revision: number) => { calls.push(`enable:${revision}`); },
	};
	await createAgentWithInitialSecrets(agent, secretInput, ports);
	assert.deepEqual(calls, ["create:false", "configure:1", "enable:2"]);
	calls.length = 0;
	await createAgentWithInitialSecrets(agent, null, ports);
	assert.deepEqual(calls, ["create:true"]);
});

test("启用响应失败时标明结果未确认，避免把重试误当新建", async () => {
	const calls: string[] = [];
	await assert.rejects(
		createAgentWithInitialSecrets(agent, secretInput, {
			create: async (input) => { calls.push(`create:${input.enabled}`); return input; },
			configure: async () => { calls.push("configure"); return { revision: 2 }; },
			enable: async () => { calls.push("enable"); throw new Error("enable response lost"); },
		}),
		(error: unknown) => error instanceof AgentSetupUnconfirmedError && error.agent.name === "worker" && error.stage === "enable",
	);
	assert.deepEqual(calls, ["create:false", "configure", "enable"]);
});
