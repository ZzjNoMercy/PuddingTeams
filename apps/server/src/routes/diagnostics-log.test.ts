import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerLogDiagnostics } from "./diagnostics-log.js";

async function makeApp(options: { logFile?: string; enabled?: boolean; level?: "error" | "warn" | "info" | "debug" } = {}) {
	const home = await mkdtemp(path.join(tmpdir(), "pt-log-diag-"));
	const app = Fastify();
	registerLogDiagnostics(app, {
		home,
		...(options.logFile ? { logFile: options.logFile } : {}),
		readLogging: async () => ({ enabled: options.enabled !== false, level: options.level ?? "info" }),
		version: "1.2.3",
		runId: "run-1",
	});
	return { app, home };
}

test("日志状态：报告级别、生效级别与已存在的文件", async () => {
	const { app, home } = await makeApp();
	try {
		const logsDir = path.join(home, "logs");
		await mkdir(logsDir, { recursive: true });
		await writeFile(path.join(logsDir, "server.log"), "line-one\nline-two\n", "utf-8");

		const body = (await app.inject({ method: "GET", url: "/api/diagnostics/logs" })).json() as {
			logging: { enabled: boolean; level: string; effectiveLevel: string };
			logFile: string | null;
			conventionalPath: string;
			files: Array<{ name: string; bytes: number }>;
		};
		assert.deepEqual(body.logging, { enabled: true, level: "info", effectiveLevel: "info" });
		assert.equal(body.logFile, null, "源码开发态没有启动器给的文件");
		assert.equal(body.conventionalPath, path.join(home, "logs", "server.log"));
		assert.deepEqual(body.files.map((file) => file.name), ["server.log"]);
		assert.equal(body.files[0]?.bytes, (await stat(path.join(logsDir, "server.log"))).size);
	} finally {
		await app.close();
	}
});

test("诊断包：带附件响应头、含尾部内容与运行标识，且不读 secrets", async () => {
	const home = await mkdtemp(path.join(tmpdir(), "pt-log-bundle-"));
	const logFile = path.join(home, "logs", "server.log");
	await mkdir(path.dirname(logFile), { recursive: true });
	await writeFile(logFile, "boot ok\nrequest failed\n", "utf-8");
	await writeFile(`${logFile}.1`, "previous run\n", "utf-8");
	// 边界：诊断包只读日志文件，secrets 目录不得进入。
	await mkdir(path.join(home, "secrets"), { recursive: true });
	await writeFile(path.join(home, "secrets", "credentials.json"), "SUPER-SECRET-TOKEN", "utf-8");

	const app = Fastify();
	registerLogDiagnostics(app, { home, logFile, readLogging: async () => ({ enabled: true, level: "debug" }), version: "9.9.9", runId: "run-42" });
	try {
		const response = await app.inject({ method: "GET", url: "/api/diagnostics/logs/bundle" });
		assert.equal(response.statusCode, 200);
		assert.match(response.headers["content-disposition"] as string, /attachment; filename="puddingteams-logs-.*\.json"/);
		const bundle = response.json() as {
			schemaVersion: number; app: { version: string; runId: string; pid: number }; logging: { effectiveLevel: string };
			logs: Record<string, { text: string; truncated: boolean }>;
		};
		assert.equal(bundle.schemaVersion, 1);
		assert.equal(bundle.app.version, "9.9.9");
		assert.equal(bundle.app.runId, "run-42");
		assert.ok(bundle.app.pid > 0);
		assert.equal(bundle.logging.effectiveLevel, "debug");
		assert.match(bundle.logs["server.log"]?.text ?? "", /request failed/);
		assert.equal(bundle.logs["server.log"]?.truncated, false, "小文件不应标记截断");
		assert.match(bundle.logs["server.log.1"]?.text ?? "", /previous run/, "轮转出的上一份要一起带上");
		assert.doesNotMatch(JSON.stringify(bundle), /SUPER-SECRET-TOKEN/);
	} finally {
		await app.close();
	}
});

test("诊断包：关闭日志时生效级别为 silent，且超过上限的尾部标记截断", async () => {
	const home = await mkdtemp(path.join(tmpdir(), "pt-log-bundle-large-"));
	const logFile = path.join(home, "logs", "server.log");
	await mkdir(path.dirname(logFile), { recursive: true });
	await writeFile(logFile, `${"x".repeat(1_200_000)}\nTAIL-MARKER\n`, "utf-8");

	const app = Fastify();
	registerLogDiagnostics(app, { home, logFile, readLogging: async () => ({ enabled: false, level: "info" }) });
	try {
		const bundle = (await app.inject({ method: "GET", url: "/api/diagnostics/logs/bundle" })).json() as {
			logging: { enabled: boolean; effectiveLevel: string };
			logs: Record<string, { text: string; truncated: boolean }>;
		};
		assert.deepEqual(bundle.logging, { enabled: false, level: "info", effectiveLevel: "silent", logFile });
		const tail = bundle.logs["server.log"]!;
		assert.equal(tail.truncated, true);
		assert.match(tail.text, /TAIL-MARKER\s*$/, "保留的是尾部而不是开头");
		assert.ok(tail.text.length <= 1024 * 1024 + 32, "尾部大小要有上限");
	} finally {
		await app.close();
	}
});
