import { spawn } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLI_BRIDGE_SOURCE } from "./cli-bridge.js";
import type { AuthorizationView } from "./connection.js";

interface SharedConnection {
	status(): Promise<ConnectionStatus>;
	begin(): Promise<AuthorizationView>;
	authorizationStatus(id: string): Promise<AuthorizationView | undefined>;
	cancel(id: string): Promise<void>;
	runtimeEnv(): Promise<NodeJS.ProcessEnv>;
}

interface RuntimeContext {
	connection?: SharedConnection;
	config: Readonly<Record<string, unknown>>;
	env: NodeJS.ProcessEnv;
	stateDir: string;
	sharedStateDir: string;
}

interface RuntimeIssue {
	code: string;
	message: string;
	fixAction?: string;
}

interface SessionRuntime {
	skillPaths?: string[];
	env?: NodeJS.ProcessEnv;
	details?: Record<string, unknown>;
	issues?: RuntimeIssue[];
}

interface ProbeRuntime extends SessionRuntime {
	authenticated?: boolean | "unknown";
}

interface CapabilityRegistration {
	registerTool(tool: unknown): void;
}

interface ConnectionContext {
	connection?: SharedConnection;
	env: NodeJS.ProcessEnv;
	stateDir: string;
}

interface ConnectionAction {
	id: string;
	label: string;
	kind?: "authorization";
	description?: string;
	confirmation?: { title: string; description: string; confirmLabel: string };
}

interface ConnectionStatus {
	id: string;
	name: string;
	description?: string;
	state: "connected" | "disconnected" | "unavailable" | "error";
	version?: string;
	accountName?: string;
	identity?: string;
	userAuthorization?: "authorized" | "expired" | "missing";
	message?: string;
	actions?: ConnectionAction[];
	checkedAt: string;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface PreparedRuntime {
	cliPath?: string;
	source: "local" | "platform";
	version?: string;
	skillPath?: string;
	skillCount: number;
	env?: NodeJS.ProcessEnv;
	issues: RuntimeIssue[];
	/** 非空表示本次不发放能力，原因已写进 issues 并会让 CLI 入口直接失败。 */
	blocked?: string;
}

interface SkillListEntry {
	path: string;
	is_dir: boolean;
}

const POSIX_NAMES = ["lark-cli"];
const WINDOWS_NAMES = ["lark-cli.exe", "lark-cli.cmd", "lark-cli.bat", "lark-cli"];
const NPM_NAMES = process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
const OFFICIAL_PACKAGE = "@larksuite/cli@latest";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 后台刷新超过这个时长仍未收尾，视为失败：不再拒绝会话，用当前版本继续。 */
const REFRESH_STALE_MS = 10 * 60 * 1000;
const preparations = new Map<string, Promise<PreparedRuntime>>();
const refreshes = new Map<string, Promise<void>>();
const connectionActions = new Map<string, Promise<void>>();

/**
 * CLI/Skills 的同步状态。会话组装只读这个文件，网络与导出永远在后台跑：
 * `refreshing` 期间不发放 CLI（避免用到写盘中途的二进制或不同版本的 Skills）。
 */
interface UpdateState {
	status: "ready" | "refreshing";
	startedAt?: string;
	finishedAt?: string;
	version?: string;
	skillCount?: number;
	error?: string;
}

function updateStateFile(runtimeDir: string): string {
	return path.join(runtimeDir, "cli-update.json");
}

async function readUpdateState(runtimeDir: string): Promise<UpdateState | undefined> {
	try {
		return JSON.parse(await readFile(updateStateFile(runtimeDir), "utf-8")) as UpdateState;
	} catch {
		return undefined;
	}
}

async function writeUpdateState(runtimeDir: string, state: UpdateState): Promise<void> {
	await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await writeFile(updateStateFile(runtimeDir), `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** 正在刷新且未超过容忍时长；超时说明后台任务卡死或进程被杀，按可用处理。 */
function refreshInFlight(state: UpdateState | undefined, now = Date.now()): boolean {
	if (state?.status !== "refreshing") return false;
	const started = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
	return !Number.isFinite(started) || now - started < REFRESH_STALE_MS;
}

function canonical(file: string): string {
	try {
		const resolved = realpathSync.native(file);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	} catch {
		const resolved = path.resolve(file);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	}
}

async function executable(file: string): Promise<boolean> {
	try {
		await access(file, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findOnPath(env: NodeJS.ProcessEnv, names: string[]): Promise<string | undefined> {
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	for (const dir of (env[pathKey] ?? "").split(path.delimiter).filter(Boolean)) {
		for (const name of names) {
			const candidate = path.resolve(dir, name);
			if (await executable(candidate)) return candidate;
		}
	}
	return undefined;
}

async function findLocalCli(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	return findOnPath(env, process.platform === "win32" ? WINDOWS_NAMES : POSIX_NAMES);
}

function prependPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
	const next = { ...env };
	const key = Object.keys(next).find((name) => name.toLowerCase() === "path") ?? "PATH";
	const wanted = canonical(dir);
	const rest = (next[key] ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.filter((entry) => canonical(entry) !== wanted);
	next[key] = [dir, ...rest].join(path.delimiter);
	return next;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000, options: { cwd?: string; signal?: AbortSignal } = {}): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			env,
			...options,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
		});
		let stdout = "";
		let stderr = "";
		const append = (current: string, chunk: Buffer): string => (current + chunk.toString("utf-8")).slice(-256 * 1024);
		child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(124);
		}, timeoutMs);
		child.on("error", (error) => {
			stderr = error.message;
			finish(127);
		});
		child.on("close", (code) => finish(code ?? 1));
	});
}

async function markerFresh(file: string): Promise<boolean> {
	try {
		return Date.now() - (await stat(file)).mtimeMs < SYNC_INTERVAL_MS;
	} catch {
		return false;
	}
}

async function markSynced(file: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await writeFile(file, `${JSON.stringify({ syncedAt: new Date().toISOString() })}\n`, { encoding: "utf-8", mode: 0o600 });
}

function commandMessage(result: CommandResult): string {
	return (result.stderr || result.stdout || `退出码 ${result.code}`).slice(0, 800);
}

async function syncLocalCli(cliPath: string, env: NodeJS.ProcessEnv, marker: string): Promise<RuntimeIssue | undefined> {
	if (await markerFresh(marker)) return undefined;
	const result = await runCommand(cliPath, ["update", "--json", "--skills-layout", "separate"], env);
	if (result.code !== 0) {
		return {
			code: "official_update_failed",
			message: "飞书官方 CLI 自动同步失败，当前已安装版本仍可继续使用",
			fixAction: commandMessage(result),
		};
	}
	await markSynced(marker);
	return undefined;
}

function platformCliPath(installRoot: string): string {
	return path.join(
		installRoot,
		"node_modules",
		".bin",
		process.platform === "win32" ? "lark-cli.cmd" : "lark-cli",
	);
}

function sharedInstallRoot(sharedStateDir: string): string {
	return path.join(sharedStateDir, "official-cli");
}

async function findAvailableCli(
	env: NodeJS.ProcessEnv,
	sharedStateDir: string,
): Promise<{ cliPath?: string; source: "local" | "platform" }> {
	const local = await findLocalCli(env);
	if (local) return { cliPath: local, source: "local" };
	const managed = platformCliPath(sharedInstallRoot(sharedStateDir));
	return (await executable(managed))
		? { cliPath: managed, source: "platform" }
		: { source: "platform" };
}

async function syncPlatformCli(
	installRoot: string,
	env: NodeJS.ProcessEnv,
	marker: string,
): Promise<{ cliPath?: string; issue?: RuntimeIssue }> {
	const cliPath = platformCliPath(installRoot);
	if ((await executable(cliPath)) && (await markerFresh(marker))) return { cliPath };
	const npmPath = await findOnPath(env, NPM_NAMES);
	if (!npmPath) {
		return {
			...(await executable(cliPath) ? { cliPath } : {}),
			issue: {
				code: "npm_not_found",
				message: "未检测到本机飞书 CLI，且平台无法调用 npm 安装官方版本",
				fixAction: "安装 Node.js/npm 后重新探测",
			},
		};
	}
	await mkdir(installRoot, { recursive: true, mode: 0o700 });
	const result = await runCommand(
		npmPath,
		["install", "--prefix", installRoot, "--no-save", "--omit=dev", "--no-audit", "--no-fund", OFFICIAL_PACKAGE],
		env,
		5 * 60_000,
	);
	if (result.code !== 0 || !(await executable(cliPath))) {
		return {
			...(await executable(cliPath) ? { cliPath } : {}),
			issue: {
				code: "official_install_failed",
				message: "飞书官方 CLI 自动安装失败",
				fixAction: commandMessage(result),
			},
		};
	}
	await markSynced(marker);
	return { cliPath };
}

function parseJson<T>(result: CommandResult, label: string): T {
	if (result.code !== 0) throw new Error(`${label}失败：${commandMessage(result)}`);
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error(`${label}返回了无效 JSON`);
	}
}

function safeSkillPath(root: string, relative: string): string {
	if (!relative.startsWith("lark-") || path.isAbsolute(relative)) throw new Error(`Skills 返回了非法路径：${relative}`);
	const resolved = path.resolve(root, relative);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Skills 路径越界：${relative}`);
	return resolved;
}

async function listSkillFiles(cliPath: string, env: NodeJS.ProcessEnv, skillNames: string[]): Promise<string[]> {
	const files: string[] = [];
	const pending = [...skillNames];
	while (pending.length > 0) {
		const current = pending.shift();
		if (!current) continue;
		const result = await runCommand(cliPath, ["skills", "list", current], env);
		const payload = parseJson<{ entries?: SkillListEntry[] }>(result, `读取官方 Skill 目录 ${current}`);
		for (const entry of payload.entries ?? []) {
			if (entry.is_dir) pending.push(entry.path);
			else files.push(entry.path);
		}
	}
	return files;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	let index = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (index < items.length) {
			const item = items[index];
			index += 1;
			if (item !== undefined) await worker(item);
		}
	}));
}

/** 已导出过的官方 Skills（按 CLI 版本缓存）：只读磁盘，不调用 CLI。 */
async function cachedSkills(runtimeDir: string, version: string): Promise<{ skillPath: string; skillCount: number } | undefined> {
	const target = path.join(runtimeDir, "skills", version);
	try {
		const complete = JSON.parse(await readFile(path.join(target, ".complete.json"), "utf-8")) as { skillCount?: number };
		return { skillPath: target, skillCount: complete.skillCount ?? 0 };
	} catch {
		return undefined;
	}
}

async function exportOfficialSkills(
	cliPath: string,
	version: string,
	env: NodeJS.ProcessEnv,
	runtimeDir: string,
): Promise<{ skillPath: string; skillCount: number }> {
	const skillsRoot = path.join(runtimeDir, "skills");
	const target = path.join(skillsRoot, version);
	const cached = await cachedSkills(runtimeDir, version);
	if (cached) return cached;

	const listResult = await runCommand(cliPath, ["skills", "list"], env);
	const list = parseJson<{ skills?: Array<{ name?: unknown }> }>(listResult, "读取飞书官方 Skills");
	const skillNames = (list.skills ?? [])
		.map((skill) => skill.name)
		.filter((name): name is string => typeof name === "string" && /^lark-[a-z0-9-]+$/.test(name));
	if (skillNames.length === 0) throw new Error("飞书官方 CLI 未返回任何 Skills");
	const files = await listSkillFiles(cliPath, env, skillNames);
	await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
	const staging = await mkdtemp(path.join(skillsRoot, `.export-${version}-`));
	try {
		await mapLimit(files, 8, async (relative) => {
			const result = await runCommand(cliPath, ["skills", "read", relative], env);
			if (result.code !== 0) throw new Error(`读取官方 Skill 文件 ${relative} 失败：${commandMessage(result)}`);
			const destination = safeSkillPath(staging, relative);
			await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
			await writeFile(destination, `${result.stdout}\n`, { encoding: "utf-8", mode: 0o600 });
		});
		await writeFile(
			path.join(staging, ".complete.json"),
			`${JSON.stringify({ cliVersion: version, skillCount: skillNames.length, exportedAt: new Date().toISOString() })}\n`,
			{ encoding: "utf-8", mode: 0o600 },
		);
		await rm(target, { recursive: true, force: true });
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return { skillPath: target, skillCount: skillNames.length };
}

function cliVersion(result: CommandResult): string | undefined {
	return (result.stdout || result.stderr).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

async function writeExecutableAtomic(file: string, source: string): Promise<void> {
	const staging = await mkdtemp(path.join(path.dirname(file), ".bridge-"));
	try {
		const temporary = path.join(staging, "entry");
		await writeFile(temporary, source, { mode: 0o700 });
		await rename(temporary, file);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** 只读组装的公共部分：PATH 与官方 notifier 抑制。 */
function baseEnv(ctx: RuntimeContext, cliPath?: string): NodeJS.ProcessEnv {
	return {
		...(cliPath ? prependPath(ctx.env, path.dirname(cliPath)) : { ...ctx.env }),
		LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
		LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
	};
}

/**
 * Worker 的 `lark-cli` 入口。`blocked` 时同一个入口直接以该原因失败：不取 token、
 * 不碰真实 CLI，让「正在更新，稍后再试」这句出现在调用现场（Manager 能直接看到），
 * 而不是让调用方挂住等更新结束。
 */
async function bridgeEnvironment(ctx: RuntimeContext, cliPath: string | undefined, blocked?: string): Promise<NodeJS.ProcessEnv> {
	const bridgeDir = path.join(ctx.sharedStateDir, "bin");
	await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
	const bridge = path.join(bridgeDir, process.platform === "win32" ? "lark-cli.cjs" : "lark-cli");
	await writeExecutableAtomic(bridge, (process.platform === "win32" ? "" : `#!${process.execPath}\n`) + CLI_BRIDGE_SOURCE);
	if (process.platform === "win32") await writeExecutableAtomic(path.join(bridgeDir, "lark-cli.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0lark-cli.cjs" %*\r\n`);
	const env: NodeJS.ProcessEnv = { ...prependPath(baseEnv(ctx, cliPath), bridgeDir) };
	if (ctx.connection) Object.assign(env, await ctx.connection.runtimeEnv());
	if (cliPath && !blocked) env.PUDDING_LARK_REAL_CLI = cliPath;
	if (blocked) env.PUDDING_LARK_BLOCKED = blocked;
	// Remove inherited upstream secrets: each invocation obtains a fresh token.
	for (const key of ["LARKSUITE_CLI_APP_SECRET", "LARKSUITE_CLI_USER_ACCESS_TOKEN", "LARKSUITE_CLI_TENANT_ACCESS_TOKEN", "LARKSUITE_CLI_CONFIG_DIR"]) env[key] = "";
	return env;
}

async function blockedRuntime(
	ctx: RuntimeContext,
	state: { source: "local" | "platform"; cliPath?: string; version?: string },
	issue: RuntimeIssue,
	known: RuntimeIssue[] = [],
): Promise<PreparedRuntime> {
	return {
		...state,
		skillCount: 0,
		issues: [...known, issue],
		blocked: issue.message,
		env: ctx.connection ? await bridgeEnvironment(ctx, undefined, issue.message) : undefined,
	};
}

/**
 * 会话组装路径：**只做本地、有界的工作**（探测版本 + 读已导出的 Skills 缓存），
 * 不做任何网络更新，也不等待后台刷新。CLI 正在更新或当前版本的 Skills 尚未
 * 导出时，不发放能力，而是明确告诉调用方「稍后再试」——绝不静默等待。
 */
async function prepareRuntimeUncached(ctx: RuntimeContext): Promise<PreparedRuntime> {
	const runtimeDir = path.join(ctx.stateDir, "runtime");
	const issues: RuntimeIssue[] = [];
	const state = await readUpdateState(runtimeDir);
	if (refreshInFlight(state)) {
		return blockedRuntime(ctx, { source: "local", ...(state?.version ? { version: state.version } : {}) }, {
			code: "cli_update_in_progress",
			message: "飞书官方 CLI 正在后台更新，请稍后再试",
			fixAction: `更新开始于 ${state?.startedAt ?? "未知时间"}；完成后重新发起本次任务即可`,
		});
	}

	const { cliPath, source } = await findAvailableCli(ctx.env, ctx.sharedStateDir);
	if (!cliPath || !(await executable(cliPath))) {
		issues.push({
			code: "cli_not_installed",
			message: "尚未安装飞书 CLI",
			fixAction: "前往「扩展 → 连接状态」确认安装飞书官方 CLI",
		});
		return { source, skillCount: 0, issues };
	}

	const env = baseEnv(ctx, cliPath);
	const versionResult = await runCommand(cliPath, ["--version"], env);
	const version = cliVersion(versionResult);
	if (versionResult.code !== 0 || !version) {
		issues.push({ code: "version_probe_failed", message: "飞书官方 CLI 版本探测失败", fixAction: commandMessage(versionResult) });
	}

	// CLI 与 Skills 必须同版本：当前版本的 Skills 没导出完就不发放，避免 Worker 拿到
	// 与手上 CLI 不匹配的官方文档。导出与升级都在后台跑。
	const skills = version ? await cachedSkills(runtimeDir, version) : undefined;
	if (!skills) {
		refreshRuntimeInBackground(ctx);
		return blockedRuntime(ctx, { source, cliPath, ...(version ? { version } : {}) }, {
			code: "official_skills_syncing",
			message: "飞书官方 CLI/Skills 正在后台同步，请稍后再试",
			fixAction: version ? `官方 Skills ${version} 尚未就绪；同步完成后重新发起本次任务` : "CLI 版本探测未通过，请查看连接状态",
		}, issues);
	}

	// 6 小时新鲜度门到了就在后台刷新，不阻塞本次会话（当前 CLI 与 Skills 是一致的）。
	if (!state || state.version !== version || Date.now() - Date.parse(state.finishedAt ?? state.startedAt ?? "") >= SYNC_INTERVAL_MS) {
		refreshRuntimeInBackground(ctx);
	}

	const bridged = ctx.connection ? await bridgeEnvironment(ctx, cliPath) : env;
	return { cliPath, source, version, skillPath: skills.skillPath, skillCount: skills.skillCount, env: bridged, issues };
}

/**
 * 后台刷新：官方 update（6 小时门）→ 重新探测版本 → 导出该版本 Skills。
 * 用状态文件对外表达进度；同一 binding 同时只跑一个。任何失败只写进状态，
 * 不阻塞会话，也不改变当前可用的 CLI/Skills。
 */
function refreshRuntimeInBackground(ctx: RuntimeContext): void {
	const key = canonical(ctx.stateDir);
	if (refreshes.has(key)) return;
	const runtimeDir = path.join(ctx.stateDir, "runtime");
	const task = (async () => {
		const available = await findAvailableCli(ctx.env, ctx.sharedStateDir);
		if (!available.cliPath) {
			await writeUpdateState(runtimeDir, { status: "ready", finishedAt: new Date().toISOString(), error: "尚未安装飞书 CLI" });
			return;
		}
		try {
			// 无事可做就不进入 refreshing 态：稳态下不该出现「正在后台更新」的误导窗口。
			const needsUpdate = available.source === "local" && !(await markerFresh(path.join(runtimeDir, "local-sync.json")));
			const before = cliVersion(await runCommand(available.cliPath, ["--version"], baseEnv(ctx, available.cliPath)));
			const beforeSkills = before ? await cachedSkills(runtimeDir, before) : undefined;
			if (!needsUpdate && beforeSkills) {
				await writeUpdateState(runtimeDir, { status: "ready", finishedAt: new Date().toISOString(), version: before, skillCount: beforeSkills.skillCount });
				return;
			}

			await writeUpdateState(runtimeDir, { status: "refreshing", startedAt: new Date().toISOString(), version: before });
			let cliPath = available.cliPath;
			let issue: RuntimeIssue | undefined;
			if (available.source === "local") {
				issue = await syncLocalCli(cliPath, ctx.env, path.join(runtimeDir, "local-sync.json"));
				// 官方 update 可能换掉本机路径，重新解析一次。
				cliPath = await findLocalCli(ctx.env) ?? cliPath;
			}
			const env = baseEnv(ctx, cliPath);
			const version = cliVersion(await runCommand(cliPath, ["--version"], env));
			if (!version) throw new Error("飞书官方 CLI 版本探测失败");
			const exported = await exportOfficialSkills(cliPath, version, env, runtimeDir);
			await writeUpdateState(runtimeDir, {
				status: "ready",
				finishedAt: new Date().toISOString(),
				version,
				skillCount: exported.skillCount,
				...(issue ? { error: issue.message } : {}),
			});
		} catch (error) {
			await writeUpdateState(runtimeDir, {
				status: "ready",
				finishedAt: new Date().toISOString(),
				error: error instanceof Error ? error.message : String(error),
			}).catch(() => undefined);
		}
	})();
	refreshes.set(key, task);
	void task.finally(() => { if (refreshes.get(key) === task) refreshes.delete(key); });
}

/** 测试与关停用：等待所有在飞的后台刷新收尾。 */
async function settleBackgroundRefresh(): Promise<void> {
	await Promise.all([...refreshes.values()].map((task) => task.catch(() => undefined)));
}


async function prepareRuntime(ctx: RuntimeContext): Promise<PreparedRuntime> {
	const key = canonical(ctx.stateDir);
	const existing = preparations.get(key);
	if (existing) return existing;
	const pending = prepareRuntimeUncached(ctx).finally(() => preparations.delete(key));
	preparations.set(key, pending);
	return pending;
}

function sessionRuntime(prepared: PreparedRuntime): SessionRuntime {
	return {
		...(prepared.skillPath ? { skillPaths: [prepared.skillPath] } : {}),
		...(prepared.env ? { env: prepared.env } : {}),
		details: {
			...(prepared.blocked ? { "CLI 同步": prepared.blocked } : {}),
			"CLI 来源": prepared.source === "local" ? "本机官方版本" : "平台安装的官方版本",
			...(prepared.version ? { "CLI 版本": prepared.version } : {}),
			"官方 Skills": prepared.skillCount > 0 ? `${prepared.skillCount} 个（与 CLI 同步）` : prepared.blocked ? "本次未发放，稍后再试" : "未就绪",
			"登录方式": "平台与 CLI 共用加密凭证",
		},
		issues: prepared.issues,
	};
}

async function resolveRuntime(ctx: RuntimeContext): Promise<SessionRuntime> {
	if (!ctx.connection) throw new Error("共享飞书连接服务尚未配置");
	return sessionRuntime(await prepareRuntime(ctx));
}

async function probeRuntime(ctx: RuntimeContext): Promise<ProbeRuntime> {
	const { cliPath, source } = await findAvailableCli(ctx.env, ctx.sharedStateDir);
	const status = ctx.connection ? await ctx.connection.status() : undefined;
	const version = cliPath ? cliVersion(await runCommand(cliPath, ["--version"], ctx.env, 5_000)) : undefined;
	// 只读：报告同步状态，但不触发任何安装/更新（同步由会话组装在后台发起）。
	const sync = await readUpdateState(path.join(ctx.stateDir, "runtime"));
	const syncDetail = refreshInFlight(sync) ? `后台同步中（开始于 ${sync?.startedAt ?? "未知时间"}）`
		: sync?.error ? `上次同步失败：${sync.error}`
		: sync?.version ? `已就绪（${sync.version}）`
		: "尚未同步";
	return {
		authenticated: status?.userAuthorization === "authorized",
		details: {
			"CLI 来源": source === "local" ? "本机官方版本" : "平台安装的官方版本",
			"CLI 版本": version ?? "未探测到",
			"CLI 同步": syncDetail,
			"登录方式": "平台与 CLI 共用加密凭证",
			...(status?.accountName ? { "登录用户": status.accountName } : {}),
		},
		issues: [
			...(!cliPath ? [{ code: "cli_not_installed", message: "尚未安装飞书 CLI", fixAction: "前往连接状态确认安装；平台授权不依赖 CLI" }] : []),
			...(status?.userAuthorization !== "authorized" ? [{ code: "not_authenticated", message: status?.message ?? "共享连接未配置", fixAction: "在设置中导入已有连接，或在连接状态发起授权" }] : []),
		],
	};
}

/** 扩展总览只读探测：不安装、不更新，也不读取或返回任何 token。 */
async function listConnections(ctx: ConnectionContext): Promise<ConnectionStatus[]> {
	const status: ConnectionStatus = ctx.connection ? await ctx.connection.status() : {
		id: "default", name: "飞书", state: "disconnected", message: "共享连接未配置，请前往设置", checkedAt: new Date().toISOString(),
	};
	const { cliPath } = await findAvailableCli(ctx.env, ctx.stateDir);
	const version = cliPath ? cliVersion(await runCommand(cliPath, ["--version"], ctx.env, 5_000)) : undefined;
	const sync = await readUpdateState(path.join(ctx.stateDir, "runtime"));
	const message = refreshInFlight(sync)
		? [status.message, "官方 CLI/Skills 正在后台同步，稍后再试"].filter(Boolean).join("；")
		: sync?.error ? [status.message, `上次同步失败：${sync.error}`].filter(Boolean).join("；") : status.message;
	return [{
		...status,
		message,
		...(version ? { version } : {}),
		...(!cliPath ? {
			message: [status.message, "Agent 执行需要安装 CLI"].filter(Boolean).join("；"),
			actions: [...status.actions ?? [], {
				id: "install-cli", label: "安装飞书 CLI",
				confirmation: { title: "安装飞书 CLI？", description: "仅为 Agent 安装官方执行工具，不重复申请用户授权。", confirmLabel: "开始安装" },
			}],
		} : {}),
	}];
}

async function runConnectionAction(connectionId: string, actionId: string, ctx: ConnectionContext): Promise<void> {
	if (connectionId !== "default" || actionId !== "install-cli") throw new Error("不支持的飞书连接动作");
	const key = canonical(ctx.stateDir);
	const existing = connectionActions.get(key);
	if (existing) return existing;
	const pending = (async () => {
		const installRoot = sharedInstallRoot(ctx.stateDir);
		const installed = await syncPlatformCli(
			installRoot,
			ctx.env,
			path.join(ctx.stateDir, "platform-install.json"),
		);
		if (!installed.cliPath || installed.issue) {
			throw new Error(installed.issue
				? `${installed.issue.message}${installed.issue.fixAction ? `：${installed.issue.fixAction}` : ""}`
				: "飞书官方 CLI 安装失败");
		}
	})().finally(() => connectionActions.delete(key));
	connectionActions.set(key, pending);
	return pending;
}

const authorization = {
	async begin(connectionId: string, actionId: string, ctx: ConnectionContext): Promise<AuthorizationView> {
		if (connectionId !== "default" || actionId !== "authorize-user") throw new Error("不支持的授权动作");
		if (!ctx.connection) throw new Error("共享飞书连接服务尚未配置");
		return ctx.connection.begin();
	},
	async status(connectionId: string, sessionId: string, ctx: ConnectionContext) {
		if (connectionId !== "default") throw new Error("连接不存在");
		return ctx.connection?.authorizationStatus(sessionId);
	},
	async cancel(connectionId: string, sessionId: string, ctx: ConnectionContext): Promise<void> {
		if (connectionId !== "default") throw new Error("连接不存在");
		await ctx.connection?.cancel(sessionId);
	},
};

export const extension = {
	manifest: {
		id: "lark-cli",
		kind: "capability" as const,
		name: "飞书 CLI",
		version: "1.0.0",
		description: "通过飞书官方 CLI 与 Skills 为目标 Pi Session 提供飞书能力。",
		tools: [],
	},
	register(_ctx: CapabilityRegistration) {},
	listConnections,
	runConnectionAction,
	authorization,
	runtime: {
		resolveSession: resolveRuntime,
		probe: probeRuntime,
	},
};

export { authorization, exportOfficialSkills, findLocalCli, listConnections, probeRuntime, resolveRuntime, runConnectionAction, settleBackgroundRefresh };
export default extension;
