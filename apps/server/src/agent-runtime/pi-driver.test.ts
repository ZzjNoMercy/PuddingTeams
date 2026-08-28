import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExtensionManifest, ExtensionCatalog } from "./extensions.js";
import { DriverRegistry } from "./driver-registry.js";
import { ExtensionRegistry } from "./extension-registry.js";
import { LocalPiDriver, PI_CAPABILITIES, piSearchFingerprint, transientCooldownMs } from "./pi-driver.js";
import { piConnectorManifest, piExtensionHooks } from "./pi-extension.js";
import type { AgentEvent, InvocationContext } from "./types.js";

/**
 * Phase 6：本地 pi Connector（§9.1 Pi 调 Pi）——装配级测试。
 * 不触发真实 LLM 调用：run/continue 的端到端由手动验证覆盖（会话创建
 * 需要本机 pi 凭证），这里锁定 capability 声明、manifest 合法性、工厂
 * 多实例、防御性 respond/cancel 与 probe 形状。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

const ctx: InvocationContext = { cwd: process.cwd(), env: {} };

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

test("Phase6: pi connector 能力诚实声明——run/continue/cancel、无 HITL、stream、sdk", async () => {
	const driver = new LocalPiDriver();
	assert.deepEqual(await driver.capabilities(), {
		operations: ["run", "continue", "cancel"],
		interactionKinds: [],
		progress: "stream",
		transport: "sdk",
	});
	assert.deepEqual(await driver.capabilities(), PI_CAPABILITIES);
});

test("Phase6: pi manifest 通过校验——builtin connector、sdk transport、权限合法", () => {
	const parsed = parseExtensionManifest(piConnectorManifest as unknown as Record<string, unknown>);
	assert.equal(parsed.kind, "connector");
	assert.equal(parsed.source, "builtin");
	if (parsed.kind !== "connector") return;
	assert.equal(parsed.connector.id, "pi");
	assert.equal(parsed.connector.defaultTransport, "sdk");
	assert.deepEqual(parsed.connector.supportedTransports, ["sdk"]);
	assert.deepEqual(parsed.permissions, ["network", "workspace"]);
	// Connector 只保留运行参数；systemPrompt 已迁到 Agent.piResources。
	const props = (parsed.connector.configSchema as { properties?: Record<string, unknown> }).properties ?? {};
	for (const key of ["model", "thinkingLevel", "sessionDir"]) {
		assert.ok(props[key], `configSchema 缺 ${key}`);
	}
	assert.equal(props.systemPrompt, undefined);
	assert.equal(parsed.connector.secretSchema, undefined);
});

test("Phase6: driverFactory 多实例——同一 Connector 按 config 构造独立 Driver", () => {
	const hooks = piExtensionHooks();
	assert.ok(hooks.driverFactory, "pi hooks 必须提供 driverFactory");
	const a = hooks.driverFactory!({ model: "openai/gpt-5" }, "sdk");
	const b = hooks.driverFactory!({ model: "anthropic/claude-sonnet" }, "sdk");
	assert.ok(a instanceof LocalPiDriver);
	assert.ok(b instanceof LocalPiDriver);
	assert.notEqual(a, b);
	assert.equal(a.id, "pi");
});

test("Phase6: registerBuiltin 后 DriverRegistry 可按 connectorId 创建 Driver", () => {
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(freshDir("pi-ext-"), new ExtensionCatalog(), drivers);
	registry.registerBuiltin(piConnectorManifest, piExtensionHooks());
	const driver = drivers.create("pi", "sdk", { piResources: { systemPrompt: "你是测试 worker" } });
	assert.ok(driver instanceof LocalPiDriver);
	assert.equal(driver!.id, "pi");
});

test("Phase6: respond 防御性失败——v1 不支持审批外送", async () => {
	const driver = new LocalPiDriver();
	const events = await collect(
		driver.respond({ runHandle: "r1", interactionHandle: "i1", requestId: "q1", responses: [] }, ctx),
	);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "failed");
	if (events[0]!.type !== "failed") return;
	assert.equal(events[0]!.result.errorCode, "interaction_unsupported");
	assert.equal(events[0]!.result.runHandle, "r1");
});

test("Phase6: cancel 对未知 runHandle 是 no-op（不抛异常）", async () => {
	const driver = new LocalPiDriver();
	await driver.cancel({ runHandle: "nonexistent" }, ctx);
});

test("Phase6: 429/过载进入同 Session 冷却续跑策略，普通错误不吞", () => {
	const options = { rateLimitDelayMs: 123, overloadedDelayMs: 456 };
	assert.equal(transientCooldownMs("429: organization max RPM", options), 123);
	assert.equal(transientCooldownMs("429: please try again after 1 seconds", options), 1_000);
	assert.equal(transientCooldownMs("rate limit; retry after 2500 ms", options), 2_500);
	assert.equal(transientCooldownMs("engine_overloaded_error", options), 456);
	assert.equal(transientCooldownMs("permission denied", options), undefined);
});

test("Pi Worker 搜索指纹包含 Workspace trust，撤权后不能复用旧 FFF Session", () => {
	const trusted = { provider: "fff" as const, workspace: { id: "w", canonicalPath: "/repo", trusted: true } };
	const denied = { provider: "fff" as const, workspace: { id: "w", canonicalPath: "/repo", trusted: false } };
	assert.notEqual(piSearchFingerprint(trusted), piSearchFingerprint(denied));
});

test("Phase6: 429 冷却后复用同一 AgentSession 与 runHandle 续跑", async () => {
	const driver = new LocalPiDriver({ transientRecovery: { maxAttempts: 1, rateLimitDelayMs: 0 } });
	const prompts: string[] = [];
	const session = {
		messages: [] as Array<Record<string, unknown>>,
		subscribe: () => () => undefined,
		async prompt(message: string) {
			prompts.push(message);
			if (prompts.length === 1) {
				this.messages.push({ role: "assistant", stopReason: "error", errorMessage: "429: organization max RPM" });
			} else {
				this.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "续跑完成" }] });
			}
		},
		async abort() {},
	};
	const drive = (driver as unknown as {
		drive(session: unknown, message: string, context: InvocationContext, sessionHandle: string, runHandle: string): AsyncIterable<AgentEvent>;
	}).drive.bind(driver);
	const events = await collect(drive(session, "原始任务", ctx, "session-1", "delegation-1"));
	assert.equal(prompts.length, 2);
	assert.equal(prompts[0], "原始任务");
	assert.match(prompts[1]!, /已有进度继续/);
	assert.ok(events.some((event) => event.type === "progress" && event.stage === "rate_limit_wait"));
	const completed = events.find((event) => event.type === "completed");
	assert.equal(completed?.type, "completed");
	if (completed?.type !== "completed") return;
	assert.equal(completed.result.sessionHandle, "session-1");
	assert.equal(completed.result.runHandle, "delegation-1");
	assert.equal(completed.result.content, "续跑完成");
});

test("Phase6: probe——SDK 随 server 发布，detected/configured 恒 true", async () => {
	const driver = new LocalPiDriver();
	const probe = await driver.probe(ctx);
	assert.equal(probe.extensionInstalled, true);
	assert.equal(probe.detected, true);
	assert.equal(probe.configured, true);
	assert.equal(probe.enabled, true);
	assert.equal(probe.compatibility, "supported");
	assert.equal(probe.transport, "sdk");
	assert.deepEqual(probe.capabilities, PI_CAPABILITIES);
	assert.ok(probe.authenticated === true || probe.authenticated === false || probe.authenticated === "unknown");
});
