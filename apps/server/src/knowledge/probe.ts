import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import path from "node:path";

/**
 * 文件实体身份：inode + 创建时间。回答「这是不是当初那个实体」，必须在
 * 卷重新挂载、系统重启后保持稳定——st_dev 在 macOS 上是挂载时分配的，
 * 重启/系统更新后会漂移，不能参与持久身份。APFS 的 inode 单调分配且跨
 * 重启稳定；birthtime 在实体生命周期内不变，删除重建必然不同，也覆盖
 * 会回收 inode 的文件系统（如 ext4）。
 */
export function fileEntityIdentity(info: Stats): string {
	return `${info.ino}:${Math.round(info.birthtimeMs)}`;
}

export interface KnowledgeRootProbe {
	canonicalRoot: string;
	rootIdentity: string;
	profile: "markdown" | "managed-wiki";
	contentRoot: string;
	readable: boolean;
	markers: Record<"wiki" | "raw" | "sourceManifest" | "schema" | "log" | "staging", boolean>;
	capabilities: { read: boolean; layoutReady: boolean; structuredPrepare: false; publish: false };
	diagnostics: string[];
}

/** Read-only capability inventory. A marker is never treated as publishing authorization. */
export async function probeKnowledgeRoot(rootPath: string): Promise<KnowledgeRootProbe> {
	if (!path.isAbsolute(rootPath)) throw new Error("knowledge root must be an absolute server path");
	const canonicalRoot = await realpath(rootPath);
	const rootStat = await stat(canonicalRoot);
	if (!rootStat.isDirectory()) throw new Error("knowledge root is not a directory");
	const rootIdentity = fileEntityIdentity(rootStat);
	const rootReadable = await access(canonicalRoot, fsConstants.R_OK | fsConstants.X_OK).then(() => true, () => false);
	const entries = {
		wiki: ["wiki", "directory"], raw: ["raw", "directory"],
		sourceManifest: ["raw/manifest.jsonl", "file"], schema: ["wiki.schema.json", "file"],
		log: ["wiki/log.md", "file"], staging: [".puddingclaw/staging", "directory"],
	} as const;
	const markers = {} as KnowledgeRootProbe["markers"];
	for (const [name, [relative, kind]] of Object.entries(entries) as Array<[keyof typeof entries, readonly [string, "directory" | "file"]]>) {
		const parts = relative.split("/");
		let current = canonicalRoot;
		let valid = true;
		for (const [index, part] of parts.entries()) {
			current = path.join(current, part);
			const info = await lstat(current).catch(() => null);
			if (!info || info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) { valid = false; break; }
			if (index === parts.length - 1) valid = kind === "directory" ? info.isDirectory() : info.isFile();
		}
		markers[name] = valid;
	}
	const profile = markers.wiki && markers.raw ? "managed-wiki" : "markdown";
	const contentRoot = profile === "managed-wiki" ? path.join(canonicalRoot, "wiki") : canonicalRoot;
	const readable = rootReadable && await access(contentRoot, fsConstants.R_OK | fsConstants.X_OK).then(() => true, () => false);
	const diagnostics: string[] = [];
	if (!readable) diagnostics.push("root_unreadable");
	if (profile === "managed-wiki") {
		for (const name of ["schema", "log"] as const) {
			if (!markers[name]) diagnostics.push(`missing_${name}`);
		}
	}
	// Publishing remains disabled until source matching, schema and staging rules are verified on a copy.
	return {
		canonicalRoot, rootIdentity, profile, contentRoot, readable, markers,
		capabilities: {
			read: readable,
			layoutReady: readable && profile === "managed-wiki" && markers.schema && markers.log,
			structuredPrepare: false,
			publish: false,
		},
		diagnostics,
	};
}
