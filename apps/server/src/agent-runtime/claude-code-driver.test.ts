import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExtensionManifest, ExtensionCatalog } from "./extensions.js";
import { DriverRegistry } from "./driver-registry.js";
import { ExtensionRegistry } from "./extension-registry.js";
import { ClaudeCodeDriver, createDriver } from "@puddingteams/connector-claude-code/driver";
import { ClaudeCodeEventReducer, CLAUDE_CODE_CAPABILITIES } from "@puddingteams/connector-claude-code/core/claude-code-normalize";
import type { AgentEvent, InvocationContext } from "./types.js";

/**
 * 路线图 P1/P2：Claude Code Connector——装配级 + 归一化测试。
 * 不触发真实 claude -p 执行（需要本机登录态），这里锁定 capability
 * 诚实声明、折叠 manifest（package.json puddingteams 字段）合法性、
 * 工厂多实例、防御性 respond/cancel、probe 形状，以及用实测 JSONL
 * 样本锁定归一化行为。Driver 本体在 extensions/connectors/claude-code（§9.5）。
 */

/** 双宿主包目录（仓库内路径安装的来源）。 */
const CLAUDE_PACKAGE_DIR = path.resolve(import.meta.dirname, "../../../../extensions/connectors/claude-code");

function claudeManifestFromPackage(): Record<string, unknown> {
	const pkg = JSON.parse(readFileSync(path.join(CLAUDE_PACKAGE_DIR, "package.json"), "utf-8")) as Record<string, unknown>;
	return pkg.puddingteams as Record<string, unknown>;
}

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

const ctx: InvocationContext = { cwd: process.cwd(), env: {} };

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

test("P1: claude-code 能力诚实声明——run/continue/cancel、无 HITL、stream、spawn", async () => {
	const driver = new ClaudeCodeDriver();
	assert.deepEqual(await driver.capabilities(), {
		operations: ["run", "continue", "cancel"],
		interactionKinds: [],
		progress: "stream",
		transport: "spawn",
	});
	assert.deepEqual(await driver.capabilities(), CLAUDE_CODE_CAPABILITIES);
});

test("P1/P2: claude-code 折叠 manifest（package.json puddingteams 字段）通过校验", () => {
	const parsed = parseExtensionManifest(claudeManifestFromPackage());
	assert.equal(parsed.kind, "connector");
	assert.equal(parsed.source, "trusted");
	assert.equal(parsed.entry, "driver/index.ts");
	if (parsed.kind !== "connector") return;
	assert.equal(parsed.connector.id, "claude-code");
	assert.equal(parsed.connector.defaultTransport, "spawn");
	assert.deepEqual(parsed.connector.supportedTransports, ["spawn"]);
	assert.deepEqual(parsed.permissions, ["spawn", "secrets"]);
	assert.equal(parsed.connector.avatar, "assets/claude-code.svg");
	const props = (parsed.connector.configSchema as { properties?: Record<string, unknown> }).properties ?? {};
	for (const key of ["command", "model", "permissionMode", "systemPrompt", "allowedTools"]) {
		assert.ok(props[key], `configSchema 缺 ${key}`);
	}
	assert.equal((props.model as Record<string, unknown>)["x-puddingteams-options"], "driver");
	// ANTHROPIC_API_KEY 可选（本机 claude 登录态优先）。
	assert.equal(parsed.connector.secretSchema?.[0]?.key, "ANTHROPIC_API_KEY");
	assert.equal(parsed.connector.secretSchema?.[0]?.required, false);
});

test("Claude Code 配置模型下拉：合并官方别名、本机 allowlist 与模型映射", async () => {
	const home = freshDir("claude-model-home-");
	const cwd = freshDir("claude-model-cwd-");
	mkdirSync(path.join(home, ".claude"), { recursive: true });
	mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
		availableModels: ["sonnet", "company-opus"],
		model: "sonnet",
		modelOverrides: { "company-opus": "gateway/opus-prod" },
		env: {
			ANTHROPIC_DEFAULT_SONNET_MODEL: "gateway/sonnet-prod",
			ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Company Sonnet",
		},
	}));
	writeFileSync(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({
		availableModels: ["haiku"],
	}));
	const options = await new ClaudeCodeDriver().listConfigOptions("model", { cwd, env: { HOME: home } });
	assert.deepEqual(options.map((option) => option.value), ["sonnet", "company-opus", "haiku"]);
	assert.equal(options[0]?.label, "Sonnet · Company Sonnet");
	assert.equal(options[0]?.isDefault, true);
	assert.equal(options[1]?.description, "company-opus 由 Claude Code 映射到 gateway/opus-prod");
	assert.deepEqual(await new ClaudeCodeDriver().listConfigOptions("unknown", { cwd, env: { HOME: home } }), []);
});

test("P1: claude-code driverFactory 多实例——同一 Connector 按 config 构造独立 Driver", () => {
	const a = createDriver({ model: "claude-sonnet-4-5", permissionMode: "acceptEdits" });
	const b = createDriver({ systemPrompt: "你是测试 worker" });
	assert.ok(a instanceof ClaudeCodeDriver);
	assert.ok(b instanceof ClaudeCodeDriver);
	assert.notEqual(a, b);
	assert.equal(a.id, "claude-code");
	// 非法 permissionMode 必须被丢弃（走默认），不能透传给 CLI。
	const c = createDriver({ permissionMode: "yolo" });
	assert.ok(c instanceof ClaudeCodeDriver);
});

test("P2: 从包目录安装（折叠 manifest + entry 模块）后 DriverRegistry 可创建 claude-code Driver", async () => {
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(freshDir("claude-ext-"), new ExtensionCatalog(), drivers);
	await registry.setDeveloperMode(true);
	const entry = await registry.install(CLAUDE_PACKAGE_DIR);
	assert.equal(entry.manifest.id, "claude-code");
	assert.equal(entry.loaded, true, entry.loadError ?? "");
	const driver = drivers.create("claude-code", "spawn", { permissionMode: "plan" });
	assert.ok(driver instanceof ClaudeCodeDriver);
	assert.equal(driver!.id, "claude-code");
});

test("P2: installOrUpdateFromDir——未安装则安装，重复调用走更新不报错", async () => {
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(freshDir("claude-ext-"), new ExtensionCatalog(), drivers);
	const first = await registry.installOrUpdateFromDir(CLAUDE_PACKAGE_DIR);
	assert.equal(first.installed, true);
	const second = await registry.installOrUpdateFromDir(CLAUDE_PACKAGE_DIR);
	assert.equal(second.loaded, true, second.loadError ?? "");
	assert.equal(drivers.create("claude-code", "spawn", {})?.id, "claude-code");
});

test("P1: claude-code respond 防御性失败——headless 不支持跨进程审批", async () => {
	const driver = new ClaudeCodeDriver();
	const events = await collect(
		driver.respond({ runHandle: "r1", interactionHandle: "i1", requestId: "q1", responses: [] }, ctx),
	);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "failed");
	if (events[0]!.type !== "failed") return;
	assert.equal(events[0]!.result.errorCode, "interaction_unsupported");
	assert.equal(events[0]!.result.runHandle, "r1");
});

test("P1: claude-code cancel 对未知 runHandle 是 no-op（不抛异常）", async () => {
	const driver = new ClaudeCodeDriver();
	await driver.cancel({ runHandle: "nonexistent" }, ctx);
});

test("P1: claude-code probe——形状合法（二进制存在与否都返回可解释结果）", async () => {
	const driver = new ClaudeCodeDriver();
	const probe = await driver.probe({ cwd: process.cwd(), env: process.env });
	assert.equal(probe.extensionInstalled, true);
	assert.equal(typeof probe.detected, "boolean");
	assert.equal(probe.enabled, true);
	assert.equal(probe.transport, "spawn");
	assert.deepEqual(probe.capabilities, CLAUDE_CODE_CAPABILITIES);
	assert.ok(probe.authenticated === true || probe.authenticated === false || probe.authenticated === "unknown");
	if (!probe.detected) {
		assert.equal(probe.issues[0]?.code, "not_detected");
	}
});

// —— 归一化：实测捕获的 claude -p --output-format stream-json 事件流（Claude Code 2.1）——

test("P1: claude-code 归一化——init/result 提取 handle 与 content，thinking_tokens 过滤", () => {
	const reducer = new ClaudeCodeEventReducer();
	const progress: string[] = [];
	const feed = (raw: unknown) => {
		const p = reducer.push(raw);
		if (p) progress.push(p);
	};
	// 实测事件序列（精简）：init → 大量 thinking_tokens → assistant(thinking) → assistant(text) → result。
	feed({ type: "system", subtype: "init", cwd: "/x", session_id: "c8537a30-91d7-4b09-a980-21d1644c3b61", model: "deepseek-v4-flash[1m]" });
	for (let i = 0; i < 50; i++) {
		feed({ type: "system", subtype: "thinking_tokens", estimated_tokens: i, estimated_tokens_delta: 1, session_id: "c8537a30-91d7-4b09-a980-21d1644c3b61" });
	}
	feed({
		type: "assistant",
		message: { content: [{ type: "thinking", thinking: "内部推理不外送" }] },
		session_id: "c8537a30-91d7-4b09-a980-21d1644c3b61",
	});
	feed({
		type: "assistant",
		message: { content: [{ type: "text", text: "PROBE_OK" }] },
		session_id: "c8537a30-91d7-4b09-a980-21d1644c3b61",
	});
	feed({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "PROBE_OK",
		session_id: "c8537a30-91d7-4b09-a980-21d1644c3b61",
		num_turns: 1,
		total_cost_usd: 0.149695,
		usage: { input_tokens: 29764, output_tokens: 35 },
	});
	// thinking_tokens / thinking / text 都不产生 progress。
	assert.deepEqual(progress, []);
	assert.equal(reducer.sessionId, "c8537a30-91d7-4b09-a980-21d1644c3b61");
	const boundary = reducer.boundary("claude-code");
	assert.ok(boundary, "收到 result 事件后必须有边界");
	assert.equal(boundary!.type, "completed");
	if (boundary!.type !== "completed") return;
	const result = (boundary as Extract<AgentEvent, { type: "completed" }>).result;
	assert.equal(result.sessionHandle, "c8537a30-91d7-4b09-a980-21d1644c3b61");
	assert.equal(result.runHandle, "c8537a30-91d7-4b09-a980-21d1644c3b61");
	assert.equal(result.content, "PROBE_OK");
	assert.equal(result.usage?.turns, 1);
	assert.equal(result.usage?.inputTokens, 29764);
	assert.equal(result.usage?.cost, 0.149695);
});

test("P1: claude-code 归一化——tool_use 产生 progress（Bash 带命令摘要）", () => {
	const reducer = new ClaudeCodeEventReducer();
	const progress: string[] = [];
	const feed = (raw: unknown) => {
		const p = reducer.push(raw);
		if (p) progress.push(p);
	};
	feed({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } });
	feed({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } });
	feed({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "x" } }] } });
	assert.deepEqual(progress, ["使用工具 Bash: pnpm test", "使用工具 Edit: src/a.ts", "使用工具 WebSearch"]);
});

test("P1: claude-code 归一化——error result 归一为 failed；缺 result 事件返回 undefined", () => {
	const reducer = new ClaudeCodeEventReducer();
	reducer.push({ type: "system", subtype: "init", session_id: "s-1" });
	reducer.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: overloaded", session_id: "s-1" });
	const boundary = reducer.boundary("claude-code");
	assert.ok(boundary);
	assert.equal(boundary!.type, "failed");
	if (boundary!.type !== "failed") return;
	assert.equal(boundary!.result.errorCode, "worker_failed");
	assert.equal(boundary!.result.sessionHandle, "s-1");
	assert.match(boundary!.result.error, /overloaded/);

	// 没有 result 事件（进程异常退出）：boundary 返回 undefined，由 driver 判 protocol_error。
	const empty = new ClaudeCodeEventReducer();
	empty.push({ type: "system", subtype: "init", session_id: "s-2" });
	assert.equal(empty.boundary("claude-code"), undefined);
});
