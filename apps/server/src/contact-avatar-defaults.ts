import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { actualImageMediaType } from "./knowledge/image-publication.js";
import { hashBufferSha256 } from "./knowledge/hashing.js";
import { NoteWriteError } from "./knowledge/note-write.js";

interface AvatarEntry { id: string; label: string; category: string; file: string; hash: string }
export type ContactAvatarOption = Omit<AvatarEntry, "file">;
const directory = fileURLToPath(new URL("../assets/contact-avatars/", import.meta.url));
let library: Promise<Array<AvatarEntry & { bytes: Buffer }>> | undefined;
async function loadLibrary() {
 if (!library) library = (async () => {
  const entries = JSON.parse(await readFile(path.join(directory, "catalog.json"), "utf8")) as AvatarEntry[];
  const ids = new Set<string>();
  return Promise.all(entries.map(async entry => {
   if (!/^[a-z0-9_]+$/.test(entry.id) || entry.file !== `${entry.id}.png` || ids.has(entry.id) || !entry.label || !entry.category) throw new Error("内置头像目录无效");
   ids.add(entry.id);
   const bytes = await readFile(path.join(directory, entry.file));
   if (bytes.length > 2 * 1024 * 1024 || actualImageMediaType(bytes) !== "image/png" || hashBufferSha256(bytes) !== entry.hash) throw new Error("内置头像资源损坏");
   return { ...entry, bytes };
  }));
 })().catch(error => { library = undefined; throw error; });
 return library;
}
export async function listContactAvatarOptions(): Promise<ContactAvatarOption[]> {
 return (await loadLibrary()).map(({ id, label, category, hash }) => ({ id, label, category, hash }));
}
export async function readContactAvatarOption(id: string): Promise<{ bytes: Buffer; hash: string }> {
 // Resolve exclusively by the bundled whitelist, never by a client-supplied filename.
 const entry = (await loadLibrary()).find(option => option.id === id);
 if (!entry) throw new NoteWriteError("invalid_input", "这个内置头像不可用，请重新选择");
 return { bytes: entry.bytes, hash: entry.hash };
}
