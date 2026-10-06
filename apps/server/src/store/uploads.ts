import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
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
	sha256: string;
}

export interface UploadIdentity {
	name: string;
	mediaType: string;
	size: number;
	sha256: string;
}

export interface FirstMessagePathReference {
	token: string;
	/** Missing sources under the Workspace may have been external symlinks. */
	required: boolean;
}

export function identifyUploads(inputs: UploadInput[]): UploadIdentity[] {
	if (!Array.isArray(inputs) || inputs.length > MAX_FILES) throw new Error(`单次最多上传 ${MAX_FILES} 个附件`);
	let total = 0;
	return inputs.map((input) => {
		if (!input || typeof input.filename !== "string" || typeof input.data !== "string" ||
			(input.mediaType !== undefined && typeof input.mediaType !== "string") ||
			(typeof input.mediaType === "string" && (input.mediaType.length > 255 || /[\u0000-\u001f\u007f]/.test(input.mediaType))) ||
			!/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) {
			throw new Error("附件格式无效");
		}
		const buffer = Buffer.from(input.data, "base64");
		if (buffer.length === 0) throw new Error(`附件「${input.filename}」为空`);
		if (buffer.length > MAX_FILE_BYTES) throw new Error(`附件「${input.filename}」超过 8MB`);
		total += buffer.length;
		if (total > MAX_TOTAL_BYTES) throw new Error("附件总大小超过 20MB");
		return {
			name: safeName(input.filename), mediaType: input.mediaType?.trim() || "application/octet-stream",
			size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"),
		};
	});
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
	async saveWithLocalFiles(sessionId: string, inputs: UploadInput[], localFiles: Array<string | LocalFileFreezeInput>, firstWorkFreezeId?: string): Promise<StoredUpload[]> {
		if (firstWorkFreezeId !== undefined && !/^[a-f0-9]{64}$/.test(firstWorkFreezeId)) throw new Error("首次工作附件冻结身份无效");
		if (inputs.length + localFiles.length > MAX_FILES) throw new Error(`单次最多上传 ${MAX_FILES} 个附件`);
		const identities = identifyUploads(inputs);
		const prepared: PreparedUpload[] = inputs.map((input, index) => ({
			buffer: Buffer.from(input.data, "base64"), name: identities[index]!.name, mediaType: identities[index]!.mediaType, sha256: identities[index]!.sha256,
		}));
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
				prepared.push({ name: safeName(source), mediaType: mediaTypeFor(source), buffer, sha256: createHash("sha256").update(buffer).digest("hex") });
			} finally {
				await handle.close();
			}
		}
		const total = prepared.reduce((sum, item) => sum + item.buffer.length, 0);
		if (total > MAX_TOTAL_BYTES) throw new Error("附件总大小超过 20MB");
		const directory = path.join(this.root, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
		await mkdir(directory, { recursive: true });
		const stored: StoredUpload[] = [];
		try {
			for (const item of prepared) {
				const target = path.join(directory, `${firstWorkFreezeId ? `firstwork-${firstWorkFreezeId}-` : ""}${randomUUID()}-${item.sha256}-${item.name}`);
				try { await writeFile(target, item.buffer, { flag: "wx", mode: 0o600 }); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(target).catch(() => undefined);
					throw error;
				}
				stored.push({
					name: item.name,
					path: target,
					mediaType: item.mediaType,
					size: item.buffer.length,
					base64: item.buffer.toString("base64"),
				});
			}
		} catch (error) {
			await this.discard(sessionId, stored).catch(() => undefined);
			throw error;
		}
		return stored;
	}

	/** Remove only files frozen by this failed send; unrelated Session files remain intact. */
	async discard(sessionId: string, uploads: StoredUpload[]): Promise<void> {
		const directory = path.join(this.root, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
		for (const item of uploads) {
			if (path.dirname(item.path) !== directory || !path.basename(item.path).endsWith(`-${item.name}`)) {
				throw new Error("不能清理非本次 Session 的附件");
			}
			await unlink(item.path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	/** Call only after the reserved Session is idle and still has no message. */
	async discardUnacceptedFirstWork(sessionId: string, firstWorkFreezeId: string): Promise<number> {
		if (!/^[a-f0-9]{64}$/.test(firstWorkFreezeId)) throw new Error("首次工作附件冻结身份无效");
		const directory = path.join(this.root, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
		let entries: string[];
		try { entries = await readdir(directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		const prefix = `firstwork-${firstWorkFreezeId}-`;
		let removed = 0;
		for (const entry of entries) {
			if (!entry.startsWith(prefix) || !/^firstwork-[a-f0-9]{64}-[a-f0-9-]{36}-[a-f0-9]{64}-.+$/.test(entry)) continue;
			await unlink(path.join(directory, entry));
			removed++;
		}
		return removed;
	}

	/** Verify a recovered first user entry against the files frozen for this Session. */
	async matchesFirstMessage(sessionId: string, message: string, content: string, identities: UploadIdentity[], references: FirstMessagePathReference[] = []): Promise<boolean> {
		if (!identities.length && references.every((reference) => !reference.required) && message === content) return true;
		const marker = "\n\n用户附件（平台冻结路径，可按需读取并在委托任务中原样传递）：\n";
		const markerAt = message.lastIndexOf(marker);
		if (markerAt < 0) return false;
		const lines = message.slice(markerAt + marker.length).split("\n");
		if (lines.length < identities.length || lines.length > MAX_FILES || lines.length - identities.length > references.length) return false;
		const directory = path.join(this.root, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
		const externalPaths: string[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			const fields = /^- (.+) \((.+), ([0-9]+) bytes\): (.+)$/.exec(line);
			if (!fields) return false;
			const name = fields[1]!;
			const mediaType = fields[2]!;
			const sizeText = fields[3]!;
			const filePath = fields[4]!;
			const size = Number(sizeText);
			if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES || path.dirname(filePath) !== directory || !path.basename(filePath).endsWith(`-${name}`)) return false;
			const frozenName = path.basename(filePath).slice(0, -(`-${name}`).length);
			const frozenIdentity = /^(?:firstwork-[a-f0-9]{64}-)?[a-f0-9-]{36}-([a-f0-9]{64})$/.exec(frozenName);
			if (!frozenIdentity) return false;
			const item = identities[index];
			if (item && (name !== item.name || mediaType !== item.mediaType || size !== item.size)) return false;
			try {
				const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
				try {
					const info = await handle.stat();
					if (!info.isFile() || info.size !== size) return false;
					const bytes = await handle.readFile();
					if (bytes.length !== size) return false;
					const actualDigest = createHash("sha256").update(bytes).digest("hex");
					if (actualDigest !== frozenIdentity[1] || (item && actualDigest !== item.sha256)) return false;
				} finally { await handle.close(); }
			} catch { return false; }
			if (!item) externalPaths.push(filePath);
		}
		const body = message.slice(0, markerAt);
		const requiredSuffix = new Array<number>(references.length + 1).fill(0);
		for (let index = references.length - 1; index >= 0; index--) {
			requiredSuffix[index] = requiredSuffix[index + 1]! + (references[index]!.required ? 1 : 0);
		}
		const stack: Array<{ referenceIndex: number; pathIndex: number; selected: Array<{ token: string; path: string }> }> = [
			{ referenceIndex: 0, pathIndex: 0, selected: [] },
		];
		let examined = 0;
		while (stack.length && examined++ < 20_000) {
			const state = stack.pop()!;
			if (requiredSuffix[state.referenceIndex]! > externalPaths.length - state.pathIndex) continue;
			if (state.referenceIndex === references.length) {
				if (state.pathIndex !== externalPaths.length) continue;
				let reconstructed = content;
				for (const replacement of state.selected) reconstructed = reconstructed.split(replacement.token).join(replacement.path);
				if (reconstructed === body) return true;
				continue;
			}
			const reference = references[state.referenceIndex]!;
			if (!reference.required) stack.push({ ...state, referenceIndex: state.referenceIndex + 1 });
			if (state.pathIndex < externalPaths.length) stack.push({
				referenceIndex: state.referenceIndex + 1, pathIndex: state.pathIndex + 1,
				selected: [...state.selected, { token: reference.token, path: externalPaths[state.pathIndex]! }],
			});
		}
		return false;
	}
}
