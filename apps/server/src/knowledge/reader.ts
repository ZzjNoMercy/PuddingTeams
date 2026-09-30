import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";

const MAX_TREE_ITEMS = 10_000;
const MAX_DEPTH = 32;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const ignoredDirectories = new Set([".git", ".pudding", ".puddingclaw", "node_modules"]);

export interface KnowledgeTreeNode {
	path: string;
	name: string;
	type: "directory" | "note";
	children?: KnowledgeTreeNode[];
}

export class KnowledgeReadError extends Error {
	constructor(readonly code: "invalid_path" | "not_found" | "too_large" | "root_changed", message: string) {
		super(message);
	}
}

function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function checkedRoot(binding: KnowledgeBinding): Promise<string> {
	const root = binding.contentRoot;
	const [actual, info, bindingInfo] = await Promise.all([
		realpath(root).catch(() => ""),
		stat(root).catch(() => null),
		stat(binding.canonicalBindingRoot).catch(() => null),
	]);
	if (actual !== root || !info?.isDirectory() || !bindingInfo ||
		`${bindingInfo.dev}:${bindingInfo.ino}` !== binding.rootIdentity ||
		!within(binding.canonicalBindingRoot, root)) {
		throw new KnowledgeReadError("root_changed", "知识库目录已变化，请重新核对绑定");
	}
	return root;
}

export async function listKnowledgeTree(binding: KnowledgeBinding): Promise<KnowledgeTreeNode[]> {
	const root = await checkedRoot(binding);
	let items = 0;
	const walk = async (absolute: string, relative: string, depth: number): Promise<KnowledgeTreeNode[]> => {
		if (depth > MAX_DEPTH) throw new KnowledgeReadError("too_large", "知识库目录层级超过上限");
		const children: KnowledgeTreeNode[] = [];
		for (const entry of await readdir(absolute, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name) || entry.isSymbolicLink()) continue;
			const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
			const nextAbsolute = path.join(absolute, entry.name);
			const info = await lstat(nextAbsolute).catch(() => null);
			if (!info || info.isSymbolicLink()) continue;
			if (info.isDirectory()) {
				const nested = await walk(nextAbsolute, nextRelative, depth + 1);
				if (nested.length) children.push({ path: nextRelative, name: entry.name, type: "directory", children: nested });
			} else if (info.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				if (++items > MAX_TREE_ITEMS) throw new KnowledgeReadError("too_large", "知识库笔记数超过上限");
				children.push({ path: nextRelative, name: entry.name, type: "note" });
			}
		}
		return children.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, "zh-CN") : a.type === "directory" ? -1 : 1);
	};
	const tree = await walk(root, "", 0);
	await checkedRoot(binding);
	return tree;
}

export async function readKnowledgeNote(binding: KnowledgeBinding, relativePath: string): Promise<{ path: string; content: string; size: number }> {
	const root = await checkedRoot(binding);
	if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0") ||
		path.posix.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
		!relativePath.toLowerCase().endsWith(".md")) {
		throw new KnowledgeReadError("invalid_path", "只能读取库内 Markdown 笔记");
	}
	let current = root;
	const parts = relativePath.split("/");
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const info = await lstat(current).catch(() => null);
		if (!info || info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
			throw new KnowledgeReadError("not_found", "笔记不存在或路径不可读取");
		}
	}
	if (!within(root, current) || await realpath(current) !== current) throw new KnowledgeReadError("invalid_path", "笔记路径越界");
	const handle = await open(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
		throw new KnowledgeReadError("not_found", "笔记不存在或路径不可读取");
	});
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new KnowledgeReadError("not_found", "笔记不是普通文件");
		if (before.size > MAX_NOTE_BYTES) throw new KnowledgeReadError("too_large", "笔记超过 2 MiB 阅读上限");
		const buffer = Buffer.alloc(before.size + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_NOTE_BYTES) throw new KnowledgeReadError("too_large", "笔记超过 2 MiB 阅读上限");
		const after = await handle.stat();
		if (after.dev !== before.dev || after.ino !== before.ino || after.size !== bytesRead ||
			await realpath(current).catch(() => "") !== current) {
			throw new KnowledgeReadError("root_changed", "笔记读取期间已变化，请重试");
		}
		await checkedRoot(binding);
		return { path: relativePath, content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)), size: bytesRead };
	} finally {
		await handle.close();
	}
}
