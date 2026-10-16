import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ProductSettingsStore, effectiveLogLevel, type LoggingSettings } from "../store/product-settings.js";
import { registerSettingsRoutes } from "./settings.js";

test("日志设置 HTTP：读取默认值、切换开关与级别、非法值被拒且不改动已保存设置", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-logging-route-"));
	const store = new ProductSettingsStore(dir);
	const app = Fastify();
	const applied: Array<LoggingSettings["level"] | "silent"> = [];
	await registerSettingsRoutes(app, dir, store, undefined, undefined, undefined, {
		logFile: "/tmp/puddingteams/logs/server.log",
		onLoggingChange: (settings) => applied.push(settings.enabled ? settings.level : "silent"),
	});
	try {
		const initial = (await app.inject({ method: "GET", url: "/api/settings/logging" })).json() as { logging: LoggingSettings; effectiveLevel: string; logFile: string | null };
		assert.deepEqual(initial.logging, { enabled: true, level: "info" });
		assert.equal(initial.effectiveLevel, "info");
		assert.equal(initial.logFile, "/tmp/puddingteams/logs/server.log", "UI 要能显示启动器重定向出的日志文件");

		const empty = await app.inject({ method: "PUT", url: "/api/settings/logging", payload: {} });
		assert.equal(empty.statusCode, 400);
		const invalid = await app.inject({ method: "PUT", url: "/api/settings/logging", payload: { level: "trace" } });
		assert.equal(invalid.statusCode, 400);
		assert.deepEqual(applied, [], "被拒的请求不得触发级别变更");

		const debug = (await app.inject({ method: "PUT", url: "/api/settings/logging", payload: { level: "debug" } })).json() as { logging: LoggingSettings; effectiveLevel: string };
		assert.equal(debug.logging.level, "debug");
		assert.equal(debug.effectiveLevel, "debug");
		assert.deepEqual(applied, ["debug"], "级别变更必须回调给 server 立即生效");

		const off = (await app.inject({ method: "PUT", url: "/api/settings/logging", payload: { enabled: false } })).json() as { logging: LoggingSettings; effectiveLevel: string };
		assert.equal(off.logging.level, "debug", "关闭开关不丢级别");
		assert.equal(off.effectiveLevel, "silent");
		assert.deepEqual(applied, ["debug", "silent"]);

		const persisted = await store.get();
		assert.deepEqual(persisted.logging, { enabled: false, level: "debug" });
	} finally {
		await app.close();
	}
});

test("pino 支持运行时改级：级别变更不需要重启后端", async () => {
	const app = Fastify({ logger: { level: "info" } });
	try {
		assert.equal(app.log.level, "info");
		app.log.level = "debug";
		assert.equal(app.log.level, "debug");
		app.log.level = "silent";
		assert.equal(app.log.level, "silent");
	} finally {
		await app.close();
	}
});

test("开关与级别即时生效：info 会写、warn 过滤 info、关闭后连 error 都不写", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-logging-live-"));
	const store = new ProductSettingsStore(dir);
	const lines: string[] = [];
	// index.ts 的真实接线：onLoggingChange 把设置打到同一个 logger 上。
	const app = Fastify({ logger: { level: "info", stream: { write: (line: string) => { lines.push(line); } } } });
	await registerSettingsRoutes(app, dir, store, undefined, undefined, undefined, {
		onLoggingChange: (settings) => { app.log.level = effectiveLogLevel(settings); },
	});
	try {
		app.log.info("启动完成");
		assert.match(lines.join(""), /启动完成/);
		lines.length = 0;

		await app.inject({ method: "PUT", url: "/api/settings/logging", payload: { level: "warn" } });
		app.log.info("这条不该出现");
		app.log.warn("这条要出现");
		assert.equal(lines.some((line) => line.includes("这条不该出现")), false);
		assert.equal(lines.some((line) => line.includes("这条要出现")), true);
		lines.length = 0;

		await app.inject({ method: "PUT", url: "/api/settings/logging", payload: { enabled: false } });
		app.log.error("关闭后连错误也不写");
		assert.deepEqual(lines, [], "总开关关闭必须真正静默");
	} finally {
		await app.close();
	}
});
