import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listConnections, probeRuntime, resolveRuntime, runConnectionAction, settleBackgroundRefresh } from "./index.js";

const connectionService = {
	status: async () => ({ id: "default", name: "飞书", state: "connected" as const, userAuthorization: "authorized" as const, accountName: "测试用户", message: "共享凭证有效", checkedAt: new Date().toISOString(), actions: [] }),
	begin: async () => ({ id: "session", state: "pending" as const, expiresAt: new Date().toISOString() }),
	authorizationStatus: async () => undefined,
	cancel: async () => {},
	runtimeEnv: async () => ({ PUDDING_LARK_BROKER_URL: "http://127.0.0.1:1234", PUDDING_LARK_BROKER_KEY: "test-delegation-key" }),
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fakeLarkCli(root: string, updateCode = 0, updateSleepSeconds = 0): Promise<{ cliPath: string; logPath: string }> {
	const cliPath = path.join(root, "lark-cli");
	const logPath = path.join(root, "calls.log");
	await writeFile(cliPath, `#!/bin/sh
echo "$*" >> ${shellQuote(logPath)}
if [ "$1" = "update" ]; then sleep ${updateSleepSeconds}; exit ${updateCode}; fi
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

test("缺少共享连接服务时拒绝独立 CLI 登录态回退", async () => {
	await assert.rejects(resolveRuntime({ config: {}, env: {}, stateDir: "/tmp/lark", sharedStateDir: "/tmp/lark" }), /共享飞书连接/);
});

test("Skills 未就绪时不发放能力、立即返回，并在后台完成同步", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-local-"));
	const { cliPath, logPath } = await fakeLarkCli(root);
	const stateDir = path.join(root, "state");
	const sharedStateDir = path.join(root, "shared");
	const context = { connection: connectionService, config: { authMode: "auto" }, env: { PATH: root }, stateDir, sharedStateDir };

	const started = Date.now();
	const blocked = await resolveRuntime(context);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 1_000, `组装不得等待后台同步（实际 ${elapsed}ms）`);
	assert.deepEqual(blocked.skillPaths, undefined, "当前版本 Skills 未导出时不发放 Skill 路径");
	assert.deepEqual(blocked.issues?.map((issue) => issue.code), ["official_skills_syncing"]);
	assert.match(String(blocked.details?.["CLI 同步"]), /稍后再试/);
	assert.match(String(blocked.env?.PUDDING_LARK_BLOCKED), /稍后再试/);
	assert.equal(blocked.env?.PUDDING_LARK_REAL_CLI, undefined, "被阻断时不暴露真实 CLI 路径");

	await settleBackgroundRefresh();
	const runtime = await resolveRuntime(context);
	assert.deepEqual(runtime.issues, []);
	assert.equal(runtime.details?.["CLI 来源"], "本机官方版本");
	assert.equal(runtime.details?.["CLI 版本"], "1.2.3");
	assert.equal(runtime.details?.["官方 Skills"], "1 个（与 CLI 同步）");
	assert.equal(runtime.details?.["登录方式"], "平台与 CLI 共用加密凭证");
	assert.equal(runtime.env?.LARKSUITE_CLI_CONFIG_DIR, "");
	assert.equal(runtime.env?.PATH?.split(path.delimiter)[0], path.join(root, "shared", "bin"));
	assert.equal(runtime.env?.PUDDING_LARK_REAL_CLI, cliPath);
	assert.equal(runtime.env?.PUDDING_LARK_BROKER_KEY, "test-delegation-key");
	assert.equal(runtime.env?.LARKSUITE_CLI_USER_ACCESS_TOKEN, "");
	assert.equal(await readFile(path.join(runtime.skillPaths?.[0] ?? "", "lark-test", "SKILL.md"), "utf-8"), "# lark-test/SKILL.md\n");
	assert.match(await readFile(logPath, "utf-8"), /update --json --skills-layout separate/);

	await resolveRuntime(context);
	await settleBackgroundRefresh();
	const calls = await readFile(logPath, "utf-8");
	assert.equal(calls.match(/^update /gm)?.length, 1, "新鲜度窗口内不重复调用官方更新");
});

test("后台更新进行中：不发放 CLI，CLI 入口直接提示稍后再试", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-refreshing-"));
	const { cliPath } = await fakeLarkCli(root);
	const stateDir = path.join(root, "state");
	const runtimeDir = path.join(stateDir, "runtime");
	await mkdir(runtimeDir, { recursive: true });
	await writeFile(path.join(runtimeDir, "cli-update.json"), JSON.stringify({ status: "refreshing", startedAt: new Date().toISOString(), version: "1.2.3" }));

	const runtime = await resolveRuntime({ connection: connectionService, config: {}, env: { PATH: root }, stateDir, sharedStateDir: path.join(root, "shared") });
	assert.deepEqual(runtime.issues?.map((issue) => issue.code), ["cli_update_in_progress"]);
	assert.equal(runtime.details?.["CLI 同步"], "飞书官方 CLI 正在后台更新，请稍后再试");
	assert.match(String(runtime.env?.PUDDING_LARK_BLOCKED), /正在后台更新，请稍后再试/);
	assert.equal(runtime.env?.PUDDING_LARK_REAL_CLI, undefined);
	assert.deepEqual(runtime.skillPaths, undefined);
	assert.equal(runtime.env?.PATH?.split(path.delimiter)[0], path.join(root, "shared", "bin"), "仍提供 CLI 入口，让调用方立刻拿到原因而不是 command not found");

	// 后台任务卡死/被杀超过容忍时长后不再永久阻塞会话。
	await writeFile(path.join(runtimeDir, "cli-update.json"), JSON.stringify({ status: "refreshing", startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), version: "1.2.3" }));
	await mkdir(path.join(runtimeDir, "skills", "1.2.3"), { recursive: true });
	await writeFile(path.join(runtimeDir, "skills", "1.2.3", ".complete.json"), JSON.stringify({ cliVersion: "1.2.3", skillCount: 1 }));
	const recovered = await resolveRuntime({ connection: connectionService, config: {}, env: { PATH: root }, stateDir, sharedStateDir: path.join(root, "shared") });
	assert.deepEqual(recovered.issues, []);
	assert.equal(recovered.details?.["官方 Skills"], "1 个（与 CLI 同步）");
	assert.equal(recovered.env?.PUDDING_LARK_BLOCKED, undefined);
	assert.equal(cliPath.startsWith(root), true);
});

test("组装路径不等待后台更新：更新耗时再长也只拿到「稍后再试」", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-slow-update-"));
	await fakeLarkCli(root, 0, 2);
	const stateDir = path.join(root, "state");
	const context = { connection: connectionService, config: {}, env: { PATH: root }, stateDir, sharedStateDir: path.join(root, "shared") };
	const started = Date.now();
	const first = await resolveRuntime(context);
	assert.ok(Date.now() - started < 700, "组装不得等官方更新（本次更新耗时 2s）");
	assert.deepEqual(first.issues?.map((issue) => issue.code), ["official_skills_syncing"]);
	let phase = "";
	for (let i = 0; i < 100 && phase !== "refreshing"; i++) {
		try { phase = (JSON.parse(await readFile(path.join(stateDir, "runtime", "cli-update.json"), "utf-8")) as { status?: string }).status ?? ""; } catch { phase = ""; }
		if (phase !== "refreshing") await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(phase, "refreshing", "后台更新期间状态必须可见");
	await settleBackgroundRefresh();
	const second = await resolveRuntime(context);
	assert.deepEqual(second.issues, []);
	assert.equal(second.details?.["官方 Skills"], "1 个（与 CLI 同步）");
});

test("探测不隐式安装，用户确认后才通过官方 npm 包安装", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-platform-"));
	const official = path.join(root, "official-cli");
	await fakeLarkCli(root);
	await symlink(path.join(root, "lark-cli"), official);
	const npmPath = path.join(root, "npm");
	const npmLog = path.join(root, "npm.log");
	await writeFile(npmPath, `#!/bin/sh
echo "$*" >> ${shellQuote(npmLog)}
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
	const sharedStateDir = path.join(root, "shared");
	const probe = await probeRuntime({ connection: connectionService, config: {}, env: { PATH: npmDir }, stateDir, sharedStateDir });
	assert.deepEqual(probe.issues?.map((issue) => issue.code), ["cli_not_installed"]);
	assert.equal(await access(npmLog).then(() => true, () => false), false, "只读探测不得调用 npm");
	const [missing] = await listConnections({ connection: connectionService, env: { PATH: npmDir }, stateDir: sharedStateDir });
	assert.equal(missing?.state, "connected", "账号连接不依赖 CLI 安装状态");
	assert.equal(missing?.actions?.[0]?.id, "install-cli");
	await runConnectionAction("default", "install-cli", { env: { PATH: npmDir }, stateDir: sharedStateDir });
	assert.match(await readFile(npmLog, "utf-8"), /install --prefix/);

	const beforeInstallSync = await resolveRuntime({ connection: connectionService, config: {}, env: { PATH: npmDir }, stateDir, sharedStateDir });
	assert.deepEqual(beforeInstallSync.issues?.map((issue) => issue.code), ["official_skills_syncing"], "刚装上 CLI 时先提示稍后再试，不等同步");
	await settleBackgroundRefresh();
	const runtime = await resolveRuntime({ connection: connectionService, config: {}, env: { PATH: npmDir }, stateDir, sharedStateDir });
	assert.deepEqual(runtime.issues, []);
	assert.equal(runtime.details?.["CLI 来源"], "平台安装的官方版本");
	assert.equal(runtime.details?.["登录方式"], "平台与 CLI 共用加密凭证");
	assert.equal(runtime.env?.LARKSUITE_CLI_CONFIG_DIR, "");
	assert.equal(runtime.details?.["CLI 版本"], "1.2.3");
});

test("官方更新暂时失败时继续使用当前 CLI 与其内嵌 Skills", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-update-fail-"));
	await fakeLarkCli(root, 1);
	const stateDir = path.join(root, "state");
	const context = { connection: connectionService, config: {}, env: { PATH: root }, stateDir, sharedStateDir: path.join(root, "shared") };
	await resolveRuntime(context);
	await settleBackgroundRefresh();
	const runtime = await resolveRuntime(context);
	assert.deepEqual(runtime.issues, [], "更新失败不阻断会话");
	assert.equal(runtime.details?.["CLI 版本"], "1.2.3");
	assert.equal(runtime.details?.["官方 Skills"], "1 个（与 CLI 同步）");
	const probe = await probeRuntime(context);
	assert.match(String(probe.details?.["CLI 同步"]), /上次同步失败/, "同步失败要能在连接状态看到");
});

test("探测结果使用中文字段且不暴露 CLI 路径", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-probe-"));
	const { logPath } = await fakeLarkCli(root);
	const probe = await probeRuntime({
		connection: connectionService,
		config: {},
		env: { PATH: root },
		stateDir: path.join(root, "state"),
		sharedStateDir: path.join(root, "shared"),
	});
	assert.equal(probe.authenticated, true);
	assert.equal(probe.details?.["登录用户"], "测试用户");
	assert.equal("cliPath" in (probe.details ?? {}), false);
	assert.doesNotMatch(await readFile(logPath, "utf-8"), /^(update|skills|auth) /m, "探测不得通过 CLI 认证、更新或同步 Skills");
});

test("CLI 版本探测失败仍注入共享凭证入口，不回退原生认证", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-bad-version-"));
	const { cliPath } = await fakeLarkCli(root);
	await writeFile(cliPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const sharedStateDir = path.join(root, "shared");
	const runtime = await resolveRuntime({ connection: connectionService, config: {}, env: { PATH: root }, stateDir: path.join(root, "binding"), sharedStateDir });
	assert.ok(runtime.issues?.some(issue => issue.code === "version_probe_failed"));
	assert.equal(runtime.env?.PATH?.split(path.delimiter)[0], path.join(sharedStateDir, "bin"));
	assert.equal(runtime.env?.PUDDING_LARK_BROKER_KEY, "test-delegation-key");
	assert.match(await readFile(path.join(sharedStateDir, "bin", "lark-cli"), "utf-8"), /PUDDING_LARK_BROKER_URL/);
});

test("连接状态使用共享接口，不通过 CLI 读取或刷新登录", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-connection-"));
	const { logPath } = await fakeLarkCli(root);
	const [connection] = await listConnections({ connection: connectionService, env: { PATH: root }, stateDir: path.join(root, "shared") });
	assert.equal(connection?.state, "connected");
	assert.equal(connection?.name, "飞书");
	assert.equal(connection?.version, "1.2.3");
	assert.equal(connection?.accountName, "测试用户");
	assert.equal(connection?.message, "共享凭证有效");
	assert.equal("cliPath" in (connection ?? {}), false);
	assert.doesNotMatch(await readFile(logPath, "utf-8"), /^(update|auth) /m);
});
