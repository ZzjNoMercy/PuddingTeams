import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createPuddingClawActivityObserver, PuddingClawDriver, projectPuddingClawActivity } from "./puddingclaw-driver.js";
import { puddingClawConnectorManifest, puddingClawExtensionHooks } from "./puddingclaw-extension.js";
import { normalizePuddingClawJson, PUDDINGCLAW_CAPABILITIES } from "./normalize.js";
import type { AgentEvent, InvocationContext, WorkerActivity } from "./types.js";

/**
 * §8.2 clarify-and-retry：worker 在 Run 启动前的发问（分析模型澄清）没有
 * continuation_token/run_id/session_id 可恢复。Driver 必须把原任务文本塞进
 * providerState 私有通道，respond 时把用户选择并入原任务重跑一次。
 */

function freshDir(): string {
	return mkdtempSync(path.join(tmpdir(), "pt-pc-driver-"));
}

const STREAM_FIXTURE = [
	{ event: "run_starting", data: { session_id: "session-http", status: "starting" } },
	{ event: "run_started", data: { run_id: "run-http", session_id: "session-http" } },
	{ event: "token", data: { content: "流式", response_id: "response-1" } },
	{ event: "token", data: { content: "进度", response_id: "response-1" } },
	{ event: "tool_start", data: { tool: "search", tool_call_id: "tool-1", input: { query: "weather" } } },
	{ event: "tool_end", data: { tool: "search", tool_call_id: "tool-1", output: { rows: 1 } } },
	{ event: "final_response", data: { final_response: "最终答复" } },
	{ event: "result", data: { status: "completed", outcome: "completed", final_response: "最终答复", run_id: "run-http", session_id: "session-http" } },
];

async function withHttpServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
	run: (endpoint: string) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) => void Promise.resolve(handler(req, res)).catch((error) => {
		res.statusCode = 500;
		res.end(String(error));
	}));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	try {
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

function streamFixture(res: ServerResponse): void {
	res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
	for (const event of STREAM_FIXTURE) {
		const line = `${JSON.stringify(event)}\n`;
		const split = Math.max(1, Math.floor(line.length / 2));
		res.write(line.slice(0, split));
		res.write(line.slice(split));
	}
	res.end();
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

test("PuddingClaw Connector 标准：包声明 spawn/http，实例 Driver 声明实际 transport", async () => {
	assert.deepEqual(puddingClawConnectorManifest.connector.supportedTransports, ["spawn", "http"]);
	assert.deepEqual(puddingClawConnectorManifest.permissions, ["spawn", "network"]);
	const hooks = puddingClawExtensionHooks();
	assert.ok(hooks.driverFactory);
	assert.equal((await hooks.driverFactory!({}, "spawn").capabilities()).transport, "spawn");
	assert.equal((await hooks.driverFactory!({}, "http").capabilities()).transport, "http");
	assert.throws(() => hooks.driverFactory!({}, "rpc"), /不支持 transport:rpc/);
});

test("PuddingClaw HTTP：增量 NDJSON 映射为房间活动并归一同一终态", async () => {
	await withHttpServer(async (req, res) => {
		if (req.method === "GET" && req.url === "/api/headless/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				agent_id: "puddingclaw",
				configured: true,
				reachable: true,
				protocol_version: "1",
				server_version: "0.1.19",
				progress: "jsonl",
				operations: { run: true, continue: true, respond: true, cancel: true },
			}));
			return;
		}
		if (req.method === "POST" && req.url === "/api/headless/runs?stream=true") {
			for await (const _chunk of req) { /* consume request body before streaming */ }
			streamFixture(res);
			return;
		}
		res.writeHead(404).end();
	}, async (endpoint) => {
		const activities: WorkerActivity[] = [];
		const driver = new PuddingClawDriver({ transport: "http", endpoint });
		const dir = freshDir();
		const events = await collect(driver.run(
			{ message: "测试 HTTP 流", requestId: "http-request-1" },
			{
				cwd: dir,
				env: { ...process.env },
				onUpdate: (_content, details) => {
					const activity = (details as { activity?: WorkerActivity } | undefined)?.activity;
					if (activity) activities.push(activity);
				},
			},
		));
		const completed = events.at(-1);
		assert.ok(completed && completed.type === "completed");
		if (completed.type !== "completed") return;
		assert.equal(completed.result.content, "最终答复");
		assert.equal(completed.result.runHandle, "run-http");
		assert.equal(completed.result.sessionHandle, "session-http");
		assert.deepEqual(activities.map((activity) => activity.sourceEvent), [
			"run_starting", "run_started", "token.batch", "tool_start", "tool_end", "final_response",
		]);
		assert.equal(activities.find((activity) => activity.sourceEvent === "token.batch")?.content, "流式进度");

		const probe = await driver.probe({ cwd: dir, env: { ...process.env } });
		assert.equal(probe.transport, "http");
		assert.equal(probe.detected, true);
		assert.equal(probe.version, "1");
		assert.equal(probe.upstreamVersion, "0.1.19");
		assert.equal(probe.compatibility, "supported");
	});
});

test("PuddingClaw HTTP probe：以 Headless API 协议和能力契约判断兼容性，不以 CLI 版本判断", async () => {
	await withHttpServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({
			agent_id: "puddingclaw",
			cli_version: "0.1.19",
			server_version: "0.1.19",
			protocol_version: "2",
			configured: true,
			reachable: true,
			progress: "jsonl",
			operations: { run: true, continue: true, respond: true, cancel: true },
		}));
	}, async (endpoint) => {
		const probe = await new PuddingClawDriver({ transport: "http", endpoint }).probe({
			cwd: freshDir(),
			env: { ...process.env },
		});
		assert.equal(probe.detected, true);
		assert.equal(probe.version, "2");
		assert.equal(probe.upstreamVersion, "0.1.19");
		assert.equal(probe.compatibility, "untested");
		assert.ok(probe.issues.some((issue) => issue.code === "protocol_untested"));
	});
});

test("PuddingClaw HTTP：断线恢复等待期间取消仍会终止已知的上游 Run", async () => {
	let cancelRunId = "";
	await withHttpServer(async (req, res) => {
		if (req.method === "POST" && req.url === "/api/headless/runs?stream=true") {
			for await (const _chunk of req) { /* consume request */ }
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			res.write(`${JSON.stringify({ event: "run_started", data: { run_id: "run-to-cancel", session_id: "session-1" } })}\n`);
			setImmediate(() => res.destroy());
			return;
		}
		if (req.method === "POST" && req.url === "/api/headless/runs/run-to-cancel/cancel") {
			cancelRunId = "run-to-cancel";
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "cancelled" }));
			return;
		}
		res.writeHead(404).end();
	}, async (endpoint) => {
		const controller = new AbortController();
		const driver = new PuddingClawDriver({
			transport: "http",
			endpoint,
			connectionRecoveryMinAgeMs: 0,
			connectionRecoveryIntervalMs: 10,
			connectionRecoveryMs: 2_000,
		});
		const events = await collect(driver.run(
			{ message: "会在恢复窗口取消", requestId: "cancel-recovery-1" },
			{
				cwd: freshDir(),
				env: { ...process.env },
				signal: controller.signal,
				onUpdate: (_content, details) => {
					if ((details as { recovering?: boolean } | undefined)?.recovering) controller.abort();
				},
			},
		));
		const last = events.at(-1);
		assert.equal(last?.type, "failed");
		if (last?.type === "failed") assert.equal(last.result.status, "cancelled");
		assert.equal(cancelRunId, "run-to-cancel");
	});
});

test("PuddingClaw 双传输一致性：同一上游事件序列生成相同 WorkerActivity 与最终文本", async () => {
	const dir = freshDir();
	const cli = path.join(dir, "fake-stream-puddingclaw.sh");
	writeFileSync(cli, [
		"#!/bin/sh",
		...STREAM_FIXTURE.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`),
		"",
	].join("\n"));
	chmodSync(cli, 0o755);

	await withHttpServer(async (req, res) => {
		if (req.method === "POST" && req.url === "/api/headless/runs?stream=true") {
			for await (const _chunk of req) { /* consume request body */ }
			streamFixture(res);
			return;
		}
		res.writeHead(404).end();
	}, async (endpoint) => {
		async function execute(driver: PuddingClawDriver): Promise<{ activities: WorkerActivity[]; result: AgentEvent | undefined }> {
			const activities: WorkerActivity[] = [];
			const events = await collect(driver.run(
				{ message: "同一任务", requestId: "same-request" },
				{
					cwd: dir,
					env: { ...process.env },
					onUpdate: (_content, details) => {
						const activity = (details as { activity?: WorkerActivity } | undefined)?.activity;
						if (activity) activities.push(activity);
					},
				},
			));
			return { activities, result: events.at(-1) };
		}

		const spawned = await execute(new PuddingClawDriver({ transport: "spawn", command: cli }));
		const http = await execute(new PuddingClawDriver({ transport: "http", endpoint }));
		assert.deepEqual(http.activities, spawned.activities);
		assert.equal(http.result?.type, "completed");
		assert.equal(spawned.result?.type, "completed");
		if (http.result?.type === "completed" && spawned.result?.type === "completed") {
			assert.equal(http.result.result.content, spawned.result.result.content);
			assert.equal(http.result.result.content, "最终答复");
		}
	});
});

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
	const stdin = JSON.parse(readFileSync(path.join(dir, "stdin.txt"), "utf-8")) as { workspace_path?: string };
	assert.equal(stdin.workspace_path, ws, "spawn transport 也必须把目标 Workspace 传给 PuddingClaw");
});

test("PuddingClaw 业务问答：逐题映射为 PWCP question 并保留同 Run 续跑状态", () => {
	const event = normalizePuddingClawJson({
		status: "needs_input",
		run_id: "run-hitl",
		continuation_token: "token-hitl",
		needs_input: {
			type: "user_input",
			request_id: "upstream-request",
			questions: [{
				id: "choice",
				prompt: "请选择 A 或 B",
				type: "single_choice",
				options: [{ id: "A", label: "方案 A" }, { id: "B", label: "方案 B" }],
			}],
		},
	});
	assert.equal(event.type, "input_required");
	if (event.type !== "input_required") return;
	assert.equal(event.result.interaction.kind, "question");
	assert.deepEqual(event.result.interaction.requests, [{ requestId: "choice", prompt: "请选择 A 或 B", options: ["A", "B"] }]);
	assert.equal(event.providerState?.interaction_type, "user_input");
	assert.equal(event.providerState?.upstream_request_id, "upstream-request");
	assert.deepEqual(event.providerState?.questions, [{ requestId: "choice", questionId: "choice", optionIds: ["A", "B"], type: "single_choice" }]);
});

test("PuddingClawDriver：业务问答答案组装为同一上游 request 的 respond payload", async () => {
	const dir = freshDir();
	const ws = path.join(dir, "target-workspace");
	mkdirSync(ws, { recursive: true });
	const cli = path.join(dir, "fake-user-input-resume.sh");
	const stdinCapture = path.join(dir, "stdin.json");
	writeFileSync(cli, [
		"#!/bin/sh",
		'printf "%s\\n" "$@" > "$ARGV_CAPTURE"',
		'cat > "$STDIN_CAPTURE"',
		'printf "%s\\n" \'{"status":"completed","final_response":"resumed","run_id":"run-hitl","session_id":"session-hitl"}\'',
		"",
	].join("\n"));
	chmodSync(cli, 0o755);
	const driver = new PuddingClawDriver({ command: cli });
	const events = await collect(driver.respond({
		runHandle: "run-hitl",
		interactionHandle: "interaction-hitl",
		requestId: "platform-request",
		responses: [{ requestId: "choice", action: "answer", value: "B" }],
	}, {
		cwd: ws,
		env: { ...process.env, ARGV_CAPTURE: path.join(dir, "argv.txt"), STDIN_CAPTURE: stdinCapture },
		providerState: {
			continuation_token: "token-hitl",
			interaction_type: "user_input",
			upstream_request_id: "upstream-request",
			questions: [{ requestId: "choice", questionId: "choice", optionIds: ["A", "B"], type: "single_choice" }],
		},
	}));
	assert.equal(events.at(-1)?.type, "completed");
	assert.deepEqual(readFileSync(path.join(dir, "argv.txt"), "utf-8").trim().split("\n").slice(0, 2), ["agent", "respond"]);
	const payload = JSON.parse(readFileSync(stdinCapture, "utf-8")) as Record<string, unknown>;
	assert.equal(payload.workspace_path, ws);
	assert.deepEqual(payload.decisions, [{
		request_id: "upstream-request",
		action: "submit",
		answers: [{ question_id: "choice", option_ids: ["B"], text: "" }],
	}]);
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
			{ runHandle: "", interactionHandle: "h", requestId: "req-2", responses: [{ requestId: "req-1", action: "answer", value: "产品配置分析" }] },
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

test("PuddingClawDriver：本机 probe 不依赖 authenticated 字段", async () => {
	const dir = freshDir();
	const cli = path.join(dir, "fake-doctor.sh");
	writeFileSync(
		cli,
		[
			"#!/bin/sh",
			'printf "%s\\n" \'{"configured":true,"reachable":true,"cli_version":"0.1.18"}\'',
			"",
		].join("\n"),
	);
	chmodSync(cli, 0o755);
	const driver = new PuddingClawDriver({ command: cli });
	const probe = await driver.probe({ cwd: dir, env: { ...process.env } });
	assert.equal(probe.configured, true);
	assert.equal(probe.authenticated, "unknown");
	assert.equal(probe.issues.length, 0);
});

test("PuddingClawDriver：长连接丢失后用同一 request_id 恢复幂等终态", async () => {
	const dir = freshDir();
	const cli = path.join(dir, "fake-recover.sh");
	const stateFile = path.join(dir, "attempt.txt");
	writeFileSync(
		cli,
		[
			"#!/bin/sh",
			'cat > "$STDIN_CAPTURE"',
			'count=$(cat "$STATE_FILE" 2>/dev/null || printf "0")',
			'count=$((count + 1))',
			'printf "%s" "$count" > "$STATE_FILE"',
			'if [ "$count" -eq 1 ]; then',
			'  printf "%s\\n" \'{"status":"error","error_code":"connection_error","error":"fetch failed"}\'',
			'elif [ "$count" -eq 2 ]; then',
			'  printf "%s\\n" \'{"status":"error","error_code":"http_error","error":"An identical Worker Run is already in progress"}\'',
			"else",
			'  printf "%s\\n" \'{"status":"completed","final_response":"recovered","run_id":"run-1","session_id":"session-1"}\'',
			"fi",
			"",
		].join("\n"),
	);
	chmodSync(cli, 0o755);
	const updates: string[] = [];
	const driver = new PuddingClawDriver({
		command: cli,
		connectionRecoveryMinAgeMs: 0,
		connectionRecoveryIntervalMs: 1,
		connectionRecoveryMs: 1_000,
	});
	const events = await collect(driver.run(
		{ message: "long task", requestId: "stable-request-id" },
		{
			cwd: dir,
			env: {
				...process.env,
				STATE_FILE: stateFile,
				STDIN_CAPTURE: path.join(dir, "stdin.json"),
			},
			onUpdate: (content) => updates.push(content),
		},
	));
	const completed = events.find((event) => event.type === "completed");
	assert.ok(completed && completed.type === "completed");
	assert.equal(completed.result.content, "recovered");
	assert.equal(readFileSync(stateFile, "utf-8"), "3");
	const stdin = JSON.parse(readFileSync(path.join(dir, "stdin.json"), "utf-8")) as { request_id?: string };
	assert.equal(stdin.request_id, "stable-request-id", "每次恢复必须重用原始幂等键");
	assert.ok(updates.some((text) => text.includes("恢复同一任务")));
	assert.ok(updates.some((text) => text.includes("仍在执行")));
});

test("PuddingClaw 时间线：19 类公共事件均有结构化投影，工具负载脱敏", () => {
	const names = [
		"run_starting", "task_preflight_started", "task_preflight_completed", "run_started",
		"run_outcome", "goal_run_continued", "new_response", "token", "segment_break",
		"segment_content_replaced", "tool_start", "tool_end", "permission_required",
		"permission_resolved", "user_input_required", "user_input_resolved",
		"final_response", "done", "error",
	];
	const projected = names.map((event, index) => projectPuddingClawActivity({
		event,
		data: {
			content: event === "token" ? "正文增量" : undefined,
			tool: "database_sql_execute",
			arguments: { query: "select 1", api_key: "must-not-leak" },
			output: { rows: 1 },
			run_id: "run-1",
			seq: index + 1,
		},
	}));
	assert.ok(projected.every(Boolean), "公共白名单事件不得静默丢弃");
	assert.deepEqual(projected.map((item) => item!.activity.sourceEvent), names);
	assert.equal(projected[7]!.activity.kind, "assistant");
	assert.equal(projected[10]!.activity.kind, "tool");
	assert.match(projected[10]!.activity.content ?? "", /\[redacted\]/);
	assert.ok(!(projected[10]!.activity.content ?? "").includes("must-not-leak"));
	assert.equal(projected[14]!.activity.title, "等待业务选择");
	assert.equal(projected[15]!.activity.title, "业务选择已提交");
});

test("PuddingClaw 时间线：连续 token 在落盘前合并，非 token 事件结束分组", () => {
	const emitted: Array<ReturnType<typeof projectPuddingClawActivity> & {}> = [];
	const observer = createPuddingClawActivityObserver((event) => emitted.push(event));
	observer.push({ event: "token", seq: 11, data: { content: "实时", response_id: "response-1" } });
	observer.push({ event: "token", seq: 12, data: { content: "天气", response_id: "response-1" } });
	assert.equal(emitted.length, 0, "连续 token 未遇边界前只在 Driver 内缓冲");
	observer.push({ event: "segment_break", seq: 13, data: {} });

	assert.equal(emitted.length, 2, "落盘一条 token batch，再落盘 segment 边界");
	assert.equal(emitted[0]?.activity.sourceEvent, "token.batch");
	assert.equal(emitted[0]?.activity.content, "实时天气");
	assert.deepEqual(emitted[0]?.activity.metadata, { tokenEventCount: 2, sourceSeqStart: 11, sourceSeqEnd: 12 });
	assert.equal(emitted[1]?.activity.sourceEvent, "segment_break");
	observer.flush();
	assert.equal(emitted.length, 2, "重复 flush 不产生空批次");
});

test("PuddingClaw 主结果只使用 final_response，不拼接过程事件或协议负载", () => {
	const completed = normalizePuddingClawJson({
		status: "completed",
		final_response: "最终答复",
		tokens: ["过程", "增量"],
		segments: ["中间回复"],
	});
	assert.equal(completed.type, "completed");
	if (completed.type !== "completed") return;
	assert.equal(completed.result.content, "最终答复");

	const empty = normalizePuddingClawJson({ status: "completed", tokens: ["不能进入主卡"] });
	assert.equal(empty.type, "completed");
	if (empty.type !== "completed") return;
	assert.equal(empty.result.content, "（puddingclaw 无最终文本输出）");
	assert.equal(PUDDINGCLAW_CAPABILITIES.progress, "stream");
});
