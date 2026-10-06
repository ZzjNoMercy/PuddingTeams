import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "parse5";
import { actualImageMediaType, IMAGE_ASSET_EXTENSIONS } from "../knowledge/image-publication.js";
import { ReadLaterError, cleanText, operationId, expectedRevision, type SavedHtmlInput, type ArticleAsset, type ArticleVersion } from "./contracts.js";
import { extractArticle } from "./extract.js";
import { canonicalizeUrl } from "./public-fetch.js";
import { ReadLaterStore, digest } from "./store.js";

const HTML_LIMIT = 5 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
function invalid(message: string): never { throw new ReadLaterError("invalid_input", message); }
function localPath(raw: string) {
  if (typeof raw !== "string" || !raw || raw.length > 500 || /[\\:\u0000]/.test(raw) || raw.startsWith("/") || raw.split("/").some(part => part === "..")) return undefined;
  return raw.replace(/^(\.\/)+/, "");
}
function decodeImage(encoded: string) {
  if (typeof encoded !== "string" || !encoded || encoded.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid("图片编码无效或超过 5 MB");
  const bytes = Buffer.from(encoded, "base64"), mediaType = actualImageMediaType(bytes);
  if (!mediaType || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType) || bytes.toString("base64") !== encoded || bytes.length > 5 * 1024 * 1024) invalid("仅支持 PNG、JPEG、GIF、WebP 图片，每张最多 5 MB");
  return { bytes, mediaType, hash: createHash("sha256").update(bytes).digest("hex") };
}
/** Processes only explicitly supplied bytes. Never opens a URL or local path. */
export async function importSavedHtml(store: ReadLaterStore, owner: string, id: string, input: SavedHtmlInput) {
  if (!input || typeof input !== "object") invalid("请选择已保存的 HTML 网页");
  const op = operationId(input.operationId), revision = expectedRevision(input.expectedRevision);
  const filename = cleanText(input.filename, 240, "文件名");
  if (!/\.html?$/i.test(filename) || /[/\\]/.test(filename)) invalid("请选择 .html 或 .htm 文件");
  if (typeof input.html !== "string" || !input.html.trim() || Buffer.byteLength(input.html) > HTML_LIMIT) invalid("HTML 网页最多 5 MB，且不能为空");
  const item = store.get(owner, id);
  if (!Array.isArray(input.images ?? []) || (input.images?.length ?? 0) > 32) invalid("最多导入 32 张本地图片");
  const files = new Map<string, ReturnType<typeof decodeImage>>();
  let total = 0;
  for (const image of input.images ?? []) {
    const name = image && localPath(image.path);
    if (!name || files.has(name)) invalid("图片文件路径无效或重复");
    const decoded = decodeImage(image.base64);
    total += decoded.bytes.length;
    if (total > IMAGE_LIMIT) invalid("图片总大小最多 8 MB");
    files.set(name, decoded);
  }
  const supplied = new Map<string, ReturnType<typeof decodeImage>>();
  const tree = parse(input.html), pending: Array<{ attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[]; tagName?: string }> = [tree];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const node = pending[cursor]!;
    pending.push(...(node.childNodes ?? []) as typeof pending);
    if (node.tagName !== "img") continue;
    for (const attribute of node.attrs ?? []) {
      if (!["src", "data-src", "data-original", "data-lazy-src", "data-actualsrc"].includes(attribute.name)) continue;
      const raw = attribute.value;
      if (supplied.has(raw)) continue;
      const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
      if (data) {
        const decoded = decodeImage(data[2]!);
        if (decoded.mediaType !== data[1]!.toLowerCase()) invalid("内嵌图片声明类型与实际内容不符");
        total += decoded.bytes.length;
        if (total > IMAGE_LIMIT) invalid("图片总大小最多 8 MB");
        supplied.set(raw, decoded);
      } else {
        let name: string | undefined;
        try { name = localPath(decodeURIComponent(raw.split(/[?#]/)[0]!)); } catch { continue; }
        if (!name) continue;
        const exact = files.get(name);
        const matches = [...files.entries()].filter(([key]) => path.posix.basename(key) === path.posix.basename(name!));
        if (exact) supplied.set(raw, exact);
        else if (matches.length === 1) supplied.set(raw, matches[0]![1]);
      }
    }
  }
  const article = extractArticle(input.html, item.canonicalUrl, "text/html", new Set(supplied.keys()));
  if (article.unavailableReason) invalid("所选文件仍是微信安全验证页，请保存已经显示正文的文章页面");
  if (new URL(item.canonicalUrl).hostname === "mp.weixin.qq.com" && !pending.some(node => node.attrs?.some(attribute => attribute.name === "id" && attribute.value === "js_content"))) invalid("所选网页缺少公众号正文区域，请保存已经显示正文的文章页面");
  if (article.warnings.some(warning => warning.includes("不足 80"))) invalid("所选网页没有足够的正文，请确认保存的是文章页面");
  const warnings = [...article.warnings];
  if (article.declaredUrl) {
    let declared: string;
    try { declared = canonicalizeUrl(new URL(article.declaredUrl, item.canonicalUrl).href); } catch { invalid("网页声明的原文链接无效"); }
    if (declared! !== item.canonicalUrl) {
      const saved = new URL(declared!), original = new URL(item.canonicalUrl);
      const wechat = saved.hostname === "mp.weixin.qq.com" && original.hostname === saved.hostname;
      const identityKeys = ["__biz", "mid", "idx", "sn"];
      const sameIdentity = identityKeys.every(key => saved.searchParams.has(key) && saved.searchParams.get(key) === original.searchParams.get(key));
      const shortAndLong = (saved.pathname === "/s" && original.pathname.startsWith("/s/")) || (original.pathname === "/s" && saved.pathname.startsWith("/s/"));
      if (wechat && shortAndLong) warnings.push("导入网页声明的是微信长链接，无法离线核对收藏短链接；文章来源对应关系由用户选择确认。");
      else if (!(wechat && (sameIdentity || (saved.pathname === original.pathname && saved.search === original.search)))) invalid("所选网页的原文链接与这条收藏不同，请选择对应文章");
    }
  }
  if (!article.declaredUrl) warnings.push("导入文件未声明原文地址，文章来源对应关系由用户选择确认。");
  const versionId = randomUUID(), directory = path.join(store.directory, "assets", id, versionId);
  const assets: ArticleAsset[] = [], replacements = new Map<number, string>();
  let committed = false, missing = 0;
  try {
    for (const [index, image] of article.images.entries()) {
      const local = supplied.get(image.url);
      if (!local || assets.length >= 32) { missing++; continue; }
      const hash = local.hash;
      const previous = assets.find(asset => asset.hash === hash);
      if (previous) { replacements.set(index, `assets/${previous.path}`); continue; }
      const filename = `${hash}.${IMAGE_ASSET_EXTENSIONS[local.mediaType]}`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, filename), local.bytes, { mode: 0o600, flag: "wx" });
      assets.push({ id: randomUUID(), hash, mediaType: local.mediaType, byteSize: local.bytes.length, path: filename,
        sourceUrl: image.url.startsWith("data:") ? `saved-page:embedded/${hash}` : `saved-page:${image.url}`, alt: image.alt, role: image.role });
      replacements.set(index, `assets/${filename}`);
    }
    if (missing) warnings.push(`${missing} 张图片未导入。可重新导入网页并选择随网页保存的图片；导入过程不访问远程图片。`);
    const content = article.content.replace(/(!\[(?:\\.|[^\]\\])*\])\(read-later-image:(\d+)\)/g,
      (_match, label: string, index: string) => replacements.has(Number(index)) ? `${label}(${replacements.get(Number(index))})` : `${label.slice(1)}（图片未导入）`);
    const version: ArticleVersion = { id: versionId, itemId: id, content, contentHash: createHash("sha256").update(content).digest("hex"), assets, warnings,
      coverAssetId: assets.find(asset => asset.role === "cover")?.id, capturedAt: new Date().toISOString(), extractorVersion: "teams-read-later/2",
      captureMethod: "saved_html", sourceFilename: filename };
    const hash = digest({ id, revision, filename, html: input.html, images: [...files].map(([name, file]) => [name, file.hash]).sort() });
    const result = store.importVersion(owner, id, revision, op, hash, { title: article.title, siteName: article.siteName, author: article.author, description: article.description }, version);
    committed = !result.replayed;
    return result;
  } finally {
    if (!committed) await rm(directory, { recursive: true, force: true });
  }
}
