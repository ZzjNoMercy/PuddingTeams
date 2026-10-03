import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identifyUploads, type UploadInput } from "../store/uploads.js";
import type { KnowledgeObjectStore } from "./objects.js";
import { imageDimensions, parseImageExtraction, type ImageExtractionArtifact } from "./image-extraction.js";

export type KnowledgeSourceKind = "text" | "markdown" | "image" | "pdf";
export interface KnowledgeSourceOrigin {
	sessionId?: string;
	messageId?: string;
	windowId?: string;
	channel?: "user_input" | "agent_task";
}

export interface WebCaptureOrigin { itemId: string; versionId: string; originalUrl: string; canonicalUrl: string; fetchedUrl?: string; author: string; siteName: string; capturedAt: string; extractorVersion: string; contentHash: string; captureMethod?: "http" | "saved_html"; sourceFilename?: string }
export interface KnowledgeSource {
	id: string;
	ownerId: string;
	kind: KnowledgeSourceKind;
	title: string;
	mediaType: string;
	byteSize: number;
	/** Original and derived bytes live in host objects, independently of chat attachment cleanup. */
	originalHash: string;
	textHash?: string;
	status: "ready" | "needs_attention" | "failed";
	locations: Array<{ kind: "lines"; startLine: number; endLine: number } | { kind: "image_region"; segmentId: string; startLine: number; endLine: number; x?: number; y?: number; width?: number; height?: number }>;
	derivedFrom?: string;
	extraction?: { extractorId: string; version: number; modelRef: string; originalHash: string; artifactHash: string; warnings: string[] };
	warnings: string[];
	origin?: KnowledgeSourceOrigin;
	webCapture?: WebCaptureOrigin;
	assets?: Array<{ hash: string; mediaType: string; alt: string; sourceUrl: string }>;
	createdAt: string;
}

export class KnowledgeSourceError extends Error {
	constructor(readonly code: "invalid_input" | "not_found" | "source_unavailable" | "integrity_error", message: string) {
		super(message);
	}
}

/** Every source version and its displayed evidence metadata are part of the frozen job identity. */
export function knowledgeSourceManifestHash(sources: readonly KnowledgeSource[]): string {
	return createHash("sha256").update(JSON.stringify([...sources].sort((a, b) => a.id.localeCompare(b.id)).map((source) => [
		source.id, source.ownerId, source.kind, source.title, source.mediaType, source.byteSize,
		source.originalHash, source.textHash ?? null, source.status, source.locations, source.warnings,
		source.origin?.sessionId ?? null, source.origin?.messageId ?? null, source.origin?.windowId ?? null,
		source.origin?.channel ?? "user_input",
		source.derivedFrom ?? null, source.extraction ?? null, source.webCapture ?? null, source.assets ?? null,
	]))).digest("hex");
}

function magicMediaType(bytes: Buffer): string | undefined {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("ascii"))) return "application/pdf";
	return undefined;
}

const EXTENSION_TYPES: Record<string, string> = {
	".md": "text/markdown", ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg",
	".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
};
const TEXT_LIMIT = 8 * 1024 * 1024;

/** Intake preserves originals but never promotes a material into accepted knowledge. */
export class KnowledgeSourceStore {
	private readonly file: string;
	private readonly objects: Pick<KnowledgeObjectStore, "put" | "get">;

	constructor(private readonly deps: { stateDir: string; objects: Pick<KnowledgeObjectStore, "put" | "get"> }) {
		this.file = path.join(deps.stateDir, "sources.sqlite");
		this.objects = deps.objects;
	}

	private async database<T>(action: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
		await mkdir(this.deps.stateDir, { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.file);
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("CREATE TABLE IF NOT EXISTS knowledge_sources (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, record_json TEXT NOT NULL)");
			return await action(db);
		} finally { db.close(); }
	}

	private checkOwner(ownerId: string): void {
		if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 200) throw new KnowledgeSourceError("invalid_input", "素材归属无效");
	}

	private cleanOrigin(origin?: KnowledgeSourceOrigin): KnowledgeSourceOrigin | undefined {
		if (origin === undefined) return undefined;
		if (!origin || typeof origin !== "object") throw new KnowledgeSourceError("invalid_input", "素材来源位置无效");
		const clean: KnowledgeSourceOrigin = {};
		if (origin.channel !== undefined) {
			if (origin.channel !== "user_input" && origin.channel !== "agent_task") throw new KnowledgeSourceError("invalid_input", "素材来源通道无效");
			clean.channel = origin.channel;
		}
		for (const key of ["sessionId", "messageId", "windowId"] as const) {
			const value = origin[key];
			if (value !== undefined) {
				if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
					throw new KnowledgeSourceError("invalid_input", "素材来源位置无效");
				}
				clean[key] = value;
			}
		}
		return clean;
	}

	private async freeze(ownerId: string, kind: KnowledgeSourceKind, title: string, mediaType: string, bytes: Buffer,
		origin?: KnowledgeSourceOrigin): Promise<KnowledgeSource> {
		const raw = await this.objects.put(bytes);
		const source: KnowledgeSource = { id: randomUUID(), ownerId, kind, title, mediaType,
			byteSize: bytes.length, originalHash: raw.hash, status: "needs_attention", locations: [], warnings: [],
			...(origin ? { origin } : {}), createdAt: new Date().toISOString() };
		if (kind === "text" || kind === "markdown") {
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				if (text.includes("\0")) throw new Error("binary text");
			} catch {
				source.status = "failed";
				source.warnings.push("文本不是有效 UTF-8 或包含二进制内容；原件已保留，请转换编码后重试");
				return source;
			}
			const derived = await this.objects.put(Buffer.from(text, "utf8"));
			source.textHash = derived.hash;
			source.status = "ready";
			source.locations = [{ kind: "lines", startLine: 1, endLine: text.split(/\r\n|\r|\n/).length }];
		} else {
			source.warnings.push(kind === "pdf" ? "PDF 原件已保留；PDF 解析/OCR 能力尚未接入，不能用于生成候选" :
				"图片原件已保留；尚未提取，整理任务将检查视觉模型并生成独立提取快照");
		}
		return source;
	}

	private async save(sources: KnowledgeSource[], guard?: { assertCurrent: () => Promise<void>; commitGuard: () => void }): Promise<void> {
		await this.database(async (db) => {
			await guard?.assertCurrent();
			guard?.commitGuard();
			db.exec("BEGIN IMMEDIATE");
			try {
				const insert = db.prepare("INSERT INTO knowledge_sources (id, owner_id, record_json) VALUES (?, ?, ?)");
				for (const source of sources) insert.run(source.id, source.ownerId, JSON.stringify(source));
				db.exec("COMMIT");
			} catch (error) { db.exec("ROLLBACK"); throw error; }
		});
	}

	async createText(ownerId: string, text: string, origin?: KnowledgeSourceOrigin): Promise<KnowledgeSource> {
		this.checkOwner(ownerId);
		if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > TEXT_LIMIT || Buffer.from(text, "utf8").toString("utf8") !== text) {
			throw new KnowledgeSourceError("invalid_input", "请输入非空文字，最大 8MB");
		}
		const source = await this.freeze(ownerId, "text", `${origin?.channel === "agent_task" ? "Agent 任务请求：" : ""}${text.trim().split(/\r\n|\r|\n/)[0]!.slice(0, 120)}`,
			"text/plain", Buffer.from(text, "utf8"), this.cleanOrigin(origin));
		await this.save([source]);
		return source;
	}

	/** Trusted read-later intake; the HTTP intake never accepts object hashes. */
	async createWebCapture(ownerId: string, input: { id: string; title: string; content: string; metadata: WebCaptureOrigin; warnings: string[]; assets: Array<{ bytes: Buffer; mediaType: string; alt: string; sourceUrl: string }> }): Promise<KnowledgeSource> {
		this.checkOwner(ownerId);
		const existing = await this.get(ownerId, input.id); if (existing) return existing;
		const source = await this.freeze(ownerId, "markdown", input.title, "text/markdown", Buffer.from(input.content));
		source.id = input.id; source.webCapture = input.metadata; source.warnings = input.warnings;
		source.assets = [];
		for (const asset of input.assets) { const frozen = await this.objects.put(asset.bytes); source.assets.push({ hash: frozen.hash, mediaType: asset.mediaType, alt: asset.alt, sourceUrl: asset.sourceUrl }); }
		try { await this.save([source]); } catch (error) { const winner = await this.get(ownerId, input.id); if (winner) return winner; throw error; }
		return source;
	}
	async readAsset(ownerId: string, id: string, hash: string): Promise<Buffer> {
		const source = await this.get(ownerId, id);
		if (!source || !(source.kind === "image" && source.originalHash === hash) && !source.assets?.some(asset => asset.hash === hash)) throw new KnowledgeSourceError("not_found", "素材图片不存在");
		return this.objects.get(hash);
	}

	async createUploads(ownerId: string, uploads: UploadInput[], origin?: KnowledgeSourceOrigin): Promise<KnowledgeSource[]> {
		this.checkOwner(ownerId);
		const cleanOrigin = this.cleanOrigin(origin);
		let identities: ReturnType<typeof identifyUploads>;
		try { identities = identifyUploads(uploads); }
		catch (error) { throw new KnowledgeSourceError("invalid_input", error instanceof Error ? error.message : "附件格式无效"); }
		// Validate all payloads before persisting any source records or bytes.
		const prepared = identities.map((identity, index) => {
			const bytes = Buffer.from(uploads[index]!.data, "base64");
			const declared = identity.mediaType.split(";")[0]!.trim().toLowerCase();
			const extensionType = EXTENSION_TYPES[path.extname(identity.name).toLowerCase()];
			const actual = magicMediaType(bytes);
			const mediaType = actual ?? extensionType ?? (["text/plain", "text/markdown"].includes(declared) ? declared : undefined);
			if (!mediaType || (actual && extensionType && actual !== extensionType) ||
				(!actual && mediaType !== "text/markdown" && mediaType !== "text/plain") ||
				(declared !== "application/octet-stream" && declared !== mediaType)) {
				throw new KnowledgeSourceError("invalid_input", "附件实际类型与声明不一致，或尚不支持该类型");
			}
			const kind: KnowledgeSourceKind = mediaType === "application/pdf" ? "pdf" : mediaType.startsWith("image/") ? "image" :
				mediaType === "text/markdown" ? "markdown" : "text";
			return { bytes, kind, mediaType, title: identity.name };
		});
		const sources: KnowledgeSource[] = [];
		for (const entry of prepared) sources.push(await this.freeze(ownerId, entry.kind, entry.title, entry.mediaType, entry.bytes, cleanOrigin));
		await this.save(sources);
		return sources;
	}

	async get(ownerId: string, id: string): Promise<KnowledgeSource | undefined> {
		this.checkOwner(ownerId);
		if (typeof id !== "string" || !id || id.length > 200) return undefined;
		return this.database((db) => {
			const row = db.prepare("SELECT record_json FROM knowledge_sources WHERE id = ? AND owner_id = ?").get(id, ownerId) as { record_json: string } | undefined;
			if (!row) return undefined;
			const source = JSON.parse(row.record_json) as KnowledgeSource;
			if (source.id !== id || source.ownerId !== ownerId) throw new KnowledgeSourceError("integrity_error", "素材记录归属不一致");
			return source;
		});
	}

	/** A derived immutable source never replaces the original intake record. */
	async createImageExtraction(ownerId: string, id: string, artifact: ImageExtractionArtifact, guard?: { assertCurrent: () => Promise<void>; commitGuard: () => void }): Promise<KnowledgeSource> {
		const { source: original, bytes } = await this.readOriginal(ownerId, id);
		if (original.kind !== "image" || original.extraction || original.textHash || artifact.originalHash !== original.originalHash ||
			artifact.version !== 1 || artifact.extractorId !== "pi-vision" || !artifact.modelRef) throw new KnowledgeSourceError("invalid_input", "图片提取物与原件身份不一致");
		const dimensions = imageDimensions(bytes, original.mediaType);
		if (artifact.width !== dimensions.width || artifact.height !== dimensions.height) throw new KnowledgeSourceError("integrity_error", "图片提取定位与原图尺寸不一致");
		const parsed = parseImageExtraction(JSON.stringify(artifact), 22);
		const text = parsed.segments.map((segment) => segment.text).join("\n\n");
		const textObject = await this.objects.put(Buffer.from(text));
		const artifactObject = await this.objects.put(Buffer.from(JSON.stringify({ ...artifact, segments: parsed.segments, warnings: parsed.warnings, sourceId: original.id })));
		let line = 1;
		const locations: KnowledgeSource["locations"] = parsed.segments.map((segment, index) => {
			const startLine = line, endLine = startLine + segment.text.split("\n").length - 1;
			line = endLine + 2;
			return { kind: "image_region", segmentId: `segment-${index + 1}`, startLine, endLine, ...segment.region };
		});
		const source: KnowledgeSource = { ...original, id: randomUUID(), derivedFrom: original.id, textHash: textObject.hash, status: "ready", locations,
			warnings: [...parsed.warnings, ...parsed.segments.flatMap((segment) => segment.warnings)],
			extraction: { extractorId: artifact.extractorId, version: artifact.version, modelRef: artifact.modelRef, originalHash: artifact.originalHash, artifactHash: artifactObject.hash, warnings: parsed.warnings },
			createdAt: new Date().toISOString() };
		await this.save([source], guard);
		return source;
	}

	async readText(ownerId: string, id: string): Promise<{ source: KnowledgeSource; text: string }> {
		const source = await this.get(ownerId, id);
		if (!source) throw new KnowledgeSourceError("not_found", "素材不存在");
		if (source.status !== "ready" || !source.textHash) throw new KnowledgeSourceError("source_unavailable", "素材尚无可用提取文本");
		if (source.extraction) await this.objects.get(source.extraction.artifactHash);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(await this.objects.get(source.textHash));
		return { source, text };
	}

	async readOriginal(ownerId: string, id: string): Promise<{ source: KnowledgeSource; bytes: Buffer }> {
		const source = await this.get(ownerId, id);
		if (!source) throw new KnowledgeSourceError("not_found", "素材不存在");
		return { source, bytes: await this.objects.get(source.originalHash) };
	}

	async manifest(ownerId: string, ids: string[]): Promise<{ sources: KnowledgeSource[]; manifestHash: string }> {
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length) {
			throw new KnowledgeSourceError("invalid_input", "素材列表必须非空且去重，最多 100 项");
		}
		const sources: KnowledgeSource[] = [];
		for (const id of ids) {
			const source = await this.get(ownerId, id);
			if (!source) throw new KnowledgeSourceError("not_found", "素材不存在");
			// Read both original and derived objects now: freezing a missing/corrupt object is forbidden.
			await this.objects.get(source.originalHash);
			if (source.textHash) await this.objects.get(source.textHash);
			if (source.extraction) await this.objects.get(source.extraction.artifactHash);
			for (const asset of source.assets ?? []) await this.objects.get(asset.hash);
			sources.push(source);
		}
		return { sources, manifestHash: knowledgeSourceManifestHash(sources) };
	}
}
