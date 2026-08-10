import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceRecord {
	id: string;
	name: string;
	/** 用户选择的服务端绝对路径。 */
	rootPath: string;
	/** realpath 后的稳定去重身份。 */
	canonicalPath: string;
	/** 选择目录所属的 Git 仓库根；允许 rootPath 保留为仓库子目录。 */
	gitRoot?: string;
	managed: boolean;
	createdAt: string;
	lastOpenedAt: string;
}

export interface WorkspaceSummary extends WorkspaceRecord {
	available: boolean;
}

/** Whether a frozen path still resolves to the same readable directory identity. */
export async function isWorkspaceDirectoryAvailable(rootPath: string, canonicalPath: string): Promise<boolean> {
	const current = await realpath(rootPath).catch(() => undefined);
	if (!current || current !== canonicalPath) return false;
	const info = await stat(current).catch(() => undefined);
	if (!info?.isDirectory()) return false;
	return access(current, fsConstants.R_OK).then(
		() => true,
		() => false,
	);
}

interface WorkspacesFile {
	version: 1;
	workspaces: Record<string, WorkspaceRecord>;
}

/** 平台管理的项目身份。Window/Session/Delegation 只引用 workspaceId。 */
export class WorkspaceStore {
	private readonly file: string;
	private readonly managedRoot: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly teamsDir: string) {
		this.file = path.join(teamsDir, "workspaces.json");
		this.managedRoot = path.join(teamsDir, "workspaces");
	}

	async init(): Promise<void> {
		await mkdir(this.managedRoot, { recursive: true });
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async load(): Promise<WorkspacesFile> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<WorkspacesFile>;
			return { version: 1, workspaces: parsed.workspaces ?? {} };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { version: 1, workspaces: {} };
		}
	}

	private async write(data: WorkspacesFile): Promise<void> {
		await mkdir(this.teamsDir, { recursive: true });
		const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, this.file);
	}

	private static async validateDirectory(input: string): Promise<{ rootPath: string; canonicalPath: string }> {
		const rootPath = path.resolve(input.trim());
		if (!path.isAbsolute(input.trim())) throw new Error("项目路径必须是绝对路径");
		const info = await stat(rootPath).catch(() => undefined);
		if (!info?.isDirectory()) throw new Error("项目路径不存在或不是目录");
		await access(rootPath, fsConstants.R_OK);
		return { rootPath, canonicalPath: await realpath(rootPath) };
	}

	private static async findGitRoot(canonicalPath: string): Promise<string | undefined> {
		let current = canonicalPath;
		while (true) {
			const marker = await stat(path.join(current, ".git")).catch(() => undefined);
			if (marker) return current;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}

	async createFromPath(input: { path: string; name?: string }): Promise<WorkspaceRecord> {
		const { rootPath, canonicalPath } = await WorkspaceStore.validateDirectory(input.path);
		return this.serialize(async () => {
			const data = await this.load();
			const existing = Object.values(data.workspaces).find((w) => w.canonicalPath === canonicalPath);
			if (existing) {
				existing.lastOpenedAt = new Date().toISOString();
				if (input.name?.trim()) existing.name = input.name.trim();
				await this.write(data);
				return existing;
			}
			const now = new Date().toISOString();
			const record: WorkspaceRecord = {
				id: randomUUID(),
				name: input.name?.trim() || path.basename(rootPath) || rootPath,
				rootPath,
				canonicalPath,
				gitRoot: await WorkspaceStore.findGitRoot(canonicalPath),
				managed: false,
				createdAt: now,
				lastOpenedAt: now,
			};
			data.workspaces[record.id] = record;
			await this.write(data);
			return record;
		});
	}

	async createManaged(name = "临时项目"): Promise<WorkspaceRecord> {
		const id = randomUUID();
		const rootPath = path.join(this.managedRoot, id);
		await mkdir(rootPath, { recursive: true });
		const canonicalPath = await realpath(rootPath);
		const now = new Date().toISOString();
		const record: WorkspaceRecord = {
			id,
			name: name.trim() || "临时项目",
			rootPath,
			canonicalPath,
			managed: true,
			createdAt: now,
			lastOpenedAt: now,
		};
		await this.serialize(async () => {
			const data = await this.load();
			data.workspaces[id] = record;
			await this.write(data);
		});
		return record;
	}

	async get(id: string): Promise<WorkspaceRecord | undefined> {
		return (await this.load()).workspaces[id];
	}

	async require(id: string): Promise<WorkspaceRecord> {
		const workspace = await this.get(id);
		if (!workspace) throw new Error(`workspace not found: ${id}`);
		const current = await realpath(workspace.rootPath).catch(() => undefined);
		if (!current || current !== workspace.canonicalPath) {
			throw new Error(`项目路径已失效或身份已变化：${workspace.rootPath}`);
		}
		const info = await stat(current);
		if (!info.isDirectory()) throw new Error(`项目路径不是目录：${workspace.rootPath}`);
		await access(current, fsConstants.R_OK);
		return workspace;
	}

	async touch(id: string): Promise<WorkspaceRecord> {
		return this.serialize(async () => {
			const data = await this.load();
			const workspace = data.workspaces[id];
			if (!workspace) throw new Error(`workspace not found: ${id}`);
			workspace.lastOpenedAt = new Date().toISOString();
			await this.write(data);
			return workspace;
		});
	}

	async list(): Promise<WorkspaceSummary[]> {
		const data = await this.load();
		const summaries = await Promise.all(
			Object.values(data.workspaces).map(async (workspace) => ({
				...workspace,
				available: await isWorkspaceDirectoryAvailable(workspace.rootPath, workspace.canonicalPath),
			})),
		);
		return summaries.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
	}
}
