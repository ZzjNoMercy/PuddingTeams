import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, SessionConflictError } from "../agent-runtime/runtime.js";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "../agent-runtime/interaction-secret-store.js";
import { InteractionError } from "../agent-runtime/interaction-broker.js";
import type { AgentDriver, AgentEvent, DriverCapabilities, InvocationContext } from "../agent-runtime/types.js";

/**
 * Phase 0 锚测试：needs_input → manager 重试 team_task → 409 的失败复现。
 *
 * 现在（Phase 3 前）的行为是：manager 把 needs_input 当文字告诉用户，用户回复后
 * 再次调用 team_task，导致同一 PuddingClaw Session 上创建新 Run → 409。
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
		{ windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "分析上月销售", mode: "run" },
		{ cwd: process.cwd(), env: {} },
	);
	assert.equal(first.status, "needs_input");
	assert.ok(first.interaction, "等待审批时必须产生 interaction");
	assert.equal(first.result.status, "needs_input");
	// needs_input 事件里的 interaction.id 是本地占位；真正的公开 id 由 store 生成。
	const interactionId = first.interaction!.id;
	assert.notEqual(interactionId, "", "interaction 必须有公开 id");

	// 第二次 delegate：同一 Session 已有 waiting_input，Runtime 锁拒绝（409 语义）。
	// 这是现在（Phase 3 前）manager 重试 team_task 得到 409 的等价复现：
	// 同一 Session 已占用，绝不能重跑任务。
	await assert.rejects(
		() =>
			runtime.delegate(
				{ windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "分析上月销售", mode: "continue", sessionHandle: "worker-session-1" },
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

test("Phase0 anchor: 非 pending 状态拒绝二次消费（revision 校验）", async () => {
	const { delegations, secrets } = await makeRuntime();
	const { driver } = makeDriver("worker-session-2", "run-def");
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 24 * 60 * 60 * 1000 });

	const first = await runtime.delegate(
		{ windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
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
		{ windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
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
		{ windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", message: "x", mode: "run" },
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

