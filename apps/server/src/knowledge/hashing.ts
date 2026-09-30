import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

export const MAX_HASH_BYTES = 2 * 1024 * 1024;

export class KnowledgeHashError extends Error {
	constructor(readonly code: "too_large" | "not_found", message: string) {
		super(message);
	}
}

/** 流式 sha256；O_NOFOLLOW 拒符号链接，超过上限抛 too_large，读中变更抛 not_found 要求重试。 */
export async function hashFileSha256(absolutePath: string, maxBytes = MAX_HASH_BYTES): Promise<{ hash: string; size: number }> {
	const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
		throw new KnowledgeHashError("not_found", "文件不存在或不可读取");
	});
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new KnowledgeHashError("not_found", "目标不是普通文件");
		if (before.size > maxBytes) throw new KnowledgeHashError("too_large", "文件超过 2 MiB 哈希上限");
		const hash = createHash("sha256");
		let size = 0;
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			size += (chunk as Buffer).length;
			if (size > maxBytes) throw new KnowledgeHashError("too_large", "文件超过 2 MiB 哈希上限");
			hash.update(chunk as Buffer);
		}
		const after = await handle.stat();
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== size) {
			throw new KnowledgeHashError("not_found", "文件读取期间已变化，请重试");
		}
		return { hash: hash.digest("hex"), size };
	} finally {
		await handle.close();
	}
}

export function hashBufferSha256(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}
