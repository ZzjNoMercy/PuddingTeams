import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExtensionManifest, ExtensionCatalog } from "./extensions.js";
import { DriverRegistry } from "./driver-registry.js";
import { ExtensionRegistry } from "./extension-registry.js";
import { CodexDriver, createDriver } from "@puddingteams/connector-codex/driver";
import { CodexEventReducer, CODEX_CAPABILITIES } from "@puddingteams/connector-codex/core/codex-normalize";
import type { AgentEvent, InvocationContext } from "./types.js";

/**
 * 路线图 P1/P2：Codex Connector——装配级 + 归一化测试。
 * 不触发真实 codex exec 执行（需要本机登录态），这里锁定 capability
 * 诚实声明、折叠 manifest（package.json puddingteams 字段）合法性、
 * 工厂多实例、防御性 respond/cancel、probe 形状，以及用实测 JSONL
 * 样本锁定归一化行为。Driver 本体在 extensions/connectors/codex（§9.5）。
 */

/** 双宿主包目录（仓库内路径安装的来源）。 */
const CODEX_PACKAGE_DIR = path.resolve(import.meta.dirname, "../../../../extensions/connectors/codex");

function codexManifestFromPackage(): Record<string, unknown> {
	const pkg = JSON.parse(readFileSync(path.join(CODEX_PACKAGE_DIR, "package.json"), "utf-8")) as Record<string, unknown>;
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

test("P1: codex 能力诚实声明——run/continue/cancel、无 HITL、stream、spawn", async () => {
	const driver = new CodexDriver();
	assert.deepEqual(await driver.capabilities(), {
		operations: ["run", "continue", "cancel"],
		interactionKinds: [],
		progress: "stream",
		transport: "spawn",
	});
	assert.deepEqual(await driver.capabilities(), CODEX_CAPABILITIES);
});

test("P1/P2: codex 折叠 manifest（package.json puddingteams 字段）通过校验", () => {
	const parsed = parseExtensionManifest(codexManifestFromPackage());
	assert.equal(parsed.kind, "connector");
	assert.equal(parsed.source, "trusted");
	assert.equal(parsed.entry, "driver/index.ts");
	if (parsed.kind !== "connector") return;
	assert.equal(parsed.connector.id, "codex");
	assert.equal(parsed.connector.defaultTransport, "spawn");
	assert.deepEqual(parsed.connector.supportedTransports, ["spawn"]);
	assert.deepEqual(parsed.permissions, ["spawn", "secrets"]);
	assert.equal(parsed.connector.avatar, "assets/codex.svg");
	const props = (parsed.connector.configSchema as { properties?: Record<string, unknown> }).properties ?? {};
	for (const key of ["command", "model", "sandbox"]) {
		assert.ok(props[key], `configSchema 缺 ${key}`);
	}
	assert.equal((props.model as Record<string, unknown>)["x-puddingteams-options"], "driver");
	// OPENAI_API_KEY 可选（本机 codex login 登录态优先）。
	assert.equal(parsed.connector.secretSchema?.[0]?.key, "OPENAI_API_KEY");
	assert.equal(parsed.connector.secretSchema?.[0]?.required, false);
});

test("P1: codex driverFactory 多实例——同一 Connector 按 config 构造独立 Driver", () => {
	const a = createDriver({ model: "gpt-5", sandbox: "read-only" });
	const b = createDriver({ model: "gpt-5-codex" });
	assert.ok(a instanceof CodexDriver);
	assert.ok(b instanceof CodexDriver);
	assert.notEqual(a, b);
	assert.equal(a.id, "codex");
	// 非法 sandbox 值必须被丢弃（走默认），不能透传给 CLI。
	const c = createDriver({ sandbox: "yolo-mode" });
	assert.ok(c instanceof CodexDriver);
});

test("P2: 从包目录安装（折叠 manifest + entry 模块）后 DriverRegistry 可创建 codex Driver", async () => {
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(freshDir("codex-ext-"), new ExtensionCatalog(), drivers);
	await registry.setDeveloperMode(true);
	const entry = await registry.install(CODEX_PACKAGE_DIR);
	assert.equal(entry.manifest.id, "codex");
	assert.equal(entry.loaded, true, entry.loadError ?? "");
	const driver = drivers.create("codex", { sandbox: "workspace-write" });
	assert.ok(driver instanceof CodexDriver);
	assert.equal(driver!.id, "codex");
});

test("P2: installOrUpdateFromDir——未安装则安装，重复调用走更新不报错", async () => {
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(freshDir("codex-ext-"), new ExtensionCatalog(), drivers);
	const first = await registry.installOrUpdateFromDir(CODEX_PACKAGE_DIR);
	assert.equal(first.installed, true);
	const second = await registry.installOrUpdateFromDir(CODEX_PACKAGE_DIR);
	assert.equal(second.loaded, true, second.loadError ?? "");
	assert.equal(drivers.create("codex", {})?.id, "codex");
});

test("P1: codex respond 防御性失败——headless 不支持跨进程审批", async () => {
	const driver = new CodexDriver();
	const events = await collect(
		driver.respond({ runHandle: "r1", interactionHandle: "i1", requestId: "q1", responses: [] }, ctx),
	);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "failed");
	if (events[0]!.type !== "failed") return;
	assert.equal(events[0]!.result.errorCode, "interaction_unsupported");
	assert.equal(events[0]!.result.runHandle, "r1");
});

test("P1: codex cancel 对未知 runHandle 是 no-op（不抛异常）", async () => {
	const driver = new CodexDriver();
	await driver.cancel({ runHandle: "nonexistent" }, ctx);
});

test("P1: codex probe——形状合法（二进制存在与否都返回可解释结果）", async () => {
	const driver = new CodexDriver();
	const probe = await driver.probe({ cwd: process.cwd(), env: process.env });
	assert.equal(probe.extensionInstalled, true);
	assert.equal(typeof probe.detected, "boolean");
	assert.equal(probe.enabled, true);
	assert.equal(probe.transport, "spawn");
	assert.deepEqual(probe.capabilities, CODEX_CAPABILITIES);
	assert.ok(probe.authenticated === true || probe.authenticated === false || probe.authenticated === "unknown");
	if (!probe.detected) {
		assert.equal(probe.issues[0]?.code, "not_detected");
	}
});

test("Codex 配置模型下拉：通过 app-server model/list 读取账号可用模型", async () => {
	const dir = freshDir("codex-model-list-");
	const fake = path.join(dir, "fake-codex");
	writeFileSync(fake, `#!/usr/bin/env node
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
    if (message.method === "model/list") send({ id: message.id, result: { data: [
      { id: "gpt-default", model: "gpt-default", displayName: "GPT Default", description: "Default model", isDefault: true },
      { id: "gpt-fast", model: "gpt-fast", displayName: "GPT Fast", description: "Fast model", isDefault: false }
    ], nextCursor: null } });
  }
});
`, "utf8");
	chmodSync(fake, 0o755);
	const driver = new CodexDriver({ command: fake });
	assert.deepEqual(await driver.listConfigOptions("model", { cwd: dir, env: process.env }), [
		{ value: "gpt-default", label: "GPT Default", description: "Default model", isDefault: true },
		{ value: "gpt-fast", label: "GPT Fast", description: "Fast model", isDefault: false },
	]);
	assert.deepEqual(await driver.listConfigOptions("unknown", { cwd: dir, env: process.env }), []);
});

// —— 归一化：实测捕获的 codex exec --json 事件流（codex-cli 0.145）——

const REAL_EXEC_STREAM = [
	{ type: "thread.started", thread_id: "019fe53e-aa6d-7091-bf26-498d8f870186" },
	{ type: "turn.started" },
	{ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "PROBE_OK" } },
	{
		type: "turn.completed",
		usage: { input_tokens: 17016, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 },
	},
];

test("P1: codex 归一化——thread_id 成为 session/run handle，content 累积，usage 提取", () => {
	const reducer = new CodexEventReducer();
	for (const raw of REAL_EXEC_STREAM) {
		// 本样本里没有产生 progress 的事件（agent_message 不外送，避免与终态重复）。
		assert.equal(reducer.push(raw), undefined);
	}
	assert.equal(reducer.threadId, "019fe53e-aa6d-7091-bf26-498d8f870186");
	assert.equal(reducer.sawTurnCompleted, true);
	const boundary = reducer.boundary("codex");
	assert.equal(boundary.type, "completed");
	if (boundary.type !== "completed") return;
	assert.equal(boundary.result.sessionHandle, "019fe53e-aa6d-7091-bf26-498d8f870186");
	assert.equal(boundary.result.runHandle, "019fe53e-aa6d-7091-bf26-498d8f870186");
	assert.equal(boundary.result.content, "PROBE_OK");
	assert.equal(boundary.result.usage?.inputTokens, 17016);
	assert.equal(boundary.result.usage?.outputTokens, 7);
});

test("P1: codex 归一化——终态只取最后一条 agent_message；过程消息仍逐事件投影", () => {
	const reducer = new CodexEventReducer();
	const progress: string[] = [];
	const feed = (raw: unknown) => {
		const p = reducer.push(raw);
		if (p) progress.push(p);
	};
	feed({ type: "thread.started", thread_id: "t-1" });
	feed({ type: "item.completed", item: { type: "command_execution", command: "pnpm test", exit_code: 0 } });
	feed({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
	feed({ type: "item.completed", item: { type: "reasoning", text: "内部推理不外送" } });
	feed({ type: "item.completed", item: { type: "agent_message", text: "过程说明" } });
	feed({ type: "item.completed", item: { type: "agent_message", text: "最终答复" } });
	feed({ type: "turn.completed", usage: {} });
	assert.deepEqual(progress, ["$ pnpm test", "修改 src/a.ts, src/b.ts"]);
	const boundary = reducer.boundary("codex");
	assert.equal(boundary.type, "completed");
	if (boundary.type !== "completed") return;
	assert.equal(boundary.result.content, "最终答复");
});

test("P1: codex 归一化——turn.failed/error 事件归一为 failed 边界", () => {
	const reducer = new CodexEventReducer();
	reducer.push({ type: "thread.started", thread_id: "t-2" });
	reducer.push({ type: "turn.failed", error: "stream disconnected" });
	const boundary = reducer.boundary("codex");
	assert.equal(boundary.type, "failed");
	if (boundary.type !== "failed") return;
	assert.equal(boundary.result.errorCode, "worker_failed");
	assert.equal(boundary.result.sessionHandle, "t-2");
	assert.match(boundary.result.error, /stream disconnected/);
});

test("Codex 时间线：started/updated/completed、MCP、计划与推理摘要完整投影", () => {
	const reducer = new CodexEventReducer();
	const projected = [
		{ type: "thread.started", thread_id: "t-rich" },
		{ type: "turn.started" },
		{ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", status: "in_progress" } },
		{ type: "item.completed", item: { id: "cmd-1", type: "command_execution", command: "pnpm test", aggregated_output: "ok", exit_code: 0, status: "completed" } },
		{ type: "item.started", item: { id: "plan-1", type: "todo_list", items: [{ text: "实现", completed: false }] } },
		{ type: "item.updated", item: { id: "plan-1", type: "todo_list", items: [{ text: "实现", completed: true }] } },
		{ type: "item.started", item: { id: "mcp-1", type: "mcp_tool_call", server: "github", tool: "get_issue", arguments: { id: 1 }, status: "in_progress" } },
		{ type: "item.completed", item: { id: "mcp-1", type: "mcp_tool_call", server: "github", tool: "get_issue", result: { content: [{ type: "text", text: "done" }] }, status: "completed" } },
		{ type: "item.completed", item: { id: "reason-1", type: "reasoning", text: "可见推理摘要" } },
	].map((event) => reducer.pushWithActivity(event).activity).filter(Boolean);

	assert.deepEqual(projected.map((event) => [event!.sourceEvent, event!.kind, event!.status]), [
		["thread.started", "lifecycle", "started"],
		["turn.started", "lifecycle", "started"],
		["item.started", "tool", "started"],
		["item.completed", "tool", "completed"],
		["item.started", "plan", "started"],
		["item.updated", "plan", "updated"],
		["item.started", "tool", "started"],
		["item.completed", "tool", "completed"],
		["item.completed", "reasoning", "completed"],
	]);
	assert.equal(projected[2]!.itemId, "cmd-1");
	assert.match(projected[7]!.content ?? "", /done/);
});
