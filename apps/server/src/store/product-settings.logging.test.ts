import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProductSettingsStore, DEFAULT_LOGGING_SETTINGS, effectiveLogLevel, readLoggingSettings } from "./product-settings.js";

const freshDir = () => mkdtemp(path.join(tmpdir(), "pt-product-logging-"));

test("默认开启 info；关闭开关等价于 silent", async () => {
	const store = new ProductSettingsStore(await freshDir());
	const initial = await store.get();
	assert.deepEqual(initial.logging, DEFAULT_LOGGING_SETTINGS);
	assert.equal(initial.logging.level, "info", "默认不能是 warn，否则启动期问题无日志可查");
	assert.equal(effectiveLogLevel(initial.logging), "info");

	const off = await store.setLogging({ enabled: false });
	assert.equal(off.logging.enabled, false);
	assert.equal(effectiveLogLevel(off.logging), "silent", "关闭后必须真的静默");
	const back = await store.setLogging({ enabled: true });
	assert.equal(back.logging.enabled, true);
	assert.equal(effectiveLogLevel(back.logging), "info", "重新打开沿用上次级别");
});

test("级别只接受 error|warn|info|debug，落盘后重启仍生效", async () => {
	const dir = await freshDir();
	const store = new ProductSettingsStore(dir);
	await store.setLogging({ level: "debug" });
	assert.equal((await store.get()).logging.level, "debug");
	assert.equal(effectiveLogLevel((await new ProductSettingsStore(dir).setLogging({})).logging), "debug");

	await assert.rejects(store.setLogging({ level: "trace" }), /logging\.level/);
	await assert.rejects(store.setLogging({ level: "silent" }), /logging\.level/, "silent 只能由开关产生");
	await assert.rejects(store.setLogging({ enabled: "yes" as unknown as boolean }), /logging\.enabled/);
	assert.equal((await store.get()).logging.level, "debug", "非法输入不得改动已保存的设置");
});

test("设置日志不影响 Harness 设置；Harness 写入不得丢日志设置", async () => {
	const dir = await freshDir();
	const store = new ProductSettingsStore(dir);
	await store.setLogging({ level: "warn" });
	const harness = await store.setHarness({ codeSearch: { defaultProvider: "fff" } });
	assert.equal(harness.logging.level, "warn", "Harness 保存要保留日志设置");
	assert.equal(harness.harness.codeSearch.defaultProvider, "fff");
	assert.equal((await store.setLogging({ enabled: false })).harness.codeSearch.defaultProvider, "fff", "日志保存要保留 Harness 设置");
});

test("启动期读取：文件缺失或损坏都回退默认，不抛错", async () => {
	const dir = await freshDir();
	assert.deepEqual(await readLoggingSettings(dir), DEFAULT_LOGGING_SETTINGS);
	await writeFile(path.join(dir, "product.json"), "{ not json", "utf-8");
	assert.deepEqual(await readLoggingSettings(dir), DEFAULT_LOGGING_SETTINGS);
	await writeFile(path.join(dir, "product.json"), JSON.stringify({ logging: { enabled: false, level: "debug" } }), "utf-8");
	assert.deepEqual(await readLoggingSettings(dir), { enabled: false, level: "debug" });
	assert.match(await readFile(path.join(dir, "product.json"), "utf-8"), /"logging"/);
});
