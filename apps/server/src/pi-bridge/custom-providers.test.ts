import { test, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	deleteCustomProvider,
	listCustomProviders,
	modelsJsonPath,
	upsertCustomProvider,
} from "./custom-providers.js";

/**
 * 自定义 Provider 控制面（models.json）测试。通过 PI_CODING_AGENT_DIR 指向
 * 临时目录，绝不触碰真实 ~/.pi/agent/models.json。
 */

let savedEnv: string | undefined;

before(() => {
	savedEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "pt-models-json-"));
});

after(() => {
	if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedEnv;
});

test("自定义 provider：upsert → list 回读，原子写 + 0600", async () => {
	const saved = await upsertCustomProvider("my-vllm", {
		name: "内网 vLLM",
		baseUrl: "https://vllm.internal/v1/",
		api: "openai-completions",
		models: [
			{ id: "qwen3-32b", name: "Qwen3 32B", reasoning: true },
			{ id: "qwen3-8b", contextWindow: 32_768, maxTokens: 4_096 },
		],
	});
	assert.equal(saved.baseUrl, "https://vllm.internal/v1", "baseUrl 尾斜杠归一化");

	const list = await listCustomProviders();
	assert.equal(list.length, 1);
	assert.equal(list[0]!.id, "my-vllm");
	assert.equal(list[0]!.models.length, 2);
	assert.equal(list[0]!.models[0]!.reasoning, true);
	assert.equal(list[0]!.models[1]!.contextWindow, 32_768);

	// 0600
	const mode = statSync(modelsJsonPath()).mode & 0o777;
	assert.equal(mode, 0o600, "models.json 必须 0600");
});

test("自定义 provider：upsert 同 id 整体替换；delete 后消失", async () => {
	await upsertCustomProvider("replace-me", {
		name: "v1",
		baseUrl: "http://localhost:1/v1",
		api: "openai-completions",
		models: [{ id: "a" }, { id: "b" }],
	});
	await upsertCustomProvider("replace-me", {
		name: "v2",
		baseUrl: "http://localhost:2/v1",
		api: "openai-responses",
		models: [{ id: "c" }],
	});
	let list = await listCustomProviders();
	const found = list.find((p) => p.id === "replace-me");
	assert.equal(found?.name, "v2");
	assert.deepEqual(found?.models.map((m) => m.id), ["c"], "整体替换而不是合并");

	assert.equal(await deleteCustomProvider("replace-me"), true);
	list = await listCustomProviders();
	assert.equal(list.some((p) => p.id === "replace-me"), false);
	assert.equal(await deleteCustomProvider("replace-me"), false, "重复删除返回 false");
});

test("自定义 provider：参数校验（id/baseUrl/模型）", async () => {
	const base = { name: "x", baseUrl: "http://localhost/v1", api: "openai-completions", models: [{ id: "m" }] };
	await assert.rejects(() => upsertCustomProvider("Bad_Id", base), /非法/);
	await assert.rejects(() => upsertCustomProvider("ok-id", { ...base, baseUrl: "ftp://x" }), /http/);
	await assert.rejects(() => upsertCustomProvider("ok-id", { ...base, models: [] }), /至少/);
	await assert.rejects(
		() => upsertCustomProvider("ok-id", { ...base, models: [{ id: "m" }, { id: "m" }] }),
		/重复/,
	);
});
