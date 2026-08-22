import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * PuddingTeams 用户数据目录（文档 §4）。一切平台状态都挂在
 * `PUDDINGTEAMS_HOME`（缺省 `~/.puddingteams`）下，不再散落到源码仓库
 * （`.teams`/`.sessions`）或 pi 全局目录：
 *
 * ```
 * <home>/config/product.json
 * <home>/state/{agents,windows,workspaces,delegations,interactions,work-states,artifacts}.json
 * <home>/state/delegation-timelines/<delegationId>.jsonl  # spawn worker append-only events
 * <home>/sessions/ + sessions/workers/      # pi manager JSONL + pi worker sessions
 * <home>/extensions/registry.json
 * <home>/assets/avatars/
 * <home>/uploads/
 * <home>/artifacts/blobs/
 * <home>/workspaces/{managed/,unscoped/}   # unscoped = 无项目中立 cwd
 * <home>/secrets/{credentials.json,credentials.key,interaction-secrets.json,interactions.key,auth.json}
 * <home>/runtime/{backend.lease,tmp/}
 * <home>/logs/  <home>/migrations/
 * ```
 */
export interface PuddingTeamsPaths {
	home: string;
	config: string;
	state: string;
	sessions: string;
	workerSessions: string;
	extensions: string;
	assets: string;
	uploads: string;
	artifactBlobs: string;
	managedWorkspaces: string;
	unscopedWorkspace: string;
	secrets: string;
	runtime: string;
	logs: string;
	migrations: string;
}

/**
 * 解析用户数据目录树。非空 `PUDDINGTEAMS_HOME` 优先且必须是绝对路径
 * （相对路径会让数据落点随启动 cwd 漂移，直接拒绝启动）；缺省
 * `<homedir>/.puddingteams`。
 */
export function resolvePuddingTeamsPaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): PuddingTeamsPaths {
	const override = env.PUDDINGTEAMS_HOME?.trim();
	let root: string;
	if (override) {
		if (!path.isAbsolute(override)) {
			throw new Error(`PUDDINGTEAMS_HOME 必须是绝对路径，收到：${override}`);
		}
		root = override;
	} else {
		root = path.join(home, ".puddingteams");
	}
	return {
		home: root,
		config: path.join(root, "config"),
		state: path.join(root, "state"),
		sessions: path.join(root, "sessions"),
		workerSessions: path.join(root, "sessions", "workers"),
		extensions: path.join(root, "extensions"),
		assets: path.join(root, "assets"),
		uploads: path.join(root, "uploads"),
		artifactBlobs: path.join(root, "artifacts", "blobs"),
		managedWorkspaces: path.join(root, "workspaces", "managed"),
		unscopedWorkspace: path.join(root, "workspaces", "unscoped"),
		secrets: path.join(root, "secrets"),
		runtime: path.join(root, "runtime"),
		logs: path.join(root, "logs"),
		migrations: path.join(root, "migrations"),
	};
}

/**
 * 本地宿主之间核对数据目录时使用的不可逆指纹。HTTP health 只暴露指纹，
 * 不把用户 Home 的绝对路径发送给 renderer 或其他本地调用方。
 */
export function puddingTeamsHomeId(home: string): string {
	return createHash("sha256").update(path.resolve(home)).digest("hex");
}

/** 启动时建目录树并验证可读写；任何一级不可写都拒绝启动。 */
export async function ensurePaths(paths: PuddingTeamsPaths): Promise<void> {
	const dirs = [
		paths.config,
		paths.state,
		paths.sessions,
		paths.workerSessions,
		paths.extensions,
		path.join(paths.assets, "avatars"),
		paths.uploads,
		paths.artifactBlobs,
		paths.managedWorkspaces,
		paths.unscopedWorkspace,
		paths.secrets,
		path.join(paths.runtime, "tmp"),
		paths.logs,
		paths.migrations,
	];
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true });
		await access(dir, fsConstants.R_OK | fsConstants.W_OK);
	}
}

interface LeasePayload {
	pid: number;
	startedAt: string;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = 进程存在但无权 signal，视为存活；其余（ESRCH）视为已退出。
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 单写者 Lease：`runtime/backend.lease` 以 O_EXCL 创建（内容 {pid,
 * startedAt}）。已存在且记录的进程仍存活 → 拒绝启动；进程已死或内容
 * 损坏（stale）→ 回收后重建。返回 release 函数（进程退出时删除 lease）。
 */
export async function acquireLease(paths: PuddingTeamsPaths): Promise<() => Promise<void>> {
	const file = path.join(paths.runtime, "backend.lease");
	await mkdir(paths.runtime, { recursive: true });
	const payload: LeasePayload = { pid: process.pid, startedAt: new Date().toISOString() };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(file, "wx");
			try {
				await handle.writeFile(JSON.stringify(payload) + "\n", "utf-8");
			} finally {
				await handle.close();
			}
			return async () => {
				await rm(file, { force: true });
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const raw = await readFile(file, "utf-8").catch(() => "");
			let pid: number | undefined;
			try {
				const parsed = JSON.parse(raw) as Partial<LeasePayload>;
				if (typeof parsed.pid === "number") pid = parsed.pid;
			} catch {
				pid = undefined;
			}
			if (pid !== undefined && processAlive(pid)) {
				throw new Error(`另一个 PuddingTeams 后端正在运行（pid ${pid}），同一数据目录拒绝第二个实例：${paths.home}`);
			}
			// stale lease：回收后重试 O_EXCL 创建。
			await rm(file, { force: true });
		}
	}
	throw new Error(`无法获取后端 lease：${file}`);
}
