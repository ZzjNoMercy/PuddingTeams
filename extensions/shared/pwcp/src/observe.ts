import type { ArtifactRef } from "./types.js";
import { spawnWorker } from "./spawn.js";

/** observe 收集的文件数上限（防御失控 diff）。 */
const MAX_OBSERVED = 200;

async function gitStatus(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const res = await spawnWorker({
		command: "git",
		// -uall：逐个列出 untracked 文件（默认会把整个未跟踪目录折叠成 "dir/"）。
		args: ["-C", cwd, "status", "--porcelain", "-uall"],
		env,
		timeoutMs: 10_000,
		startupMs: 5_000,
	});
	return res.exitCode === 0 ? res.stdout : undefined;
}

function parsePaths(stdout: string): string[] {
	const out: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length < 4) continue;
		// porcelain 格式："XY path"，重命名是 "XY orig -> new"（取新路径）。
		let p = line.slice(3).trim();
		const arrow = p.indexOf(" -> ");
		if (arrow >= 0) p = p.slice(arrow + 4).trim();
		// 含空格的路径 porcelain 会加引号，去掉。
		if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
		if (!p || p.endsWith("/") || p.startsWith(".pudding/")) continue;
		out.push(p);
	}
	return out;
}

/**
 * §15.4 observe 轨的任务前基线：非 git 工作区返回 null（完成后不收集）。
 */
export async function gitBaseline(cwd: string, env: NodeJS.ProcessEnv): Promise<Set<string> | null> {
	const stdout = await gitStatus(cwd, env);
	if (stdout === undefined) return null;
	return new Set(parsePaths(stdout));
}

/**
 * §15.4 observe 轨：worker 完成后对比任务前基线，只把**新增的** git status
 * 条目收为 ArtifactRef{origin:"observe"}。机械收集的诚实边界：任务前就已
 * 经脏的路径（如平台自身开发改动）不会误报，但任务对这些文件的二次修改
 * 也无法归因——要精确归因请用 push 轨（--export / handoff）。
 */
export async function observeGitArtifacts(
	cwd: string,
	env: NodeJS.ProcessEnv,
	baseline: Set<string> | null,
): Promise<ArtifactRef[]> {
	if (baseline === null) return [];
	const stdout = await gitStatus(cwd, env);
	if (stdout === undefined) return [];

	const out: ArtifactRef[] = [];
	for (const p of parsePaths(stdout)) {
		if (baseline.has(p)) continue;
		out.push({
			name: p.split(/[\\/]+/).filter(Boolean).pop() ?? p,
			path: p,
			origin: "observe",
		});
		if (out.length >= MAX_OBSERVED) break;
	}
	return out;
}
