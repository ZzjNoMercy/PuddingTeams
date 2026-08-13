import { readFileSync } from "node:fs";

// 打包产物（esbuild 单文件 bundle）里目录深度塌平，import.meta.url 相对路径读不到
// apps/server/package.json；构建脚本用 --define 把版本注入这个常量。dev/tsx 下
// 未定义，回退到文件读取。typeof 守卫保证未定义时不抛 ReferenceError。
declare const PUDDINGTEAMS_HOST_VERSION_DEFINE: string | undefined;

interface HostPackageJson {
	version?: unknown;
}

function readHostVersion(): string {
	if (typeof PUDDINGTEAMS_HOST_VERSION_DEFINE === "string" && PUDDINGTEAMS_HOST_VERSION_DEFINE.trim()) {
		return PUDDINGTEAMS_HOST_VERSION_DEFINE.trim();
	}
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as HostPackageJson;
	if (typeof pkg.version !== "string" || !pkg.version.trim()) {
		throw new Error("@puddingteams/server package.json 缺少合法 version");
	}
	return pkg.version;
}

/** Extension engines.puddingteams 匹配的唯一宿主版本事实源。 */
export const PUDDINGTEAMS_HOST_VERSION = readHostVersion();
