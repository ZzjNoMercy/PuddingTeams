import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { THINKING_LEVELS, thinkingLevelsFor } from "@/lib/model-catalog";

/**
 * 思考强度归一化枚举必须单一来源、且与服务端逐项一致。
 *
 * 历史上这份枚举被复制成多份且长度不一：pi Connector `configSchema` 的 enum 少了
 * `max`，于是 worker 表单选不到该档（Kimi K3 / GLM / DeepSeek 都支持），而 manager
 * 表单用另一份 7 档常量——同一平台两套选项。本测试锁住「四处必须一致」。
 */
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

test("pi Connector configSchema 的 thinkingLevel enum 与归一化枚举一致", () => {
	const source = read("apps/server/src/agent-runtime/pi-extension.ts");
	const match = source.match(/thinkingLevel:[\s\S]{0,400}?enum:\s*\[([^\]]+)\]/);
	assert.ok(match, "未能在 pi-extension.ts 找到 thinkingLevel enum");
	const declared = [...match[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
	assert.deepEqual(declared, [...THINKING_LEVELS], "Connector schema enum 必须与 THINKING_LEVELS 逐项一致");
});

test("服务端 manager 校验枚举与归一化枚举一致", () => {
	const source = read("apps/server/src/store/teams.ts");
	const match = source.match(/const levels = \[([^\]]+)\]/);
	assert.ok(match, "未能在 teams.ts 找到 manager thinking level 校验枚举");
	const declared = [...match[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
	assert.deepEqual(declared, [...THINKING_LEVELS], "teams.ts 校验枚举必须与 THINKING_LEVELS 逐项一致");
});

test("不得在别处再硬编码一份档位列表", () => {
	// 归一化枚举只允许在 model-catalog/types 里定义；其它命中应是服务端校验或 schema。
	const allowed = new Set([
		"apps/server/src/agent-runtime/pi-extension.ts",
		"apps/server/src/store/teams.ts",
	]);
	const suspects: string[] = [];
	for (const file of [
		"apps/web/src/components/agent-config/model-section.tsx",
		"apps/web/src/components/agents/manager-dialog.tsx",
		"apps/web/src/app/page.tsx",
		"apps/web/src/components/chat/composer.tsx",
		"apps/web/src/components/chat/worker-model-picker.tsx",
	]) {
		const source = read(file);
		if (/"off",\s*"minimal",\s*"low",\s*"medium",\s*"high"/.test(source) || /ALL_THINKING_LEVELS\s*=/.test(source)) {
			suspects.push(file);
		}
	}
	assert.deepEqual(suspects, [], `以下文件仍硬编码档位列表，应改用 THINKING_LEVELS/levelsFor：${suspects.join(", ")}`);
	assert.ok(allowed.size === 2);
});

test("thinkingLevelsFor 按模型收敛，未命中回退全集", () => {
	assert.deepEqual(thinkingLevelsFor(undefined), [...THINKING_LEVELS]);
	assert.deepEqual(thinkingLevelsFor(null), [...THINKING_LEVELS]);
	// 目录未就绪 / 未声明时回退全集，不臆断。
	assert.deepEqual(thinkingLevelsFor({}), [...THINKING_LEVELS]);
	// 非推理模型只有 off。
	assert.deepEqual(thinkingLevelsFor({ reasoning: false, thinkingLevels: ["off"] }), ["off"]);
	// 按模型 map 收敛（如 DeepSeek V4 Flash）。
	assert.deepEqual(thinkingLevelsFor({ reasoning: true, thinkingLevels: ["off", "low", "high", "max"] }), ["off", "low", "high", "max"]);
	// 调用方拿到副本，改它不会污染常量。
	const copy = thinkingLevelsFor({ reasoning: true, thinkingLevels: ["off", "high"] });
	copy.push("max");
	assert.deepEqual([...THINKING_LEVELS].length, 7);
});
