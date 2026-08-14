#!/usr/bin/env node
/**
 * 开发态启动（单命令）：构建 main/preload → 拉起 dev 栈（server :8933 + web
 * :8934，若尚未运行）→ 就绪后启动 electron 壳加载 Next dev server。
 *
 * - 检测到 :8933/:8934 已在跑（比如另开终端 `pnpm dev`）则直接复用，不重复起；
 * - electron 退出时，若 dev 栈是本脚本拉起的，按进程组一并 SIGTERM 收掉。
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const outdir = path.join(root, "dist");
const electronPath = require("electron");

const WEB_URL = "http://localhost:8934";
const HEALTH_URL = "http://127.0.0.1:8933/api/health";
const READY_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isUp(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function waitFor(url, label, timeoutMs = READY_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isUp(url)) return true;
		await sleep(500);
	}
	return false;
}

await build({
	entryPoints: {
		main: path.join(root, "src", "main.ts"),
		preload: path.join(root, "src", "preload.ts"),
	},
	outdir,
	outExtension: { ".js": ".cjs" },
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	external: ["electron"],
	sourcemap: true,
	logLevel: "warning",
});

let devProcess = null;

async function main() {
	// 先清一次端口：复用仓库 kill-ports 逻辑。此时我们尚未建立任何到
	// 8933/8934 的探活连接，不会被 lsof 误杀（这正是直接跑根 `pnpm dev`
	// 时 predev kill-ports 杀本脚本的根因）。
	const { status, error } = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "kill-ports.mjs")], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	if (error) {
		console.error(`✗ kill-ports 启动失败：${error.message}`);
		process.exit(1);
	}
	if (status !== 0) {
		console.error(`✗ kill-ports 执行失败（exit ${status}）`);
		process.exit(1);
	}

	if ((await isUp(WEB_URL)) && (await isUp(HEALTH_URL))) {
		// dev server 已在跑（另开终端的 pnpm dev），直接复用。
		startElectron();
		return;
	}

	console.log("▸ dev server（:8933/:8934）未运行，自动拉起 …");
	// 直接起 server + web 两个 dev，不经过根 pnpm dev 的 predev（其 kill-ports
	// 会用 lsof 误杀正在探活的本脚本）。detached 便于退出时整组回收。
	devProcess = spawn(
		"pnpm",
		["--filter", "@puddingteams/server", "--filter", "@puddingteams/web", "--parallel", "run", "dev"],
		{ cwd: repoRoot, stdio: "inherit", env: process.env, detached: true },
	);

	const [webReady, serverReady] = [await waitFor(WEB_URL, "web"), await waitFor(HEALTH_URL, "server")];
	if (!webReady || !serverReady) {
		console.error(`✗ dev server 未就绪（web: ${webReady}, server: ${serverReady}），请检查 pnpm dev 输出`);
		stopDev();
		process.exit(1);
	}
	startElectron();
}

function startElectron() {
	console.log("✓ dev server 就绪，启动桌面壳…");
	const child = spawn(electronPath, ["."], {
		cwd: root,
		env: { ...process.env, PUDDINGTEAMS_ELECTRON_DEV: "1" },
		stdio: "inherit",
	});
	child.on("exit", (code) => {
		stopDev();
		process.exit(code ?? 0);
	});
}

function stopDev() {
	if (!devProcess) return;
	try {
		process.kill(-devProcess.pid, "SIGTERM");
	} catch {
		// 已退出
	}
	devProcess = null;
}

main().catch((err) => {
	console.error(err);
	stopDev();
	process.exit(1);
});
