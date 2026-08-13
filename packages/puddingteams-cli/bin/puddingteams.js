#!/usr/bin/env node
/**
 * puddingteams CLI 引导（零依赖纯 node，可直接全局安装）。
 *
 * - init / doctor / extension *  → 转发到打包好的 cli.bundle.mjs（原 TS 向导
 *   与体检逻辑，esbuild 单文件，普通 node 直接跑）；
 * - start / stop / restart / status / open / version → 本文件内实现：后台
 *   拉起 server bundle，pidfile + 健康检查管理；数据目录沿用
 *   PUDDINGTEAMS_HOME（缺省 ~/.puddingteams），单写者 Lease 由 server 自带。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PKG = require("../package.json");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_BUNDLE = path.join(ROOT, "runtime", "apps", "server", "src", "server.bundle.mjs");
const CLI_BUNDLE = path.join(ROOT, "runtime", "apps", "server", "src", "cli", "cli.bundle.mjs");

const HOME = process.env.PUDDINGTEAMS_HOME?.trim() || path.join(os.homedir(), ".puddingteams");
const PID_FILE = path.join(HOME, "run", "server.pid");
const LOG_FILE = path.join(HOME, "logs", "server.log");
const DEFAULT_PORT = 8933;

const USAGE = `puddingteams v${PKG.version}

用法：
  puddingteams init [--json]        首次初始化向导（provider / worker 安装引导）
  puddingteams doctor [--json]      环境体检（只读）
  puddingteams start [--port N]     后台启动 server + web（默认端口 ${DEFAULT_PORT}）
  puddingteams stop                 停止后台 server
  puddingteams restart [--port N]   重启
  puddingteams status               查看运行状态
  puddingteams open                 在浏览器中打开（未运行则提示先 start）
  puddingteams extension init|validate …   Extension 包脚手架与校验
  puddingteams version              版本号

环境变量：
  PUDDINGTEAMS_HOME   数据目录（缺省 ~/.puddingteams）
  PORT                start 未显式 --port 时的端口
`;

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

function parseFlags(args, allowed) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		if (!allowed.has(name)) fail(`未知参数：--${name}\n\n${USAGE}`);
		flags[name] = eq === -1 ? (args[i + 1]?.startsWith("--") || i + 1 >= args.length ? true : args[++i]) : arg.slice(eq + 1);
	}
	return { flags, positional };
}

function resolvePort(flags) {
	const raw = flags.port ?? process.env.PORT ?? String(DEFAULT_PORT);
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`非法端口：${raw}`);
	return port;
}

function readRunState() {
	try {
		const raw = readFileSync(PID_FILE, "utf-8").trim();
		// 新格式 JSON {pid, port}；兼容旧的纯 pid 文本。
		const parsed = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw) };
		const pid = Number(parsed.pid);
		if (!Number.isInteger(pid) || pid <= 0) return {};
		return { pid, port: Number.isInteger(parsed.port) ? parsed.port : undefined };
	} catch {
		return {};
	}
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function healthOk(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function delegateToCliBundle(args) {
	if (!existsSync(CLI_BUNDLE)) fail("runtime 不完整：缺少 cli.bundle.mjs（请重新安装/构建发行包）");
	const child = spawn(process.execPath, [CLI_BUNDLE, ...args], { stdio: "inherit", env: process.env });
	child.on("error", (e) => fail(`无法启动 CLI：${e.message}`));
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 1);
	});
}

async function cmdStart(args) {
	const { flags } = parseFlags(args, new Set(["port"]));
	const port = resolvePort(flags);
	if (!existsSync(SERVER_BUNDLE)) fail("runtime 不完整：缺少 server.bundle.mjs（请重新安装/构建发行包）");
	const { pid } = readRunState();
	if (pid && pidAlive(pid)) {
		console.log(`已在运行（pid ${pid}）→ http://127.0.0.1:${port}`);
		return;
	}
	if (await healthOk(port)) fail(`端口 ${port} 已有一个 PuddingTeams server 在响应（非本 CLI 管理）；先 puddingteams stop 或换 --port`);
	mkdirSync(path.dirname(PID_FILE), { recursive: true });
	mkdirSync(path.dirname(LOG_FILE), { recursive: true });
	const logFd = openSync(LOG_FILE, "a");
	const child = spawn(process.execPath, [SERVER_BUNDLE], {
		env: { ...process.env, PORT: String(port), PUDDINGTEAMS_HOME: HOME },
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	child.unref();
	if (!child.pid) fail("server 进程拉起失败");
	writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port }), "utf-8");
	for (let i = 0; i < 40; i++) {
		await sleep(500);
		if (await healthOk(port)) {
			console.log(`✓ 已启动（pid ${child.pid}，数据目录 ${HOME}）`);
			console.log(`  → http://127.0.0.1:${port}   （puddingteams open 打开浏览器）`);
			console.log(`  日志：${LOG_FILE}`);
			return;
		}
		if (!pidAlive(child.pid)) break;
	}
	rmSync(PID_FILE, { force: true });
	fail(`server 启动超时或已退出，查看日志：${LOG_FILE}`);
}

async function cmdStop(args) {
	parseFlags(args, new Set());
	const { pid } = readRunState();
	if (!pid || !pidAlive(pid)) {
		rmSync(PID_FILE, { force: true });
		console.log("未在运行");
		return;
	}
	process.kill(pid, "SIGTERM");
	for (let i = 0; i < 20; i++) {
		await sleep(500);
		if (!pidAlive(pid)) {
			rmSync(PID_FILE, { force: true });
			console.log("✓ 已停止");
			return;
		}
	}
	fail(`pid ${pid} 未在 10s 内退出；可手动 kill ${pid}`);
}

async function cmdStatus(args) {
	parseFlags(args, new Set());
	const { pid, port } = readRunState();
	const alive = pid !== undefined && pidAlive(pid);
	console.log(`数据目录：${HOME}`);
	console.log(`进程：${alive ? `运行中（pid ${pid}）` : "未运行"}`);
	const probePort = alive && port ? port : Number(process.env.PORT) || DEFAULT_PORT;
	console.log(`健康检查（:${probePort}）：${(await healthOk(probePort)) ? "ok" : "无响应"}`);
}

async function cmdOpen(args) {
	const { flags } = parseFlags(args, new Set(["port"]));
	const { pid, port: runPort } = readRunState();
	const port = flags.port !== undefined || process.env.PORT ? resolvePort(flags) : runPort && pid && pidAlive(pid) ? runPort : resolvePort(flags);
	if (!(await healthOk(port))) fail(`server 未在 :${port} 响应，先 puddingteams start`);
	const url = `http://127.0.0.1:${port}`;
	const [cmd, cmdArgs] =
		process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
	child.on("error", () => console.log(`请手动打开：${url}`));
	child.unref();
	console.log(`→ ${url}`);
}

async function main() {
	const [cmd, ...args] = process.argv.slice(2);
	switch (cmd) {
		case "init":
		case "doctor":
			delegateToCliBundle([cmd, ...args]);
			return;
		case "extension":
			delegateToCliBundle([cmd, ...args]);
			return;
		case "start":
			await cmdStart(args);
			return;
		case "stop":
			await cmdStop(args);
			return;
		case "restart":
			await cmdStop([]);
			await cmdStart(args);
			return;
		case "status":
			await cmdStatus(args);
			return;
		case "open":
			await cmdOpen(args);
			return;
		case "version":
		case "--version":
		case "-v":
			console.log(PKG.version);
			return;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return;
		default:
			console.error(`未知命令：${cmd}\n\n${USAGE}`);
			process.exit(1);
	}
}

await main();
