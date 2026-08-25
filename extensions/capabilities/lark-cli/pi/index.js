import { spawn } from "node:child_process";

const SYNCED_KEY = Symbol.for("@puddingteams/capability-lark-cli:official-sync");
const flags = globalThis;

function run(command, args, timeoutMs = 300_000) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf-8")).slice(-2000); });
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 127, error: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, error: stderr.trim() });
		});
	});
}

async function syncOfficialLarkCli() {
	if (flags[SYNCED_KEY]) return { changed: false };
	flags[SYNCED_KEY] = true;
	let installed = false;
	let status = await run("lark-cli", ["--version"], 30_000);
	if (status.code !== 0) {
		status = await run("npm", ["install", "-g", "@larksuite/cli@latest"]);
		if (status.code !== 0) {
			flags[SYNCED_KEY] = false;
			return { changed: false, error: status.error || "npm 安装失败" };
		}
		installed = true;
	}
	const updated = await run("lark-cli", ["update", "--json", "--skills-layout", "separate"]);
	if (updated.code !== 0) {
		flags[SYNCED_KEY] = false;
		return { changed: installed, error: updated.error || "官方更新失败" };
	}
	return { changed: true };
}

export default function larkCliExtension(pi) {
	pi.registerCommand("lark-cli", {
		description: "查看飞书官方 CLI 与 Skills 的接入说明",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"该扩展直接使用飞书官方 lark-cli。启动 Pi Session 时会自动调用官方更新流程；首次安装后执行 /reload 即可载入官方 lark-* Skills。",
				"info",
			);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		const result = await syncOfficialLarkCli();
		if (result.error && ctx.hasUI) ctx.ui.notify(`飞书官方 CLI/Skills 自动同步失败：${result.error}`, "warning");
		else if (result.changed && ctx.hasUI) ctx.ui.notify("飞书官方 CLI 与 Skills 已同步；首次安装请执行 /reload 载入 Skills。", "info");
	});
}
