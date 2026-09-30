import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaPresetAgents, TEAMS_SCHEMA_PRESET_AGENTS } from "./schema-guidance.js";
import { TEAMS_SCHEMA_PRESETS, validateTeamsSchema } from "./schema-presets.js";

test("每份操作契约都对应一个已存在的结构预置", () => {
	for (const presetId of Object.keys(TEAMS_SCHEMA_PRESET_AGENTS)) {
		assert.ok(TEAMS_SCHEMA_PRESETS[presetId], `契约 ${presetId} 没有对应的结构预置`);
		assert.deepEqual(validateTeamsSchema(TEAMS_SCHEMA_PRESETS[presetId]!), []);
	}
	assert.equal(schemaPresetAgents("ghost"), undefined);
});

test("人脉契约不复述结构表，只声明操作与证据边界", () => {
	const agents = schemaPresetAgents("people")!;
	for (const item of TEAMS_SCHEMA_PRESETS.people!.entities) {
		assert.ok(!agents.includes(`${item.type}/`), `契约不应复述结构表：${item.directory}`);
	}
	assert.match(agents, /wiki\.schema\.json/);
	assert.match(agents, /不得用模型既有知识补全/);
	assert.match(agents, /禁止推断敏感属性/);
	assert.match(agents, /## Lint（检查）/);
	for (const presetId of Object.keys(TEAMS_SCHEMA_PRESET_AGENTS)) {
		assert.ok(schemaPresetAgents(presetId)!.endsWith("\n"), `${presetId} 契约应以换行结尾，落盘后 diff 干净`);
	}
});

test("研究契约要求来源可追溯、署名不可互换，且不复述结构表", () => {
	const agents = schemaPresetAgents("research")!;
	for (const item of TEAMS_SCHEMA_PRESETS.research!.entities) {
		assert.ok(!agents.includes(`${item.directory}/`), `契约不应复述结构表：${item.directory}`);
	}
	assert.match(agents, /\`sources\` 必填/);
	assert.match(agents, /不得把发布渠道、账号名和自然人身份互换/);
	assert.match(agents, /模型既有知识不能作为补充证据/);
	assert.match(agents, /## Lint（检查）/);
});
