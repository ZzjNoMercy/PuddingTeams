import { test } from "node:test";
import assert from "node:assert/strict";
import { configTransferFromDraft, draftWithConfigTransfer, parseConfigTransfer } from "./config-transfer.js";
import { buildConfigBody, draftFromAgent } from "./draft.js";
import type { AgentConfig } from "../../lib/types.js";

test("配置导入只接受可用于草稿的嵌套字段", () => {
	const transfer = parseConfigTransfer({
		description: "Worker",
		responsibility: { domain: "code", owns: ["实现"], excludes: [], escalateWhen: ["需审批"] },
		manager: { model: "openai/example", thinkingLevel: "high", builtinTools: true },
		piResources: { skillPaths: ["/skills/a"], enabledSkills: ["a"], loadWorkspaceContext: false },
	}, "manager");
	assert.equal(transfer.description, "Worker");
	assert.deepEqual(transfer.responsibility?.owns, ["实现"]);
	assert.deepEqual(transfer.piResources?.skillPaths, ["/skills/a"]);
	for (const value of [
		{ responsibility: [] },
		{ responsibility: { owns: ["实现"] } },
		{ responsibility: { owns: "bad" } },
		{ responsibility: { excludes: [1] } },
		{ manager: null },
		{ manager: { builtinTools: "true" } },
		{ manager: { thinkingLevel: "ultra" } },
		{ connectorConfig: [] },
		{ piResources: { enabledSkills: "bad" } },
		{ piResources: { loadWorkspaceContext: "false" } },
	]) assert.throws(() => parseConfigTransfer(value, "manager"));
});

test("导入须有适用字段，且不把其他 Agent 类型的配置静默丢弃", () => {
	for (const value of [{}, { secrets: { API_KEY: "secret" } }, { connectorConfig: { model: "openai/example" } }])
		assert.throws(() => parseConfigTransfer(value, "manager"));
	assert.throws(() => parseConfigTransfer({ description: "改名", manager: { model: "openai/example" } }, "worker"));
	assert.throws(() => parseConfigTransfer({ description: "改名", secrets: { API_KEY: "secret" } }, "worker"));
	assert.throws(() => parseConfigTransfer({ manager: { model: "openai/example", apiKey: "secret" } }, "manager"));
	assert.throws(() => parseConfigTransfer({ connectorConfig: { model: "openai/example", apiKey: "secret" } }, "worker"));
	assert.throws(() => parseConfigTransfer({ connectorConfig: [] }, "worker"));
	for (const config of [{ model: 1 }, { sessionDir: [] }, { thinkingLevel: "ultra" }])
		assert.throws(() => parseConfigTransfer({ connectorConfig: config }, "worker"));
	assert.deepEqual(parseConfigTransfer({ description: "" }, "worker"), { description: "" });
	assert.deepEqual(parseConfigTransfer({ connectorConfig: { model: "openai/example" } }, "worker").connectorConfig, { model: "openai/example" });
});

test("Pi Worker 代码搜索策略随配置 JSON 往返，Manager 不接收 Worker 策略", () => {
	const worker = {
		name: "builder", description: "Worker", pinned: false, codeSearch: "fff",
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: { model: "openai/example" } },
	} as AgentConfig;
	const exported = configTransferFromDraft(worker, draftFromAgent(worker));
	assert.equal(exported.codeSearch, "fff");
	const imported = parseConfigTransfer(JSON.parse(JSON.stringify(exported)) as unknown, "worker");
	const target = { ...draftFromAgent(worker), codeSearch: "inherit" as const };
	const importedDraft = draftWithConfigTransfer(target, imported);
	assert.equal(importedDraft.codeSearch, "fff");
	assert.equal(buildConfigBody(worker, importedDraft).codeSearch, "fff");
	assert.throws(() => parseConfigTransfer({ codeSearch: "off" }, "worker"));
	assert.throws(() => parseConfigTransfer(exported, "manager"));
	const manager = { name: "manager", description: "Manager", pinned: true, manager: { codeSearch: "off" } } as AgentConfig;
	assert.equal(configTransferFromDraft(manager, draftFromAgent(manager)).codeSearch, undefined);
});
