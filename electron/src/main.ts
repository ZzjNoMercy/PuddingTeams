import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	dataHomeId,
	DEFAULT_DESKTOP_PORT,
	mergeExecutablePaths,
	parseManagedServerState,
	resolvePuddingTeamsHome,
} from "./runtime.js";

/**
 * PuddingTeams 桌面宿主。
 *
 * - 不复制业务逻辑：打包态启动与 npm CLI 同源的 server.bundle.mjs；
 * - 不复制业务数据：PUDDINGTEAMS_HOME 缺省仍为 ~/.puddingteams；
 * - 不复制 pi global：不覆盖 HOME/PI_CODING_AGENT_DIR，继续使用 ~/.pi/agent；
 * - Electron userData 只存桌面日志、窗口与更新器等宿主状态。
 */

const DEV = process.env.PUDDINGTEAMS_ELECTRON_DEV === "1";
const DEV_WEB_URL = "http://127.0.0.1:8934";
const APP_NAME = "PuddingTeams";
const LOGIN_PATH_MARKER = "__PUDDINGTEAMS_LOGIN_PATH__";
const execFileAsync = promisify(execFile);

const IPC = {
	pickDirectory: "puddingteams:pick-directory",
	revealInFinder: "puddingteams:reveal-in-finder",
	openExternal: "puddingteams:open-external",
} as const;

const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface HealthPayload {
	ok?: boolean;
	service?: string;
	dataHomeId?: string;
}

let serverChild: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let currentAppUrl: string | null = null;
let trustedOrigin: string | null = null;
let quitting = false;

function resolveServerBundle(): string | undefined {
	const candidates = app.isPackaged
		? [path.join(process.resourcesPath, "runtime", "apps", "server", "src", "server.bundle.mjs")]
		: [path.join(REPO_ROOT, "packages", "puddingteams-cli", "runtime", "apps", "server", "src", "server.bundle.mjs")];
	return candidates.find((candidate) => existsSync(candidate));
}

function resolveDesktopPort(): number {
	const raw = process.env.PUDDINGTEAMS_DESKTOP_PORT?.trim();
	if (!raw) return DEFAULT_DESKTOP_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`PUDDINGTEAMS_DESKTOP_PORT 非法：${raw}`);
	}
	return port;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readCliServerState(home: string): { pid: number; port: number } | undefined {
	try {
		const state = parseManagedServerState(readFileSync(path.join(home, "run", "server.pid"), "utf8"));
		if (!state || !processAlive(state.pid)) return undefined;
		return { pid: state.pid, port: state.port ?? DEFAULT_DESKTOP_PORT };
	} catch {
		return undefined;
	}
}

async function probeHealth(port: number): Promise<HealthPayload | undefined> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!response.ok) return undefined;
		const payload = await response.json() as HealthPayload;
		return payload.service === "puddingteams-server" ? payload : undefined;
	} catch {
		return undefined;
	}
}

async function waitForHealth(
	port: number,
	child: ChildProcess,
	expectedHomeId: string,
	timeoutMs = 45_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server 提前退出（exit code ${child.exitCode}）`);
		const health = await probeHealth(port);
		if (health) {
			if (health.dataHomeId && health.dataHomeId !== expectedHomeId) {
				throw new Error(`端口 ${port} 上的 PuddingTeams 使用了另一份数据目录`);
			}
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`server 健康检查超时（${timeoutMs}ms）`);
}

function commonExecutablePaths(home: string): string {
	return [
		path.join(home, ".local", "bin"),
		path.join(home, ".npm-global", "bin"),
		path.join(home, ".bun", "bin"),
		path.join(home, ".cargo", "bin"),
		path.join(home, ".volta", "bin"),
		path.join(home, "Library", "pnpm"),
		...(process.platform === "win32"
			? [
				path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm"),
				path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "pnpm"),
				path.join(home, "scoop", "shims"),
			]
			: []),
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	].join(path.delimiter);
}

async function resolveExecutablePath(home: string): Promise<string> {
	let loginPath: string | undefined;
	if (process.platform !== "win32") {
		const loginShell = process.env.SHELL?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
		try {
			const { stdout } = await execFileAsync(
				loginShell,
				["-ilc", `printf '\\n${LOGIN_PATH_MARKER}%s\\n' "$PATH"`],
				{ env: { ...process.env, HOME: home }, timeout: 5000, maxBuffer: 1024 * 1024 },
			);
			const marker = stdout.lastIndexOf(LOGIN_PATH_MARKER);
			if (marker >= 0) loginPath = stdout.slice(marker + LOGIN_PATH_MARKER.length).split(/\r?\n/, 1)[0]?.trim();
		} catch {
			// shell rc 不可用时仍有确定性的常见目录兜底。
		}
	}
	return mergeExecutablePaths(loginPath, process.env.PATH, commonExecutablePaths(home));
}

async function stopServer(): Promise<void> {
	const child = serverChild;
	serverChild = null;
	if (!child || child.exitCode !== null) return;
	child.kill("SIGTERM");
	const exited = await Promise.race([
		new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
	]);
	if (!exited) child.kill("SIGKILL");
}

function desktopLogPath(): string {
	return path.join(app.getPath("userData"), "logs", "server.log");
}

function logToFile(line: string): void {
	try {
		const file = desktopLogPath();
		mkdirSync(path.dirname(file), { recursive: true });
		if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) truncateSync(file, 0);
		appendFileSync(file, line);
	} catch {
		// 日志失败不影响运行。
	}
}

async function reuseExistingServer(home: string, expectedHomeId: string): Promise<number | undefined> {
	const cliState = readCliServerState(home);
	if (cliState) {
		const health = await probeHealth(cliState.port);
		if (health && (!health.dataHomeId || health.dataHomeId === expectedHomeId)) {
			logToFile(`[desktop] reuse CLI server pid=${cliState.pid} port=${cliState.port}\n`);
			return cliState.port;
		}
	}

	const port = resolveDesktopPort();
	const health = await probeHealth(port);
	if (!health) return undefined;
	if (health.dataHomeId !== expectedHomeId) {
		throw new Error(
			health.dataHomeId
				? `端口 ${port} 已有 PuddingTeams，但它使用了另一份数据目录。请先停止该实例或设置 PUDDINGTEAMS_DESKTOP_PORT。`
				: `端口 ${port} 上的 PuddingTeams 版本无法证明数据目录一致。请先停止旧实例，再打开客户端。`,
		);
	}
	logToFile(`[desktop] reuse PuddingTeams server port=${port}\n`);
	return port;
}

async function spawnProductionServer(home: string, expectedHomeId: string): Promise<number> {
	const bundle = resolveServerBundle();
	if (!bundle) {
		throw new Error("找不到 server bundle。源码运行请先执行 pnpm build:runtime。");
	}
	const port = resolveDesktopPort();
	const executablePath = await resolveExecutablePath(os.homedir());
	const child = spawn(process.execPath, [bundle], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			PUDDINGTEAMS_DESKTOP: "1",
			PORT: String(port),
			HOST: "127.0.0.1",
			PUDDINGTEAMS_HOME: home,
			PATH: executablePath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (data: Buffer) => logToFile(data.toString()));
	child.stderr?.on("data", (data: Buffer) => logToFile(data.toString()));
	child.once("error", (error) => logToFile(`[desktop] server spawn error: ${error.message}\n`));
	child.once("exit", (code, signal) => {
		logToFile(`[desktop] server exit code=${code ?? "null"} signal=${signal ?? "null"}\n`);
		if (!quitting && serverChild === child) {
			serverChild = null;
			dialog.showErrorBox("PuddingTeams 后端已退出", `后端进程意外退出。日志：${desktopLogPath()}`);
			app.quit();
		}
	});
	serverChild = child;
	await waitForHealth(port, child, expectedHomeId);
	return port;
}

function sameOrigin(url: string, origin: string): boolean {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

function createWindow(appUrl: string): BrowserWindow {
	const appOrigin = new URL(appUrl).origin;
	trustedOrigin = appOrigin;
	const win = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 940,
		minHeight: 600,
		title: APP_NAME,
		backgroundColor: "#09090b",
		show: false,
		...(process.platform === "darwin"
			? {
				titleBarStyle: "hiddenInset" as const,
				trafficLightPosition: { x: 18, y: 18 },
			}
			: {}),
		...(!app.isPackaged ? { icon: path.join(REPO_ROOT, "electron", "build", "icon.png") } : {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			devTools: DEV,
			webviewTag: false,
		},
	});
	win.once("ready-to-show", () => win.show());
	win.on("closed", () => {
		if (mainWindow === win) mainWindow = null;
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (!sameOrigin(url, appOrigin)) event.preventDefault();
	});
	win.webContents.on("will-attach-webview", (event) => event.preventDefault());
	win.webContents.setWindowOpenHandler(({ url }) => {
		try {
			const protocol = new URL(url).protocol;
			if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
		} catch {
			// 非法 URL 直接拒绝。
		}
		return { action: "deny" };
	});
	win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	void win.loadURL(appUrl);
	return win;
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
	if (!trustedOrigin || event.senderFrame?.url === undefined || !sameOrigin(event.senderFrame.url, trustedOrigin)) {
		throw new Error("拒绝非 PuddingTeams 页面调用桌面能力");
	}
}

function registerIpc(): void {
	ipcMain.handle(IPC.pickDirectory, async (event, initialPath: unknown) => {
		assertTrustedSender(event);
		const options: Electron.OpenDialogOptions = {
			properties: ["openDirectory", "createDirectory"],
			defaultPath: typeof initialPath === "string" && initialPath ? initialPath : undefined,
		};
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	});
	ipcMain.handle(IPC.revealInFinder, (event, targetPath: unknown) => {
		assertTrustedSender(event);
		if (typeof targetPath === "string" && path.isAbsolute(targetPath)) shell.showItemInFolder(targetPath);
	});
	ipcMain.handle(IPC.openExternal, async (event, url: unknown) => {
		assertTrustedSender(event);
		if (typeof url !== "string") return;
		const parsed = new URL(url);
		if (parsed.protocol === "https:" || parsed.protocol === "http:") await shell.openExternal(parsed.toString());
	});
}

async function bootstrap(): Promise<void> {
	registerIpc();
	if (DEV) {
		currentAppUrl = DEV_WEB_URL;
		mainWindow = createWindow(currentAppUrl);
		return;
	}
	try {
		const home = resolvePuddingTeamsHome(process.env, os.homedir());
		const expectedHomeId = dataHomeId(home);
		const port = await reuseExistingServer(home, expectedHomeId) ?? await spawnProductionServer(home, expectedHomeId);
		currentAppUrl = `http://127.0.0.1:${port}`;
		mainWindow = createWindow(currentAppUrl);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		dialog.showErrorBox("PuddingTeams 启动失败", `${detail}\n\n桌面日志：${desktopLogPath()}`);
		app.quit();
	}
}

// scoped npm 包名会让 Electron 缺省生成 `@puddingteams/electron` 目录；桌面
// 宿主状态显式固定到产品名，业务数据仍完全独立地使用 ~/.puddingteams。
// 保留 Electron 标准 --user-data-dir 覆盖，便于并行预览/自动化使用隔离的
// Chromium profile；它不会改变 PUDDINGTEAMS_HOME。
app.setName(APP_NAME);
if (!app.commandLine.hasSwitch("user-data-dir")) {
	app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!mainWindow && currentAppUrl) mainWindow = createWindow(currentAppUrl);
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
	});
	if (process.platform === "win32") app.setAppUserModelId("com.puddingteams.app");
	void app.whenReady().then(bootstrap);
}

app.on("activate", () => {
	if (!mainWindow && currentAppUrl) mainWindow = createWindow(currentAppUrl);
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
	if (serverChild && !quitting) {
		event.preventDefault();
		quitting = true;
		void stopServer().then(() => app.quit());
	}
});

process.on("exit", () => {
	if (serverChild && serverChild.exitCode === null) serverChild.kill("SIGKILL");
});
