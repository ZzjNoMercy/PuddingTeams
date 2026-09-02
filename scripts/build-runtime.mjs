#!/usr/bin/env node
/**
 * 组装发行 runtime：packages/puddingteams-cli/runtime/
 *
 * 产物布局复刻仓库相对路径，server/cli bundle 里的 import.meta.url 相对引用
 * （assets、extensions/connectors、apps/web/out、templates）在 npm 包内原样成立：
 *
 *   runtime/apps/server/src/server.bundle.mjs   esbuild 单文件（pi SDK 内联）
 *   runtime/apps/server/src/{app-bridge.bundle.js,mcp-keyring-helper.cjs,mcp-script-worker.mjs}
 *                                               pi-mcp-adapter 运行时资源
 *   runtime/apps/server/src/cli/cli.bundle.mjs  init/doctor/extension CLI
 *   runtime/apps/server/assets/                 pi 默认头像等包内资源
 *   runtime/apps/web/out/                       Next 静态导出产物（server 同源托管）
 *   runtime/extensions/connectors/{codex,claude-code}/   entry 预编译为 .mjs
 *   runtime/extensions/capabilities/lark-cli/       # 官方 CLI/Skills 自动同步适配层
 *   runtime/extensions/shared/templates/        extension init 脚手架模板
 *
 * 用法：node scripts/build-runtime.mjs [--skip-web]
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME = path.join(ROOT, "packages", "puddingteams-cli", "runtime");
const skipWeb = process.argv.includes("--skip-web");

const BANNER = 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);';
const serverVersion = JSON.parse(readFileSync(path.join(ROOT, "apps", "server", "package.json"), "utf-8")).version;
if (!serverVersion) throw new Error("apps/server/package.json 缺少 version");

function step(msg) {
	console.log(`\x1b[36m▸\x1b[0m ${msg}`);
}

async function bundle(entry, outfile) {
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		banner: { js: BANNER },
		define: { PUDDINGTEAMS_HOST_VERSION_DEFINE: JSON.stringify(serverVersion) },
		outfile,
		logLevel: "warning",
	});
}

/** 递归复制，排除 node_modules / 测试 / ts 构建配置（运行时用不到）。 */
function copyPkg(src, dest) {
	cpSync(src, dest, {
		recursive: true,
		filter: (s) => {
			const base = path.basename(s);
			if (base === "node_modules" || base === "tsconfig.json" || base === ".turbo") return false;
			if (base.endsWith(".test.ts")) return false;
			return true;
		},
	});
}

rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });

step(`server bundle（宿主版本 ${serverVersion}）`);
await bundle(
	path.join(ROOT, "apps", "server", "src", "index.ts"),
	path.join(RUNTIME, "apps", "server", "src", "server.bundle.mjs"),
);

step("pi-mcp-adapter 运行时资源");
for (const asset of ["app-bridge.bundle.js", "mcp-keyring-helper.cjs", "mcp-script-worker.mjs"]) {
	cpSync(
		path.join(ROOT, "apps", "server", "node_modules", "pi-mcp-adapter", asset),
		path.join(RUNTIME, "apps", "server", "src", asset),
	);
}

step("cli bundle（init / doctor / extension）");
await bundle(
	path.join(ROOT, "apps", "server", "src", "cli", "extension-cli.ts"),
	path.join(RUNTIME, "apps", "server", "src", "cli", "cli.bundle.mjs"),
);

step("server assets（pi 默认头像等）");
cpSync(path.join(ROOT, "apps", "server", "assets"), path.join(RUNTIME, "apps", "server", "assets"), { recursive: true });

if (skipWeb) {
	step("跳过 web 构建（--skip-web），仅复制已有 apps/web/out");
} else {
	step("web 静态导出（next build）");
	const res = spawnSync("pnpm", ["--filter", "@puddingteams/web", "build"], { cwd: ROOT, stdio: "inherit" });
	if (res.status !== 0) throw new Error("web build 失败");
}
const webOut = path.join(ROOT, "apps", "web", "out");
if (!existsSync(path.join(webOut, "index.html"))) throw new Error("apps/web/out 不存在或不完整，请先构建 web");
cpSync(webOut, path.join(RUNTIME, "apps", "web", "out"), { recursive: true });

step("第一方 extensions（entry 预编译 .ts → .mjs）");
const FIRST_PARTY = [
	path.join("extensions", "connectors", "codex"),
	path.join("extensions", "connectors", "claude-code"),
	path.join("extensions", "capabilities", "lark-cli"),
];
for (const rel of FIRST_PARTY) {
	const dest = path.join(RUNTIME, rel);
	copyPkg(path.join(ROOT, rel), dest);
	const pkgPath = path.join(dest, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	const entry = pkg.puddingteams?.entry;
	if (entry?.endsWith(".ts")) {
		// 注意：entry 指向被 filter 排除前的源文件，从仓库目录编译，输出到包内 .mjs。
		await bundle(path.join(ROOT, rel, entry), path.join(dest, entry.replace(/\.ts$/, ".mjs")));
		pkg.puddingteams.entry = entry.replace(/\.ts$/, ".mjs");
		writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
	}
	console.log(`  ${rel} → entry ${pkg.puddingteams?.entry ?? "(manifest-only)"}`);
}

step("extension 脚手架模板");
cpSync(
	path.join(ROOT, "extensions", "shared", "templates"),
	path.join(RUNTIME, "extensions", "shared", "templates"),
	{ recursive: true },
);

// 汇总
let totalBytes = 0;
let totalFiles = 0;
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else {
			totalFiles++;
			totalBytes += statSync(p).size;
		}
	}
})(RUNTIME);
console.log(`\n✓ runtime 组装完成：${path.relative(ROOT, RUNTIME)}（${totalFiles} 个文件，${(totalBytes / 1024 / 1024).toFixed(1)} MB）`);
console.log("下一步：cd packages/puddingteams-cli && npm pack");
