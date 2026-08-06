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
