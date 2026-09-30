import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

/** 交付物登记记录（§15.6）：push / observe 两种来源登记后无差别。 */
export interface ArtifactRecord {
	id: string;
	name: string;
	/** 本地源文件的规范路径，仅用于来源追溯；下载读取 snapshotPath。 */
	path: string;
	/** 登记瞬间冻结的只读副本；下载永远读取它，不受 workspace 后续修改影响。 */
	snapshotPath: string;
	/** 冻结副本的 SHA-256。 */
	contentHash: string;
	kind?: string;
	size?: number;
	/** agent 主动导出（push）/ Driver 观察收集（observe，Phase 7）。 */
	origin: "push" | "observe";
	/** 产出者 agentId。 */
	producer: string;
	delegationId: string;
	windowId: string;
	workspaceId?: string;
	cwdSnapshot: string;
	createdAt: string;
}

export type ArtifactInput = Omit<ArtifactRecord, "id" | "createdAt" | "snapshotPath" | "contentHash" | "size">;

export class ArtifactIntegrityError extends Error {
	constructor() {
		super("交付物冻结快照与登记哈希不一致，无法打开");
		this.name = "ArtifactIntegrityError";
	}
}

interface ArtifactsFile {
	version: number;
	artifacts: Record<string, ArtifactRecord>;
}

/**
 * ArtifactStore：交付物的登记与查询（§15.6）。只登记、不扫描 workspace
 * 猜测交付物；没有 --export 产物的 Run 不会在这里留下任何记录。
 * 登记表持久化为 stateDir 下 artifacts.json，冻结副本（blob）放独立的
 * blobsDir；写路径与 DelegationStore 一致（进程内互斥 + tmp 原子 rename）。
 */
export class ArtifactStore {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly file: string;
	private readonly downloadsDir: string;
	/** artifact.created 事件订阅方（index.ts 挂到 manager session 通知通道）。 */
	private listeners = new Set<(record: ArtifactRecord) => void>();

	constructor(
		private readonly stateDir: string,
		private readonly blobsDir: string,
	) {
		this.file = path.join(stateDir, "artifacts.json");
		this.downloadsDir = path.join(blobsDir, ".downloads");
	}

	async init(): Promise<void> {
		await mkdir(this.blobsDir, { recursive: true });
		// The Home lease is acquired before init; no live backend can own these
		// request copies after a restart.
		await rm(this.downloadsDir, { recursive: true, force: true });
		await mkdir(this.downloadsDir, { recursive: true, mode: 0o700 });
	}

	/** 订阅 artifact.created；返回退订函数。 */
	onCreated(fn: (record: ArtifactRecord) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emitCreated(record: ArtifactRecord): void {
		for (const fn of this.listeners) {
			try {
				fn(record);
			} catch {
				// 监听器异常不影响登记主流程。
			}
		}
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async load(): Promise<Record<string, ArtifactRecord>> {
		try {
			const raw = await readFile(this.file, "utf-8");
			const parsed = JSON.parse(raw) as Partial<ArtifactsFile>;
			return parsed.artifacts ?? {};
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return {};
		}
	}

	private async write(all: Record<string, ArtifactRecord>): Promise<void> {
		await mkdir(this.stateDir, { recursive: true });
		const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify({ version: 1, artifacts: all }, null, 2) + "\n", "utf-8");
		await rename(tmp, this.file);
	}

	/** 登记一个交付物（push/observe 无差别）。大小和哈希都以冻结副本为准。 */
	async register(input: ArtifactInput): Promise<ArtifactRecord> {
		const root = await realpath(input.cwdSnapshot);
		if (root !== input.cwdSnapshot) throw new Error("cwdSnapshot identity changed");
		const target = await realpath(input.path);
		const relative = path.relative(root, target);
		if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
			throw new Error("artifact is outside delegation cwdSnapshot");
		}
		const info = await stat(target);
		if (!info.isFile()) throw new Error("artifact is not a file");
		const id = randomUUID();
		const snapshotPath = path.join(await realpath(this.blobsDir), id);
		let sourceHandle;
		try {
			sourceHandle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			const [currentRoot, currentTarget, pathInfo, fdInfo] = await Promise.all([
				realpath(input.cwdSnapshot), realpath(target), stat(target), sourceHandle.stat(),
			]);
			if (currentRoot !== root || currentTarget !== target || !fdInfo.isFile() || pathInfo.dev !== fdInfo.dev || pathInfo.ino !== fdInfo.ino) {
				throw new Error("artifact source identity changed before capture");
			}
			const hash = createHash("sha256");
			let size = 0;
			const source = sourceHandle.createReadStream({ autoClose: true });
			source.on("data", (chunk: string | Buffer) => { hash.update(chunk); size += Buffer.byteLength(chunk); });
			await pipeline(source, createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }));
			await chmod(snapshotPath, 0o444);
			const record: ArtifactRecord = {
				...input,
				path: target,
				snapshotPath,
				contentHash: hash.digest("hex"),
				size,
				id,
				createdAt: new Date().toISOString(),
			};
			await this.serialize(async () => {
				const all = await this.load();
				all[record.id] = record;
				await this.write(all);
			});
			this.emitCreated(record);
			return record;
		} catch (error) {
			await rm(snapshotPath, { force: true }).catch(() => undefined);
			throw error;
		} finally {
			await sourceHandle?.close().catch(() => undefined);
		}
	}

	async get(id: string): Promise<ArtifactRecord | undefined> {
		return (await this.load())[id];
	}

	private async copyVerifiedSnapshot(record: ArtifactRecord, destination: string): Promise<void> {
		const resolved = path.resolve(record.snapshotPath);
		let handle;
		try {
			handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
			const [blobRoot, real, pathInfo, fdInfo] = await Promise.all([
				realpath(this.blobsDir), realpath(resolved), stat(resolved), handle.stat(),
			]);
			const relative = path.relative(blobRoot, real);
			if (real !== record.snapshotPath || relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("artifact snapshot path rejected");
			if (!fdInfo.isFile() || pathInfo.dev !== fdInfo.dev || pathInfo.ino !== fdInfo.ino) throw new Error("artifact snapshot is not stable");
			const hash = createHash("sha256");
			const source = handle.createReadStream({ autoClose: true });
			source.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
			await pipeline(source, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
			if (hash.digest("hex") !== record.contentHash) throw new ArtifactIntegrityError();
		} catch (error) {
			await rm(destination, { force: true }).catch(() => undefined);
			throw error;
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	/** A unique verified copy keeps download bytes stable after the hash check. */
	async prepareDownload(id: string): Promise<{ record: ArtifactRecord; filePath: string; cleanup: () => Promise<void> } | undefined> {
		const record = await this.get(id);
		if (!record) return undefined;
		const directory = await mkdtemp(path.join(this.downloadsDir, "request-"));
		const filePath = path.join(directory, "content");
		try {
			await this.copyVerifiedSnapshot(record, filePath);
		} catch (error) {
			await rm(directory, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
		return { record, filePath, cleanup: () => rm(directory, { recursive: true, force: true }) };
	}

	/**
	 * Materialize a named, read-only copy for the operating system's default app.
	 * Blob names are opaque UUIDs, so opening the blob directly would lose the
	 * file extension that Excel/Preview/etc. use for application dispatch.
	 */
	async materializeForOpen(id: string): Promise<string | undefined> {
		const record = await this.get(id);
		if (!record) return undefined;
		const safeName = path.basename(record.name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_") || `artifact-${id}`;
		const directory = path.join(this.blobsDir, "open", id);
		await mkdir(directory, { recursive: true });
		const target = path.join(directory, safeName);
		const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
		try {
			await this.copyVerifiedSnapshot(record, temporary);
			await chmod(temporary, 0o444).catch(() => undefined);
			await rm(target, { force: true });
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
		return target;
	}

	async list(filter: { windowId?: string; delegationId?: string } = {}): Promise<ArtifactRecord[]> {
		const all = await this.load();
		return Object.values(all)
			.filter((a) => (!filter.windowId || a.windowId === filter.windowId) && (!filter.delegationId || a.delegationId === filter.delegationId))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
}
