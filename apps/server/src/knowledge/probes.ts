import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { probeKnowledgeRoot, type KnowledgeRootProbe } from "./probe.js";

export class KnowledgeProbeError extends Error {
	constructor(readonly code: "not_found" | "invalid_path", message: string) {
		super(message);
	}
}

export interface KnowledgeProbeRecord {
	probeId: string;
	ownerId: string;
	/** 规范化绝对根（realpath 之后）。 */
	canonicalBindingRoot: string;
	/** 目录尚不存在时无法锚定身份，为 null；apply 创建目录后重新计算。 */
	rootIdentity: string | null;
	/** intent=create 且目录不存在时为 false：仅表示"可创建"，不授予任何写入。 */
	targetExists: boolean;
	profile: "markdown" | "managed-wiki";
	contentRoot: string;
	linkRoot: string;
	/** 唯一候选时直接定值；双候选时留空，由 plan 阶段显式选择。 */
	obsidianRoot?: string;
	obsidianRootCandidates?: string[];
	markers: {
		hasWiki: boolean;
		hasRaw: boolean;
		hasManifest: boolean;
		hasSchema: boolean;
		hasObsidianRoot: boolean;
		hasObsidianWiki: boolean;
	};
	capabilities: KnowledgeRootProbe["capabilities"];
	warnings: string[];
	createdAt: string;
}

const PROBE_TTL_MS = 10 * 60 * 1000;

/** 家目录简写展开：仅处理 "~" 与 "~/..."（及 Windows 习惯的 "~\\..."），"~user" 形式不展开。 */
function expandHomePrefix(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homedir(), input.slice(2));
	return input;
}

async function hasObsidianDirectory(directory: string): Promise<boolean> {
	const info = await lstat(path.join(directory, ".obsidian")).catch(() => null);
	return Boolean(info && !info.isSymbolicLink() && info.isDirectory());
}

/**
 * 接入探测：内存驻留，TTL 10 分钟（懒清理）。probe 只读取目录元信息，
 * 不读取 contentRoot 之外的文件内容；路径不存在/不是目录/无权限/相对路径
 * 分级报错，绝不把不存在的目录当作空库。
 * 唯一例外：显式 intent=create 且目标不存在时，校验父目录可写后返回
 * targetExists:false 的"待创建"探测（不创建任何目录），由用户确认后才进入计划。
 */
export class KnowledgeProbeStore {
	private readonly records = new Map<string, { record: KnowledgeProbeRecord; expiresAt: number }>();

	constructor(private readonly ttlMs = PROBE_TTL_MS, private readonly now: () => number = () => Date.now()) {}

	async create(ownerId: string, inputPath: string, options?: { intent?: "bind" | "create" }): Promise<KnowledgeProbeRecord> {
		this.sweep();
		const trimmed = expandHomePrefix(inputPath.trim());
		if (!path.isAbsolute(trimmed)) {
			throw new KnowledgeProbeError("invalid_path", "请输入服务端机器上的绝对路径（支持 ~/ 开头的家目录简写）");
		}
		const canonicalRoot = await realpath(trimmed).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") {
				if (options?.intent === "create") return null;
				throw new KnowledgeProbeError("not_found", "目录不存在，请核对路径后重试");
			}
			throw new KnowledgeProbeError("invalid_path", "目录无法访问（可能无权限）");
		});
		if (canonicalRoot === null) return this.createForMissingTarget(ownerId, trimmed);
		const info = await stat(canonicalRoot).catch(() => null);
		if (!info?.isDirectory()) throw new KnowledgeProbeError("invalid_path", "目标不是目录");
		const accessible = await access(canonicalRoot, fsConstants.R_OK | fsConstants.X_OK).then(() => true, () => false);
		if (!accessible) throw new KnowledgeProbeError("invalid_path", "目录无读取权限");

		const probe = await probeKnowledgeRoot(canonicalRoot);
		const hasObsidianRoot = await hasObsidianDirectory(canonicalRoot);
		const wikiRoot = path.join(canonicalRoot, "wiki");
		const hasObsidianWiki = probe.markers.wiki && await hasObsidianDirectory(wikiRoot);
		let obsidianRoot: string | undefined;
		let obsidianRootCandidates: string[] | undefined;
		if (hasObsidianRoot && hasObsidianWiki) {
			obsidianRootCandidates = [canonicalRoot, wikiRoot];
		} else if (hasObsidianRoot) {
			obsidianRoot = canonicalRoot;
		} else if (hasObsidianWiki) {
			obsidianRoot = wikiRoot;
		}

		const warnings: string[] = [];
		if (probe.profile === "managed-wiki") {
			for (const diagnostic of probe.diagnostics) {
				if (diagnostic.startsWith("missing_")) warnings.push(`受管 Wiki 布局缺少 ${diagnostic.slice("missing_".length)}，结构化能力降级`);
			}
		} else {
			warnings.push("未检测到受管 Wiki 布局（wiki/ + raw/），按普通 Markdown 库接入");
		}
		if (obsidianRootCandidates) {
			warnings.push("根目录与 wiki/ 均存在 .obsidian，需要在计划中显式选择 Obsidian 根");
		} else if (!obsidianRoot) {
			warnings.push("未检测到 .obsidian 配置，打开 Obsidian 客户端能力不可用");
		}
		if (!probe.readable) warnings.push("内容目录不可读，阅读 capability 降级");

		const record: KnowledgeProbeRecord = {
			probeId: randomUUID(),
			ownerId,
			canonicalBindingRoot: probe.canonicalRoot,
			rootIdentity: probe.rootIdentity,
			targetExists: true,
			profile: probe.profile,
			contentRoot: probe.contentRoot,
			linkRoot: probe.contentRoot,
			...(obsidianRoot ? { obsidianRoot } : {}),
			...(obsidianRootCandidates ? { obsidianRootCandidates } : {}),
			markers: {
				hasWiki: probe.markers.wiki,
				hasRaw: probe.markers.raw,
				hasManifest: probe.markers.sourceManifest,
				hasSchema: probe.markers.schema,
				hasObsidianRoot,
				hasObsidianWiki,
			},
			capabilities: probe.capabilities,
			warnings,
			createdAt: new Date(this.now()).toISOString(),
		};
		this.records.set(record.probeId, { record, expiresAt: this.now() + this.ttlMs });
		return record;
	}

	/**
	 * intent=create 的"待创建"探测：只校验路径语义与父目录（已存在、是目录、可写），
	 * 不做任何磁盘写入；canonicalBindingRoot 取 realpath(父目录) + 末级名。
	 */
	private async createForMissingTarget(ownerId: string, inputPath: string): Promise<KnowledgeProbeRecord> {
		if (inputPath.split(path.sep).includes("..")) {
			throw new KnowledgeProbeError("invalid_path", "路径不允许包含 .. 相对语义，请使用规范化绝对路径");
		}
		const normalized = path.normalize(inputPath);
		const parent = path.dirname(normalized);
		if (parent === normalized) throw new KnowledgeProbeError("invalid_path", "路径不可用");
		const parentInfo = await stat(parent).catch(() => null);
		if (!parentInfo) throw new KnowledgeProbeError("invalid_path", "父目录不存在，请先创建上级目录，或改选已存在的目录");
		if (!parentInfo.isDirectory()) throw new KnowledgeProbeError("invalid_path", "父路径已存在但不是目录，无法在其中创建知识库目录");
		const writable = await access(parent, fsConstants.W_OK).then(() => true, () => false);
		if (!writable) throw new KnowledgeProbeError("invalid_path", "父目录无写入权限，无法在该位置创建目录");
		const canonicalRoot = path.join(await realpath(parent), path.basename(normalized));

		const record: KnowledgeProbeRecord = {
			probeId: randomUUID(),
			ownerId,
			canonicalBindingRoot: canonicalRoot,
			rootIdentity: null,
			targetExists: false,
			profile: "markdown",
			contentRoot: canonicalRoot,
			linkRoot: canonicalRoot,
			markers: {
				hasWiki: false,
				hasRaw: false,
				hasManifest: false,
				hasSchema: false,
				hasObsidianRoot: false,
				hasObsidianWiki: false,
			},
			capabilities: { read: false, layoutReady: false, structuredPrepare: false, publish: false },
			warnings: ["目录尚不存在，将在应用接入计划时创建", "目录创建后按普通 Markdown 库接入，可在计划中生成首页与结构脚手架"],
			createdAt: new Date(this.now()).toISOString(),
		};
		this.records.set(record.probeId, { record, expiresAt: this.now() + this.ttlMs });
		return record;
	}

	get(ownerId: string, probeId: string): KnowledgeProbeRecord {
		this.sweep();
		const found = this.records.get(probeId);
		if (!found || found.record.ownerId !== ownerId) {
			throw new KnowledgeProbeError("not_found", "探测结果不存在或已过期，请重新探测");
		}
		return found.record;
	}

	private sweep(): void {
		const now = this.now();
		for (const [probeId, entry] of this.records) {
			if (entry.expiresAt <= now) this.records.delete(probeId);
		}
	}
}
