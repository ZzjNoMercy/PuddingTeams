import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyThinkingCapabilityOverrides, listCustomProvidersSnapshot, upsertCustomProvider, modelsJsonPath } from "./custom-providers.js";
import { thinkingCapabilityOverrides, toModelOverrideEntries } from "./thinking-capabilities.js";

/**
 * 思考强度能力表（§10.6）：平台经 pi 官方 models.json `modelOverrides` 顶层覆盖层
 * 修正上游目录与官方 API 文档不一致的模型。覆盖必须可重复执行、幂等，且不能被
 * 自定义 Provider 的整条替换写入静默抹掉。
 */
const savedEnv = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pt-thinking-cap-"));

function readRaw(): Record<string, any> {
	return JSON.parse(readFileSync(modelsJsonPath(), "utf8")) as Record<string, any>;
}

test.after(() => {
	if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedEnv;
});

test("能力声明只覆盖 DeepSeek 三档，不误伤其它 provider", () => {
	const overrides = toModelOverrideEntries();
	assert.equal(overrides["deepseek/deepseek-v4-flash"]?.supportsReasoningEffort, true);
	// 目录里本来就正确的模型不得被声明（否则会把上游修复回滚成平台判断）。
	for (const ref of Object.keys(overrides)) {
		assert.match(ref, /^deepseek\//, `非 DeepSeek 模型不应出现在能力表：${ref}`);
	}
	// 每条声明都要有可复核的文档来源。
	for (const [ref, entry] of Object.entries(thinkingCapabilityOverrides())) {
		assert.match(entry.source, /^https?:\/\//, `${ref} 缺少文档来源`);
	}
});

test("applyThinkingCapabilityOverrides 幂等，且保留用户手写的同模型 override", async () => {
	writeFileSync(modelsJsonPath(), JSON.stringify({
		providers: {
			deepseek: {
				modelOverrides: {
					"deepseek-v4-flash": { name: "我的 Flash", compat: { maxTokensField: "max_tokens" } },
				},
			},
		},
	}, null, 2), "utf8");

	const first = await applyThinkingCapabilityOverrides(toModelOverrideEntries());
	assert.ok(first.changed > 0, "首次应写入覆盖");

	const entry = readRaw().providers.deepseek.modelOverrides["deepseek-v4-flash"];
	assert.equal(entry.compat.supportsReasoningEffort, true, "平台声明应生效");
	assert.equal(entry.compat.maxTokensField, "max_tokens", "用户手写的同模型 compat 不得被抹掉");
	assert.equal(entry.name, "我的 Flash", "用户手写的其它 override 字段不得被抹掉");

	// 幂等：再跑一次不应产生变化。
	const second = await applyThinkingCapabilityOverrides(toModelOverrideEntries());
	assert.equal(second.changed, 0, "重复执行必须幂等");
});

test("自定义 Provider 整条替换不得抹掉 modelOverrides", async () => {
	await applyThinkingCapabilityOverrides(toModelOverrideEntries());
	assert.ok(readRaw().providers.deepseek?.modelOverrides, "前置条件：能力覆盖已写入");

	const snapshot = await listCustomProvidersSnapshot();
	await upsertCustomProvider("deepseek", {
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		api: "openai-completions",
		models: [{ id: "deepseek-v4-flash", reasoning: true }],
	}, snapshot.revision);

	const after = readRaw().providers.deepseek;
	assert.ok(after.modelOverrides, "整条替换后 modelOverrides 仍须保留");
	assert.equal(after.modelOverrides["deepseek-v4-flash"].compat.supportsReasoningEffort, true);
	assert.equal(after.name, "DeepSeek", "同 id 的可见字段仍应被更新");
	assert.ok(Array.isArray(after.models) && after.models.length === 1, "models 列表应被表单覆盖");
});
