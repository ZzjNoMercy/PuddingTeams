import path from "node:path";
import { hashBufferSha256 } from "./hashing.js";
import type { PublicationBatch, PublicationFile } from "./contracts.js";
import type { KnowledgeObjectStore } from "./objects.js";
import type { KnowledgeSource } from "./sources.js";
import { parseNoteFrontmatterFields } from "./acceptance.js";
import { Lexer, walkTokens } from "marked";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

export const IMAGE_ASSET_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
export function actualImageMediaType(bytes: Buffer): string | undefined {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (bytes.length >= 16 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && /avif|avis/.test(bytes.subarray(8, 32).toString("ascii"))) return "image/avif";
	return undefined;
}
/** Image limits are separate from the 2 MiB Markdown reader. */
export async function readImageDiskBytes(absolute: string): Promise<Buffer> {
	const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > 10 * 1024 * 1024) throw new Error("图片文件不可读取或超过10MiB");
		const bytes = Buffer.alloc(before.size + 1), read = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
		if (read.bytesRead !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) throw new Error("图片读取期间已变化");
		return bytes.subarray(0, read.bytesRead);
	} finally { await handle.close(); }
}
export function imageAssetPath(hash: string, mediaType: string, contentPrefix = ""): string {
	const extension = IMAGE_ASSET_EXTENSIONS[mediaType];
	if (!["", "wiki/"].includes(contentPrefix) || !/^[a-f0-9]{64}$/.test(hash) || !extension) throw new Error("图片资产格式或哈希无效");
	return `${contentPrefix}assets/images/${hash}.${extension}`;
}
export function assertImageAssetBytes(targetPath: string, bytes: Buffer, mediaType?: string): string {
	const actual = actualImageMediaType(bytes);
	if (!actual || (mediaType && actual !== mediaType) || imageAssetPath(hashBufferSha256(bytes), actual, targetPath.startsWith("wiki/") ? "wiki/" : "") !== targetPath) throw new Error("图片资产路径、签名或哈希不一致");
	return actual;
}
export function relativeImagePath(pagePath: string, assetPath: string): string {
	return path.posix.relative(path.posix.dirname(pagePath), assetPath);
}
export function resolveImagePath(pagePath: string, target: string): string {
	if (!target || /^[A-Za-z][A-Za-z0-9+.-]*:|^\//.test(target) || /[\\\u0000-\u001f?#]/.test(target)) throw new Error("候选图片只能引用宿主冻结的库内相对资源");
	let decoded: string; try { decoded = decodeURIComponent(target); } catch { throw new Error("图片相对路径编码无效"); }
	const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(pagePath), decoded));
	if (!/^(?:wiki\/)?assets\/images\/[a-f0-9]{64}\.(png|jpg|gif|webp|avif)$/.test(resolved)) throw new Error("候选图片路径不属于宿主管理的图片资产");
	return resolved;
}
/** Standard inline/reference Markdown images only; code examples are not references. */
export function markdownImageTargets(content: string): string[] {
	const targets: string[] = [];
	walkTokens(Lexer.lex(content), (token) => {
		if (token.type === "image") targets.push(token.href);
		if ((token.type === "html" && /<img\b/i.test(token.text)) || (token.type === "text" && /!\[\[/.test(token.text))) throw new Error("候选图片请使用标准 Markdown 相对路径引用");
	});
	return targets;
}
export function sourceImageAssets(sources: KnowledgeSource[], contentPrefix = ""): Array<{ sourceId: string; path: string; hash: string; mediaType: string }> {
	return sources.flatMap((source) => (source.kind === "image" ? [{ hash: source.originalHash, mediaType: source.mediaType }] : source.assets ?? []).map(asset => ({ sourceId: source.id, path: imageAssetPath(asset.hash, asset.mediaType, contentPrefix), hash: asset.hash, mediaType: asset.mediaType })));
}
export function attachSourceImages(pagePath: string, content: string, usedSources: string[], sources: KnowledgeSource[], contentPrefix = ""): { content: string; assets: ReturnType<typeof sourceImageAssets> } {
	const assets = sourceImageAssets(sources.filter((source) => usedSources.includes(source.id)), contentPrefix);
	let updated = content;
	const paths = new Set(markdownImageTargets(updated).map((target) => resolveImagePath(pagePath, target)));
	for (const target of paths) if (!assets.some((asset) => asset.path === target)) throw new Error("候选图片缺少该页已采纳的原件来源");
	for (const asset of assets) if (!paths.has(asset.path)) {
		const source = sources.find((source) => source.id === asset.sourceId)!;
		const alt = source.title.replace(/[\[\]\\\r\n]/g, " ");
		updated += `\n\n![${alt}](${relativeImagePath(pagePath, asset.path)})\n`; paths.add(asset.path);
	}
	return { content: updated, assets };
}

/** Byte-level closure checked independently by Publisher and candidate readers. */
export async function assertImageBatchIntegrity(batch: PublicationBatch, objects: Pick<KnowledgeObjectStore, "get">): Promise<void> {
	const assets = batch.files.filter((file) => file.kind === "image");
	const receipt = assets.length ? JSON.parse(batch.validationReceipt) as { sources?: KnowledgeSource[]; historicalSources?: KnowledgeSource[] } : {};
	const sources = [...(receipt.sources ?? []), ...(receipt.historicalSources ?? [])];
	const referenced = new Set<string>();
	for (const asset of assets) {
		const bytes = await objects.get(asset.blobRef!); assertImageAssetBytes(asset.targetPath, bytes, asset.mediaType);
		if (hashBufferSha256(bytes) !== asset.candidateHash || !batch.sourceSnapshots.includes(asset.candidateHash!)) throw new Error("图片原件不在固定来源快照内");
		if (!asset.sourceIds?.length || asset.sourceIds.some((id) => !sources.some((source) => source.id === id && ((source.kind === "image" && source.originalHash === asset.candidateHash && source.mediaType === asset.mediaType) || source.assets?.some(image => image.hash === asset.candidateHash && image.mediaType === asset.mediaType))))) throw new Error("图片资产原件来源不一致");
	}
	for (const group of batch.dependencyGroups) for (const [index, target] of group.entries()) {
		const file = batch.files.find((file) => file.targetPath === target)!; if (file.kind === "image" || file.operation === "delete") continue;
		const content = (await objects.get(file.blobRef!)).toString("utf8");
		const fields = parseNoteFrontmatterFields(content);
		for (const image of markdownImageTargets(content)) {
			const targetPath = resolveImagePath(file.targetPath, image), asset = assets.find((asset) => asset.targetPath === targetPath);
			if (!asset || group.indexOf(targetPath) < 0 || group.indexOf(targetPath) >= index) throw new Error("图片与引用页面必须同组且先发布原件");
			if (!Array.isArray(fields.sources) || !asset.sourceIds!.some((id) => (fields.sources as unknown[]).includes(id))) throw new Error("页面未声明图片原件来源");
			referenced.add(targetPath);
		}
	}
	if (assets.some((asset) => !referenced.has(asset.targetPath))) throw new Error("固定批次包含未被页面引用的图片");
}
