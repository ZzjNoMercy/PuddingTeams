import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PuddingClawDriver } from "./puddingclaw-driver.js";
import type { AgentEvent, InvocationContext } from "./types.js";

/**
 * §8.2 clarify-and-retry：worker 在 Run 启动前的发问（分析模型澄清）没有
 * continuation_token/run_id/session_id 可恢复。Driver 必须把原任务文本塞进
 * providerState 私有通道，respond 时把用户选择并入原任务重跑一次。
 */

function freshDir(): string {
	return mkdtempSync(path.join(tmpdir(), "pt-pc-driver-"));
}

/**
 * 假 CLI：首次 run 输出"模型路由澄清"形 needs_input（无 run_id/token）；
 * stdin 含「用户已明确」时视为重跑成功，输出 completed。
 */
function fakeCli(dir: string): string {
	const cli = path.join(dir, "fake-puddingclaw.sh");
	writeFileSync(
		cli,
		[
			"#!/bin/sh",
			'printf "%s\\n" "$@" > "$ARGV_CAPTURE"',
			'cat > "$STDIN_CAPTURE"',
			'if grep -q "用户已明确" "$STDIN_CAPTURE"; then',
			'  printf "%s\\n" \'{"status":"completed","final_response":"done","run_id":"r2","session_id":"s2"}\'',
			"else",
			'  printf "%s\\n" \'{"status":"needs_input","needs_input":{"type":"analytics_model_clarification","prompt":"无法根据当前问题唯一匹配分析模型","options":[{"id":"产品配置分析"},{"id":"汽车行业综合分析"}]}}\'',
			"fi",
			"",
		].join("\n"),
	);
	chmodSync(cli, 0o755);
	return cli;
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const e of iter) out.push(e);
	return out;
}

test("PuddingClawDriver：input_required 时原任务文本进 providerState 私有通道", async () => {
	const dir = freshDir();
	const ws = path.join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	const driver = new PuddingClawDriver({ command: fakeCli(dir) });
	const ctx: InvocationContext = {
		cwd: ws,
		env: { ...process.env, ARGV_CAPTURE: path.join(dir, "argv.txt"), STDIN_CAPTURE: path.join(dir, "stdin.txt") },
	};
	const events = await collect(driver.run({ message: "分析一下上月的配置数据", requestId: "req-1" }, ctx));
	const needs = events.find((e) => e.type === "input_required");
	assert.ok(needs && needs.type === "input_required");
	assert.equal(needs.providerState?.task, "分析一下上月的配置数据", "clarify-and-retry 需要原任务文本");
	assert.equal(needs.providerState?.continuation_token, undefined, "该形发问本来就没有 token");
});

test("PuddingClawDriver：respond 无 token 时按用户选择并入原任务重跑", async () => {
	const dir = freshDir();
	const ws = path.join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	const driver = new PuddingClawDriver({ command: fakeCli(dir) });
	const stdinCapture = path.join(dir, "stdin.txt");
	const ctx: InvocationContext = {
		cwd: ws,
		env: { ...process.env, ARGV_CAPTURE: path.join(dir, "argv.txt"), STDIN_CAPTURE: stdinCapture },
		providerState: { task: "分析一下上月的配置数据" },
	};
	const events = await collect(
		driver.respond(
			{ runHandle: "", interactionHandle: "h", requestId: "req-2", responses: [{ requestId: "req-1", action: "approve", scope: "产品配置分析" }] },
			ctx,
		),
	);
	const completed = events.find((e) => e.type === "completed");
	assert.ok(completed, `重跑应完成：${JSON.stringify(events)}`);
	const argv = readFileSync(path.join(dir, "argv.txt"), "utf-8").trim().split("\n");
	assert.deepEqual(argv.slice(0, 2), ["agent", "run"], "clarify-and-retry 走的是 agent run 而不是 respond");
	const stdin = JSON.parse(readFileSync(stdinCapture, "utf-8")) as { message: string };
	assert.ok(stdin.message.includes("分析一下上月的配置数据"), "重跑必须带原任务");
	assert.ok(stdin.message.includes("「产品配置分析」"), "重跑必须并入用户选择");
});

test("PuddingClawDriver：respond 无 token 且缺原任务/选择时明确失败，不静默重跑", async () => {
	const dir = freshDir();
	const ws = path.join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	const driver = new PuddingClawDriver({ command: fakeCli(dir) });
	const ctx: InvocationContext = {
		cwd: ws,
		env: { ...process.env, ARGV_CAPTURE: path.join(dir, "argv.txt"), STDIN_CAPTURE: path.join(dir, "stdin.txt") },
		providerState: {},
	};
	const events = await collect(
		driver.respond(
			{ runHandle: "", interactionHandle: "h", requestId: "req-3", responses: [{ requestId: "req-1", action: "approve", scope: "once" }] },
			ctx,
		),
	);
	const failed = events.find((e) => e.type === "failed");
	assert.ok(failed && failed.type === "failed");
	assert.equal(failed.result.errorCode, "interaction_unsupported");
});
