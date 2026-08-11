import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
		if (inputs.length > MAX_FILES) throw new Error(`单次最多上传 ${MAX_FILES} 个附件`);
		const prepared = inputs.map((input) => {
			if (!input || typeof input.filename !== "string" || typeof input.data !== "string") {
				throw new Error("附件格式无效");
			}
			const buffer = Buffer.from(input.data, "base64");
			if (buffer.length === 0) throw new Error(`附件「${input.filename}」为空`);
			if (buffer.length > MAX_FILE_BYTES) throw new Error(`附件「${input.filename}」超过 8MB`);
			return { input, buffer, name: safeName(input.filename) };
		});
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
				mediaType: item.input.mediaType?.trim() || "application/octet-stream",
				size: item.buffer.length,
				base64: item.input.data,
			});
		}
		return stored;
	}
}
