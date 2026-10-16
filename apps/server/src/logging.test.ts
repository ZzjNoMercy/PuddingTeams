import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { LogController } from "fastify";
import { accessLoggingEnabled, applyLoggingSettings, configureConsoleLogPolicy, LogRing, logStream, type ConsoleSink } from "./logging.js";

function fakeConsole(): ConsoleSink & { lines: string[] } {
	const lines: string[] = [];
	const push = (name: string) => (...args: unknown[]) => { lines.push(`${name}:${args.join(" ")}`); };
	return { lines, log: push("log"), info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug"), trace: push("trace") };
}

test("级别按详略过滤 console：warn 保留 warn/error，info 与 debug 静默", () => {
	const sink = fakeConsole();
	configureConsoleLogPolicy({ enabled: true, level: "warn" }, sink);
	sink.error("e");
	sink.warn("w");
	sink.info("i");
	sink.log("l");
	sink.debug("d");
	sink.trace("t");
	assert.deepEqual(sink.lines, ["error:e", "warn:w"]);
});

test("关闭开关后连 console.error 也不输出，重新打开完整恢复", () => {
	const sink = fakeConsole();
	configureConsoleLogPolicy({ enabled: false, level: "debug" }, sink);
	sink.error("e");
	sink.warn("w");
	sink.log("l");
	assert.deepEqual(sink.lines, [], "总开关关闭必须真正静默");

	// 先关闭再打开：不能把空实现当成原始实现，否则日志永久消失。
	configureConsoleLogPolicy({ enabled: true, level: "debug" }, sink);
	sink.info("恢复");
	assert.deepEqual(sink.lines, ["info:恢复"]);
});

test("applyLoggingSettings 同时改 logger 级别与 console 策略，不叠加包装", () => {	const sink = fakeConsole();
	const logger = { level: "info" };
	applyLoggingSettings(logger, { enabled: true, level: "error" }, sink);
	assert.equal(logger.level, "error");
	sink.info("i");
	sink.error("e");
	assert.deepEqual(sink.lines, ["error:e"]);

	// 反复应用只保留一层策略：恢复后原始实现必须完整可用。
	applyLoggingSettings(logger, { enabled: true, level: "error" }, sink);
	applyLoggingSettings(logger, { enabled: true, level: "info" }, sink);
	assert.equal(logger.level, "info");
	sink.info("i2");
	assert.deepEqual(sink.lines, ["error:e", "info:i2"]);
});

test("内存环形缓冲：只留最近 N 行并如实标记截断；输出流同时写 stdout", () => {
	const ring = new LogRing(3);
	for (const line of ["a", "b", "c", "d", ""]) ring.append(line);
	assert.deepEqual(ring.snapshot(), { text: "b\nc\nd", truncated: true });
	assert.deepEqual(new LogRing(3).snapshot(), { text: "", truncated: false });

	const written: string[] = [];
	logStream(ring, { write: (chunk: string) => { written.push(chunk); return true; } } as unknown as NodeJS.WriteStream).write("e\n");
	assert.deepEqual(written, ["e\n"]);
	assert.equal(ring.snapshot().text, "c\nd\ne");
});

test("访问日志不进环形缓冲（否则会冲掉有意义的行），但仍照常写 stdout", () => {
	const ring = new LogRing(10);
	const written: string[] = [];
	const stream = logStream(ring, { write: (chunk: string) => { written.push(chunk); return true; } } as unknown as NodeJS.WriteStream);
	stream.write(`${JSON.stringify({ level: 30, reqId: "req-1", req: { method: "GET", url: "/api/health" }, msg: "incoming request" })}\n`);
	stream.write(`${JSON.stringify({ level: 30, reqId: "req-1", res: { statusCode: 200 }, msg: "request completed" })}\n`);
	stream.write(`${JSON.stringify({ level: 40, msg: "manager Capability runtime: 未就绪" })}\n`);
	assert.equal(written.length, 3, "stdout 仍要有全部行");
	assert.equal(ring.snapshot().text, JSON.stringify({ level: 40, msg: "manager Capability runtime: 未就绪" }));
});

test("访问日志只在有日志文件的运行态输出：源码开发态默认关闭，可显式打开", () => {
	assert.equal(accessLoggingEnabled({}), false, "pnpm dev 没有日志文件，终端不应被逐请求日志刷屏");
	assert.equal(accessLoggingEnabled({ PUDDINGTEAMS_LOG_FILE: "   " }), false, "空白视同未设置");
	assert.equal(accessLoggingEnabled({ PUDDINGTEAMS_LOG_FILE: "/tmp/pt/logs/server.log" }), true, "CLI / Electron 有文件，保留按 URL 取证的能力");
	assert.equal(accessLoggingEnabled({ PUDDINGTEAMS_ACCESS_LOG: "1" }), true, "需要时能强制打开");
});

/** 用与 index.ts 相同的接线跑一次真实请求，锁住「dev 默认静音 / 发行态仍打点」。 */
async function requestLogLines(disableRequestLogging: boolean): Promise<string[]> {
	const lines: string[] = [];
	const app = Fastify({
		logController: new LogController({ disableRequestLogging }),
		logger: { level: "info", stream: { write: (line: string) => { lines.push(line); } } },
	});
	app.get("/api/health", async () => ({ ok: true }));
	try {
		await app.inject({ method: "GET", url: "/api/health" });
	} finally {
		await app.close();
	}
	return lines;
}

test("关闭访问日志后 Fastify 不再逐请求打点，平台自身日志不受影响", async () => {
	const lines = await requestLogLines(true);
	assert.ok(!lines.some((line) => /incoming request|request completed/.test(line)), `不应有访问日志，实际：${lines.join("")}`);
});

test("打开访问日志后仍逐请求打点（发行态按 URL 取证）", async () => {
	const lines = await requestLogLines(false);
	assert.ok(lines.some((line) => /incoming request/.test(line)), `应有访问日志，实际：${lines.join("")}`);
	assert.ok(lines.some((line) => /request completed/.test(line)));
});
