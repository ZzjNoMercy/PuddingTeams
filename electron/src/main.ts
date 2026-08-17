import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

/**
 * PuddingTeams 桌面宿主（平台设计 §5/§8，P3-4 §9）。
 *
 * 分发形态：Electron 壳是 npm CLI 发行物（runtime/）的并列桌面宿主，不复制
 * 业务逻辑——主进程启动同一份生产 server bundle（ELECTRON_RUN_AS_NODE 用自带
 * 的 Electron/Node 运行，不依赖系统 Node），用随机本地端口 + health 探活，
 * BrowserWindow 只加载本地 server URL。
 *
 * 开发形态：`PUDDINGTEAMS_ELECTRON_DEV=1`（scripts/dev.mjs 设置）时直接加载
 * Next dev server（:8934），API 走 `pnpm dev` 起的 :8933——前端有 HMR，与
 * 浏览器调试一致。
 *
 * 数据目录：spawn 的 server 继承 `PUDDINGTEAMS_HOME=<userData>`，数据格式与
 * CLI 完全一致（P3-4 §9：显式与 CLI 的 ~/.puddingteams 分离）。
 */

const DEV = process.env.PUDDINGTEAMS_ELECTRON_DEV === "1";
const DEV_WEB_URL = "http://localhost:8934";
const APP_NAME = "PuddingTeams";

const IPC = {
	pickDirectory: "puddingteams:pick-directory",
	revealInFinder: "puddingteams:reveal-in-finder",
	openExternal: "puddingteams:open-external",
} as const;

// 仓库根目录（仅开发/源码运行期用于解析 runtime；打包态走 resourcesPath）。
const REPO_ROOT = path.resolve(__dirname, "..", "..");

let serverChild: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function resolveServerBundle(): string | undefined {
	const candidates = app.isPackaged
		? [path.join(process.resourcesPath, "runtime", "apps", "server", "src", "server.bundle.mjs")]
		: [path.join(REPO_ROOT, "packages", "puddingteams-cli", "runtime", "apps", "server", "src", "server.bundle.mjs")];
	return candidates.find((p) => existsSync(p));
}

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				const port = address.port;
				server.close(() => resolve(port));
			} else {
				server.close();
				reject(new Error("无法分配本地端口"));
			}
		});
	});
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs = 45_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server 提前退出（exit code ${child.exitCode}）`);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 未就绪，继续探活
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`server 健康检查超时（${timeoutMs}ms）`);
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

function logToFile(line: string): void {
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		mkdirSync(dir, { recursive: true });
		appendFileSync(path.join(dir, "server.log"), line);
	} catch {
		// 日志失败不影响运行
	}
}

async function spawnProductionServer(): Promise<{ port: number; child: ChildProcess }> {
	const bundle = resolveServerBundle();
	if (!bundle) {
		throw new Error("找不到 server bundle（runtime/apps/server/src/server.bundle.mjs）。请先构建 runtime：pnpm build:runtime");
	}
	const port = await getFreePort();
	const home = app.getPath("userData");
	const child = spawn(process.execPath, [bundle], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			PORT: String(port),
			HOST: "127.0.0.1",
			PUDDINGTEAMS_HOME: home,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (data: Buffer) => logToFile(data.toString()));
	child.stderr.on("data", (data: Buffer) => logToFile(data.toString()));
	serverChild = child;
	await waitForHealth(port, child);
	return { port, child };
}

function createWindow(appUrl: string): BrowserWindow {
	const win = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 940,
		minHeight: 600,
		title: APP_NAME,
		backgroundColor: "#09090b",
		...(!app.isPackaged ? { icon: path.join(REPO_ROOT, "electron", "build", "icon.png") } : {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	// 只允许本 app 源内导航；外部链接一律交系统浏览器。
	const appOrigin = new URL(appUrl).origin;
	win.webContents.on("will-navigate", (event, url) => {
		if (!url.startsWith(appOrigin)) event.preventDefault();
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http:") || url.startsWith("https:")) void shell.openExternal(url);
		return { action: "deny" };
	});
	void win.loadURL(appUrl);
	return win;
}

function registerIpc(): void {
	// 白名单 IPC：只暴露这 3 个 channel，preload 只代理这些。
	ipcMain.handle(IPC.pickDirectory, async (_event, initialPath: unknown) => {
		const options: Electron.OpenDialogOptions = {
			properties: ["openDirectory", "createDirectory"],
			defaultPath: typeof initialPath === "string" && initialPath ? initialPath : undefined,
		};
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	});
	ipcMain.handle(IPC.revealInFinder, (_event, targetPath: unknown) => {
		if (typeof targetPath === "string") shell.showItemInFolder(targetPath);
	});
	ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
		if (typeof url === "string" && /^https?:\/\//i.test(url)) await shell.openExternal(url);
	});
}

async function bootstrap(): Promise<void> {
	registerIpc();
	if (DEV) {
		mainWindow = createWindow(DEV_WEB_URL);
		return;
	}
	try {
		const { port } = await spawnProductionServer();
		mainWindow = createWindow(`http://127.0.0.1:${port}`);
	} catch (err) {
		dialog.showErrorBox("PuddingTeams 启动失败", err instanceof Error ? err.message : String(err));
		app.quit();
	}
}

// 单实例：第二个实例把焦点还给已存在的窗口，避免第二个 server/lease。
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});
	app.setName(APP_NAME);
	app.whenReady().then(bootstrap);
}

app.on("window-all-closed", () => app.quit());

app.on("before-quit", (event) => {
	if (serverChild) {
		event.preventDefault();
		void stopServer().then(() => app.quit());
	}
});

// 兜底：主进程被 kill 时也尽量终止 server 子进程，避免孤儿进程。
process.on("exit", () => {
	if (serverChild && serverChild.exitCode === null) serverChild.kill("SIGKILL");
});
