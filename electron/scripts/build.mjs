#!/usr/bin/env node
/**
 * 编译 electron 主进程 + preload：esbuild 单文件 CJS（main.cjs / preload.cjs）。
 *
 * - main.cjs：spawn 生产 server、窗口与 IPC 生命周期；
 * - preload.cjs：contextBridge 白名单代理（sandbox 下只能 require electron）。
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "dist");
mkdirSync(outdir, { recursive: true });

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
	target: "node22",
	external: ["electron"],
	sourcemap: true,
	logLevel: "warning",
});

console.log("✓ electron main/preload → dist/main.cjs, dist/preload.cjs");
