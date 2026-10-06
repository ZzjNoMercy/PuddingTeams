import path from "node:path";
import { hashBufferSha256 } from "./hashing.js";
import { actualImageMediaType, imageAssetPath } from "./image-publication.js";
import type { KnowledgeImageAsset } from "./assets.js";
import { NoteWriteError } from "./note-write.js";

export const MAX_CONTACT_AVATAR_BYTES = 2 * 1024 * 1024;
export type ContactAvatarAsset = KnowledgeImageAsset;

export function contactAvatarAsset(notePath: string, encoded: unknown): ContactAvatarAsset {
 if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(MAX_CONTACT_AVATAR_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
  throw new NoteWriteError("invalid_input", "请选择 2 MB 以内的 JPG、PNG 或 WebP 图片");
 }
 const bytes = Buffer.from(encoded, "base64"), type = actualImageMediaType(bytes);
 if (bytes.length > MAX_CONTACT_AVATAR_BYTES) throw new NoteWriteError("too_large", "头像不能超过 2 MB");
 if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type)) throw new NoteWriteError("invalid_input", "请选择 JPG、PNG 或 WebP 图片");
 return { path: imageAssetPath(hashBufferSha256(bytes), type, notePath.startsWith("wiki/") ? "wiki/" : ""), bytes };
}

/** Edit one top-level field without reserializing the user's Markdown or other metadata. */
export function withContactAvatar(content: string, reference: string | null): string {
 const match = /^(---\r?\n)([\s\S]*?)(^---[ \t]*\r?$)/m.exec(content);
 if (!match || match.index !== 0) throw new NoteWriteError("invalid_input", "人物笔记缺少有效的基本信息，请先在知识库中编辑");
 const newline = match[1]!.includes("\r") ? "\r\n" : "\n";
 const lines = match[2]!.split(/\r?\n/), kept: string[] = [];
 let skipping = false;
 for (const line of lines) {
  if (/^(?:avatar|"avatar"|'avatar')\s*:/.test(line)) { skipping = true; continue; }
  if (skipping && /^(?:\s+\S|\s*$)/.test(line)) continue;
  skipping = false; kept.push(line);
 }
 while (kept.at(-1) === "") kept.pop();
 if (reference !== null) kept.push(`avatar: ${reference}`);
 return `${match[1]}${kept.join(newline)}${newline}${content.slice(match[1]!.length + match[2]!.length)}`;
}

export function resolveContactAvatar(notePath: string, reference: unknown): string | undefined {
 if (typeof reference !== "string" || !reference || /^[A-Za-z][A-Za-z0-9+.-]*:|^\//.test(reference) || /[\\\u0000-\u001f?#]/.test(reference)) return;
 let decoded: string; try { decoded = decodeURIComponent(reference); } catch { return; }
 if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\//.test(decoded) || /[\\\u0000-\u001f?#]/.test(decoded)) return;
 const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(notePath), decoded));
 if (resolved.split("/").some(part => !part || part.startsWith(".")) || !/\.(?:png|jpe?g|webp)$/i.test(resolved)) return;
 return resolved;
}

