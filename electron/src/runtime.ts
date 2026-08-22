import { createHash } from "node:crypto";
import path from "node:path";

export const DEFAULT_DESKTOP_PORT = 8933;

export interface ManagedServerState {
	pid: number;
	port?: number;
}

/**
 * 桌面宿主与 CLI 必须解析到同一个业务数据目录。Electron 的 userData 只存
 * 窗口/更新器等宿主偏好，不能成为第二套 PuddingTeams Home。
 */
export function resolvePuddingTeamsHome(env: NodeJS.ProcessEnv, userHome: string): string {
	const override = env.PUDDINGTEAMS_HOME?.trim();
	if (override) {
		if (!path.isAbsolute(override)) {
			throw new Error(`PUDDINGTEAMS_HOME 必须是绝对路径，收到：${override}`);
		}
		return path.resolve(override);
	}
	return path.join(userHome, ".puddingteams");
}

/** HTTP 只暴露不可逆目录指纹，供桌面壳确认要复用的是同一数据目录。 */
export function dataHomeId(home: string): string {
	return createHash("sha256").update(path.resolve(home)).digest("hex");
}

export function parseManagedServerState(raw: string): ManagedServerState | undefined {
	try {
		const parsed = raw.trim().startsWith("{")
			? JSON.parse(raw) as { pid?: unknown; port?: unknown }
			: { pid: Number(raw.trim()) };
		const pid = Number(parsed.pid);
		if (!Number.isInteger(pid) || pid <= 0) return undefined;
		const port = Number(parsed.port);
		return {
			pid,
			...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
		};
	} catch {
		return undefined;
	}
}

/** 合并 Finder 环境、登录 shell 与常见安装目录，保持先出现者优先。 */
export function mergeExecutablePaths(...values: Array<string | undefined>): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		for (const entry of value?.split(path.delimiter) ?? []) {
			const normalized = entry.trim();
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result.join(path.delimiter);
}
