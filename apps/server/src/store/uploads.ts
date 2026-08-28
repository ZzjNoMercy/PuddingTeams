import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;

export interface UploadInput {
	filename: string;
	mediaType?: string;
	data: string;
}

export interface StoredUpload {
	name: string;
	path: string;
	mediaType: string;
	size: number;
	base64: string;
}

function safeName(value: string): string {
	const base = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "_").trim();
	return (base || "attachment").slice(0, 180);
}

function mediaTypeFor(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return ({
		".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
		".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
		".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
		".csv": "text/csv", ".ts": "text/plain", ".tsx": "text/plain", ".js": "text/plain",
	} as Record<string, string>)[ext] ?? "application/octet-stream";
}

interface PreparedUpload {
	name: string;
	mediaType: string;
	buffer: Buffer;
}

export interface LocalFileFreezeInput {
	path: string;
	/** Optional identity captured by the authorization/preflight step. */
	dev?: number | bigint;
	ino?: number | bigint;
}

/** Browser attachments become immutable, platform-owned files for one Session. */
export class UploadStore {
	private readonly root: string;

	constructor(uploadsDir: string) {
		this.root = uploadsDir;
	}

	async init(): Promise<void> {
		await mkdir(this.root, { recursive: true });
	}

	async save(sessionId: string, inputs: UploadInput[]): Promise<StoredUpload[]> {
		return this.saveWithLocalFiles(sessionId, inputs, []);
	}

	/** Freeze browser payloads and host-local files in one quota-checked transaction. */
	async saveWithLocalFiles(sessionId: string, inputs: UploadInput[], localFiles: Array<string | LocalFileFreezeInput>): Promise<StoredUpload[]> {
		if (inputs.length + localFiles.length > MAX_FILES) throw new Error(`单次最多上传 ${MAX_FILES} 个附件`);
		const prepared: PreparedUpload[] = inputs.map((input) => {
			if (!input || typeof input.filename !== "string" || typeof input.data !== "string") {
				throw new Error("附件格式无效");
			}
			const buffer = Buffer.from(input.data, "base64");
			if (buffer.length === 0) throw new Error(`附件「${input.filename}」为空`);
			if (buffer.length > MAX_FILE_BYTES) throw new Error(`附件「${input.filename}」超过 8MB`);
			return { buffer, name: safeName(input.filename), mediaType: input.mediaType?.trim() || "application/octet-stream" };
		});
		for (const localFile of localFiles) {
			const source = typeof localFile === "string" ? localFile : localFile.path;
			if (!path.isAbsolute(source) || source.includes("\0")) throw new Error("会话附件源路径必须是绝对路径");
			const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
			const handle = await open(source, flags).catch((error: unknown) => {
				throw new Error(`无法冻结外部文件「${source}」：${error instanceof Error ? error.message : String(error)}`);
			});
			try {
				const info = await handle.stat();
				if (!info.isFile()) throw new Error(`外部路径不是普通文件：${source}`);
				if (typeof localFile !== "string") {
					if (localFile.dev !== undefined && BigInt(info.dev) !== BigInt(localFile.dev)) throw new Error(`外部文件身份在冻结前发生变化：${source}`);
					if (localFile.ino !== undefined && BigInt(info.ino) !== BigInt(localFile.ino)) throw new Error(`外部文件身份在冻结前发生变化：${source}`);
				}
				if (info.size === 0) throw new Error(`外部文件为空：${source}`);
				if (info.size > MAX_FILE_BYTES) throw new Error(`外部文件「${path.basename(source)}」超过 8MB`);
				const buffer = await handle.readFile();
				if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) throw new Error(`外部文件大小在冻结期间发生变化：${source}`);
				const after = await handle.stat();
				if (after.dev !== info.dev || after.ino !== info.ino || after.size !== buffer.length) throw new Error(`外部文件身份在冻结期间发生变化：${source}`);
				prepared.push({ name: safeName(source), mediaType: mediaTypeFor(source), buffer });
			} finally {
				await handle.close();
			}
		}
		const total = prepared.reduce((sum, item) => sum + item.buffer.length, 0);
		if (total > MAX_TOTAL_BYTES) throw new Error("附件总大小超过 20MB");
		const directory = path.join(this.root, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
		await mkdir(directory, { recursive: true });
		const stored: StoredUpload[] = [];
		for (const item of prepared) {
			const target = path.join(directory, `${randomUUID()}-${item.name}`);
			await writeFile(target, item.buffer, { flag: "wx", mode: 0o600 });
			stored.push({
				name: item.name,
				path: target,
				mediaType: item.mediaType,
				size: item.buffer.length,
				base64: item.buffer.toString("base64"),
			});
		}
		return stored;
	}
}
