import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { KnowledgeBinding } from "./contracts.js";

/** Explicit, bounded contract access. Never runs native context-file discovery. */
const contractCache = new Map<string, { mtimeMs: number; size: number; result: { content: string; hash: string } }>();

export async function readKnowledgeOperationContract(binding: KnowledgeBinding): Promise<{ content: string; hash: string } | null> {
	const file = path.join(binding.canonicalBindingRoot, "AGENTS.md");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
		.catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
	if (!handle) return null;
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024) throw new Error("知识库操作契约必须是小于64 KiB的普通文件");
		const cached = contractCache.get(file);
		if (cached && cached.mtimeMs === before.mtimeMs && cached.size === before.size) return cached.result;
		const bytes = Buffer.alloc(before.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const after = await handle.stat();
		if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("知识库操作契约读取期间已变化");
		const contentBytes = bytes.subarray(0, bytesRead);
		const result = { content: new TextDecoder("utf-8", { fatal: true }).decode(contentBytes), hash: createHash("sha256").update(contentBytes).digest("hex") };
		contractCache.set(file, { mtimeMs: before.mtimeMs, size: before.size, result });
		return result;
	} finally { await handle.close(); }
}
