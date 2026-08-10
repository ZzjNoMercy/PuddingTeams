import { test, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExtensionManifest } from "../agent-runtime/extensions.js";

/**
 * `puddingteams extension` CLI（P2-d）：init 脚手架与 validate 校验。
 *
 * 所有 CLI 调用都经 bin/puddingteams.mjs 子进程执行：node 26 + tsx 下
 * node:test 子进程里进程内调用 runExtensionCli 会间歇性损坏 runner IPC
 * （"Unable to deserialize cloned data"，纯 in-process 复现约 20% 失败率），
 * 子进程路径稳定且顺带覆盖 bin 引导的端到端冒烟。runExtensionCli 本身保持
 * 可 import 的纯函数形态（返回退出码），逻辑不变。
 * 不触环境的纯断言（生成产物的 manifest 过 parseExtensionManifest、占位符
 * 替换结果）留在进程内。
 */

const REPO_ROOT = path.resolve(new URL("../../../../", import.meta.url).pathname);
const SERVER_DIR = path.join(REPO_ROOT, "apps", "server");

const cleanupDirs: string[] = [];
after(() => {
	for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string, underServer = false): string {
	// 代码型模板产物要 import @puddingteams/pwcp，放在 apps/server 下才能沿
	// node_modules 解析到 workspace 依赖；其余用系统 tmp。
	const base = underServer ? SERVER_DIR : tmpdir();
	const dir = mkdtempSync(path.join(base, prefix));
	cleanupDirs.push(dir);
	return dir;
}

function writePackage(dir: string, pkg: Record<string, unknown>): void {
	writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf-8");
}

/** 经真实 bin 跑 CLI（tsx 孙进程），返回退出码与合并输出。 */
function runBin(args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(SERVER_DIR, "bin/puddingteams.mjs"), ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code: code ?? 1, out }));
	});
}

// ---- usage ----

test("无参数 / 未知命令打印 usage 退出码 1", async () => {
	assert.strictEqual((await runBin([])).code, 1);
	assert.strictEqual((await runBin(["bogus"])).code, 1);
	const { code, out } = await runBin(["extension", "bogus"]);
	assert.strictEqual(code, 1);
	assert.match(out, /用法/);
});

// ---- validate 真包 ----

test("validate 声明式真包 echo → 0", async () => {
	const { code, out } = await runBin(["extension", "validate", path.join(REPO_ROOT, "extensions/connectors/echo")]);
	assert.strictEqual(code, 0, out);
	assert.match(out, /\{packageDir\}\/cli\.mjs 存在/);
});

test("validate 代码型真包 codex → 0（真 import driver 模块）", async () => {
	const { code, out } = await runBin(["extension", "validate", path.join(REPO_ROOT, "extensions/connectors/codex")]);
	assert.strictEqual(code, 0, out);
	assert.match(out, /createDriver 工厂已导出/);
});

// ---- validate 坏包 ----

test("validate 缺 puddingteams 字段的 package.json → 1", async () => {
	const dir = freshDir("ext-cli-bad-");
	writePackage(dir, { name: "bad-pkg", version: "1.0.0" });
	const { code, out } = await runBin(["extension", "validate", dir]);
	assert.strictEqual(code, 1);
	assert.match(out, /缺少 puddingteams 字段/);
});

test("validate manifest kind 非法 → 1", async () => {
	const dir = freshDir("ext-cli-bad-");
	writePackage(dir, {
		name: "bad-kind",
		version: "1.0.0",
		puddingteams: {
			id: "bad-kind",
			publisher: "test",
			displayName: "Bad",
			version: "1.0.0",
			source: "external",
			kind: "widget",
			engines: { puddingteams: ">=0.1 <1" },
		},
	});
	assert.strictEqual((await runBin(["extension", "validate", dir])).code, 1);
});

test("validate declarative + entry 混排 → 1", async () => {
	const dir = freshDir("ext-cli-bad-");
	writePackage(dir, {
		name: "bad-mixed",
		version: "1.0.0",
		puddingteams: {
			id: "bad-mixed",
			publisher: "test",
			displayName: "Bad Mixed",
			version: "1.0.0",
			source: "external",
			kind: "connector",
			engines: { puddingteams: ">=0.1 <1" },
			entry: "driver/index.ts",
			connector: {
				id: "bad-mixed",
				displayName: "Bad Mixed",
				apiVersion: "1",
				defaultTransport: "spawn",
				supportedTransports: ["spawn"],
				declarative: {
					command: "node",
					operations: { run: { args: ["run", "{message}"] } },
					output: { mode: "jsonl" },
					capabilities: { operations: ["run"], interactionKinds: [] },
				},
			},
		},
	});
	const { code, out } = await runBin(["extension", "validate", dir]);
	assert.strictEqual(code, 1);
	assert.match(out, /互斥/);
});

test("validate entry 声明但文件缺失 → 1", async () => {
	const dir = freshDir("ext-cli-bad-");
	writePackage(dir, {
		name: "bad-entry",
		version: "1.0.0",
		puddingteams: {
			id: "bad-entry",
			publisher: "test",
			displayName: "Bad Entry",
			version: "1.0.0",
			source: "external",
			kind: "connector",
			engines: { puddingteams: ">=0.1 <1" },
			entry: "driver/index.ts",
			connector: {
				id: "bad-entry",
				displayName: "Bad Entry",
				apiVersion: "1",
				defaultTransport: "spawn",
				supportedTransports: ["spawn"],
			},
		},
	});
	const { code, out } = await runBin(["extension", "validate", dir]);
	assert.strictEqual(code, 1);
	assert.match(out, /driver\/index\.ts 不存在/);
});

// ---- init 代码型 ----

test("init 代码型 connector：manifest 过校验，产物经 validate（含 driver import）→ 0", async () => {
	const dir = path.join(freshDir(".tmp-ext-cli-init-", true), "demo-cli");
	const { code } = await runBin(["extension", "init", "--type", "connector", "--id", "demo-cli", dir]);
	assert.strictEqual(code, 0);

	// 生成的 package.json 占位符全部替换，puddingteams 折叠 manifest 过全量校验。
	const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
	assert.strictEqual(pkg.name, "@puddingteams/connector-demo-cli");
	const manifest = parseExtensionManifest(pkg.puddingteams);
	assert.strictEqual(manifest.kind, "connector");
	assert.strictEqual(manifest.id, "demo-cli");
	assert.strictEqual(manifest.entry, "driver/index.ts");

	// 类名占位符已转 PascalCase，模板占位符无残留。
	const driverSrc = readFileSync(path.join(dir, "driver/index.ts"), "utf-8");
	assert.ok(driverSrc.includes("class DemoCliDriver"));
	assert.ok(driverSrc.includes("export function createDriver"));
	assert.ok(!driverSrc.includes("__CONNECTOR_ID__"));

	// validate 交叉验证：entry import + createDriver 导出检查全过（生成后即可编译运行）。
	const res = await runBin(["extension", "validate", dir]);
	assert.strictEqual(res.code, 0, res.out);
	assert.match(res.out, /createDriver 工厂已导出/);
});

test("init 自定义 --name / --display", async () => {
	const dir = path.join(freshDir(".tmp-ext-cli-init-", true), "custom");
	const { code } = await runBin([
		"extension",
		"init",
		"--type",
		"connector",
		"--id",
		"my-agent",
		"--name",
		"@acme/connector-my-agent",
		"--display",
		"My Agent",
		dir,
	]);
	assert.strictEqual(code, 0);
	const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as { name: string; puddingteams: { displayName: string } };
	assert.strictEqual(pkg.name, "@acme/connector-my-agent");
	assert.strictEqual(pkg.puddingteams.displayName, "My Agent");
});

// ---- init 声明式 ----

test("init --declarative：生成后用 CLI 自身 validate 交叉验证 → 0", async () => {
	const dir = path.join(freshDir("ext-cli-init-"), "demo-decl");
	const { code } = await runBin(["extension", "init", "--type", "connector", "--declarative", "--id", "demo-decl", dir]);
	assert.strictEqual(code, 0);

	const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
	const manifest = parseExtensionManifest(pkg.puddingteams);
	assert.strictEqual(manifest.kind, "connector");
	if (manifest.kind !== "connector") throw new Error("unreachable");
	assert.ok(manifest.connector.declarative, "声明式包必须有 connector.declarative");
	assert.strictEqual(manifest.entry, undefined);

	// {packageDir}/cli.mjs 引用文件已生成，validate 应全过。
	const res = await runBin(["extension", "validate", dir]);
	assert.strictEqual(res.code, 0, res.out);
});

// ---- init 防御 ----

test("init 目标目录已存在且非空 → 1", async () => {
	const dir = freshDir("ext-cli-nonempty-");
	writeFileSync(path.join(dir, "keep.txt"), "occupied", "utf-8");
	const { code, out } = await runBin(["extension", "init", "--type", "connector", "--id", "demo-x", dir]);
	assert.strictEqual(code, 1);
	assert.match(out, /目标目录非空/);
});

test("init 目标目录存在但为空 → 0", async () => {
	const dir = path.join(freshDir(".tmp-ext-cli-init-", true), "empty-dir");
	mkdirSync(dir);
	assert.strictEqual((await runBin(["extension", "init", "--type", "connector", "--id", "demo-empty", dir])).code, 0);
});

test("init --id 非法字符 → 1", async () => {
	const dir = path.join(freshDir("ext-cli-init-"), "bad-id");
	assert.strictEqual((await runBin(["extension", "init", "--type", "connector", "--id", "Demo_Cli", dir])).code, 1);
});

test("P3: validate 真实 Capability 包 + init capability 模板闭环", async () => {
	const real = path.resolve(import.meta.dirname, "../../../../extensions/capabilities/minimal-tool");
	assert.equal((await runBin(["extension", "validate", real])).code, 0);
	const dir = path.join(freshDir("pt-cap-init-"), "capability");
	assert.equal(
		(await runBin(["extension", "init", "--type", "capability", "--id", "demo-cap", dir])).code,
		0,
	);
	assert.equal((await runBin(["extension", "validate", dir])).code, 0);
});
