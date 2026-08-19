import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, SessionConflictError } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { InteractionError } from "../agent-runtime/interaction-broker.js";
import type { AgentDriver, AgentEvent, DriverCapabilities, InvocationContext } from "../agent-runtime/types.js";

const PROJECT = { workspaceId: "workspace-1", cwdSnapshot: process.cwd(), agentRevision: 0 } as const;

/**
 * Phase 0 锚测试：needs_input → manager 重试委托 → 409 的失败复现。
 *
 * 现在（Phase 3 前）的行为是：manager 把 needs_input 当文字告诉用户，用户回复后
 * 再次调用委托工具，导致同一 PuddingClaw Session 上创建新 Run → 409。
 *
 * 修正后的状态机（§1.3）：waiting_input 不是 failed，正确路径是保存 pending
 * Interaction，用户审批后调用 Driver.respond 恢复**同一条 Run**，绝不重跑。
 * 本测试固化的正确行为是：同一 Session 处于 waiting_input 时，二次 delegate
 * 必须被 Runtime 拒绝（409 语义），且 respond 后 runHandle 不变、任务不重跑。
 */

/** Mock driver: first run returns needs_input; respond returns completed. */
function makeDriver(sessionId: string, runId: string): { driver: AgentDriver; responded: { requestId: string }[] } {
	const responded: { requestId: string }[] = [];
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: ["permission"], progress: "none", transport: "spawn" };
		},
		async *run(input: { message: string; requestId: string; options?: Record<string, unknown> }, ctx: InvocationContext): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: sessionId, runHandle: runId };
			yield {
				type: "input_required",
				result: {
					agentId: "puddingclaw",
					status: "needs_input",
					sessionHandle: sessionId,
					runHandle: runId,
					interaction: {
						id: "int_placeholder",
						kind: "permission",
						requests: [{ requestId: "perm-1", prompt: "允许执行 SQL 查询？", options: ["once", "run", "reject"] }],
					},
				},
			};
		},
		async *continue(input: { message: string; requestId: string; sessionHandle: string; options?: Record<string, unknown> }, ctx: InvocationContext): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: sessionId, runHandle: runId };
			yield {
				type: "input_required",
				result: {
					agentId: "puddingclaw",
					status: "needs_input",
					interaction: { id: "int_placeholder", kind: "permission", requests: [] },
				},
			};
		},
		async *respond(input: { runHandle: string; interactionHandle: string; requestId: string; responses: Array<{ requestId: string; action: string }> }, ctx: InvocationContext): AsyncIterable<AgentEvent> {
			responded.push({ requestId: input.requestId });
			yield { type: "started", sessionHandle: sessionId, runHandle: runId };
			yield {
				type: "completed",
				result: { agentId: "puddingclaw", status: "completed", sessionHandle: sessionId, runHandle: runId, content: "分析完成" },
			};
		},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue", "respond"], interactionKinds: ["permission"], progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	return { driver, responded };
}

function freshDir(): string {
	return mkdtempSync(path.join(tmpdir(), "pt-anchor-"));
}

async function makeRuntime() {
	const dir = freshDir();
	const delegations = new DelegationStore(dir);
	await delegations.init();
	const secrets = new InteractionSecretStore(dir);
	await secrets.init();
	return { delegations, secrets, dir };
}

test("Phase0 anchor: needs_input 后同一 Session 二次 delegate 返回 409 语义（不重跑任务）", async () => {
	const { delegations, secrets } = await makeRuntime();
	const { driver, responded } = makeDriver("worker-session-1", "run-abc");
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const first = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "分析上月销售", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(first.status, "needs_input");
	assert.ok(first.interaction, "等待审批时必须产生 interaction");
	assert.equal(first.result.status, "needs_input");
	// needs_input 事件里的 interaction.id 是本地占位；真正的公开 id 由 store 生成。
	const interactionId = first.interaction!.id;
	assert.notEqual(interactionId, "", "interaction 必须有公开 id");

	// 第二次 delegate：同一 Session 已有 waiting_input，Runtime 锁拒绝（409 语义）。
	// 这是现在（Phase 3 前）manager 重试委托工具得到 409 的等价复现：
	// 同一 Session 已占用，绝不能重跑任务。
	await assert.rejects(
		() =>
			runtime.delegate(
				{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "分析上月销售", mode: "continue", sessionHandle: "worker-session-1" },
				{ cwd: process.cwd(), env: {} },
			),
		(err) => err instanceof SessionConflictError && /active Run or pending input/.test(err.message),
	);

	// 正确路径：用户审批 → respond（不是新的 run/continue）。
	const outcome = await runtime.respond(
		interactionId,
		{ requestId: "ui-submit-1", revision: 0, responses: [{ requestId: "perm-1", action: "approve", scope: "once" }] },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "completed");
	assert.equal(responded.length, 1, "respond 只应调用一次 driver.respond");
	assert.equal(responded[0]!.requestId, "ui-submit-1");

	// 幂等：同一 requestId 重放返回相同结果，不重复执行授权。
	const replay = await runtime.respond(
		interactionId,
		{ requestId: "ui-submit-1", revision: 1, responses: [{ requestId: "perm-1", action: "approve", scope: "once" }] },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(replay.status, "completed", "幂等重放应返回相同终态");
	assert.equal(responded.length, 1, "幂等重放不得再次调用 driver");

	// runHandle 不变（§12.1）。
	assert.equal((first.result as { runHandle?: string }).runHandle, "run-abc");
});

test("respond：delegation 无 runHandle 时不抛错卡死，交给 Driver 判断（clarify-and-retry）", async () => {
	const { delegations, secrets } = await makeRuntime();
	// worker 在 Run 启动前发问（分析模型澄清）：input_required 不带 runHandle/
	// sessionHandle，旧实现在这里抛 "has no runHandle"，delegation 永卡
	// waiting_input 且审批已被消费。
	const responded: string[] = [];
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: ["question"], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started" };
			yield {
				type: "input_required",
				result: {
					agentId: "puddingclaw",
					status: "needs_input",
					interaction: {
						id: "",
						kind: "question",
						requests: [{ requestId: "req-1", prompt: "无法唯一匹配分析模型", options: ["once"] }],
					},
				},
				providerState: { task: "分析一下上月的配置数据" },
			};
		},
		async *continue(): AsyncIterable<AgentEvent> { throw new Error("unused"); },
		async *respond(input: { runHandle: string; requestId: string }): AsyncIterable<AgentEvent> {
			responded.push(input.runHandle);
			yield { type: "started" };
			yield { type: "completed", result: { agentId: "puddingclaw", status: "completed", content: "done" } };
		},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue", "respond"] as const, interactionKinds: ["question"] as const, progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const first = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(first.status, "needs_input");
	const outcome = await runtime.respond(
		first.interaction!.id,
		{ requestId: "ui-1", revision: 0, responses: [{ requestId: "req-1", action: "approve", scope: "once" }] },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "completed", "无 runHandle 不得阻断 respond（由 Driver 决定如何继续）");
	assert.deepEqual(responded, [""], "Driver 收到空 runHandle 并自行降级（clarify-and-retry）");
});

test("Phase0 anchor: 非 pending 状态拒绝二次消费（revision 校验）", async () => {
	const { delegations, secrets } = await makeRuntime();
	const { driver } = makeDriver("worker-session-2", "run-def");
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const first = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	const id = first.interaction!.id;

	// 已消费后再次提交（不同 requestId）应抛 not_pending。
	await runtime.respond(
		id,
		{ requestId: "r1", revision: 0, responses: [{ requestId: "perm-1", action: "approve", scope: "once" }] },
		{ cwd: process.cwd(), env: {} },
	);
	await assert.rejects(
		() => runtime.respond(id, { requestId: "r2", revision: 1, responses: [{ requestId: "perm-1", action: "approve", scope: "once" }] }, { cwd: process.cwd(), env: {} }),
		(err) => err instanceof InteractionError && err.code === "not_pending",
	);
});

test("Phase0 anchor: 拒绝也是合法响应，Run 进入可解释终态", async () => {
	const { delegations, secrets } = await makeRuntime();
	const driver = makeDriver("worker-session-3", "run-ghi");
	const runtime = new AgentRuntime(delegations, secrets, () => driver.driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const first = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	const id = first.interaction!.id;

	const outcome = await runtime.respond(
		id,
		{ requestId: "reject-1", revision: 0, responses: [{ requestId: "perm-1", action: "reject" }] },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "rejected", "用户拒绝是合法响应");
	assert.equal(driver.responded.length, 0, "拒绝不调用 driver.respond");
});

/**
 * 安全收口回归：reject 是终态，必须释放 input_required 占的 session 锁
 * （否则该 session 永久 409 直到重启），并清理加密 continuation token。
 */
test("安全收口: reject 释放 session 锁并清理 provider state", async () => {
	const { delegations, secrets } = await makeRuntime();
	const sessionId = "sess-rej-1";
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: ["permission"], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started" };
			yield {
				type: "input_required",
				result: {
					agentId: "puddingclaw",
					status: "needs_input",
					sessionHandle: sessionId,
					runHandle: "run-rej-1",
					interaction: { id: "int_placeholder", kind: "permission", requests: [{ requestId: "perm-1", prompt: "允许？", options: ["once", "reject"] }] },
				},
				providerState: { continuation_token: "secret-token-rej" },
			};
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: "puddingclaw", status: "failed", errorCode: "x", error: "不应被调用", recoverable: false } };
		},
		async *continue(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: "puddingclaw", status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue", "respond"], interactionKinds: ["permission"], progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const first = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	const interactionId = first.interaction!.id;
	assert.ok(await secrets.getProviderState(interactionId), "needs_input 时 token 必须已加密落盘");

	const outcome = await runtime.respond(
		interactionId,
		{ requestId: "rej-1", revision: 0, responses: [{ requestId: "perm-1", action: "reject" }] },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "rejected");
	assert.equal(outcome.delegation.status, "cancelled", "reject 后 delegation 进入 cancelled 终态");
	assert.equal(await secrets.getProviderState(interactionId), undefined, "reject 后必须清理加密 token");

	// 锁已释放：同一 session 可再次 delegate，不再抛 SessionConflictError。
	const second = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "y", mode: "continue", sessionHandle: sessionId },
		{ cwd: process.cwd(), env: {} },
	);
	assert.ok(second.status !== "failed" || (second.result as { errorCode?: string }).errorCode !== "session_conflict", "reject 后同 session 必须可再次使用");
});

/**
 * C1/H1 回归：真实 PuddingClawDriver 的 `started` 事件不带 runHandle/sessionHandle，
 * 它们只出现在 boundary result 里。delegation 必须从 input_required 的 result 持久化
 * 这两个 handle，否则 respond 因缺 runHandle 抛错、续接因缺 sessionHandle 失效。
 */
test("Phase1 回归: boundary result 的 runHandle/sessionHandle 被持久化（respond 可恢复原 Run）", async () => {
	const { delegations, secrets } = await makeRuntime();
	// 模拟真实 driver：started 空 handle，needs_input 的 result 带 session_id/run_id。
	const runId = "run-real-1";
	const sessionId = "sess-real-1";
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: ["permission"], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started" };
			yield {
				type: "input_required",
				result: {
					agentId: "puddingclaw",
					status: "needs_input",
					sessionHandle: sessionId,
					runHandle: runId,
					interaction: { id: "int_placeholder", kind: "permission", requests: [{ requestId: "perm-1", prompt: "允许？", options: ["once", "reject"] }] },
				},
				providerState: { continuation_token: "secret-token-xyz" },
			};
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "started" };
			yield { type: "completed", result: { agentId: "puddingclaw", status: "completed", sessionHandle: sessionId, runHandle: runId, content: "完成" } };
		},
		async *continue(): AsyncIterable<AgentEvent> {
			yield { type: "started" };
			yield { type: "failed", result: { agentId: "puddingclaw", status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue", "respond"], interactionKinds: ["permission"], progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const first = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(first.status, "needs_input");
	// C1：delegation 必须已持久化 runHandle/sessionHandle。
	assert.equal(first.delegation.runHandle, runId, "delegation 必须持久化 boundary result 的 runHandle");
	assert.equal(first.delegation.sessionHandle, sessionId, "delegation 必须持久化 boundary result 的 sessionHandle");

	// C1：respond 必须能成功（不再因缺 runHandle 抛错）。
	const outcome = await runtime.respond(
		first.interaction!.id,
		{ requestId: "ok-1", revision: 0, responses: [{ requestId: "perm-1", action: "approve", scope: "once" }] },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.delegation.runHandle, runId, "respond 后 runHandle 不变（§12.1）");
});

/**
 * H4 回归：needs_input 的 options（答案选项）不得被映射成多个并行 request，
 * 必须是一个 request + 选项；真实 request_id 必须被保留。
 */
test("Phase1 回归: needs_input 归一化只产生一个 request，选项不破坏覆盖校验", async () => {
	const { normalizePuddingClawJson } = await import("../agent-runtime/normalize.js");
	const event = normalizePuddingClawJson({
		status: "needs_input",
		request_id: "model-select-1",
		session_id: "s1",
		run_id: "r1",
		needs_input: {
			type: "analytics_model_selection",
			prompt: "请选择分析模型",
			options: [
				{ id: "m1", name: "销售模型" },
				{ id: "m2", name: "财务模型" },
			],
		},
	});
	assert.equal(event.type, "input_required");
	if (event.type !== "input_required") return;
	assert.equal(event.result.interaction.requests.length, 1, "必须只有一个 request");
	const req = event.result.interaction.requests[0]!;
	assert.equal(req.requestId, "model-select-1", "必须保留真实 request_id");
	assert.equal(req.prompt, "请选择分析模型");
	assert.equal(event.result.sessionHandle, "s1", "sessionHandle 进入 result 供持久化");
	assert.equal(event.result.runHandle, "r1", "runHandle 进入 result 供持久化");
	const ps = (event as { providerState?: Record<string, unknown> }).providerState;
	assert.ok(ps && ps.run_id === "r1" && ps.session_id === "s1", "providerState 携带 run/session 定位信息");
	assert.equal(ps.continuation_token, undefined, "无 continuation_token 时 providerState 不含 token");
});

test("PuddingClaw 权限目标 scope 归一化为 CLI 可接受的 once/session", async () => {
	const { normalizePuddingClawJson } = await import("../agent-runtime/normalize.js");
	const event = normalizePuddingClawJson({
		status: "needs_input",
		request_id: "perm-req-shell-test",
		needs_input: {
			type: "permission_request",
			prompt: "允许终端访问目录？",
			options: [
				{ id: "exact_directory_run" },
				{ id: "exact_directory_session" },
			],
		},
	});
	assert.equal(event.type, "input_required");
	if (event.type !== "input_required") return;
	assert.deepEqual(event.result.interaction.requests[0]?.options, ["once", "session", "reject"]);
});

test("未知或仅一次性权限 option 不制造 session 授权", async () => {
	const { normalizePuddingClawJson } = await import("../agent-runtime/normalize.js");
	const event = normalizePuddingClawJson({
		status: "needs_input",
		needs_input: {
			type: "permission",
			prompt: "允许一次执行？",
			options: [{ id: "exact_shell_run" }],
		},
	});
	assert.equal(event.type, "input_required");
	if (event.type !== "input_required") return;
	assert.deepEqual(event.result.interaction.requests[0]?.options, ["once", "reject"]);
});


/**
 * Phase6 回归：run 模式 completed outcome 必须携带更新后的 delegation
 * （sessionHandle/runHandle）。invoker 据 outcome.delegation.sessionHandle
 * 写 workerBindings 续接记忆——返回创建时的旧对象会让 run 模式永远丢
 * sessionHandle，第二次委托退化成新会话（pi connector 实测复现）。
 */
test("Phase6 回归: run 模式 completed outcome 的 delegation 带 sessionHandle/runHandle", async () => {
	const { delegations, secrets } = await makeRuntime();
	const runId = "run-pi-1";
	const sessionId = "sess-pi-1";
	const driver: AgentDriver = {
		id: "pi",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "cancel"], interactionKinds: [], progress: "stream", transport: "sdk" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			// pi driver：started 才给出 handle，boundary result 也带（H1）。
			yield { type: "started", sessionHandle: sessionId, runHandle: runId };
			yield {
				type: "completed",
				result: { agentId: "pi", status: "completed", sessionHandle: sessionId, runHandle: runId, content: "完成" },
			};
		},
		async *continue(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: sessionId, runHandle: runId };
			yield {
				type: "completed",
				result: { agentId: "pi", status: "completed", sessionHandle: sessionId, runHandle: runId, content: "完成" },
			};
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: "pi", status: "failed", errorCode: "interaction_unsupported", error: "x", recoverable: false } };
		},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue", "cancel"], interactionKinds: [], progress: "stream" as const, transport: "sdk" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const outcome = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "pi", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.delegation.sessionHandle, sessionId, "completed outcome 必须带更新后的 sessionHandle");
	assert.equal(outcome.delegation.runHandle, runId, "completed outcome 必须带更新后的 runHandle");

	// failed 终态同样不能返回创建时的旧 delegation。
	const failedDriver: AgentDriver = {
		...driver,
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: "sess-pi-2", runHandle: "run-pi-2" };
			yield {
				type: "failed",
				result: { agentId: "pi", status: "failed", sessionHandle: "sess-pi-2", runHandle: "run-pi-2", errorCode: "x", error: "x", recoverable: true },
			};
		},
	};
	const runtime2 = new AgentRuntime(delegations, secrets, () => failedDriver, { ttlMs: 24 * 60 * 60 * 1000 });
	const failed = await runtime2.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "pi", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(failed.status, "failed");
	assert.equal(failed.delegation.sessionHandle, "sess-pi-2", "failed outcome 同样必须带 sessionHandle");
});

test("P3-1: respond 忽略调用方的新 cwd，始终恢复到 Delegation.cwdSnapshot", async () => {
	const { delegations, secrets, dir } = await makeRuntime();
	const a = path.join(dir, "project-a");
	const b = path.join(dir, "project-b");
	mkdirSync(a);
	mkdirSync(b);
	let respondCwd = "";
	const driver: AgentDriver = {
		id: "snapshot",
		async capabilities() {
			return { operations: ["run", "respond"], interactionKinds: ["permission"], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield {
				type: "input_required",
				result: {
					agentId: "snapshot", status: "needs_input", runHandle: "run-a", sessionHandle: "session-a",
					interaction: { id: "placeholder", kind: "permission", requests: [{ requestId: "p1", prompt: "允许？" }] },
				},
			};
		},
		async *continue(): AsyncIterable<AgentEvent> { throw new Error("unused"); },
		async *respond(_input, ctx): AsyncIterable<AgentEvent> {
			respondCwd = ctx.cwd;
			yield { type: "completed", result: { agentId: "snapshot", status: "completed", content: "ok" } };
		},
		async probe() { throw new Error("unused"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 });
	const cwdSnapshot = realpathSync(a);
	const delegated = await runtime.delegate(
		{ workspaceId: "workspace-a", cwdSnapshot, windowId: "window-a", managerSessionId: "manager-a", agentId: "snapshot", agentRevision: 0, message: "x", mode: "run" },
		{ cwd: cwdSnapshot, env: {} },
	);
	await runtime.respond(
		delegated.interaction!.id,
		{ requestId: "approve-a", revision: 0, responses: [{ requestId: "p1", action: "approve" }] },
		{ cwd: realpathSync(b), env: {} },
	);
	assert.equal(respondCwd, cwdSnapshot);
});

test("P3-1: cancel abort 真实 Run，迟到 completed 不能复活 cancelled Delegation", async () => {
	const dir = freshDir();
	const store = new DelegationStore(dir);
	await store.init();
	const secrets = new InteractionSecretStore(dir);
	await secrets.init();
	let observedAbort = false;
	const driver: AgentDriver = {
		id: "slow",
		async capabilities() {
			return { operations: ["run", "cancel"], interactionKinds: [], progress: "stream", transport: "spawn" };
		},
		async *run(_input, ctx) {
			await new Promise<void>((resolve) => {
				if (ctx.signal?.aborted) return resolve();
				ctx.signal?.addEventListener("abort", () => {
					observedAbort = true;
					resolve();
				}, { once: true });
			});
			yield { type: "completed", result: { agentId: "slow", status: "completed", content: "late" } };
		},
		async *continue() {},
		async *respond() {},
		async probe() {
			return { extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] };
		},
	};
	const runtime = new AgentRuntime(store, secrets, () => driver);
	const outcomePromise = runtime.delegate(
		{ ...PROJECT, windowId: "window-cancel", managerSessionId: "manager-cancel", agentId: "slow", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	let delegation;
	for (let i = 0; i < 20 && !delegation; i += 1) {
		delegation = (await runtime.listDelegations("window-cancel"))[0];
		if (!delegation) await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(delegation);
	await runtime.cancel(delegation.id, { cwd: process.cwd(), env: {} });
	const outcome = await outcomePromise;
	assert.equal(observedAbort, true);
	assert.equal(outcome.delegation.status, "cancelled");
	assert.equal((await runtime.getDelegation(delegation.id))?.status, "cancelled");
});

test("P3-1: terminal CAS 阻止 cancelled 被 completed 覆盖", async () => {
	const store = new DelegationStore(freshDir());
	await store.init();
	const delegation = await store.createDelegation({
		...PROJECT,
		windowId: "window-cas",
		managerSessionId: "manager-cas",
		agentId: "slow",
		operation: "run",
	});
	const cancelled = await store.transitionDelegation(delegation.id, ["running"], { status: "cancelled" });
	const completed = await store.transitionDelegation(delegation.id, ["running"], {
		status: "completed",
		result: { agentId: "slow", status: "completed", content: "late" },
	});
	assert.equal(cancelled.applied, true);
	assert.equal(completed.applied, false);
	assert.equal(completed.record?.status, "cancelled");
});

test("P3-1: Driver throw 与无边界流都落持久化 failed，不留下 running 幽灵", async () => {
	for (const behavior of ["throw", "empty"] as const) {
		const dir = freshDir();
		const store = new DelegationStore(dir);
		await store.init();
		const secrets = new InteractionSecretStore(dir);
		await secrets.init();
		const driver: AgentDriver = {
			id: behavior,
			async capabilities() {
				return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" };
			},
			async *run() {
				if (behavior === "throw") throw new Error("driver exploded");
			},
			async *continue() {},
			async *respond() {},
			async probe() {
				return { extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] };
			},
		};
		const runtime = new AgentRuntime(store, secrets, () => driver);
		const promise = runtime.delegate(
			{ ...PROJECT, windowId: `window-${behavior}`, managerSessionId: "manager", agentId: behavior, message: "x", mode: "run" },
			{ cwd: process.cwd(), env: {} },
		);
		if (behavior === "throw") await assert.rejects(() => promise, /driver exploded/);
		else assert.equal((await promise).status, "failed");
		assert.equal((await runtime.listDelegations(`window-${behavior}`))[0]?.status, "failed");
	}
});


test("失效会话自动恢复：continue 撞 session-not-found → 丢弃旧 handle 以新会话透明重跑", async () => {
	const { delegations, secrets } = await makeRuntime();
	const calls: string[] = [];
	const updates: string[] = [];
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue", "respond", "cancel"], interactionKinds: [], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			calls.push("run");
			yield { type: "started", sessionHandle: "worker-session-fresh", runHandle: "run-new" };
			yield {
				type: "completed",
				result: { agentId: "puddingclaw", status: "completed", sessionHandle: "worker-session-fresh", runHandle: "run-new", content: "完成" },
			};
		},
		async *continue(): AsyncIterable<AgentEvent> {
			calls.push("continue");
			yield { type: "started", sessionHandle: "worker-session-stale" };
			yield {
				type: "failed",
				result: { agentId: "puddingclaw", status: "failed", errorCode: "http_error", error: "Headless Session not found", recoverable: false },
			};
		},
		async *respond(): AsyncIterable<AgentEvent> {},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue", "respond"], interactionKinds: [], progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);

	const outcome = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "接着上次分析", mode: "continue", sessionHandle: "worker-session-stale" },
		{ cwd: process.cwd(), env: {}, onUpdate: (content) => updates.push(content) },
	);
	assert.equal(outcome.status, "completed", "失效会话必须透明重跑而不是失败");
	assert.deepEqual(calls, ["continue", "run"], "先 continue，失败后以新会话 run 重试一次");
	assert.ok(updates.some((u) => u.includes("旧会话已失效")), "恢复过程应经 onUpdate 告知");

	const record = (await runtime.listDelegations("win-1"))[0]!;
	assert.equal(record.status, "completed");
	assert.equal(record.sessionHandle, "worker-session-fresh", "delegation 必须记录新 session handle");
});

test("失效会话恢复只重试一次：新会话也失败则正常失败，不死循环", async () => {
	const { delegations, secrets } = await makeRuntime();
	const calls: string[] = [];
	const fail = (error: string): AgentEvent => ({
		type: "failed",
		result: { agentId: "puddingclaw", status: "failed", errorCode: "http_error", error, recoverable: false },
	});
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue"], interactionKinds: [], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			calls.push("run");
			yield { type: "started", sessionHandle: "worker-session-fresh" };
			yield fail("Headless Session not found");
		},
		async *continue(): AsyncIterable<AgentEvent> {
			calls.push("continue");
			yield { type: "started", sessionHandle: "worker-session-stale" };
			yield fail("Headless Session not found");
		},
		async *respond(): AsyncIterable<AgentEvent> {},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue"], interactionKinds: [], progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);

	const outcome = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "continue", sessionHandle: "worker-session-stale" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "failed", "重试仍失败则正常失败");
	assert.deepEqual(calls, ["continue", "run"], "恢复重试最多一次");
});

test("失效会话恢复不误吞普通失败：非 session-not-found 错误直接失败", async () => {
	const { delegations, secrets } = await makeRuntime();
	const calls: string[] = [];
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue"], interactionKinds: [], progress: "none", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			calls.push("run");
			yield { type: "started" };
		},
		async *continue(): AsyncIterable<AgentEvent> {
			calls.push("continue");
			yield { type: "started", sessionHandle: "worker-session-stale" };
			yield {
				type: "failed",
				result: { agentId: "puddingclaw", status: "failed", errorCode: "auth_error", error: "Worker Access Key is invalid, revoked, expired, or out of scope", recoverable: false },
			};
		},
		async *respond(): AsyncIterable<AgentEvent> {},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue"], interactionKinds: [], progress: "none" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);

	const outcome = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "continue", sessionHandle: "worker-session-stale" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(outcome.status, "failed");
	assert.deepEqual(calls, ["continue"], "普通失败不得触发新会话重跑");
});

test("started 事件经 onUpdate 透出 sessionHandle/delegationId（执行过程可视化入口）", async () => {
	const { delegations, secrets } = await makeRuntime();
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities(): Promise<DriverCapabilities> {
			return { operations: ["run", "continue"], interactionKinds: [], progress: "stream", transport: "spawn" };
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started", sessionHandle: "worker-session-9", runHandle: "run-9" };
			yield {
				type: "completed",
				result: { agentId: "puddingclaw", status: "completed", sessionHandle: "worker-session-9", runHandle: "run-9", content: "done" },
			};
		},
		async *continue(): AsyncIterable<AgentEvent> {},
		async *respond(): AsyncIterable<AgentEvent> {},
		async probe(ctx: InvocationContext) {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true,
				compatibility: "supported" as const, capabilities: { operations: ["run", "continue"], interactionKinds: [], progress: "stream" as const, transport: "spawn" as const }, issues: [],
			};
		},
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver);

	const updates: Array<{ content: string; details?: unknown }> = [];
	const outcome = await runtime.delegate(
		{ ...PROJECT, windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
		{ cwd: process.cwd(), env: {}, onUpdate: (content, details) => updates.push({ content, details }) },
	);
	assert.equal(outcome.status, "completed");
	const ready = updates.find((u) => (u.details as { sessionHandle?: string } | undefined)?.sessionHandle === "worker-session-9");
	assert.ok(ready, "started 必须把 sessionHandle 经 onUpdate 透出给委托卡");
	assert.equal((ready.details as { delegationId?: string }).delegationId, outcome.delegation.id);
	assert.equal((ready.details as { running?: boolean }).running, true);
});
