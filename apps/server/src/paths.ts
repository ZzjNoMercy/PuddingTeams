import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * PuddingTeams 用户数据目录（文档 §4）。一切平台状态都挂在
 * `PUDDINGTEAMS_HOME`（缺省 `~/.puddingteams`）下，不再散落到源码仓库
 * （`.teams`/`.sessions`）或 pi 全局目录：
 *
 * ```
 * <home>/config/{product.json,mcp-servers.json}
 * <home>/state/{agents,windows,workspaces,delegations,interactions,work-states,artifacts}.json
 * <home>/state/delegation-timelines/<delegationId>.jsonl  # spawn worker append-only events
 * <home>/sessions/ + sessions/workers/      # pi manager JSONL + pi worker sessions
 * <home>/extensions/registry.json
 * <home>/assets/avatars/
 * <home>/uploads/
 * <home>/artifacts/blobs/
 * <home>/state/knowledge/ + state/knowledge/{acceptance,plans,reviews,operations}/ + knowledge/objects/ + cache/knowledge/ # Teams 2.0
 * <home>/state/calendar/                                  # Teams 2.0
 * <home>/workspaces/{managed/,unscoped/}   # unscoped = 无项目中立 cwd
 * <home>/secrets/{credentials.json,credentials.key,interaction-secrets.json,interactions.key,auth.json}
 * <home>/secrets/mcp/{credentials.json,credentials.key} # MCP Server 加密凭据
 * <home>/secrets/capabilities/<extension>/<agent>/<binding>/ # CLI 自管认证状态
 * <home>/runtime/{backend.leases/,tmp/,fff/workspaces/<workspace-key>/}
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
	knowledgeState: string;
	knowledgeAcceptance: string;
	knowledgePlans: string;
	knowledgeReviews: string;
	knowledgeOperations: string;
	knowledgeObjects: string;
	knowledgeCache: string;
	calendarState: string;
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
		knowledgeState: path.join(root, "state", "knowledge"),
		knowledgeAcceptance: path.join(root, "state", "knowledge", "acceptance"),
		knowledgePlans: path.join(root, "state", "knowledge", "plans"),
		knowledgeReviews: path.join(root, "state", "knowledge", "reviews"),
		knowledgeOperations: path.join(root, "state", "knowledge", "operations"),
		knowledgeObjects: path.join(root, "knowledge", "objects"),
		knowledgeCache: path.join(root, "cache", "knowledge"),
		calendarState: path.join(root, "state", "calendar"),
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
		paths.knowledgeState,
		paths.knowledgeAcceptance,
		paths.knowledgePlans,
		paths.knowledgeReviews,
		paths.knowledgeOperations,
		paths.knowledgeObjects,
		paths.knowledgeCache,
		paths.calendarState,
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
 * 每个候选进程创建独立的 lease 文件，文件名在写入内容之前就包含 PID。
 * 随后扫描同目录：存在其他存活进程的候选文件就拒绝启动。两个同时
 * 回收 stale 文件的进程不会删除彼此的新文件；同时竞选可能双双拒绝，
 * 但绝不能双双取得单写者资格。遗留单文件 lease 一律拒绝，避免
 * 无法确认旧版后端是否仍在写入。仅支持本机文件系统上的单写者语义。
 */
export async function acquireLease(paths: PuddingTeamsPaths): Promise<() => Promise<void>> {
	const directory = path.join(paths.runtime, "backend.leases");
	await mkdir(directory, { recursive: true });
	const payload: LeasePayload = { pid: process.pid, startedAt: new Date().toISOString() };
	const legacyFile = path.join(paths.runtime, "backend.lease");
	try {
		await access(legacyFile);
		throw new Error(`检测到旧版后端 lease，无法确认是否仍在写入，拒绝启动：${legacyFile}`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const filename = `${process.pid}-${randomUUID()}.json`;
	const file = path.join(directory, filename);
	const handle = await open(file, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(payload) + "\n", "utf-8");
	} catch (err) {
		await rm(file, { force: true });
		throw err;
	} finally {
		await handle.close();
	}
	try {
		for (const candidate of await readdir(directory)) {
			if (candidate === filename) continue;
			const match = /^(\d+)-[0-9a-f-]+\.json$/.exec(candidate);
			if (!match) throw new Error(`无法识别后端 lease：${candidate}`);
			const pid = Number(match[1]);
			if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`无效后端 lease：${candidate}`);
			if (processAlive(pid)) {
				throw new Error(`另一个 PuddingTeams 后端正在运行（pid ${pid}），同一数据目录拒绝第二个实例：${paths.home}`);
			}
			await rm(path.join(directory, candidate), { force: true });
		}
	} catch (err) {
		await rm(file, { force: true });
		throw err;
	}
	return async () => { await rm(file, { force: true }); };
}
