import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	readManifestFromDir,
	type ConnectorExtensionManifest,
	type PuddingTeamsExtensionManifest,
} from "../agent-runtime/extensions.js";
import { runDoctorCli, runInitCli } from "./init-cli.js";

/**
 * `puddingteams extension` CLI（路线图 P2-d）：Extension 包的脚手架与校验。
 *
 * - init     从 extensions/shared/templates/ 复制模板并替换占位符；
 * - validate 校验 manifest（与安装流程共用 readManifestFromDir）、entry
 *   存在性、代码型包的 createDriver/driver 导出、声明式包的 {packageDir}
 *   引用文件。
 *
 * bin/puddingteams.mjs 是纯 node 引导，用 tsx 跑本文件；runExtensionCli
 * 返回退出码，测试直接 import 调用。
 */

const TEMPLATES_DIR = fileURLToPath(new URL("../../../../extensions/shared/templates", import.meta.url));

const USAGE = `puddingteams — 初始化引导 / 环境体检 / Extension 包脚手架与校验

用法：
  puddingteams init [--json]
  puddingteams doctor [--json]
  puddingteams extension init --type connector|capability [--declarative] --id <id> [--name <packageName>] [--display <displayName>] <dir>
  puddingteams extension validate <path>

子命令：
  init          首次初始化：环境探测 + 缺失 worker（puddingclaw/codex/claude-code）的确认式安装引导；
                非 TTY 只提示不安装，跳过不阻塞（退出码 0）
  doctor        只读体检：Node、数据目录、各 worker 可用性与修复建议；worker 缺失不影响退出码
  extension init     从模板生成 Extension 包骨架（--declarative 生成纯 manifest 声明式包）
  extension validate 校验包的 manifest、entry 与 Driver 导出，全部通过退出码 0
`;

function log(msg: string): void {
	console.log(msg);
}

function err(msg: string): void {
	console.error(msg);
}

// ---- 占位符替换 ----

/** connector id（[a-z0-9-]+）转 PascalCase（类名用）：demo-cli → DemoCli。 */
function toPascalCase(id: string): string {
	return id
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join("");
}

/** id 转标题展示名：demo-cli → Demo Cli。 */
function toTitle(id: string): string {
	return id
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join(" ");
}

interface Placeholders {
	__CONNECTOR_ID__: string;
	__CONNECTOR_ID_PASCAL__: string;
	__PACKAGE_NAME__: string;
	__DISPLAY_NAME__: string;
	__DESCRIPTION__: string;
}

function applyPlaceholders(content: string, ph: Placeholders): string {
	let out = content;
	for (const [key, value] of Object.entries(ph)) {
		out = out.split(key).join(value);
	}
	return out;
}

/** 递归复制模板目录：去掉 .tmpl 后缀，文本内容做占位符替换。 */
async function copyTemplate(srcDir: string, destDir: string, ph: Placeholders, written: string[]): Promise<void> {
	await mkdir(destDir, { recursive: true });
	for (const entry of await readdir(srcDir, { withFileTypes: true })) {
		const src = path.join(srcDir, entry.name);
		const destName = entry.name.endsWith(".tmpl") ? entry.name.slice(0, -".tmpl".length) : entry.name;
		const dest = path.join(destDir, destName);
		if (entry.isDirectory()) {
			await copyTemplate(src, dest, ph, written);
		} else {
			await writeFile(dest, applyPlaceholders(await readFile(src, "utf-8"), ph), "utf-8");
			written.push(dest);
		}
	}
}

// ---- extension init ----

interface InitOptions {
	type: "connector" | "capability";
	declarative: boolean;
	id: string;
	packageName: string;
	displayName: string;
	dir: string;
}

function parseInitArgs(args: string[]): InitOptions {
	let type: string | undefined;
	let declarative = false;
	let id: string | undefined;
	let packageName: string | undefined;
	let displayName: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		switch (arg) {
			case "--type":
				type = args[++i];
				break;
			case "--declarative":
				declarative = true;
				break;
			case "--id":
				id = args[++i];
				break;
			case "--name":
				packageName = args[++i];
				break;
			case "--display":
				displayName = args[++i];
				break;
			default:
				if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
				positional.push(arg);
		}
	}
	if (type !== "connector" && type !== "capability") throw new Error('--type 必须是 "connector" 或 "capability"');
	if (type === "capability" && declarative) throw new Error("--declarative 仅适用于 connector");
	if (!id) throw new Error("缺少 --id <connectorId>");
	if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`--id「${id}」非法：只允许小写字母/数字/连字符（[a-z0-9-]+）`);
	if (positional.length !== 1) throw new Error("init 需要恰好一个目标目录参数");
	return {
		type,
		declarative,
		id,
		packageName: packageName ?? `@puddingteams/${type}-${id}`,
		displayName: displayName ?? toTitle(id),
		dir: positional[0]!,
	};
}

async function extensionInit(args: string[]): Promise<number> {
	let opts: InitOptions;
	try {
		opts = parseInitArgs(args);
	} catch (e) {
		err(`✗ ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
	const destDir = path.resolve(opts.dir);
	// 目标目录必须不存在或为空，防覆盖已有工作。
	if (existsSync(destDir)) {
		const entries = await readdir(destDir);
		if (entries.length > 0) {
			err(`✗ 目标目录非空：${destDir}（init 只写入不存在或空目录）`);
			return 1;
		}
	}
	const templateDir = path.join(TEMPLATES_DIR, opts.type === "capability" ? "capability" : opts.declarative ? "connector-declarative" : "connector");
	if (!existsSync(templateDir)) {
		err(`✗ 模板目录不存在：${templateDir}`);
		return 1;
	}
	const display = opts.displayName;
	const ph: Placeholders = {
		__CONNECTOR_ID__: opts.id,
		__CONNECTOR_ID_PASCAL__: toPascalCase(opts.id),
		__PACKAGE_NAME__: opts.packageName,
		__DISPLAY_NAME__: display,
		__DESCRIPTION__: opts.type === "capability"
			? `${display} Capability Extension：为绑定的 Agent 提供命名空间工具。`
			: opts.declarative
			? `${display} 声明式 Connector：纯 manifest 包，无代码接入 CLI（§10.3 第 1 级）。`
			: `${display} Connector 双宿主包：PuddingTeams Driver SPI 本体 + pi extension 门面。`,
	};
	const written: string[] = [];
	await copyTemplate(templateDir, destDir, ph, written);
	log(`✓ 已生成${opts.declarative ? "声明式 " : ""}${opts.type === "capability" ? "Capability" : "Connector"} 包「${opts.id}」→ ${destDir}`);
	for (const f of written) log(`  ${path.relative(destDir, f)}`);
	log(`下一步：puddingteams extension validate ${destDir}`);
	return 0;
}

// ---- extension validate ----

interface CheckResult {
	ok: boolean;
	label: string;
	detail?: string;
}

function pass(label: string, detail?: string): CheckResult {
	return { ok: true, label, ...(detail ? { detail } : {}) };
}

function fail(label: string, detail: string): CheckResult {
	return { ok: false, label, detail };
}

interface LoadedEntryModule {
	createDriver?: unknown;
	driver?: unknown;
	extension?: unknown;
	default?: unknown;
}

/** 代码型包：动态 import entry，按 registry 的识别规则检查导出。 */
async function checkEntryExports(entryPath: string, manifest: PuddingTeamsExtensionManifest & { entry?: string }): Promise<CheckResult> {
	let mod: LoadedEntryModule;
	try {
		mod = (await import(pathToFileURL(entryPath).href)) as LoadedEntryModule;
	} catch (e) {
		return fail("模块加载", `import ${manifest.entry} 失败：${e instanceof Error ? e.message : String(e)}`);
	}
	const inner = (mod.default ?? {}) as LoadedEntryModule & { register?: unknown };
	if (manifest.kind === "capability") {
		const extension = mod.extension ?? (inner.register ? inner : undefined);
		if (extension) return pass("模块导出", "capability 模块（extension/default.register）已导出");
		return fail("模块导出", "capability 包未导出 extension 模块（含 manifest + register）");
	}
	const createDriver = mod.createDriver ?? inner.createDriver;
	const driver = mod.driver ?? inner.driver;
	if (typeof createDriver === "function") return pass("模块导出", "createDriver 工厂已导出（多实例，推荐）");
	if (driver && typeof driver === "object") return pass("模块导出", "driver 单例已导出（建议改为 createDriver 工厂）");
	return fail("模块导出", "connector 包未导出 createDriver/driver");
}

/** 声明式包：收集 argv 里 {packageDir}/xxx 引用并检查文件存在（不探测可执行性，避免副作用）。 */
function checkDeclarativeRefs(dir: string, manifest: ConnectorExtensionManifest): CheckResult[] {
	const declarative = manifest.connector.declarative!;
	const argLists: string[][] = [...(declarative.probe ? [declarative.probe.args] : []), declarative.operations.run.args];
	if (declarative.operations.continue) argLists.push(declarative.operations.continue.args);
	const refs = new Set<string>();
	for (const args of argLists) {
		for (const arg of args) {
			const m = /^\{packageDir\}\/(.+)$/.exec(arg);
			if (m) refs.add(m[1]!);
		}
	}
	if (refs.size === 0) {
		return [pass("包内文件引用", "declarative args 未引用 {packageDir} 文件")];
	}
	return [...refs].map((ref) => {
		if (ref.includes("..") || path.isAbsolute(ref)) {
			return fail("包内文件引用", `{packageDir}/${ref} 越界（不允许绝对路径/..）`);
		}
		return existsSync(path.join(dir, ref))
			? pass("包内文件引用", `{packageDir}/${ref} 存在`)
			: fail("包内文件引用", `{packageDir}/${ref} 不存在于包内`);
	});
}

async function extensionValidate(args: string[]): Promise<number> {
	const positional = args.filter((a) => !a.startsWith("--"));
	if (positional.length !== 1) {
		err("✗ validate 需要恰好一个包目录参数");
		return 1;
	}
	const dir = path.resolve(positional[0]!);
	if (!existsSync(dir) || !(await stat(dir)).isDirectory()) {
		err(`✗ 目录不存在：${dir}`);
		return 1;
	}

	log(`校验 Extension 包：${dir}`);
	const results: CheckResult[] = [];

	// 1+2. manifest 读取与全量校验（与安装流程同一入口，含 declarative schema 与互斥）。
	let manifest: PuddingTeamsExtensionManifest & { entry?: string };
	try {
		manifest = await readManifestFromDir(dir);
		results.push(pass("manifest", `${manifest.kind}「${manifest.id}」v${manifest.version}（${manifest.displayName}）校验通过`));
	} catch (e) {
		results.push(fail("manifest", e instanceof Error ? e.message : String(e)));
		printResults(results);
		return 1;
	}

	// 3. entry 存在性（声明式包跳过）。
	const declarative = manifest.kind === "connector" ? manifest.connector.declarative : undefined;
	if (manifest.entry) {
		const entryPath = path.join(dir, manifest.entry);
		if (existsSync(entryPath)) {
			results.push(pass("entry 文件", `${manifest.entry} 存在`));
			// 4a. 代码型包：import entry 检查导出。
			results.push(await checkEntryExports(entryPath, manifest));
		} else {
			results.push(fail("entry 文件", `${manifest.entry} 不存在于包内`));
		}
	} else if (declarative) {
		results.push(pass("entry 文件", "声明式 Connector 无 entry（核心 DeclarativeDriver 执行），跳过"));
		// 4b. 声明式包：检查 {packageDir} 引用文件。
		results.push(...checkDeclarativeRefs(dir, manifest as ConnectorExtensionManifest));
	} else if (manifest.kind === "capability") {
		results.push(fail("entry 文件", "capability 包缺少 entry 模块入口"));
	} else {
		results.push(pass("entry 文件", "manifest-only 包（无 entry 无 declarative），只登记目录不注册 driver"));
	}

	printResults(results);
	const failed = results.filter((r) => !r.ok);
	if (failed.length === 0) {
		log(`\n全部 ${results.length} 项检查通过`);
		return 0;
	}
	err(`\n${failed.length} 项检查失败`);
	return 1;
}

function printResults(results: CheckResult[]): void {
	for (const r of results) {
		const line = `${r.ok ? "✓" : "✗"} ${r.label}${r.detail ? `：${r.detail}` : ""}`;
		if (r.ok) log(line);
		else err(line);
	}
}

// ---- 入口 ----

export async function runExtensionCli(argv: string[]): Promise<number> {
	const [scope, cmd, ...rest] = argv;
	if (scope === "init" || scope === "doctor") {
		try {
			return scope === "init" ? await runInitCli(argv.slice(1)) : await runDoctorCli(argv.slice(1));
		} catch (e) {
			err(`✗ ${e instanceof Error ? e.message : String(e)}`);
			return 1;
		}
	}
	if (scope !== "extension" || (cmd !== "init" && cmd !== "validate")) {
		err(USAGE);
		return 1;
	}
	try {
		return cmd === "init" ? await extensionInit(rest) : await extensionValidate(rest);
	} catch (e) {
		err(`✗ ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

// 被 bin/puddingteams.mjs 经 tsx 直接执行时进入 CLI；被测试 import 时不触发。
const invokedAsScript = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedAsScript) {
	runExtensionCli(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e: unknown) => {
			console.error(e);
			process.exit(1);
		},
	);
}
