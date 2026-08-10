#!/usr/bin/env node
/**
 * puddingteams CLI 引导脚本（纯 node，不依赖 TS 运行时）。
 *
 * server 源码全是 TS，bin 不能 import TS 模块，所以这里只做转发：用
 * server devDependencies 里的 tsx 跑 src/cli/extension-cli.ts，透传 stdio
 * 与退出码。真正的逻辑在 extension-cli.ts（可被 tsx --test 直接 import）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let tsxCliPath;
try {
	tsxCliPath = require.resolve("tsx/cli");
} catch {
	console.error("找不到 tsx（请先在仓库根目录执行 pnpm install）");
	process.exit(1);
}
const cliEntry = fileURLToPath(new URL("../src/cli/extension-cli.ts", import.meta.url));

const child = spawn(process.execPath, [tsxCliPath, cliEntry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", (err) => {
	console.error(`无法启动 tsx：${err.message}`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
