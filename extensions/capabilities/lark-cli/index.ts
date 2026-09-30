import { spawn } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

type AuthMode = "auto" | "local" | "isolated";

interface LarkConfig {
	authMode: AuthMode;
	configDir?: string;
}

interface RuntimeContext {
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
	authMode: Exclude<AuthMode, "auto">;
	configDir?: string;
	issues: RuntimeIssue[];
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
const preparations = new Map<string, Promise<PreparedRuntime>>();
const connectionActions = new Map<string, Promise<void>>();

function stringConfig(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseConfig(raw: Readonly<Record<string, unknown>>): LarkConfig {
	const authMode = raw.authMode;
	return {
		authMode: authMode === "local" || authMode === "isolated" || authMode === "auto" ? authMode : "auto",
		configDir: stringConfig(raw.configDir),
	};
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

async function exportOfficialSkills(
	cliPath: string,
	version: string,
	env: NodeJS.ProcessEnv,
	runtimeDir: string,
): Promise<{ skillPath: string; skillCount: number }> {
	const skillsRoot = path.join(runtimeDir, "skills");
	const target = path.join(skillsRoot, version);
	const complete = path.join(target, ".complete.json");
	if (await access(complete).then(() => true, () => false)) {
		const cached = JSON.parse(await readFile(complete, "utf-8")) as { skillCount?: number };
		return { skillPath: target, skillCount: cached.skillCount ?? 0 };
	}

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

async function prepareRuntimeUncached(ctx: RuntimeContext): Promise<PreparedRuntime> {
	const config = parseConfig(ctx.config);
	const runtimeDir = path.join(ctx.stateDir, "runtime");
	const issues: RuntimeIssue[] = [];
	let { cliPath, source } = await findAvailableCli(ctx.env, ctx.sharedStateDir);
	if (cliPath) {
		if (source === "local") {
			const issue = await syncLocalCli(cliPath, ctx.env, path.join(runtimeDir, "local-sync.json"));
			if (issue) issues.push(issue);
			cliPath = await findLocalCli(ctx.env) ?? cliPath;
		}
	}

	const authMode: PreparedRuntime["authMode"] = config.authMode === "auto"
		? (source === "local" ? "local" : "isolated")
		: config.authMode;
	let configDir: string | undefined;
	if (authMode === "isolated") {
		if (config.configDir && !path.isAbsolute(config.configDir)) throw new Error("自定义登录目录必须是绝对路径");
		configDir = config.configDir ?? path.join(ctx.stateDir, "auth");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
	}
	if (!cliPath || !(await executable(cliPath))) {
		issues.push({
			code: "cli_not_installed",
			message: "尚未安装飞书 CLI",
			fixAction: "前往「扩展 → 连接状态」确认安装飞书官方 CLI",
		});
		return { source, skillCount: 0, authMode, configDir, issues };
	}

	let env = prependPath(ctx.env, path.dirname(cliPath));
	env = {
		...env,
		LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
		LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
		...(configDir ? { LARKSUITE_CLI_CONFIG_DIR: configDir } : {}),
	};
	const versionResult = await runCommand(cliPath, ["--version"], env);
	const version = cliVersion(versionResult);
	if (versionResult.code !== 0 || !version) {
		issues.push({ code: "version_probe_failed", message: "飞书官方 CLI 版本探测失败", fixAction: commandMessage(versionResult) });
		return { cliPath, source, skillCount: 0, env, authMode, configDir, issues };
	}

	let skillPath: string | undefined;
	let skillCount = 0;
	try {
		const exported = await exportOfficialSkills(cliPath, version, env, runtimeDir);
		skillPath = exported.skillPath;
		skillCount = exported.skillCount;
	} catch (error) {
		issues.push({
			code: "official_skills_sync_failed",
			message: "飞书官方 Skills 自动同步失败",
			fixAction: error instanceof Error ? error.message : String(error),
		});
	}
	return { cliPath, source, version, skillPath, skillCount, env, authMode, configDir, issues };
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
			"CLI 来源": prepared.source === "local" ? "本机官方版本" : "平台安装的官方版本",
			...(prepared.version ? { "CLI 版本": prepared.version } : {}),
			"官方 Skills": prepared.skillCount > 0 ? `${prepared.skillCount} 个（与 CLI 同步）` : "未就绪",
			"登录方式": prepared.authMode === "local" ? "沿用本机登录状态" : "当前绑定独立保存",
		},
		issues: prepared.issues,
	};
}

async function resolveRuntime(ctx: RuntimeContext): Promise<SessionRuntime> {
	return sessionRuntime(await prepareRuntime(ctx));
}

function quote(value: string): string {
	if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function probeRuntime(ctx: RuntimeContext): Promise<ProbeRuntime> {
	const config = parseConfig(ctx.config);
	const { cliPath, source } = await findAvailableCli(ctx.env, ctx.sharedStateDir);
	const authMode: PreparedRuntime["authMode"] = config.authMode === "auto"
		? (source === "local" ? "local" : "isolated")
		: config.authMode;
	let configDir: string | undefined;
	if (authMode === "isolated") {
		if (config.configDir && !path.isAbsolute(config.configDir)) throw new Error("自定义登录目录必须是绝对路径");
		configDir = config.configDir ?? path.join(ctx.stateDir, "auth");
	}
	const details: Record<string, unknown> = {
		"CLI 来源": source === "local" ? "本机官方版本" : "平台安装的官方版本",
		"登录方式": authMode === "local" ? "沿用本机登录状态" : "当前绑定独立保存",
	};
	const issues: RuntimeIssue[] = [];
	if (!cliPath) {
		issues.push({
			code: "cli_not_installed",
			message: "尚未安装飞书 CLI",
			fixAction: "前往「扩展 → 连接状态」确认安装飞书官方 CLI",
		});
		return { authenticated: false, details, issues };
	}

	let env = prependPath(ctx.env, path.dirname(cliPath));
	env = {
		...env,
		LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
		LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
		...(configDir ? { LARKSUITE_CLI_CONFIG_DIR: configDir } : {}),
	};
	const versionResult = await runCommand(cliPath, ["--version"], env, 5_000);
	const version = cliVersion(versionResult);
	if (version) details["CLI 版本"] = version;
	else issues.push({ code: "version_probe_failed", message: "飞书 CLI 版本探测失败", fixAction: "请重新检查连接状态" });

	const authResult = await runCommand(cliPath, ["auth", "status", "--json", "--verify"], env, 8_000);
	let authenticated = authResult.code === 0;
	try {
		const status = JSON.parse(authResult.stdout) as Record<string, unknown>;
		if (typeof status.verified === "boolean") authenticated = status.verified;
		const identities = status.identities as { user?: { userName?: unknown; status?: unknown } } | undefined;
		if (typeof identities?.user?.userName === "string") details["登录用户"] = identities.user.userName;
		if (typeof identities?.user?.status === "string") details["身份状态"] = identities.user.status;
	} catch {
		// 非 JSON 或旧版输出以 exit code 为准，不把原始认证输出返回浏览器。
	}
	if (!authenticated) {
		if (process.platform === "win32" && configDir) {
			details.loginCommand = `set "LARKSUITE_CLI_CONFIG_DIR=${configDir.replaceAll('"', '\\"')}"\n${quote(cliPath)} config init --new\n${quote(cliPath)} auth login`;
		} else {
			const prefix = configDir ? `LARKSUITE_CLI_CONFIG_DIR=${quote(configDir)} ` : "";
			details.loginCommand = `${prefix}${quote(cliPath)} config init --new\n${prefix}${quote(cliPath)} auth login`;
		}
		issues.push({
			code: authResult.code === 124 ? "auth_probe_timeout" : "not_authenticated",
			message: authResult.code === 124 ? "登录状态检查超时" : "飞书 CLI 尚未登录或登录已失效",
			fixAction: authResult.code === 124 ? "检查网络后重新探测" : "按下方登录命令完成认证",
		});
	}
	return { authenticated, details, issues };
}

/** 扩展总览只读探测：不安装、不更新，也不读取或返回任何 token。 */
async function listConnections(ctx: ConnectionContext): Promise<ConnectionStatus[]> {
	const checkedAt = new Date().toISOString();
	const { cliPath, source } = await findAvailableCli(ctx.env, ctx.stateDir);
	if (!cliPath) {
		return [{
			id: "default",
			name: "飞书 CLI",
			description: "飞书账号连接",
			state: "unavailable",
			message: "尚未安装飞书 CLI",
			actions: [{
				id: "install-cli",
				label: "安装飞书 CLI",
				description: "通过 npm 安装飞书官方最新版 CLI",
				confirmation: {
					title: "安装飞书 CLI？",
					description: "将从飞书官方 npm 包 @larksuite/cli 安装最新版。安装需要 Node.js/npm 和可用网络，完成后会自动重新检查连接状态。",
					confirmLabel: "开始安装",
				},
			}],
			checkedAt,
		}];
	}

	const env = {
		...prependPath(ctx.env, path.dirname(cliPath)),
		LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
		LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
	};
	const description = source === "local" ? "本机飞书账号连接" : "平台安装的飞书账号连接";
	const authorizeAction: ConnectionAction = { id: "authorize-user", kind: "authorization", label: "用户授权", description: "恢复已有用户授权；首次授权按飞书官方默认业务范围申请，具体权限由用户在飞书授权页确认" };
	const versionResult = await runCommand(cliPath, ["--version"], env, 5_000);
	const version = cliVersion(versionResult);
	const authResult = await runCommand(cliPath, ["auth", "status", "--json", "--verify"], env, 8_000);
	if (authResult.code !== 0) {
		return [{
			id: "default",
			name: "飞书 CLI",
			description,
			state: authResult.code === 124 ? "error" : "disconnected",
			...(version ? { version } : {}),
			message: authResult.code === 124 ? "登录状态检查超时，请检查网络后重试" : "尚未登录或登录已失效",
			actions: [authorizeAction],
			checkedAt,
		}];
	}

	try {
		const status = JSON.parse(authResult.stdout) as {
			ok?: unknown;
			verified?: unknown;
			identity?: unknown;
			identities?: { user?: { userName?: unknown; status?: unknown; tokenStatus?: unknown } };
		};
		if (status.ok === false || status.verified === false) {
			return [{
				id: "default",
				name: "飞书 CLI",
				description,
				state: "disconnected",
				...(version ? { version } : {}),
				message: "登录凭证验证未通过",
				actions: [authorizeAction],
				checkedAt,
			}];
		}
		const user = status.identities?.user;
		const identity = status.identity === "bot" ? "机器人身份" : status.identity === "user" || user ? "用户身份" : undefined;
		const identityStatus = typeof user?.status === "string" ? user.status : undefined;
		const tokenStatus = typeof user?.tokenStatus === "string" ? user.tokenStatus : undefined;
		const userAuthorization = tokenStatus === "expired" || identityStatus === "needs_refresh" ? "expired"
			: tokenStatus === "valid" || (identityStatus === "active" && tokenStatus !== "missing") ? "authorized" : "missing";
		return [{
			id: "default",
			name: "飞书 CLI",
			description,
			state: "connected",
			...(version ? { version } : {}),
			...(typeof user?.userName === "string" ? { accountName: user.userName } : {}),
			...(identity ? { identity } : {}),
			userAuthorization,
			actions: [{ ...authorizeAction, label: userAuthorization === "authorized" || userAuthorization === "expired" ? "重新授权" : "用户授权" }],
			message: userAuthorization === "authorized" ? "登录状态有效" : userAuthorization === "expired" ? "用户授权已过期；机器人连接不代表个人日历可访问" : "用户尚未授权；机器人连接不代表个人日历可访问",
			checkedAt,
		}];
	} catch {
		return [{
			id: "default",
			name: "飞书 CLI",
			description,
			state: "error",
			...(version ? { version } : {}),
			message: "无法解析飞书 CLI 登录状态",
			checkedAt,
		}];
	}
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

interface AuthorizationSession {
	id: string;
	state: "pending" | "completed" | "failed" | "expired" | "cancelled";
	verificationUrl?: string;
	qrCodeDataUrl?: string;
	expiresAt: string;
	message?: string;
}

interface PendingAuthorization {
	view: AuthorizationSession;
	key: string;
	deviceCode?: string;
	cliPath: string;
	env: NodeJS.ProcessEnv;
	controller: AbortController;
	polling: boolean;
}
const authorizations = new Map<string, PendingAuthorization>();
const authorizationStarts = new Map<string, Promise<AuthorizationSession>>();

function authorizationKey(connectionId: string, ctx: ConnectionContext): string {
	if (connectionId !== "default") throw new Error("飞书连接不存在");
	return canonical(ctx.stateDir);
}

function finishAuthorization(session: PendingAuthorization, state: AuthorizationSession["state"], message: string): void {
	if (session.view.state !== "pending") return;
	session.view = { id: session.view.id, state, expiresAt: session.view.expiresAt, message };
	session.deviceCode = undefined;
	session.controller.abort();
}

/** 官方 CLI 管理凭证；平台只保留本次流程的临时设备码，不另建 token 存储。 */
const authorization = {
	async begin(connectionId: string, actionId: string, ctx: ConnectionContext): Promise<AuthorizationSession> {
		const key = authorizationKey(connectionId, ctx);
		if (actionId !== "authorize-user") throw new Error("不支持的授权动作");
		const starting = authorizationStarts.get(key);
		if (starting) return starting;
		const pending = (async () => {
			for (const session of authorizations.values()) {
				if (session.key === key) finishAuthorization(session, "cancelled", "已重新发起授权");
			}
			const { cliPath } = await findAvailableCli(ctx.env, ctx.stateDir);
			if (!cliPath) throw new Error("请先安装飞书 CLI");
			const env = { ...prependPath(ctx.env, path.dirname(cliPath)), LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };
			const current = await runCommand(cliPath, ["auth", "status", "--json"], env, 5_000);
			let scope: string | undefined;
			if (current.code === 0) {
				try {
					const status = JSON.parse(current.stdout) as { identities?: { user?: { scope?: unknown } } };
					const existing = status.identities?.user?.scope;
					if (typeof existing === "string") scope = existing.trim() || undefined;
					else if (Array.isArray(existing) && existing.every(item => typeof item === "string")) scope = existing.join(" ").trim() || undefined;
				} catch { throw new Error("无法确认已有授权范围，请检查 CLI 配置后重试"); }
			} else if (current.code === 124) throw new Error("读取授权范围超时，请重试");
			const result = await runCommand(cliPath, ["auth", "login", ...(scope ? ["--scope", scope] : ["--recommend"]), "--no-wait", "--json"], env, 20_000);
			if (result.code !== 0) throw new Error(result.code === 124 ? "获取授权入口超时，请检查网络后重试" : "无法发起用户授权，请确认 CLI 已配置飞书应用且允许用户登录");
			let data: { verification_url?: unknown; device_code?: unknown; expires_in?: unknown };
			try { data = JSON.parse(result.stdout); } catch { throw new Error("无法读取飞书授权入口，请检查官方 CLI 版本"); }
			if (typeof data.verification_url !== "string" || typeof data.device_code !== "string" || !data.device_code) throw new Error("飞书未返回有效授权入口");
			const url = new URL(data.verification_url);
			if (url.protocol !== "https:" || url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) throw new Error("飞书返回了非官方授权地址");
			const ttl = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? Math.min(data.expires_in, 600) * 1000 : 240_000;
			const expiresAt = new Date(Date.now() + ttl).toISOString();
			const qrDir = await mkdtemp(path.join(tmpdir(), "pt-lark-auth-"));
			let qrCodeDataUrl: string;
			try {
				const qr = await runCommand(cliPath, ["auth", "qrcode", data.verification_url, "--output", "authorization.png"], env, 5_000, { cwd: qrDir });
				if (qr.code !== 0) throw new Error("无法生成授权二维码，请重试或更新官方 CLI");
				const png = await readFile(path.join(qrDir, "authorization.png"));
				if (png.length > 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("授权二维码格式无效");
				qrCodeDataUrl = `data:image/png;base64,${png.toString("base64")}`;
			} finally { await rm(qrDir, { recursive: true, force: true }); }
			const view: AuthorizationSession = { id: randomUUID(), state: "pending", verificationUrl: data.verification_url, qrCodeDataUrl, expiresAt, message: "等待用户授权" };
			const session: PendingAuthorization = { view, key, deviceCode: data.device_code, cliPath, env, controller: new AbortController(), polling: false };
			authorizations.set(view.id, session);
			setTimeout(() => finishAuthorization(session, "expired", "授权入口已过期，请重新发起"), Math.max(0, Date.parse(expiresAt) - Date.now())).unref();
			setTimeout(() => authorizations.delete(view.id), ttl + 60_000).unref();
			return { ...view };
		})().finally(() => authorizationStarts.delete(key));
		authorizationStarts.set(key, pending);
		return pending;
	},
	async status(connectionId: string, sessionId: string, ctx: ConnectionContext): Promise<AuthorizationSession | undefined> {
		const session = authorizations.get(sessionId);
		if (!session || session.key !== authorizationKey(connectionId, ctx)) return undefined;
		if (session.view.state === "pending" && Date.parse(session.view.expiresAt) <= Date.now()) finishAuthorization(session, "expired", "授权入口已过期，请重新发起");
		// 前端已拿到并展示链接后才启动官方等待流程；请求立即返回，不阻塞页面。
		if (session.view.state === "pending" && !session.polling) {
			session.polling = true;
			void runCommand(session.cliPath, ["auth", "login", "--device-code", session.deviceCode!, "--json"], session.env, Math.max(1, Date.parse(session.view.expiresAt) - Date.now()), { signal: session.controller.signal })
				.then(async (result) => {
					if (session.view.state !== "pending") return;
					if (result.code !== 0) {
						finishAuthorization(session, result.code === 124 ? "expired" : "failed", result.code === 124 ? "授权入口已过期，请重新发起" : "授权未完成或被拒绝，请重新发起");
						return;
					}
					const [connection] = await listConnections(ctx);
					finishAuthorization(session, connection?.userAuthorization === "authorized" ? "completed" : "failed", connection?.userAuthorization === "authorized" ? "用户授权成功，登录状态已更新" : "授权已返回，但用户凭证未通过验证，请重新检查");
				})
				.catch(() => finishAuthorization(session, "failed", "授权确认失败，请重试"));
		}
		return { ...session.view };
	},
	async cancel(connectionId: string, sessionId: string, ctx: ConnectionContext): Promise<void> {
		const session = authorizations.get(sessionId);
		if (session?.key === authorizationKey(connectionId, ctx)) finishAuthorization(session, "cancelled", "已停止等待授权");
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

export { authorization, exportOfficialSkills, findLocalCli, listConnections, parseConfig, probeRuntime, resolveRuntime, runConnectionAction };
export default extension;
