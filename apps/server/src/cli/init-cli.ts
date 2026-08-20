import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolvePuddingTeamsPaths, type PuddingTeamsPaths } from "../paths.js";
import { upsertCustomProvider, type CustomProviderInput } from "../pi-bridge/custom-providers.js";
import { CredentialsStore } from "../store/credentials.js";
import { TeamsStore } from "../store/teams.js";

/**
 * `puddingteams doctor` / `puddingteams init`：环境体检与首次初始化向导。
 *
 * 向导分阶段（对标 openclaw / PuddingClaw deploy CLI）：
 * - 阶段 0  环境检查：Node ≥20、数据目录可写（探测只读，不主动创建目录）；
 * - 阶段 1  模型 Provider：选 provider → API Key（隐藏输入）→ 连通性探测 →
 *           写平台自有 secrets/auth.json（与 pi CLI 解耦 §10.6）→ 选默认模型；
 * - 阶段 2  第一方 Connector 状态：pi/puddingclaw 内置恒 ✓；codex/claude-code
 *           只读展示 extensions/registry.json 的 bundled 预装状态（init 无安装动作）；
 * - 阶段 2.5 上游 CLI 安装：puddingclaw 第一优先级，codex/claude 询问式安装 +
 *           登录态提示；
 * - 阶段 3  PuddingClaw 接入：本机回环 Backend URL → agents.json env →
 *           `puddingclaw doctor --json` 复核；不配置 PuddingClaw Token；
 * - 阶段 4  汇总确认后原子写入；跳过/非 TTY 不阻塞（退出码 0）。
 *
 * 原则：探测只读；写入前汇总确认；密钥不回显不进日志；失败给可操作修复指引。
 * 安装 spec 可用环境变量 `PUDDINGTEAMS_INSTALL_SPEC_<ID>` 覆盖（开发场景）。
 */

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface HttpProbeResult {
	ok: boolean;
	detail: string;
}

/** 可注入依赖：测试用假 exec/ask 驱动全部流程，不触真实环境。 */
export interface CliDeps {
	isTTY: boolean;
	env: NodeJS.ProcessEnv;
	nodeVersion: string;
	exec: (
		command: string,
		args: string[],
		opts: { timeoutMs: number; stdio?: "pipe" | "inherit"; env?: NodeJS.ProcessEnv },
	) => Promise<ExecResult>;
	ask: (question: string) => Promise<string>;
	/** 密钥输入（不回显）。缺省实现用 readline 屏蔽 echo。 */
	secretAsk?: (question: string) => Promise<string>;
	/** provider 连通性探测（缺省 fetch GET）。 */
	probeHttp?: (opts: { url: string; headers: Record<string, string>; timeoutMs: number }) => Promise<HttpProbeResult>;
	/** 列出 provider 的目录模型（缺省走 SDK 静态目录，PI_OFFLINE 不联网）。 */
	listProviderModels?: (providerId: string) => Promise<Array<{ id: string; name?: string }>>;
	/** 写默认模型（缺省 SDK SettingsManager，落在 pi 全局 settings.json，与 Web 设置页一致）。 */
	setDefaultModel?: (provider: string, model: string) => Promise<void>;
	/** 登记自定义 provider（缺省写 pi 全局 models.json，与 Web 设置页一致）。 */
	registerCustomProvider?: (id: string, input: CustomProviderInput) => Promise<void>;
}

interface WorkerEntry {
	/** probe id（小写），同时用于环境变量名。 */
	id: string;
	label: string;
	/** 内置 worker（进程内 SDK），无需安装，恒为可用。 */
	builtin?: boolean;
	/** 探测命令与版本参数。 */
	command?: string;
	versionArgs?: string[];
	/** 从探测 stdout 解析版本展示（缺省取首行）。 */
	parseVersion?: (stdout: string) => string | undefined;
	/** 默认 npm 安装 spec。 */
	installSpec?: string;
	/** 一句话用途，缺失时展示给用户判断要不要装。 */
	purpose: string;
	/** 登录态提示：本地凭证文件（缺 ~ 前缀展开）与未检测到时的指引。 */
	loginHint?: { credentialFiles: string[]; hint: string };
}

const WORKERS: WorkerEntry[] = [
	{ id: "pi", label: "pi", builtin: true, purpose: "内置 pi worker（进程内 SDK，无需安装）" },
	{
		id: "puddingclaw",
		label: "puddingclaw",
		command: "puddingclaw",
		// deploy-cli 不支持 --version 标志，用 version 子命令的 JSON 输出。
		versionArgs: ["version", "--json"],
		parseVersion: (stdout) => {
			try {
				const v = (JSON.parse(stdout) as { cli_version?: unknown }).cli_version;
				return typeof v === "string" ? `puddingclaw ${v}` : undefined;
			} catch {
				return undefined;
			}
		},
		// npm 公开包名是 scoped 的 @puddingai/puddingclaw（bin 名 puddingclaw）。
		installSpec: "@puddingai/puddingclaw",
		purpose: "PuddingClaw worker（连接 PuddingClaw Backend 的数据分析 Agent，第一优先 worker）",
	},
	{
		id: "codex",
		label: "codex",
		command: "codex",
		versionArgs: ["--version"],
		installSpec: "@openai/codex",
		purpose: "Codex worker（OpenAI Codex CLI）",
		loginHint: {
			credentialFiles: [".codex/auth.json"],
			hint: "未检测到 codex 登录凭证（~/.codex/auth.json），首次委派前请运行 codex login",
		},
	},
	{
		id: "claude",
		label: "claude-code",
		command: "claude",
		versionArgs: ["--version"],
		installSpec: "@anthropic-ai/claude-code",
		purpose: "Claude Code worker（Anthropic Claude Code CLI）",
		loginHint: {
			credentialFiles: [".claude/.credentials.json"],
			hint: "未检测到 claude 本地凭证文件（可能走系统钥匙串）；如委派失败请先在 claude 内登录",
		},
	},
];

export interface ProbeItem {
	id: string;
	ok: boolean;
	detail: string;
	/** 修复建议（仅 ok=false 时给出）。 */
	remediation?: string;
}

export interface DoctorReport {
	core: ProbeItem[];
	workers: ProbeItem[];
}

const PROBE_TIMEOUT_MS = 5_000;
const HTTP_PROBE_TIMEOUT_MS = 8_000;
const INSTALL_TIMEOUT_MS = 180_000;
const DEFAULT_PUDDINGCLAW_URL = "http://127.0.0.1:8888";
/** 阶段 2 只读展示的 bundled Connector（随 server 启动自动预装）。 */
const BUNDLED_CONNECTORS = [
	{ id: "codex", label: "codex" },
	{ id: "claude-code", label: "claude-code" },
];

// ---- 默认依赖实现 ----

function defaultExec(
	command: string,
	args: string[],
	opts: { timeoutMs: number; stdio?: "pipe" | "inherit"; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
			stdio: opts.stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve({ code: -1, stdout, stderr: `${stderr}\n命令超时（${opts.timeoutMs}ms）：${command}` });
		}, opts.timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: String((err as NodeJS.ErrnoException).code ?? err.message) });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

async function defaultAsk(question: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}

/** 隐藏输入：提示语直接写 stdout，输入字符不 echo（密钥不进日志/终端回显）。 */
async function defaultSecretAsk(question: string): Promise<string> {
	process.stdout.write(question);
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const mutable = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
	mutable._writeToOutput = function _writeToOutput(s: string) {
		// 屏蔽所有回显（含输入字符与 Enter 的 \r\n），结束后由我们补换行。
		void s;
	};
	try {
		return await rl.question("");
	} finally {
		rl.close();
		process.stdout.write("\n");
	}
}

async function defaultProbeHttp(opts: {
	url: string;
	headers: Record<string, string>;
	timeoutMs: number;
}): Promise<HttpProbeResult> {
	try {
		const res = await fetch(opts.url, { headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs) });
		if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
		const body = await res.text().catch(() => "");
		return { ok: false, detail: `HTTP ${res.status}${body ? `：${body.slice(0, 120)}` : ""}` };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

async function defaultListProviderModels(providerId: string): Promise<Array<{ id: string; name?: string }>> {
	// 只要静态目录：SDK 缺省会对所有内置 provider 做无超时联网 availability 探测。
	process.env.PI_OFFLINE ??= "1";
	const rt = await ModelRuntime.create();
	return rt.getModels(providerId).map((m) => ({ id: m.id, name: m.name }));
}

async function defaultSetDefaultModel(provider: string, model: string): Promise<void> {
	SettingsManager.create(process.cwd(), getAgentDir()).setDefaultModelAndProvider(provider, model);
}

async function defaultRegisterCustomProvider(id: string, input: CustomProviderInput): Promise<void> {
	await upsertCustomProvider(id, input);
}

function defaultDeps(): CliDeps {
	return {
		isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		env: process.env,
		nodeVersion: process.versions.node,
		exec: defaultExec,
		ask: defaultAsk,
	};
}

type ResolvedDeps = CliDeps & {
	secretAsk: (question: string) => Promise<string>;
	probeHttp: NonNullable<CliDeps["probeHttp"]>;
	listProviderModels: NonNullable<CliDeps["listProviderModels"]>;
	setDefaultModel: NonNullable<CliDeps["setDefaultModel"]>;
	registerCustomProvider: NonNullable<CliDeps["registerCustomProvider"]>;
};

function resolveDeps(deps: CliDeps): ResolvedDeps {
	return {
		...deps,
		secretAsk: deps.secretAsk ?? defaultSecretAsk,
		probeHttp: deps.probeHttp ?? defaultProbeHttp,
		listProviderModels: deps.listProviderModels ?? defaultListProviderModels,
		setDefaultModel: deps.setDefaultModel ?? defaultSetDefaultModel,
		registerCustomProvider: deps.registerCustomProvider ?? defaultRegisterCustomProvider,
	};
}

// ---- 探测 ----

function installSpecFor(worker: WorkerEntry, env: NodeJS.ProcessEnv): string {
	const override = env[`PUDDINGTEAMS_INSTALL_SPEC_${worker.id.toUpperCase().replaceAll("-", "_")}`]?.trim();
	return override || worker.installSpec!;
}

async function probeCore(deps: CliDeps): Promise<ProbeItem[]> {
	const items: ProbeItem[] = [];
	const major = Number.parseInt(deps.nodeVersion.split(".")[0] ?? "0", 10);
	items.push(
		major >= 20
			? { id: "node", ok: true, detail: `v${deps.nodeVersion}（>=20）` }
			: { id: "node", ok: false, detail: `v${deps.nodeVersion}`, remediation: "PuddingTeams 需要 Node.js >= 20，请升级后重试" },
	);
	let home = "";
	try {
		home = resolvePuddingTeamsPaths(deps.env).home;
		// 探测只读：目录不存在不创建，改验父目录可写（首次启动时会自动创建）。
		try {
			await access(home, fsConstants.R_OK | fsConstants.W_OK);
			items.push({ id: "home", ok: true, detail: home });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			await access(path.dirname(home), fsConstants.W_OK);
			items.push({ id: "home", ok: true, detail: `${home}（尚未创建，首次启动自动创建）` });
		}
	} catch (err) {
		items.push({
			id: "home",
			ok: false,
			detail: home || "(未解析)",
			remediation: `数据目录不可写：${err instanceof Error ? err.message : String(err)}；检查权限或设置 PUDDINGTEAMS_HOME 指向可写目录`,
		});
	}
	return items;
}

async function probeWorker(worker: WorkerEntry, deps: CliDeps): Promise<ProbeItem> {
	if (worker.builtin) return { id: worker.id, ok: true, detail: "内置（无需安装）" };
	const res = await deps.exec(worker.command!, worker.versionArgs!, { timeoutMs: PROBE_TIMEOUT_MS });
	if (res.code === 0) {
		const version = worker.parseVersion?.(res.stdout) ?? res.stdout.trim().split("\n")[0]?.trim();
		return { id: worker.id, ok: true, detail: version || "已安装" };
	}
	const spec = installSpecFor(worker, deps.env);
	return {
		id: worker.id,
		ok: false,
		detail: `未找到命令 \`${worker.command}\``,
		remediation: `npm install -g ${spec}（或运行 puddingteams init 引导安装）`,
	};
}

export async function runDoctor(deps: CliDeps): Promise<DoctorReport> {
	const core = await probeCore(deps);
	const workers: ProbeItem[] = [];
	for (const worker of WORKERS) workers.push(await probeWorker(worker, deps));
	return { core, workers };
}

// ---- 输出 ----

function printSection(title: string, items: ProbeItem[], labels: Map<string, string>, log: (msg: string) => void): void {
	log(`\n${title}`);
	for (const item of items) {
		const label = labels.get(item.id) ?? item.id;
		log(`  ${item.ok ? "✓" : "✗"} ${label} — ${item.detail}`);
		if (!item.ok && item.remediation) log(`    修复：${item.remediation}`);
	}
}

const CORE_LABELS = new Map([
	["node", "Node.js"],
	["home", "数据目录"],
]);

const WORKER_LABELS = new Map(WORKERS.map((w) => [w.id, w.label]));

// ---- doctor ----

export async function runDoctorCli(args: string[], deps: CliDeps = defaultDeps()): Promise<number> {
	const json = args.includes("--json");
	const report = await runDoctor(deps);
	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log("PuddingTeams doctor");
		printSection("核心", report.core, CORE_LABELS, console.log);
		printSection("Worker", report.workers, WORKER_LABELS, console.log);
	}
	// 核心不可用是产品级故障（退出码 1）；worker 缺失是可选项，不影响退出码。
	return report.core.every((item) => item.ok) ? 0 : 1;
}

// ---- init 向导 ----

/** 写入前汇总确认的草稿：一切持久化动作都先登记在这里，确认后统一 apply。 */
interface InitDraft {
	/** provider API key → 平台自有 secrets/auth.json（§10.6 与 pi CLI 解耦）。 */
	providerKey?: { providerId: string; apiKey: string };
	/** 自定义 provider → pi 全局 models.json（模型目录层与 pi CLI 共享）。 */
	customProvider?: { id: string; input: CustomProviderInput };
	/** 默认模型 → pi 全局 settings.json（与 Web 设置页同一写入路径）。 */
	defaultModel?: { provider: string; model: string };
	/** PuddingClaw 接入：URL → agents.json env；Token → CredentialsStore（加密）。 */
	puddingclaw?: { url?: string };
}

async function askYesNo(deps: ResolvedDeps, question: string, defaultYes = false): Promise<boolean> {
	const suffix = defaultYes ? "[Y/n]" : "[y/N]";
	const answer = (await deps.ask(`${question} ${suffix} `)).trim().toLowerCase();
	if (!answer) return defaultYes;
	return answer === "y" || answer === "yes";
}

/** 编号选择：循环直到输入合法序号；支持额外命令键（如 m = 手动输入）。
 * 连续 3 次无效输入放弃本阶段（防脚本/误操作死循环）。 */
async function chooseIndex(
	deps: ResolvedDeps,
	prompt: string,
	options: string[],
	log: (msg: string) => void,
	extraKeys: string[] = [],
): Promise<number | string | undefined> {
	for (let invalid = 0; ; ) {
		const lines = options.map((opt, i) => `  [${i + 1}] ${opt}`);
		const extra = extraKeys.map((k) => `  [${k}] ${k === "m" ? "手动输入" : k}`);
		const answer = (await deps.ask(`\n${prompt}\n${[...lines, ...extra].join("\n")}\n选择: `)).trim().toLowerCase();
		if (extraKeys.includes(answer)) return answer;
		const n = Number.parseInt(answer, 10);
		if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
		invalid += 1;
		if (invalid >= 3) {
			log("  连续无效输入，跳过本阶段。");
			return undefined;
		}
		log("  输入无效，请重新选择。");
	}
}

// ---- 阶段 1：模型 Provider ----

interface BuiltinProvider {
	id: string;
	label: string;
	probeUrl: string;
	probeHeaders: (apiKey: string) => Record<string, string>;
}

const BUILTIN_PROVIDERS: BuiltinProvider[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		probeUrl: "https://api.deepseek.com/models",
		probeHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
	},
	{
		id: "anthropic",
		label: "Anthropic",
		probeUrl: "https://api.anthropic.com/v1/models",
		probeHeaders: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
	},
];

/** key 探测失败时的兜底：用户确认后仍可保存（离线/探测端点不可达不代表 key 无效）。 */
async function probeKeyOrConfirm(
	deps: ResolvedDeps,
	probe: { url: string; headers: Record<string, string> },
	log: (msg: string) => void,
): Promise<boolean> {
	const res = await deps.probeHttp({ ...probe, timeoutMs: HTTP_PROBE_TIMEOUT_MS });
	if (res.ok) {
		log(`  ✓ 连通性探测通过（${res.detail}）`);
		return true;
	}
	log(`  ✗ 连通性探测失败：${res.detail}`);
	return askYesNo(deps, "  探测未通过（可能只是网络不可达）。仍要保存该 key 吗？");
}

async function pickDefaultModel(
	deps: ResolvedDeps,
	providerId: string,
	fallbackIds: string[],
	log: (msg: string) => void,
): Promise<string | undefined> {
	let models: Array<{ id: string; name?: string }> = [];
	try {
		models = await deps.listProviderModels(providerId);
	} catch (err) {
		log(`  ○ 模型目录读取失败（${err instanceof Error ? err.message : String(err)}），改为手动输入`);
	}
	if (models.length === 0) models = fallbackIds.map((id) => ({ id }));
	if (models.length === 0) return undefined;
	const shown = models.slice(0, 10);
	const choice = await chooseIndex(
		deps,
		"选择默认模型：",
		shown.map((m) => (m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id)),
		log,
		["m"],
	);
	if (choice === "m") {
		const manual = (await deps.ask("输入模型 id: ")).trim();
		return manual || undefined;
	}
	if (choice === undefined || typeof choice !== "number") return undefined;
	return shown[choice]?.id;
}

async function stageProvider(deps: ResolvedDeps, draft: InitDraft, log: (msg: string) => void): Promise<void> {
	log("\n阶段 1  模型 Provider（manager 思考与回复所需）");
	const choice = await chooseIndex(deps, "选择 Provider：", [...BUILTIN_PROVIDERS.map((p) => p.label), "自定义（OpenAI 兼容端点）", "跳过"], log);
	if (choice === undefined || typeof choice === "string") return;
	if (choice === 3) {
		log("  已跳过（之后可重新运行 puddingteams init，或在 Web 设置页配置）");
		return;
	}

	if (choice === 2) {
		// 自定义 OpenAI 兼容 provider：模型目录层登记到 models.json，key 仍走 auth.json。
		let id = "";
		for (;;) {
			id = (await deps.ask("  provider id（小写字母/数字/连字符，字母开头）: ")).trim();
			if (/^[a-z0-9][a-z0-9-]*$/.test(id)) break;
			log("  id 非法，请重新输入。");
		}
		const name = (await deps.ask(`  显示名称 [${id}]: `)).trim() || id;
		let baseUrl = "";
		for (;;) {
			baseUrl = (await deps.ask("  端点 baseUrl（https://…）: ")).trim().replace(/\/+$/, "");
			if (/^https?:\/\//.test(baseUrl)) break;
			log("  baseUrl 必须是 http(s) URL，请重新输入。");
		}
		let modelIds: string[] = [];
		for (;;) {
			modelIds = (await deps.ask("  模型 id 列表（逗号分隔）: "))
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (modelIds.length > 0) break;
			log("  至少登记一个模型。");
		}
		draft.customProvider = {
			id,
			input: { name, baseUrl, api: "openai-completions", models: modelIds.map((mid) => ({ id: mid })) },
		};
		const apiKey = (await deps.secretAsk(`  ${name} API Key（输入不显示）: `)).trim();
		if (apiKey) {
			const save = await probeKeyOrConfirm(
				deps,
				{ url: `${baseUrl}/models`, headers: { authorization: `Bearer ${apiKey}` } },
				log,
			);
			if (save) draft.providerKey = { providerId: id, apiKey };
		} else {
			log("  未输入 key：provider 仅登记目录，稍后在 Web 设置页补 key");
		}
		const model = await pickDefaultModel(deps, id, modelIds, log);
		if (model) draft.defaultModel = { provider: id, model };
		return;
	}

	const provider = BUILTIN_PROVIDERS[choice as number]!;
	const apiKey = (await deps.secretAsk(`  ${provider.label} API Key（输入不显示）: `)).trim();
	if (!apiKey) {
		log(`  未输入 key，已跳过 ${provider.label}（稍后可重新运行 init 或在 Web 设置页配置）`);
		return;
	}
	const save = await probeKeyOrConfirm(
		deps,
		{ url: provider.probeUrl, headers: provider.probeHeaders(apiKey) },
		log,
	);
	if (!save) {
		log("  已放弃保存该 key");
		return;
	}
	draft.providerKey = { providerId: provider.id, apiKey };
	const model = await pickDefaultModel(deps, provider.id, [], log);
	if (model) draft.defaultModel = { provider: provider.id, model };
}

// ---- 阶段 2：Connector 状态（只读） ----

async function stageConnectorStatus(paths: PuddingTeamsPaths, log: (msg: string) => void): Promise<void> {
	log("\n阶段 2  第一方 Connector（适配器层，随 server 自带，无需安装）");
	log("  ✓ pi — 内置");
	log("  ✓ puddingclaw — 内置");
	let bundledIds = new Set<string>();
	let registryNote = "";
	try {
		const raw = await readFile(path.join(paths.extensions, "registry.json"), "utf-8");
		const parsed = JSON.parse(raw) as { extensions?: Array<{ origin?: unknown; manifest?: { id?: unknown } }> };
		bundledIds = new Set(
			(parsed.extensions ?? [])
				.filter((e) => e?.origin === "bundled" && typeof e?.manifest?.id === "string")
				.map((e) => e.manifest!.id as string),
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") registryNote = "registry 尚未初始化";
		else registryNote = `registry 读取失败：${err instanceof Error ? err.message : String(err)}`;
	}
	for (const c of BUNDLED_CONNECTORS) {
		if (bundledIds.has(c.id)) log(`  ✓ ${c.label} — bundled 已预装`);
		else log(`  ○ ${c.label} — ${registryNote || "未发现"}（首次启动 server 时自动预装）`);
	}
}

// ---- 阶段 2.5：上游 CLI 安装 ----

async function loginHintFor(worker: WorkerEntry, deps: ResolvedDeps, log: (msg: string) => void): Promise<void> {
	if (!worker.loginHint) return;
	for (const rel of worker.loginHint.credentialFiles) {
		try {
			await access(path.join(os.homedir(), rel), fsConstants.R_OK);
			return; // 检测到凭证，无需提示
		} catch {
			// 继续查下一个候选
		}
	}
	log(`  ○ ${worker.loginHint.hint}`);
}

async function stageCliInstall(
	deps: ResolvedDeps,
	report: DoctorReport,
	log: (msg: string) => void,
): Promise<{ installed: string[]; skipped: string[]; failed: string[]; available: Set<string> }> {
	log("\n阶段 2.5  上游 CLI（worker 引擎）");
	const installed: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];
	const available = new Set(report.workers.filter((w) => w.ok).map((w) => w.id));

	for (const worker of WORKERS) {
		if (worker.builtin) {
			log(`  ✓ ${worker.label} — 内置无需安装`);
			continue;
		}
		if (available.has(worker.id)) {
			const detail = report.workers.find((w) => w.id === worker.id)?.detail ?? "已安装";
			log(`  ✓ ${worker.label} — ${detail}`);
			await loginHintFor(worker, deps, log);
			continue;
		}
		const spec = installSpecFor(worker, deps.env);
		if (!deps.isTTY) {
			skipped.push(worker.id);
			log(`  ○ ${worker.label} 未安装（非交互模式跳过）：npm install -g ${spec}`);
			continue;
		}
		const yes = await askYesNo(deps, `\n  未找到 ${worker.label}（${worker.purpose}）。\n  安装将执行：npm install -g ${spec}\n  现在安装？`);
		if (!yes) {
			skipped.push(worker.id);
			log(`  已跳过 ${worker.label}（之后可重新运行 puddingteams init，或手动 npm install -g ${spec}）`);
			continue;
		}
		const res = await deps.exec("npm", ["install", "-g", spec, "--ignore-scripts", "--no-audit", "--no-fund"], {
			timeoutMs: INSTALL_TIMEOUT_MS,
			stdio: "inherit",
		});
		if (res.code !== 0) {
			failed.push(worker.id);
			console.error(`  ✗ ${worker.label} 安装失败（退出码 ${res.code}）；可稍后手动执行：npm install -g ${spec}`);
			continue;
		}
		// 装完复测，不假装成功。
		const reprobe = await probeWorker(worker, deps);
		if (reprobe.ok) {
			installed.push(worker.id);
			available.add(worker.id);
			log(`  ✓ ${worker.label} 安装完成：${reprobe.detail}`);
			await loginHintFor(worker, deps, log);
		} else {
			failed.push(worker.id);
			console.error(`  ✗ ${worker.label} 安装后仍不可用：${reprobe.detail}；请检查 PATH 或手动执行 npm install -g ${spec}`);
		}
	}
	return { installed, skipped, failed, available };
}

// ---- 阶段 3：PuddingClaw 接入配置 ----

async function stagePuddingClawSetup(deps: ResolvedDeps, draft: InitDraft, log: (msg: string) => void): Promise<void> {
	log("\n阶段 3  PuddingClaw 本机接入（Backend URL）");
	if (!deps.isTTY) {
		log("  ○ 非交互模式跳过（可稍后重跑 init 或在 Web 智能体管理配置）");
		return;
	}
	const yes = await askYesNo(deps, "  现在配置 PuddingClaw Backend 接入？", true);
	if (!yes) {
		log("  已跳过（稍后可重跑 init 或在 Web 智能体管理 → puddingclaw 配置）");
		return;
	}
	const url = (await deps.ask(`  Backend URL [${DEFAULT_PUDDINGCLAW_URL}]: `)).trim() || DEFAULT_PUDDINGCLAW_URL;
	draft.puddingclaw = { url };
}

/** 递归找 configured/reachable 布尔字段，容忍 doctor JSON 结构变化。 */
function summarizeDoctorFlags(value: unknown, out: string[] = []): string[] {
	if (!value || typeof value !== "object") return out;
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (["configured", "reachable"].includes(k) && typeof v === "boolean") {
			out.push(`${k}=${v ? "✓" : "✗"}`);
		} else {
			summarizeDoctorFlags(v, out);
		}
	}
	return out;
}

async function verifyPuddingClaw(deps: ResolvedDeps, draft: InitDraft, log: (msg: string) => void): Promise<void> {
	const env: NodeJS.ProcessEnv = {};
	if (draft.puddingclaw?.url) env.PUDDINGCLAW_URL = draft.puddingclaw.url;
	const res = await deps.exec("puddingclaw", ["doctor", "--json"], { timeoutMs: PROBE_TIMEOUT_MS, env });
	if (res.code !== 0) {
		log(`  ○ puddingclaw doctor 复核失败（退出码 ${res.code}）：${res.stderr.trim().split("\n")[0] ?? "无输出"}；启动后可用 Web 探测复核`);
		return;
	}
	let flags: string[] = [];
	try {
		flags = summarizeDoctorFlags(JSON.parse(res.stdout));
	} catch {
		// 非 JSON 输出
	}
	log(flags.length > 0 ? `  ✓ puddingclaw doctor 复核：${flags.join(" ")}` : "  ○ doctor 输出未识别（可手动 puddingclaw doctor 复核）");
}

// ---- 阶段 4：汇总确认 + 原子写入 ----

function draftSummary(draft: InitDraft, home: string): string[] {
	const lines: string[] = [];
	if (draft.providerKey) lines.push(`provider key（${draft.providerKey.providerId}）→ ${home}/secrets/auth.json（平台自有，与 pi CLI 解耦）`);
	if (draft.customProvider) lines.push(`自定义 provider「${draft.customProvider.id}」（${draft.customProvider.input.models.length} 个模型）→ pi 全局 models.json`);
	if (draft.defaultModel) lines.push(`默认模型 ${draft.defaultModel.provider}/${draft.defaultModel.model} → pi 全局 settings.json`);
	if (draft.puddingclaw?.url) lines.push(`puddingclaw Backend URL ${draft.puddingclaw.url} → agents.json env（PUDDINGCLAW_URL）`);
	return lines;
}

/** auth.json 与 SDK AuthStorage 同格式：Record<providerId, {type:"api_key", key}>。 */
async function writeAuthJson(paths: PuddingTeamsPaths, providerId: string, apiKey: string): Promise<void> {
	const file = path.join(paths.secrets, "auth.json");
	let data: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	data[providerId] = { type: "api_key", key: apiKey };
	await mkdir(paths.secrets, { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, file);
	await chmod(file, 0o600).catch(() => undefined);
}

async function applyDraft(draft: InitDraft, deps: ResolvedDeps): Promise<string[]> {
	const paths = resolvePuddingTeamsPaths(deps.env);
	const applied: string[] = [];
	if (draft.providerKey) {
		await writeAuthJson(paths, draft.providerKey.providerId, draft.providerKey.apiKey);
		applied.push(`provider key（${draft.providerKey.providerId}）`);
	}
	if (draft.customProvider) {
		await deps.registerCustomProvider(draft.customProvider.id, draft.customProvider.input);
		applied.push(`自定义 provider「${draft.customProvider.id}」`);
	}
	if (draft.defaultModel) {
		await deps.setDefaultModel(draft.defaultModel.provider, draft.defaultModel.model);
		applied.push(`默认模型 ${draft.defaultModel.provider}/${draft.defaultModel.model}`);
	}
	if (draft.puddingclaw?.url) {
		const credentials = new CredentialsStore(paths.secrets);
		await credentials.init();
		if (draft.puddingclaw.url) {
			await mkdir(paths.unscopedWorkspace, { recursive: true });
			const teams = new TeamsStore(
				{ state: paths.state, assets: paths.assets, managedWorkspaces: paths.managedWorkspaces },
				paths.unscopedWorkspace,
				900_000,
				credentials,
			);
			await teams.init();
			const agent = await teams.getAgent("puddingclaw");
			if (!agent) throw new Error("agents.json 缺少内置 puddingclaw agent（数据损坏）");
			await teams.upsertAgent({ ...agent, env: { ...(agent.env ?? {}), PUDDINGCLAW_URL: draft.puddingclaw.url } });
			applied.push("puddingclaw Backend URL");
		}
	}
	return applied;
}

// ---- init ----

/**
 * 首次初始化向导：环境检查 → Provider → Connector 状态 → CLI 安装 →
 * PuddingClaw 接入 → 汇总确认后原子写入。
 * 跳过/非 TTY 都不阻塞（退出码 0）；核心故障、确认后安装/写入失败才退出码 1。
 */
export async function runInitCli(args: string[], deps: CliDeps = defaultDeps()): Promise<number> {
	const json = args.includes("--json");
	const d = resolveDeps(deps);
	const log = json ? () => undefined : console.log;
	const draft: InitDraft = {};

	// 阶段 0：环境检查
	const report = await runDoctor(d);
	log("PuddingTeams init");
	printSection("阶段 0  环境检查", report.core, CORE_LABELS, log);
	const coreFailed = report.core.filter((item) => !item.ok);
	if (coreFailed.length > 0) {
		if (!json) {
			for (const item of coreFailed) console.error(`✗ ${item.remediation ?? item.detail}`);
		} else {
			console.log(JSON.stringify({ ...report, aborted: "core_failed" }, null, 2));
		}
		return 1;
	}

	// 阶段 1：模型 Provider（仅交互；非 TTY 给结构化提示）
	let providerSkipped = true;
	if (d.isTTY) {
		await stageProvider(d, draft, log);
		providerSkipped = !draft.providerKey && !draft.customProvider;
	} else {
		log("\n阶段 1  模型 Provider\n  ○ 非交互模式跳过（可稍后重跑 init 或在 Web 设置页配置）");
	}

	// 阶段 2：Connector 状态（只读）
	const paths = resolvePuddingTeamsPaths(d.env);
	await stageConnectorStatus(paths, log);

	// 阶段 2.5：上游 CLI 安装
	const cli = await stageCliInstall(d, report, log);

	// 阶段 3：PuddingClaw 接入（CLI 可用时）
	if (cli.available.has("puddingclaw")) {
		await stagePuddingClawSetup(d, draft, log);
	} else {
		log("\n阶段 3  PuddingClaw 接入\n  ○ puddingclaw CLI 不可用，跳过接入配置");
	}

	// 阶段 4：汇总确认 → 原子写入
	const summary = draftSummary(draft, paths.home);
	const applied: string[] = [];
	const writeFailed: string[] = [];
	if (summary.length === 0) {
		log("\n阶段 4  写入确认\n  ○ 没有待写入的配置");
	} else if (!d.isTTY) {
		log(`\n阶段 4  写入确认\n  ○ 非交互模式不写入；待配项：\n${summary.map((s) => `    - ${s}`).join("\n")}`);
	} else {
		log(`\n阶段 4  写入确认\n${summary.map((s) => `  - ${s}`).join("\n")}`);
		const yes = await askYesNo(d, "确认写入以上配置？", true);
		if (!yes) {
			log("  已放弃，未写入任何配置");
		} else {
			try {
				applied.push(...(await applyDraft(draft, d)));
				for (const item of applied) log(`  ✓ 已写入：${item}`);
			} catch (err) {
				writeFailed.push(err instanceof Error ? err.message : String(err));
				console.error(`  ✗ 写入失败：${writeFailed[0]}（已写入项不回滚，可重跑 init 覆盖）`);
			}
		}
	}

	// PuddingClaw doctor 复核（配置过且 CLI 可用时）
	if (applied.length > 0 && draft.puddingclaw && cli.available.has("puddingclaw")) {
		await verifyPuddingClaw(d, draft, log);
	}

	if (json) {
		console.log(
			JSON.stringify(
				{
					...report,
					providerConfigured: !providerSkipped,
					installed: cli.installed,
					skipped: cli.skipped,
					failed: cli.failed,
					applied,
					writeFailed,
				},
				null,
				2,
			),
		);
	} else {
		log(
			`\ninit 完成${applied.length ? `，写入 ${applied.length} 项` : ""}${cli.installed.length ? `，新装：${cli.installed.join(", ")}` : ""}${cli.skipped.length ? `，跳过：${cli.skipped.join(", ")}` : ""}${cli.failed.length || writeFailed.length ? "，有失败项见上" : ""}。\n启动 PuddingTeams 后端后即可使用。`,
		);
	}
	return cli.failed.length > 0 || writeFailed.length > 0 ? 1 : 0;
}
