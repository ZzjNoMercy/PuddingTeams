import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 首版与提交校验保持一致：单文件 2 MiB、候选总量 8 MiB、最多 100 页。 */
export const TASK_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const TASK_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const TASK_MAX_PAGES = 100;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_GREP_MATCHES = 40;

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export class TaskWorkspaceError extends Error {
	constructor(readonly code: "invalid_path" | "not_found" | "read_only" | "too_large" | "sealed" | "invalid_input", message: string) {
		super(message);
	}
}

export interface TaskPage {
	/** 相对 library 根（即正式库 contentRoot）的路径，例如 wiki/concepts/x.md。 */
	path: string;
	content: string;
	size: number;
}

/**
 * 一次整理任务的候选工作区（file as API 的工作副本）。
 *
 * 目录布局：
 *   AGENTS.md / wiki.schema.json / task.md   只读规则
 *   sources/                                 只读素材（含 manifest.json）
 *   library/                                 可写候选，镜像正式库 contentRoot 坐标
 *   .host/                                   宿主私有：read evidence、sealed 标记
 *
 * 提交前 library 可变；提交成功后 sealed，后续修改必须开新任务/新代际。
 */
export class TaskWorkspace {
	constructor(readonly root: string, private readonly options: { sourcesRoot?: string } = {}) {}

	get library(): string { return path.join(this.root, "library"); }
	get sources(): string { return this.options.sourcesRoot ?? path.join(this.root, "sources"); }
	get hostDir(): string { return path.join(this.root, ".host"); }
	private get readyMarker(): string { return path.join(this.hostDir, "ready"); }
	private get sealedMarker(): string { return path.join(this.hostDir, "sealed"); }
	private get evidenceFile(): string { return path.join(this.hostDir, "reads.jsonl"); }

	async ready(): Promise<boolean> { return Boolean(await lstat(this.readyMarker).catch(() => null)); }
	async markReady(): Promise<void> { await mkdir(this.hostDir, { recursive: true, mode: 0o700 }); await writeFile(this.readyMarker, new Date().toISOString(), { mode: 0o600 }); }
	async isSealed(): Promise<boolean> { return Boolean(await lstat(this.sealedMarker).catch(() => null)); }
	async seal(): Promise<void> { await mkdir(this.hostDir, { recursive: true, mode: 0o700 }); await writeFile(this.sealedMarker, new Date().toISOString(), { mode: 0o600 }); }

	/** 宿主写入（不受候选工具限制）：规则、素材、库副本。 */
	async hostWrite(relative: string, bytes: Buffer | string, mode = 0o444): Promise<void> {
		const target = this.hostResolve(relative);
		await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await writeFile(target, bytes, { mode });
	}

	private hostResolve(relative: string): string {
		if (!relative || path.isAbsolute(relative) || relative.includes("\0")) throw new TaskWorkspaceError("invalid_path", "任务路径无效");
		const target = path.resolve(this.root, relative);
		if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new TaskWorkspaceError("invalid_path", "任务路径越界");
		const parts = path.relative(this.root, target).split(path.sep);
		if (parts.some((part) => part === ".." || part.startsWith("."))) throw new TaskWorkspaceError("invalid_path", "任务路径无效");
		return target;
	}

	/** 模型可见路径：相对任务根；写只能落在 library/**，读不能进入 .host/**。 */
	private async resolve(relative: string, access: "read" | "write"): Promise<string> {
		if (!relative || path.isAbsolute(relative) || relative.includes("\0")) throw new TaskWorkspaceError("invalid_path", "路径必须是任务目录内的相对路径");
		// sources/ 是任务级共享素材（只读）；其余路径相对当前目标库目录。
		const isSources = relative === "sources" || relative.startsWith("sources/");
		const base = isSources ? this.sources : this.root;
		const rest = isSources ? relative.slice("sources".length).replace(/^\//, "") : relative;
		const target = rest ? path.resolve(base, rest) : base;
		if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new TaskWorkspaceError("invalid_path", "路径越出任务目录");
		const relativeParts = path.relative(base, target).split(path.sep).filter(Boolean);
		if (relativeParts.some((part) => part === ".." || part === ".host")) throw new TaskWorkspaceError("invalid_path", "路径无效或属于宿主私有区");
		if (access === "write") {
			if (isSources) throw new TaskWorkspaceError("read_only", "sources/ 是只读素材");
			if (await this.isSealed()) throw new TaskWorkspaceError("sealed", "候选已提交；继续修改请开始新的整理任务");
			if (!target.startsWith(`${this.library}${path.sep}`)) throw new TaskWorkspaceError("read_only", "只能写 library/ 下的候选文件");
			if (!target.endsWith(".md")) throw new TaskWorkspaceError("invalid_input", "候选只接受 Markdown 文件");
			if (relativeParts.some((part) => part.startsWith("."))) throw new TaskWorkspaceError("invalid_path", "路径无效");
		}
		// 逐段 lstat：拒绝符号链接，避免借链接逃出任务目录。
		let current = base;
		for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			const info = await lstat(current).catch(() => null);
			if (!info) break;
			if (info.isSymbolicLink()) throw new TaskWorkspaceError("invalid_path", "路径包含符号链接");
		}
		return target;
	}

	private async recordRead(relative: string, content: string): Promise<void> {
		await mkdir(this.hostDir, { recursive: true, mode: 0o700 });
		await appendFile(this.evidenceFile, `${JSON.stringify({ at: new Date().toISOString(), path: relative, hash: sha(content) })}\n`, { mode: 0o600 });
	}

	async read(relative: string): Promise<{ path: string; content: string; size: number; hash: string }> {
		const target = await this.resolve(relative, "read");
		const info = await lstat(target).catch(() => null);
		if (!info?.isFile()) throw new TaskWorkspaceError("not_found", "文件不存在");
		if (info.size > MAX_READ_BYTES) throw new TaskWorkspaceError("too_large", "文件超过 2 MiB，无法读取");
		const content = await readFile(target, "utf8");
		await this.recordRead(relative, content);
		return { path: relative, content, size: info.size, hash: sha(content) };
	}

	async list(relative = "."): Promise<Array<{ name: string; type: "file" | "directory"; size?: number }>> {
		const target = await this.resolve(relative, "read");
		const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
		if (!entries) throw new TaskWorkspaceError("not_found", "目录不存在");
		return entries.filter((entry) => !entry.name.startsWith(".")).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
			.slice(0, MAX_LIST_ENTRIES)
			.map((entry) => entry.isDirectory() ? { name: entry.name, type: "directory" as const } : { name: entry.name, type: "file" as const });
	}

	async write(relative: string, content: string): Promise<{ path: string; size: number; hash: string }> {
		const target = await this.resolve(relative, "write");
		const bytes = Buffer.from(content, "utf8");
		if (bytes.length > TASK_MAX_FILE_BYTES) throw new TaskWorkspaceError("too_large", "候选文件超过 2 MiB");
		await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await writeFile(target, bytes, { mode: 0o644 });
		return { path: relative, size: bytes.length, hash: sha(bytes) };
	}

	async edit(relative: string, find: string, replace: string): Promise<{ path: string; size: number; hash: string }> {
		if (!find) throw new TaskWorkspaceError("invalid_input", "old_text 不能为空");
		const current = await this.read(relative);
		const first = current.content.indexOf(find);
		if (first < 0) throw new TaskWorkspaceError("invalid_input", "old_text 未在文件中找到");
		if (current.content.indexOf(find, first + find.length) >= 0) throw new TaskWorkspaceError("invalid_input", "old_text 在文件中出现多次，请提供更长的唯一片段");
		return this.write(relative, `${current.content.slice(0, first)}${replace}${current.content.slice(first + find.length)}`);
	}

	async find(pattern: string): Promise<Array<{ path: string; size: number }>> {
		if (!pattern || pattern.includes("\0")) throw new TaskWorkspaceError("invalid_input", "pattern 无效");
		const files = await this.walk(this.library, "");
		const needle = pattern.toLowerCase();
		return files.filter((file) => file.path.toLowerCase().includes(needle)).slice(0, TASK_MAX_PAGES);
	}

	async grep(query: string, relative = "library"): Promise<Array<{ path: string; line: number; text: string }>> {
		if (!query || query.includes("\0")) throw new TaskWorkspaceError("invalid_input", "query 无效");
		const target = await this.resolve(relative, "read");
		const info = await lstat(target).catch(() => null);
		const files = info?.isDirectory() ? await this.walk(target, path.relative(this.library, target)) : [{ path: path.relative(this.library, target), absolute: target, size: 0 }];
		const matches: Array<{ path: string; line: number; text: string }> = [];
		for (const file of files) {
			if (!file.path.endsWith(".md") || matches.length >= MAX_GREP_MATCHES) continue;
			const content = await readFile(file.absolute, "utf8").catch(() => "");
			for (const [index, line] of content.split("\n").entries()) {
				if (!line.includes(query)) continue;
				matches.push({ path: file.path, line: index + 1, text: line.slice(0, 240) });
				if (matches.length >= MAX_GREP_MATCHES) break;
			}
		}
		return matches;
	}

	/** 提交时扫描 library：只收 Markdown，拒绝符号链接，执行首版容量上限。 */
	async scanPages(): Promise<TaskPage[]> {
		const target = await this.resolve("library", "read");
		const files = await this.walk(target, "");
		const pages: TaskPage[] = [];
		let total = 0;
		for (const file of files) {
			if (!file.path.endsWith(".md")) continue;
			const bytes = await readFile(file.absolute);
			if (bytes.length > TASK_MAX_FILE_BYTES) throw new TaskWorkspaceError("too_large", `候选文件超过 2 MiB：${file.path}`);
			total += bytes.length;
			if (total > TASK_MAX_TOTAL_BYTES) throw new TaskWorkspaceError("too_large", "候选总量超过 8 MiB");
			pages.push({ path: file.path, content: bytes.toString("utf8"), size: bytes.length });
			if (pages.length > TASK_MAX_PAGES) throw new TaskWorkspaceError("too_large", `候选页数超过 ${TASK_MAX_PAGES}`);
		}
		return pages.sort((a, b) => a.path.localeCompare(b.path));
	}

	async evidence(): Promise<Array<{ at: string; path: string; hash: string }>> {
		const raw = await readFile(this.evidenceFile, "utf8").catch(() => "");
		return raw.split("\n").filter(Boolean).flatMap((line) => {
			try { const value = JSON.parse(line) as { at?: unknown; path?: unknown; hash?: unknown };
				return typeof value.at === "string" && typeof value.path === "string" && typeof value.hash === "string" ? [{ at: value.at, path: value.path, hash: value.hash }] : [];
			} catch { return []; }
		});
	}

	private async walk(dir: string, prefix: string): Promise<Array<{ path: string; absolute: string; size: number }>> {
		const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const files: Array<{ path: string; absolute: string; size: number }> = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new TaskWorkspaceError("invalid_path", `候选区包含符号链接：${relative}`);
			if (entry.isDirectory()) { files.push(...await this.walk(absolute, relative)); continue; }
			const info = await lstat(absolute).catch(() => null);
			if (info?.isFile()) files.push({ path: relative, absolute, size: info.size });
		}
		return files;
	}
}
