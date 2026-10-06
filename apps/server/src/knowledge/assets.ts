import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertImageAssetBytes } from "./image-publication.js";
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

export interface KnowledgeImageAsset { path: string; bytes: Buffer }

/** Write immutable images completely before exposing the final content-addressed filename. */
export async function persistKnowledgeImage(binding: KnowledgeBinding, asset: KnowledgeImageAsset): Promise<void> {
 assertImageAssetBytes(asset.path, asset.bytes);
 const root = await checkedKnowledgeRoot(binding);
 let directory = root;
 const directories: Array<{ path: string; dev: number; ino: number }> = [];
 const verifyDirectories = async () => {
  await checkedKnowledgeRoot(binding);
  for (const item of directories) {
   const current = await lstat(item.path);
   if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== item.dev || current.ino !== item.ino || await realpath(item.path) !== item.path) throw new KnowledgeReadError("root_changed", "图片保存目录已变化，请重试");
  }
 };
 for (const part of asset.path.split("/").slice(0, -1)) {
  await verifyDirectories();
  directory = path.join(directory, part);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new KnowledgeAssetError("invalid_input", "图片保存目录不可用");
  directories.push({ path: directory, dev: stat.dev, ino: stat.ino });
 }
 await verifyDirectories();
 const absolute = path.join(root, asset.path), temporary = path.join(directory, `.image-upload-${randomUUID()}.tmp`);
 const output = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
 const identity = await output.stat();
 try {
  // O_NOFOLLOW protects the leaf; additionally validate parents and the open inode before writing bytes.
  await verifyDirectories();
  const check = await lstat(temporary);
  if (check.isSymbolicLink() || check.ino !== identity.ino || check.dev !== identity.dev || await realpath(temporary) !== temporary) throw new KnowledgeReadError("root_changed", "图片保存位置已变化");
  await output.writeFile(asset.bytes); await output.sync();
  await verifyDirectories();
  const finalCheck = await lstat(temporary);
  if (finalCheck.ino !== identity.ino || finalCheck.dev !== identity.dev || finalCheck.nlink !== 1 || await realpath(temporary) !== temporary) throw new KnowledgeReadError("root_changed", "图片保存位置已变化");
  // Exclusive atomic publication: a crash can leave only an unreferenced temp, never a partial final image.
  await link(temporary, absolute).catch(error => { if (error.code !== "EEXIST") throw error; });
  await verifyDirectories();
  const stored = await readKnowledgeAsset(binding, asset.path);
  if (!stored.content.equals(asset.bytes)) throw new KnowledgeReadError("root_changed", "图片文件已发生变化，请重新选择图片");
 } finally {
  await output.close();
  const leftover = await lstat(temporary).catch(() => null);
  if (leftover?.ino === identity.ino && leftover.dev === identity.dev && await realpath(temporary).catch(() => "") === temporary) await unlink(temporary).catch(() => undefined);
 }
}
