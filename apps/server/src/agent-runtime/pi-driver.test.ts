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
import type { KnowledgeWorkerExecution } from "../knowledge/runtime-service.js";

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

async function runStopSequence(sequence: Array<Record<string, unknown> | undefined>) {
	const driver = new LocalPiDriver();
	const prompts: string[] = [];
	const session = {
		messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'old result' }] }] as Array<Record<string, unknown>>,
		subscribe: () => () => undefined,
		async prompt(message: string) {
			prompts.push(message);
			const next = sequence[prompts.length - 1];
			if (next) this.messages.push({ role: 'assistant', usage: { input: 10, output: 8192 }, ...next });
		},
		async abort() {},
	};
	const drive = (driver as unknown as {
		drive(session: unknown, message: string, context: InvocationContext, sessionHandle: string, runHandle: string): AsyncIterable<AgentEvent>;
	}).drive.bind(driver);
	return { events: await collect(drive(session, 'original', ctx, 'session-limit', 'run-limit')), prompts };
}
const truncatedThinking = { stopReason: 'length', rawStopReason: 'length', content: [{ type: 'thinking', thinking: '还准备写文件' }] };

test('pi 输出截断在原 Session/Run 有界续接，累计用量且只取新的最终正文', async () => {
	const { events, prompts } = await runStopSequence([truncatedThinking, { stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }]);
	assert.equal(prompts.length, 2);
	assert.match(prompts[1]!, /不要重复已完成操作/);
	assert.ok(events.some(e => e.type === 'progress' && e.stage === 'output_limit_recovery'));
	const end = events.at(-1)!;
	assert.equal(end.type, 'completed');
	if (end.type !== 'completed') return;
	assert.equal(end.result.content, 'done');
	assert.equal(end.result.sessionHandle, 'session-limit');
	assert.equal(end.result.runHandle, 'run-limit');
	assert.equal(end.result.usage?.outputTokens, 16384);
});

test('pi 连续截断停止自动续接，保留部分正文和停止原因，绝不报 completed', async () => {
	const { events, prompts } = await runStopSequence([truncatedThinking, { stopReason: 'length', rawStopReason: 'length', content: [{ type: 'text', text: 'partial' }] }]);
	assert.equal(prompts.length, 2);
	assert.ok(!events.some(e => e.type === 'completed'));
	const end = events.at(-1)!;
	assert.equal(end.type, 'failed');
	if (end.type !== 'failed') return;
	assert.equal(end.result.errorCode, 'output_limit_exceeded');
	assert.equal(end.result.content, 'partial');
	assert.equal(end.result.meta?.stopReason, 'length');
	assert.equal(end.result.recoverable, true);
});

for (const ending of [undefined, { stopReason: 'stop', content: [{ type: 'thinking', thinking: 'plan' }] }, { stopReason: 'stop', content: [{ type: 'text', text: '  ' }] }, { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't', name: 'write', arguments: {} }] }]) {
	test(`pi 不把旧结果、空正文或未结算工具边界当成功：${JSON.stringify(ending)}`, async () => {
		const { events, prompts } = await runStopSequence([ending]);
		assert.equal(prompts.length, 1);
		assert.equal(events.at(-1)?.type, 'failed');
		assert.ok(!events.some(e => e.type === 'completed'));
	});
}

test('pi 截断恢复后取消与 Provider 错误保持真实失败边界', async () => {
	for (const stopReason of ['aborted', 'error']) {
		const { events } = await runStopSequence([truncatedThinking, { stopReason, errorMessage: 'provider failure' }]);
		const end = events.at(-1)!;
		assert.equal(end.type, 'failed');
		if (end.type !== 'failed') continue;
		assert.equal(end.result.status, stopReason === 'aborted' ? 'cancelled' : 'failed');
	}
});

test("Pi Worker 续聊在联网授权变化后重建工具面，授权未变时复用会话", async () => {
 const { SessionManager } = await import("@earendil-works/pi-coding-agent");
 let allowed = true;
 let disposed = 0;
 let created = 0;
 const driver = new LocalPiDriver({ sessionDir: freshDir("pi-network-access-"), managedExtensionsFingerprintFor: async () => JSON.stringify({ fetch: allowed }) });
 type FixtureSession = { sessionId: string; tools: string[]; dispose(): void };
 const fixture = driver as unknown as {
  newSession(manager: ReturnType<typeof SessionManager.create>): Promise<FixtureSession>;
  resolveModel(): Promise<undefined>;
  openSession(context: InvocationContext, handle?: string): Promise<{session: FixtureSession; sessionHandle: string}>;
 };
 fixture.resolveModel = async () => undefined;
 fixture.newSession = async manager => {
  created++;
  // A real durable SDK transcript permits the continuation path to restore it.
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "previous reply" }], timestamp: Date.now() } as Parameters<typeof manager.appendMessage>[0]);
  return { sessionId: manager.getSessionId(), tools: allowed ? ["fetch_url"] : [], dispose() { disposed++; } };
 };
 const first = await fixture.openSession(ctx);
 const same = await fixture.openSession(ctx, first.sessionHandle);
 assert.equal(same.session, first.session);assert.equal(created, 1);
 allowed = false;
 const revoked = await fixture.openSession(ctx, first.sessionHandle);
 assert.notEqual(revoked.session, first.session);assert.equal(created, 2);assert.equal(disposed, 1);
 assert.deepEqual(revoked.session.tools, []);
 assert.equal(revoked.sessionHandle, first.sessionHandle, "工具撤销重建实例，不新建聊天上下文");
 const stored = SessionManager.open((await SessionManager.list(ctx.cwd, (driver as unknown as { sessionDir(): string }).sessionDir()))[0]!.path);
 assert(stored.getBranch().some(entry => entry.type === "message" && entry.message.role === "assistant"));
});

async function runWikiLifecycle(options: {
 ending?: Record<string, unknown>;
 receipt?: Awaited<ReturnType<KnowledgeWorkerExecution['finish']>>;
 finalizeError?: boolean;
 stop?: boolean;
 signal?: AbortSignal;
}) {
 const messages: Array<Record<string, unknown>> = [];
 let prompts = 0, bound = 0, stopChecks = 0, aborts = 0;
 const reasons: string[] = [];
 const execution: KnowledgeWorkerExecution = {
  bind() { bound++; },
  async shouldStop() { stopChecks++; return options.stop ?? false; },
  async abort() { aborts++; },
  async finish(reason) {
   reasons.push(reason);
   if (options.finalizeError) throw new Error('durable receipt unavailable');
   return options.receipt;
  },
 };
 const session = {
  messages,
  agent: { state: { messages }, shouldStopAfterTurn: undefined as undefined | ((context: unknown) => Promise<boolean>) },
  subscribe: () => () => undefined,
  async prompt() {
   prompts++;
   messages.push({ role: 'assistant', ...(options.ending ?? { stopReason: 'stop', content: [{ type: 'text', text: 'model claims completed' }] }) });
   const stop = await this.agent.shouldStopAfterTurn?.({});
   if (options.stop && !stop) throw new Error('candidate caused an extra model turn');
  },
  async abort() {},
 };
 const driver = new LocalPiDriver({ transientRecovery: { maxAttempts: 2, rateLimitDelayMs: 0 } });
 const drive = (driver as unknown as {
  drive(session: unknown, message: string, context: InvocationContext, sessionHandle: string, runHandle: string,
   transientAttempt: number, usageStart: undefined, outputAttempt: number, execution: KnowledgeWorkerExecution): AsyncIterable<AgentEvent>;
 }).drive.bind(driver);
 const events = await collect(drive(session, 'organize', { ...ctx, signal: options.signal }, 'wiki-session', 'wiki-run', 0, undefined, 0, execution));
 return { events, prompts, bound, stopChecks, aborts, reasons, session };
}

test('Wiki committed candidate stops at tool boundary and completes with host receipt without final prose', async () => {
 const result = await runWikiLifecycle({ ending: { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'submit', name: 'knowledge_submit_candidate', arguments: {} }] },
  stop: true, receipt: { status: 'completed', content: '候选 batch-1 等待用户审核' } });
 assert.equal(result.prompts, 1); assert.equal(result.bound, 1); assert.equal(result.stopChecks, 1);
 const end = result.events.at(-1)!;
 assert.equal(end.type, 'completed');
 if (end.type === 'completed') assert.equal(end.result.content, '候选 batch-1 等待用户审核');
 assert.equal(result.session.agent.shouldStopAfterTurn, undefined);
});

test('Wiki natural language success without submit is a host failure; pure query keeps ordinary result', async () => {
 const missing = await runWikiLifecycle({ receipt: { status: 'failed', content: '未提交候选', errorCode: 'worker_no_submission' } });
 assert.equal(missing.events.at(-1)?.type, 'failed');
 assert.deepEqual(missing.reasons, ['worker_no_submission']);
 assert.ok(!missing.events.some(event => event.type === 'completed'));
 const query = await runWikiLifecycle({});
 assert.equal(query.events.at(-1)?.type, 'completed');
});

test('Wiki host outcome prevents outer length/error recovery and reports actual failure', async () => {
 for (const [stopReason, reason] of [['length', 'model_output_limit'], ['error', 'model_error']] as const) {
  const result = await runWikiLifecycle({ ending: { stopReason, errorMessage: '429', content: [] },
   receipt: { status: 'failed', content: reason, errorCode: reason } });
  assert.equal(result.prompts, 1); assert.deepEqual(result.reasons, [reason]);
  assert.equal(result.events.at(-1)?.type, 'failed');
  assert.ok(!result.events.some(event => event.type === 'progress' && /recovery|wait/.test(event.stage ?? '')));
 }
});

test('Wiki durable candidate survives late model abort while unsubmitted cancellation stays cancelled', async () => {
 const committed = await runWikiLifecycle({ ending: { stopReason: 'aborted', content: [] },
  receipt: { status: 'completed', content: '候选已提交待审核' } });
 assert.equal(committed.events.at(-1)?.type, 'completed');
 assert.deepEqual(committed.reasons, ['cancelled']);
 const signal = new AbortController(); signal.abort();
 const cancelled = await runWikiLifecycle({ signal: signal.signal,
  receipt: { status: 'cancelled', content: '已取消', errorCode: 'cancelled' } });
 assert.equal(cancelled.prompts, 0); assert.equal(cancelled.aborts, 1);
 const end = cancelled.events.at(-1)!;
 assert.equal(end.type, 'failed');
 if (end.type === 'failed') assert.equal(end.result.status, 'cancelled');
});

test('Wiki finalization storage failure is explicit failure and cannot fall through to prose success', async () => {
 const result = await runWikiLifecycle({ finalizeError: true });
 const end = result.events.at(-1)!;
 assert.equal(end.type, 'failed');
 if (end.type === 'failed') assert.equal(end.result.errorCode, 'knowledge_execution_finalize_failed');
});

test('Wiki driver cancellation records host abort without waiting for SDK idle', async () => {
 let entered!: () => void, release!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 let recorded = 0;
 const execution: KnowledgeWorkerExecution = {
  bind() {}, async shouldStop() { return false; },
  async abort() { recorded++; },
  async finish() { return { status: 'cancelled', content: '已取消', errorCode: 'cancelled' }; },
 };
 const messages: Array<Record<string, unknown>> = [];
 const session = {
  messages, agent: { state: { messages }, shouldStopAfterTurn: undefined },
  subscribe: () => () => undefined,
  async prompt() { entered(); await gate; messages.push({ role: 'assistant', stopReason: 'aborted' }); },
  // Uncooperative SDK abort is deliberately left unresolved.
  abort: () => new Promise<void>(() => {}),
 };
 const driver = new LocalPiDriver();
 const drive = (driver as unknown as {
  drive(session: unknown, message: string, context: InvocationContext, sessionHandle: string, runHandle: string,
   transientAttempt: number, usageStart: undefined, outputAttempt: number, execution: KnowledgeWorkerExecution): AsyncIterable<AgentEvent>;
 }).drive.bind(driver);
 const collected = collect(drive(session, 'organize', ctx, 'cancel-session', 'cancel-wiki-run', 0, undefined, 0, execution));
 await started;
 await driver.cancel({ runHandle: 'cancel-wiki-run' }, ctx);
 assert.equal(recorded, 1);
 release();
 const events = await collected;
 const end = events.at(-1)!;
 assert.equal(end.type, 'failed');
 if (end.type === 'failed') assert.equal(end.result.status, 'cancelled');
});
