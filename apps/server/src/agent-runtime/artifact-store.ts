import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 交付物登记记录（§15.6）：push / observe 两种来源登记后无差别。 */
export interface ArtifactRecord {
	id: string;
	name: string;
	/** 本地绝对路径（登记时解析）；content 下载只读这个登记路径本身。 */
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

export type ArtifactInput = Omit<ArtifactRecord, "id" | "createdAt" | "snapshotPath" | "contentHash">;

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
	/** artifact.created 事件订阅方（index.ts 挂到 manager session 通知通道）。 */
	private listeners = new Set<(record: ArtifactRecord) => void>();

	constructor(
		private readonly stateDir: string,
		private readonly blobsDir: string,
	) {
		this.file = path.join(stateDir, "artifacts.json");
	}

	async init(): Promise<void> {
		await mkdir(this.blobsDir, { recursive: true });
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

	/** 登记一个交付物（push/observe 无差别）。size 缺省时尽力 stat 补齐。 */
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
		await copyFile(target, snapshotPath);
		const snapshotInfo = await stat(snapshotPath);
		const contentHash = await new Promise<string>((resolve, reject) => {
			const hash = createHash("sha256");
			const stream = createReadStream(snapshotPath);
			stream.on("data", (chunk) => hash.update(chunk));
			stream.on("error", reject);
			stream.on("end", () => resolve(hash.digest("hex")));
		});
		const size = input.size ?? snapshotInfo.size;
		const record: ArtifactRecord = {
			...input,
			path: target,
			snapshotPath,
			contentHash,
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
	}

	async get(id: string): Promise<ArtifactRecord | undefined> {
		return (await this.load())[id];
	}

	async list(filter: { windowId?: string; delegationId?: string } = {}): Promise<ArtifactRecord[]> {
		const all = await this.load();
		return Object.values(all)
			.filter((a) => (!filter.windowId || a.windowId === filter.windowId) && (!filter.delegationId || a.delegationId === filter.delegationId))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
}
