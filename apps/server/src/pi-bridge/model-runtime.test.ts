import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureSharedModelRuntime } from "./model-runtime.js";
import { PiSessionStore } from "./session-store.js";

/**
 * §10.6 凭证解耦：平台 provider key 落在 PUDDINGTEAMS_HOME/secrets/auth.json，
 * 不读写 pi CLI 全局 agentDir（PI_CODING_AGENT_DIR）的 auth.json——平台里
 * 增删 key 不影响独立使用的 pi，反之亦然。
 *
 * PI_OFFLINE=1：SDK 的 availability refresh 会对所有内置 provider 做真实网络
 * 探测且无超时，任一上游端点丢包就会挂住整轮测试（实测卡 ~600s）。本测试只
 * 断言 auth.json 落盘，与可用性快照无关，必须离线保持 hermetic。
 */
process.env.PI_OFFLINE = "1";

test("provider key 写入平台自有 auth.json，与 pi CLI agentDir 隔离", async () => {
	const piAgentDir = mkdtempSync(path.join(tmpdir(), "pt-pi-agentdir-"));
	process.env.PI_CODING_AGENT_DIR = piAgentDir;
	const secretsDir = mkdtempSync(path.join(tmpdir(), "pt-secrets-"));
	configureSharedModelRuntime({ authPath: path.join(secretsDir, "auth.json") });

	const cwd = mkdtempSync(path.join(tmpdir(), "pt-cwd-"));
	const sessions = new PiSessionStore(cwd, path.join(cwd, "sessions"));
	await sessions.setProviderKey("deepseek", "sk-test-decouple");

	const platformAuth = JSON.parse(readFileSync(path.join(secretsDir, "auth.json"), "utf-8")) as Record<string, unknown>;
	assert.ok(platformAuth.deepseek, "平台 auth.json 必须包含写入的 provider");
	const piAuthPath = path.join(piAgentDir, "auth.json");
	if (existsSync(piAuthPath)) {
		const piAuth = JSON.parse(readFileSync(piAuthPath, "utf-8")) as Record<string, unknown>;
		assert.ok(!piAuth.deepseek, "pi CLI 的 auth.json 不得包含平台写入的 key");
	}

	await sessions.removeProviderKey("deepseek");
	const after = JSON.parse(readFileSync(path.join(secretsDir, "auth.json"), "utf-8")) as Record<string, unknown>;
	assert.ok(!after.deepseek, "删除后平台 auth.json 不得残留");
});
