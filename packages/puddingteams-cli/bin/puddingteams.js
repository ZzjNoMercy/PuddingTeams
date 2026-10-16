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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesManagedHealth, pidAlive } from "./process-state.js";

const require = createRequire(import.meta.url);
const PKG = require("../package.json");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_BUNDLE = path.join(ROOT, "runtime", "apps", "server", "src", "server.bundle.mjs");
const CLI_BUNDLE = path.join(ROOT, "runtime", "apps", "server", "src", "cli", "cli.bundle.mjs");

const HOME = process.env.PUDDINGTEAMS_HOME?.trim() || path.join(os.homedir(), ".puddingteams");
const DATA_HOME_ID = createHash("sha256").update(path.resolve(HOME)).digest("hex");
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
  puddingteams logs [--tail N]      查看日志位置与尾部（默认 120 行）
  puddingteams logs --export [--out FILE]  导出诊断包（需后端在运行）
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
		return { pid, port: Number.isInteger(parsed.port) ? parsed.port : undefined, runId: typeof parsed.runId === "string" ? parsed.runId : undefined };
	} catch {
		return {};
	}
}

async function healthInfo(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

async function portResponds(port) {
	try {
		await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
		return true;
	} catch {
		return false;
	}
}

async function ownsRunningServer(state) {
	return Boolean(state.pid && state.port && pidAlive(state.pid) && matchesManagedHealth(state, await healthInfo(state.port), DATA_HOME_ID));
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

/** 单份轮转：超过上限就把当前日志挪成 `.1`（只保留一份历史，避免无限增长）。 */
function rotateLogFile(file, maxBytes) {
	try {
		if (existsSync(file) && statSync(file).size > maxBytes) {
			rmSync(`${file}.1`, { force: true });
			renameSync(file, `${file}.1`);
		}
	} catch {
		// 轮转失败不阻塞启动。
	}
}

/** 日志级别取自「设置 → 日志」持久化的 product.json；缺失即默认值。 */
function readLoggingSettings() {
	const defaults = { enabled: true, level: "info" };
	try {
		const parsed = JSON.parse(readFileSync(path.join(HOME, "config", "product.json"), "utf-8"));
		const level = ["error", "warn", "info", "debug"].includes(parsed?.logging?.level) ? parsed.logging.level : defaults.level;
		return { enabled: parsed?.logging?.enabled !== false, level };
	} catch {
		return defaults;
	}
}

function logFileCandidates() {
	const explicit = process.env.PUDDINGTEAMS_LOG_FILE?.trim();
	return explicit ? [explicit, `${explicit}.1`] : [LOG_FILE, `${LOG_FILE}.1`];
}

function describeFile(file) {
	try {
		const info = statSync(file);
		return `${file}（${(info.size / 1024).toFixed(1)} KiB，最后修改 ${info.mtime.toISOString()}）`;
	} catch {
		return `${file}（不存在）`;
	}
}

/** 探测正在运行的后端（同数据目录指纹），返回端口或 undefined。 */
async function runningServerPort() {
	const state = readRunState();
	if (state.port && await ownsRunningServer(state)) return state.port;
	// 桌面 App / 源码开发态起的后端不在 CLI 的 pidfile 里：用健康检查确认身份。
	const candidate = Number(process.env.PORT) || DEFAULT_PORT;
	const health = await healthInfo(candidate);
	return health && health.dataHomeId === DATA_HOME_ID ? candidate : undefined;
}

/** 从运行中的后端取内存里的最近日志（开发态没有日志文件时使用）。 */
async function recentLogFromServer() {
	try {
		const port = await runningServerPort();
		if (!port) return undefined;
		const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/logs/bundle`, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return undefined;
		const bundle = await res.json();
		const text = bundle?.logs?.["recent.log"]?.text;
		return typeof text === "string" && text ? text : undefined;
	} catch {
		return undefined;
	}
}

/** 只看日志：不要求后端在运行，直接读启动器重定向出的文件。 */
async function cmdLogs(args) {
	const { flags } = parseFlags(args, new Set(["tail", "export", "out"]));
	const logging = readLoggingSettings();
	const [file, previous] = logFileCandidates();
	if (flags.export !== undefined) {
		const port = await runningServerPort();
		if (!port) {
			fail("导出诊断包需要后端正在运行（包格式由后端统一生成）；先 puddingteams start，或直接看文件：puddingteams logs");
		}
		const target = typeof flags.out === "string" ? flags.out : path.join(process.cwd(), `puddingteams-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
		let res;
		try {
			res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/logs/bundle`, { signal: AbortSignal.timeout(15_000) });
		} catch (error) {
			fail(`导出诊断包失败：${error instanceof Error ? error.message : String(error)}`);
		}
		if (!res.ok) fail(`导出诊断包失败：HTTP ${res.status}`);
		writeFileSync(target, await res.text(), "utf-8");
		console.log(`✓ 已导出诊断包：${target}`);
		console.log("  包含运行标识、日志级别与日志尾部；不含密钥或会话内容。");
		return;
	}

	const limit = flags.tail === undefined ? 120 : Number(flags.tail);
	if (!Number.isInteger(limit) || limit < 0 || limit > 200_000) fail(`非法 --tail：${flags.tail}`);
	console.log(`数据目录：${HOME}`);
	console.log(`日志级别：${logging.enabled ? logging.level : "已关闭"}（在「设置 → 日志」中调整）`);
	console.log(`日志文件：${describeFile(file)}`);
	if (existsSync(previous)) console.log(`上一份：  ${describeFile(previous)}`);
	if (!existsSync(file)) {
		// 源码开发态没有文件：若后端在跑，就从它的内存缓冲里取最近日志。
		const recent = await recentLogFromServer();
		if (recent) {
			console.log(`\n──── 最近 ${limit} 行（来自运行中的后端内存缓冲）────\n${recent.split(/\r?\n/).slice(-limit).join("\n").trimEnd()}`);
			return;
		}
		console.log("\n尚没有日志文件。源码开发态（pnpm dev）日志只输出到启动它的终端；CLI 管理的实例才写入上面的路径。");
		return;
	}
	if (limit === 0) return;
	const text = readFileSync(file, "utf-8").split(/\r?\n/);
	const tail = text.slice(Math.max(0, text.length - limit)).join("\n").trimEnd();
	console.log(`\n──── 最后 ${limit} 行 ────\n${tail}`);
	return;
}

async function cmdStart(args) {
	const { flags } = parseFlags(args, new Set(["port"]));
	const port = resolvePort(flags);
	if (!existsSync(SERVER_BUNDLE)) fail("runtime 不完整：缺少 server.bundle.mjs（请重新安装/构建发行包）");
	const state = readRunState();
	const { pid } = state;
	if (pid && pidAlive(pid)) {
		if (await ownsRunningServer(state)) {
			console.log(`已在运行（pid ${pid}）→ http://127.0.0.1:${state.port}`);
			return;
		}
		fail(`pid ${pid} 仍存在但无法核实为当前数据目录的后端；保留运行记录，请检查后手动处理`);
	}
	if (await portResponds(port)) fail(`端口 ${port} 已有服务在响应（非本 CLI 管理）；请换 --port`);
	mkdirSync(path.dirname(PID_FILE), { recursive: true });
	mkdirSync(path.dirname(LOG_FILE), { recursive: true });
	rotateLogFile(LOG_FILE, 8 * 1024 * 1024);
	const logFd = openSync(LOG_FILE, "a");
	const runId = randomUUID();
	const child = spawn(process.execPath, [SERVER_BUNDLE], {
		env: { ...process.env, PORT: String(port), PUDDINGTEAMS_HOME: HOME, PUDDINGTEAMS_RUN_ID: runId, PUDDINGTEAMS_LOG_FILE: LOG_FILE, PUDDINGTEAMS_VERSION: PKG.version },
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	child.unref();
	if (!child.pid) fail("server 进程拉起失败");
	const runState = { pid: child.pid, port, runId };
	writeFileSync(PID_FILE, JSON.stringify(runState), "utf-8");
	for (let i = 0; i < 40; i++) {
		await sleep(500);
		if (matchesManagedHealth(runState, await healthInfo(port), DATA_HOME_ID)) {
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
	const state = readRunState();
	const { pid } = state;
	if (!pid || !pidAlive(pid)) {
		rmSync(PID_FILE, { force: true });
		console.log("未在运行");
		return;
	}
	if (!(await ownsRunningServer(state))) fail(`pid ${pid} 存在但服务身份无法核实；已保留运行记录，不发送停止信号`);
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if (error?.code === "EPERM") fail(`无权停止 pid ${pid}；已保留运行记录`);
		if (error?.code === "ESRCH") {
			rmSync(PID_FILE, { force: true });
			console.log("未在运行");
			return;
		}
		throw error;
	}
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
	const state = readRunState();
	const { pid, port } = state;
	const alive = pid !== undefined && pidAlive(pid);
	console.log(`数据目录：${HOME}`);
	const owned = alive && await ownsRunningServer(state);
	console.log(`进程：${owned ? `运行中（pid ${pid}）` : alive ? `存在但身份未核实（pid ${pid}）` : "未运行"}`);
	const probePort = alive && port ? port : Number(process.env.PORT) || DEFAULT_PORT;
	console.log(`健康检查（:${probePort}）：${owned ? "ok" : (await portResponds(probePort)) ? "有响应但身份未核实" : "无响应"}`);
}

async function cmdOpen(args) {
	const { flags } = parseFlags(args, new Set(["port"]));
	const state = readRunState();
	const port = flags.port !== undefined || process.env.PORT ? resolvePort(flags) : state.port ?? resolvePort(flags);
	if (!(await ownsRunningServer(state)) || state.port !== port) fail(`无法核实当前数据目录的 server 正在 :${port} 运行，先 puddingteams start`);
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
		case "logs":
			await cmdLogs(args);
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
