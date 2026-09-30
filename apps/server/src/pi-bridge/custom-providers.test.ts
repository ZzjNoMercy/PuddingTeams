import { test, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	deleteCustomProvider,
	listCustomProviders,
	listCustomProvidersSnapshot,
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
			{ id: "qwen3-32b", name: "Qwen3 32B", reasoning: true, vision: true },
			{ id: "qwen3-8b", contextWindow: 32_768, maxTokens: 4_096 },
		],
	});
	assert.equal(saved.baseUrl, "https://vllm.internal/v1", "baseUrl 尾斜杠归一化");

	const list = await listCustomProviders();
	assert.equal(list.length, 1);
	assert.equal(list[0]!.id, "my-vllm");
	assert.equal(list[0]!.models.length, 2);
	assert.equal(list[0]!.models[0]!.reasoning, true);
	assert.equal(list[0]!.models[0]!.vision, true);
	assert.equal(list[0]!.models[1]!.vision, false);
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

test("自定义 Provider 目录旧版本拒绝覆盖与删除，删除前置副作用不执行", async () => {
	const input = { name: "versioned", baseUrl: "http://localhost:1/v1", api: "openai-completions", models: [{ id: "m" }] };
	const before = await listCustomProvidersSnapshot();
	await upsertCustomProvider("versioned", input, before.revision);
	let sideEffects = 0;
	await assert.rejects(() => upsertCustomProvider("versioned", { ...input, name: "stale" }, before.revision), /目录已变化/);
	await assert.rejects(() => deleteCustomProvider("versioned", before.revision, async () => { sideEffects += 1; }), /目录已变化/);
	assert.equal(sideEffects, 0);
	assert.equal((await listCustomProviders()).find((provider) => provider.id === "versioned")?.name, "versioned");
	const current = await listCustomProvidersSnapshot();
	assert.equal(await deleteCustomProvider("versioned", current.revision, async () => { sideEffects += 1; }), true);
	assert.equal(sideEffects, 1);
});

test("自定义 provider：参数校验（id/baseUrl/模型）", async () => {
	const base = { name: "x", baseUrl: "http://localhost/v1", api: "openai-completions", models: [{ id: "m" }] };
	await assert.rejects(() => upsertCustomProvider("Bad_Id", base), /非法/);
	await assert.rejects(() => upsertCustomProvider("ok-id", { ...base, baseUrl: "ftp://x" }), /http/);
	await assert.rejects(() => upsertCustomProvider("ok-id", { ...base, models: [] }), /至少/);
	await assert.rejects(() => upsertCustomProvider("ok-id", { ...base, models: [{ id: "m", vision: "yes" as never }] }), /图片/);
	await assert.rejects(
		() => upsertCustomProvider("ok-id", { ...base, models: [{ id: "m" }, { id: "m" }] }),
		/重复/,
	);
});

test("并发登记不同自定义 Provider 不丢失其他条目或争用临时文件", async () => {
	const ids = Array.from({ length: 20 }, (_, index) => `parallel-${index}`);
	await Promise.all(ids.map((id) => upsertCustomProvider(id, {
		name: id,
		baseUrl: `http://127.0.0.1/${id}`,
		api: "openai-completions",
		models: [{ id: "fixture" }],
	})));
	const found = new Set((await listCustomProviders()).map((provider) => provider.id));
	for (const id of ids) assert.equal(found.has(id), true, `丢失 ${id}`);
	const extras = Array.from({ length: 10 }, (_, index) => `parallel-extra-${index}`);
	await Promise.all([
		...ids.slice(0, 10).map((id) => deleteCustomProvider(id)),
		...extras.map((id) => upsertCustomProvider(id, {
			name: id,
			baseUrl: `http://127.0.0.1/${id}`,
			api: "openai-completions",
			models: [{ id: "fixture" }],
		})),
	]);
	const after = new Set((await listCustomProviders()).map((provider) => provider.id));
	for (const id of ids.slice(0, 10)) assert.equal(after.has(id), false, `未删除 ${id}`);
	for (const id of [...ids.slice(10), ...extras]) assert.equal(after.has(id), true, `丢失 ${id}`);
	assert.equal(readdirSync(path.dirname(modelsJsonPath())).some((name) => name.startsWith("models.json.tmp-")), false);
});

test("外部写入损坏的 Provider 结构时拒绝读取和改写原文件", async () => {
	const file = modelsJsonPath();
	const original = readFileSync(file, "utf8");
	const input = { name: "safe", baseUrl: "http://127.0.0.1/v1", api: "openai-completions", models: [{ id: "model" }] };
	let sideEffects = 0;
	try {
		for (const malformed of [
			'{"providers":',
			'{"providers":[]}',
			'{"providers":"invalid"}',
			'{"providers":{"existing":null}}',
			'{"providers":{"existing":{"models":"invalid"}}}',
			'{"providers":{"existing":{"models":[null]}}}',
			'{"providers":{"existing":{"models":[{}]}}}',
		]) {
			writeFileSync(file, malformed);
			await assert.rejects(() => listCustomProvidersSnapshot(), /models.json/);
			await assert.rejects(() => upsertCustomProvider("safe", input), /models.json/);
			await assert.rejects(() => deleteCustomProvider("existing", undefined, async () => { sideEffects += 1; }), /models.json/);
			assert.equal(readFileSync(file, "utf8"), malformed, "不能以静默清洗后的结构覆盖外部文件");
		}
		assert.equal(sideEffects, 0, "目录损坏时不能先撤销凭证");
	} finally {
		writeFileSync(file, original);
	}
});
