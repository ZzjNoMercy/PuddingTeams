import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import { checkedKnowledgeRoot, withinKnowledgeRoot } from "./observation.js";
import { KnowledgeReadError } from "./reader.js";

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export class KnowledgeAssetError extends Error {
	constructor(readonly code: "invalid_input", message: string) {
		super(message);
	}
}

export const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
};

/** 读取库内授权图片：白名单扩展名、≤10MiB、不跟符号链接、rootIdentity 复核。 */
export async function readKnowledgeAsset(binding: KnowledgeBinding, relativePath: string): Promise<{ path: string; content: Buffer; contentType: string; size: number }> {
	const root = await checkedKnowledgeRoot(binding);
	const extension = path.posix.extname(relativePath).slice(1).toLowerCase();
	const contentType = IMAGE_CONTENT_TYPES[extension];
	if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0") ||
		path.posix.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
		throw new KnowledgeReadError("invalid_path", "资源路径非法");
	}
	if (!contentType) throw new KnowledgeAssetError("invalid_input", "仅支持 png/jpg/jpeg/gif/webp/svg/avif 图片资源");
	let current = root;
	const parts = relativePath.split("/");
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const info = await lstat(current).catch(() => null);
		if (!info || info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
			throw new KnowledgeReadError("not_found", "资源不存在或路径不可读取");
		}
	}
	if (!withinKnowledgeRoot(root, current) || await realpath(current) !== current) {
		throw new KnowledgeReadError("invalid_path", "资源路径越界");
	}
	const handle = await open(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
		throw new KnowledgeReadError("not_found", "资源不存在或路径不可读取");
	});
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new KnowledgeReadError("not_found", "资源不是普通文件");
		if (before.size > MAX_ASSET_BYTES) throw new KnowledgeReadError("too_large", "图片超过 10 MiB 上限");
		const buffer = Buffer.alloc(before.size + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_ASSET_BYTES) throw new KnowledgeReadError("too_large", "图片超过 10 MiB 上限");
		const after = await handle.stat();
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytesRead ||
			await realpath(current).catch(() => "") !== current) {
			throw new KnowledgeReadError("root_changed", "资源读取期间已变化，请重试");
		}
		await checkedKnowledgeRoot(binding);
		return { path: relativePath, content: buffer.subarray(0, bytesRead), contentType, size: bytesRead };
	} finally {
		await handle.close();
	}
}
