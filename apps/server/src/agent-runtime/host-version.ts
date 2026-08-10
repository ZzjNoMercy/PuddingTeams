import { readFileSync } from "node:fs";

interface HostPackageJson {
	version?: unknown;
}

function readHostVersion(): string {
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as HostPackageJson;
	if (typeof pkg.version !== "string" || !pkg.version.trim()) {
		throw new Error("@puddingteams/server package.json 缺少合法 version");
	}
	return pkg.version;
}

/** Extension engines.puddingteams 匹配的唯一宿主版本事实源。 */
export const PUDDINGTEAMS_HOST_VERSION = readHostVersion();
