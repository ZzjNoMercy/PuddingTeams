import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExtensionManifest, ExtensionCatalog } from "./extensions.js";
import { DriverRegistry } from "./driver-registry.js";
import { ExtensionRegistry } from "./extension-registry.js";
import { CodexDriver, codexExecutionPolicyArgs, createDriver } from "@puddingteams/connector-codex/driver";
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
		runtimeModel: { effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
		operations: ["run", "continue", "cancel"],
		interactionKinds: [],
		progress: "stream",
		transport: "spawn",
		cancelConfirmation: "observable",
		workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: ["git_diff", "filesystem_diff"] },
		verification: { modalities: ["cli"], freshSession: true, workspaceIsolation: ["mutation_guard", "isolated_copy"], commandExecution: true, guiObservation: false, networkObservation: true },
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

test("isolated checkout 保持 workspace-write 并为受保护的 .git 写入启用命令级自动审核", () => {
	assert.deepEqual(codexExecutionPolicyArgs(undefined, { workspaceBoundary: "platform_isolated_checkout" }), ["--approve-for-me"]);
	assert.deepEqual(codexExecutionPolicyArgs("workspace-write", { workspaceBoundary: "workspace" }), ["-s", "workspace-write"]);
	assert.deepEqual(codexExecutionPolicyArgs("danger-full-access", { workspaceBoundary: "platform_isolated_checkout" }), ["-s", "danger-full-access"]);
	assert.deepEqual(codexExecutionPolicyArgs("danger-full-access", {
		workspaceBoundary: "platform_isolated_checkout",
		verificationProfile: {
			profileId: "verify",
			environmentId: "env",
			sourceBinding: "goal_workspace",
			executionRoot: "/tmp/verify",
			workspaceBoundary: "platform_isolated_copy",
			mutationPolicy: "isolated_changes_only",
			networkPolicy: "inherit_connector_policy",
		},
	}), ["--approve-for-me"]);
});

test("P2: 从包目录安装（折叠 manifest + entry 模块）后 DriverRegistry 可创建 codex Driver", async () => {
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(freshDir("codex-ext-"), new ExtensionCatalog(), drivers);
	await registry.setDeveloperMode(true);
	const entry = await registry.install(CODEX_PACKAGE_DIR);
	assert.equal(entry.manifest.id, "codex");
	assert.equal(entry.loaded, true, entry.loadError ?? "");
	const driver = drivers.create("codex", "spawn", { sandbox: "workspace-write" });
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
	assert.equal(drivers.create("codex", "spawn", {})?.id, "codex");
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

test("Codex 无换行 stdout 超限即终止且不进入 JSONL 解析器", async () => {
	const dir = freshDir("codex-output-limit-");
	const fake = path.join(dir, "fake-codex");
	writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write("x".repeat(2 * 1024 * 1024 + 1));\n`);
	chmodSync(fake, 0o755);
	const events = await collect(new CodexDriver({ command: fake }).run(
		{ message: "synthetic", requestId: "output-limit" }, { cwd: dir, env: process.env },
	));
	const boundary = events.at(-1);
	assert.equal(boundary?.type, "failed");
	if (boundary?.type === "failed") assert.equal(boundary.result.errorCode, "output_limit");
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

test("Codex 退出 0 也必须具有完整 thread/turn 边界", async () => {
	for (const [name, stream, expected] of [
		["空流", [], /thread\.started/],
		["仅有正文", [{ type: "item.completed", item: { type: "agent_message", text: "伪造成功" } }], /thread\.started/],
		["只有 thread", [{ type: "thread.started", thread_id: "t-incomplete" }], /turn\.completed/],
	] as const) {
		const reducer = new CodexEventReducer();
		for (const event of stream) reducer.push(event);
		const boundary = reducer.boundary("codex");
		assert.equal(boundary.type, "failed", name);
		if (boundary.type !== "failed") continue;
		assert.equal(boundary.result.errorCode, "protocol_incomplete");
		assert.match(boundary.result.error, expected);
	}
	const dir = freshDir("codex-empty-exec-");
	const fake = path.join(dir, "fake-codex");
	writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(fake, 0o755);
	const driver = new CodexDriver({ command: fake });
	for (const events of [
		await collect(driver.run({ message: "synthetic", requestId: "run-1" }, { cwd: dir, env: process.env })),
		await collect(driver.continue({ message: "synthetic", requestId: "run-2", sessionHandle: "old-thread" }, { cwd: dir, env: process.env })),
	]) {
		const boundary = events.at(-1);
		assert.equal(boundary?.type, "failed");
		if (boundary?.type === "failed") assert.equal(boundary.result.errorCode, "protocol_incomplete");
	}
});

test("子进程被 OS 信号终止不能映射为退出码 0", async () => {
	const dir = freshDir("codex-signalled-exec-");
	const fake = path.join(dir, "fake-codex");
	writeFileSync(fake, "#!/bin/sh\nkill -ABRT $$\n", "utf8");
	chmodSync(fake, 0o755);
	const events = await collect(new CodexDriver({ command: fake }).run({ message: "synthetic", requestId: "signal" }, { cwd: dir, env: process.env }));
	const boundary = events.at(-1);
	assert.equal(boundary?.type, "failed");
	if (boundary?.type === "failed") {
		assert.equal(boundary.result.errorCode, "worker_failed");
		assert.match(boundary.result.error, /退出码 -1/);
	}
});

test("Codex 非零退出时优先呈现 JSONL 中的模型错误", async () => {
	const dir = freshDir("codex-model-error-");
	const fake = path.join(dir, "fake-codex");
	writeFileSync(fake, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"t-model"}\' \'{"type":"turn.failed","error":{"message":"model unavailable for account"}}\'\necho "Reading additional input from stdin..." >&2\nexit 1\n', "utf8");
	chmodSync(fake, 0o755);
	const events = await collect(new CodexDriver({ command: fake }).run({ message: "synthetic", requestId: "model-error" }, { cwd: dir, env: process.env }));
	const boundary = events.at(-1);
	assert.equal(boundary?.type, "failed");
	if (boundary?.type === "failed") {
		assert.match(boundary.result.error, /model unavailable for account/);
		assert.doesNotMatch(boundary.result.error, /Reading additional input/);
	}
});

test("T03 受保护编译：Run/continue 拒绝 Agent 命令替换、探测旁路和篡改的 CLI/profile", async () => {
	const dir = freshDir("codex-protected-compile-");
	const trusted = realpathSync(freshDir("codex-protected-trusted-"));
	const fake = path.join(trusted, "fake-codex");
	const profile = path.join(trusted, "compile.sb");
	writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
	writeFileSync(profile, "(version 1)\n(deny default)\n", "utf8");
	chmodSync(fake, 0o755);
	const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
	const protectedCtx: InvocationContext = {
		cwd: dir, env: { HOST_SENTINEL: "must-not-inherit" },
		protectedCompile: {
			jobId: "synthetic-compile-job", stagingRoot: realpathSync(dir),
			commandPath: fake, commandSha256: hash(fake),
			sandboxProfilePath: profile, sandboxProfileSha256: hash(profile),
			env: { PATH: "/usr/bin:/bin" },
		},
	};
	assert.deepEqual(codexExecutionPolicyArgs("danger-full-access", protectedCtx), [
		"-s", "danger-full-access", "-c", 'approval_policy="never"', "--ignore-user-config", "--ignore-rules",
	]);
	assert.deepEqual(codexExecutionPolicyArgs("danger-full-access", {
		...protectedCtx, protectedCompile: { ...protectedCtx.protectedCompile!, modelChannel: { port: 55123 } },
	}), [
		"-s", "danger-full-access", "-c", 'approval_policy="never"', "--ignore-user-config", "--ignore-rules",
		"-c", 'model_provider="puddingteams_compile"',
		"-c", 'model_providers.puddingteams_compile.name="PuddingTeams Compile"',
		"-c", 'model_providers.puddingteams_compile.base_url="http://127.0.0.1:55123/v1"',
		"-c", 'model_providers.puddingteams_compile.wire_api="responses"',
		"-c", "model_providers.puddingteams_compile.requires_openai_auth=false",
		"-c", "model_providers.puddingteams_compile.supports_websockets=false",
		"-c", "model_providers.puddingteams_compile.request_max_retries=0",
		"-c", "model_providers.puddingteams_compile.stream_max_retries=0",
	]);
	assert.throws(() => codexExecutionPolicyArgs("workspace-write", {
		...protectedCtx, protectedCompile: { ...protectedCtx.protectedCompile!, modelChannel: { port: 0 } },
	}), /invalid protected compile model channel/);
	const overridden = new CodexDriver({ command: fake, sandbox: "danger-full-access" });
	for (const events of [
		overridden.run({ message: "attack", requestId: "run" }, protectedCtx),
		overridden.continue({ message: "attack", requestId: "continue", sessionHandle: "old" }, protectedCtx),
	]) await assert.rejects(collect(events), /Agent-configured command/);
	await assert.rejects(overridden.probe(protectedCtx), /cannot run Connector probe/);
	await assert.rejects(overridden.listConfigOptions("model", protectedCtx), /cannot run model discovery/);
	const pinned = new CodexDriver();
	writeFileSync(fake, "#!/bin/sh\necho changed\n", "utf8");
	for (const events of [
		pinned.run({ message: "attack", requestId: "run" }, protectedCtx),
		pinned.continue({ message: "attack", requestId: "continue", sessionHandle: "old" }, protectedCtx),
	]) await assert.rejects(collect(events), /identity changed/);
	writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
	writeFileSync(profile, "(version 1)\n(allow default)\n", "utf8");
	for (const events of [
		pinned.run({ message: "attack", requestId: "run-profile" }, protectedCtx),
		pinned.continue({ message: "attack", requestId: "continue-profile", sessionHandle: "old" }, protectedCtx),
	]) await assert.rejects(collect(events), /identity changed/);
	const weakCtx: InvocationContext = {
		...protectedCtx,
		protectedCompile: { ...protectedCtx.protectedCompile!, sandboxProfileSha256: hash(profile) },
	};
	for (const events of [
		pinned.run({ message: "attack", requestId: "run-weak" }, weakCtx),
		pinned.continue({ message: "attack", requestId: "continue-weak", sessionHandle: "old" }, weakCtx),
	]) await assert.rejects(collect(events), /deny-default sandbox profile/);
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
