import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

export class KnowledgeObjectError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "integrity_error", message: string) {
		super(message);
	}
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** 内容寻址快照库：<root>/<hash前2位>/<hash>.md，写入后内容不可变。 */
export class KnowledgeObjectStore {
	constructor(private readonly rootDir: string) {}

	private targetFor(hash: string): string {
		if (!HASH_PATTERN.test(hash)) throw new KnowledgeObjectError("invalid_input", "快照哈希格式无效");
		return path.join(this.rootDir, hash.slice(0, 2), `${hash}.md`);
	}

	async put(content: Buffer, knownHash?: string): Promise<{ hash: string; path: string }> {
		const hash = knownHash !== undefined && HASH_PATTERN.test(knownHash) ? knownHash : createHash("sha256").update(content).digest("hex");
		const target = this.targetFor(hash);
		await mkdir(path.dirname(target), { recursive: true });
		try {
			const handle = await open(target, "wx", 0o600);
			try {
				await handle.writeFile(content);
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await readFile(target).catch(() => null);
			if (!existing || !existing.equals(content)) {
				throw new KnowledgeObjectError("integrity_error", "快照库存在同哈希不同内容的冲突");
			}
		}
		return { hash, path: target };
	}

	async get(hash: string): Promise<Buffer> {
		const target = this.targetFor(hash);
		const content = await readFile(target).catch(() => {
			throw new KnowledgeObjectError("not_found", "快照对象不存在");
		});
		if (createHash("sha256").update(content).digest("hex") !== hash) {
			throw new KnowledgeObjectError("integrity_error", "快照对象内容校验失败");
		}
		return content;
	}

	async has(hash: string): Promise<boolean> {
		try {
			await this.get(hash);
			return true;
		} catch {
			return false;
		}
	}
}
