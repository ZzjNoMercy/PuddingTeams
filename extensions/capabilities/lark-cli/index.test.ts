import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listConnections, parseConfig, probeRuntime, resolveRuntime } from "./index.js";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fakeLarkCli(root: string, updateCode = 0): Promise<{ cliPath: string; logPath: string }> {
	const cliPath = path.join(root, "lark-cli");
	const logPath = path.join(root, "calls.log");
	await writeFile(cliPath, `#!/bin/sh
echo "$*" >> ${shellQuote(logPath)}
if [ "$1" = "update" ]; then exit ${updateCode}; fi
if [ "$1" = "--version" ]; then echo "lark-cli version 1.2.3"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"verified":true,"identities":{"user":{"userName":"测试用户","status":"active"}}}'; exit 0; fi
if [ "$1 $2" = "skills list" ] && [ -z "$3" ]; then
  echo '{"ok":true,"skills":[{"name":"lark-test","version":"1.0.0"}],"count":1}'; exit 0
fi
if [ "$1 $2 $3" = "skills list lark-test" ]; then
  echo '{"ok":true,"entries":[{"path":"lark-test/SKILL.md","is_dir":false},{"path":"lark-test/references","is_dir":true}]}'; exit 0
fi
if [ "$1 $2 $3" = "skills list lark-test/references" ]; then
  echo '{"ok":true,"entries":[{"path":"lark-test/references/usage.md","is_dir":false}]}'; exit 0
fi
if [ "$1 $2" = "skills read" ]; then echo "# $3"; exit 0; fi
exit 2
`, "utf-8");
	await chmod(cliPath, 0o755);
	return { cliPath, logPath };
}

test("parseConfig 只保留平台需要的登录配置", () => {
	assert.deepEqual(parseConfig({ cliMode: "managed", cliPath: "/tmp/old", authMode: 1, configDir: " /tmp/lark " }), {
		authMode: "auto",
		configDir: "/tmp/lark",
	});
});

test("优先使用本机官方 CLI，自动更新并导出同版本 Skills", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-local-"));
	const { cliPath, logPath } = await fakeLarkCli(root);
	const stateDir = path.join(root, "state");
	const runtime = await resolveRuntime({
		config: { authMode: "auto" },
		env: { PATH: root },
		stateDir,
	});
	assert.deepEqual(runtime.issues, []);
	assert.equal(runtime.details?.["CLI 来源"], "本机官方版本");
	assert.equal(runtime.details?.["CLI 版本"], "1.2.3");
	assert.equal(runtime.details?.["官方 Skills"], "1 个（与 CLI 同步）");
	assert.equal(runtime.details?.["登录方式"], "沿用本机登录状态");
	assert.equal(runtime.env?.LARKSUITE_CLI_CONFIG_DIR, undefined);
	assert.equal(runtime.env?.PATH?.split(path.delimiter)[0], path.dirname(cliPath));
	assert.equal(await readFile(path.join(runtime.skillPaths?.[0] ?? "", "lark-test", "SKILL.md"), "utf-8"), "# lark-test/SKILL.md\n");
	assert.match(await readFile(logPath, "utf-8"), /update --json --skills-layout separate/);

	await resolveRuntime({ config: {}, env: { PATH: root }, stateDir });
	const calls = await readFile(logPath, "utf-8");
	assert.equal(calls.match(/^update /gm)?.length, 1, "新鲜度窗口内不重复调用官方更新");
});

test("未检测到本机 CLI 时由平台通过官方 npm 包安装", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-platform-"));
	const official = path.join(root, "official-cli");
	await fakeLarkCli(root);
	await symlink(path.join(root, "lark-cli"), official);
	const npmPath = path.join(root, "npm");
	await writeFile(npmPath, `#!/bin/sh
while [ "$1" != "--prefix" ]; do shift; done
shift
install_root="$1"
/bin/mkdir -p "$install_root/node_modules/.bin"
/bin/ln -sf ${shellQuote(official)} "$install_root/node_modules/.bin/lark-cli"
`, "utf-8");
	await chmod(npmPath, 0o755);
	// PATH 只暴露 npm；lark-cli 使用另一个文件名，确保先走平台安装分支。
	await symlink(npmPath, path.join(root, "npm-only"));
	const npmDir = await mkdtemp(path.join(tmpdir(), "pt-lark-npm-path-"));
	await symlink(npmPath, path.join(npmDir, "npm"));
	const stateDir = path.join(root, "binding");
	const runtime = await resolveRuntime({ config: {}, env: { PATH: npmDir }, stateDir });
	assert.deepEqual(runtime.issues, []);
	assert.equal(runtime.details?.["CLI 来源"], "平台安装的官方版本");
	assert.equal(runtime.details?.["登录方式"], "当前绑定独立保存");
	assert.equal(runtime.env?.LARKSUITE_CLI_CONFIG_DIR, path.join(stateDir, "auth"));
	assert.equal(runtime.details?.["CLI 版本"], "1.2.3");
});

test("官方更新暂时失败时继续使用当前 CLI 与其内嵌 Skills", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-update-fail-"));
	await fakeLarkCli(root, 1);
	const runtime = await resolveRuntime({ config: {}, env: { PATH: root }, stateDir: path.join(root, "state") });
	assert.deepEqual(runtime.issues?.map((issue) => issue.code), ["official_update_failed"]);
	assert.equal(runtime.details?.["CLI 版本"], "1.2.3");
	assert.equal(runtime.details?.["官方 Skills"], "1 个（与 CLI 同步）");
});

test("探测结果使用中文字段且不暴露 CLI 路径", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-probe-"));
	await fakeLarkCli(root);
	const probe = await probeRuntime({ config: {}, env: { PATH: root }, stateDir: path.join(root, "state") });
	assert.equal(probe.authenticated, true);
	assert.equal(probe.details?.["登录用户"], "测试用户");
	assert.equal(probe.details?.["身份状态"], "active");
	assert.equal("cliPath" in (probe.details ?? {}), false);
});

test("连接状态只读展示本机飞书登录，不触发更新或泄露路径", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-connection-"));
	const { logPath } = await fakeLarkCli(root);
	const [connection] = await listConnections({ env: { PATH: root } });
	assert.equal(connection?.state, "connected");
	assert.equal(connection?.name, "飞书 CLI");
	assert.equal(connection?.version, "1.2.3");
	assert.equal(connection?.accountName, "测试用户");
	assert.equal(connection?.message, "登录状态有效");
	assert.equal("cliPath" in (connection ?? {}), false);
	assert.doesNotMatch(await readFile(logPath, "utf-8"), /^update /m);
});
