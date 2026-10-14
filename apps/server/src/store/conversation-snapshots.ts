import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ConversationSnapshot {
 formatVersion: 1; id: string; sourceSessionId: string; sourceLeafEntryId: string;
 sourceWorkspaceId?: string; cwdSnapshot: string; createdAt: string; transcriptHash: string;
 entries: SessionEntry[]; assets: Array<{ ref: string; contentHash: string; bytes: number }>;
}
function canonical(value:unknown):unknown { return Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value; }
export const snapshotHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
async function durableFile(file: string, bytes: string | Buffer) { const fd = await open(file, "wx", 0o400); try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); } }
async function syncDir(dir: string) { const fd = await open(dir, "r"); try { await fd.sync(); } finally { await fd.close(); } }

/** Immutable snapshot objects. No update API and no source-session dependency. */
export class ConversationSnapshots {
 constructor(readonly root: string) {}
 private validId(id:string) { if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error("invalid snapshot id"); }
 async save(input: Omit<ConversationSnapshot, "formatVersion" | "createdAt" | "transcriptHash" | "assets">, files: string[]) {
  this.validId(input.id);
  await mkdir(this.root, { recursive: true });
  const target = path.join(this.root, input.id), temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(path.join(temp, "assets"), { recursive: true });
  try {
   const assets: ConversationSnapshot["assets"] = [], replacements = new Map<string, string>();
   for (const file of files) {
    const before = await stat(file);if(before.size>64*1024*1024)throw new Error("snapshot_assets_too_large");
    const bytes = await readFile(file), after = await stat(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("snapshot_asset_changed");
    const contentHash = createHash("sha256").update(bytes).digest("hex"), basename = `${contentHash}${path.extname(file)}`;
    const ref = path.join(target, "assets", basename);
    if (!assets.some(asset => asset.ref === ref)) { await durableFile(path.join(temp, "assets", basename), bytes); assets.push({ ref, contentHash, bytes: bytes.length }); }
    replacements.set(file, ref);
   }
   const replace = (value: unknown): unknown => typeof value === "string" ? [...replacements].sort((a,b) => b[0].length-a[0].length).reduce((text,[from,to]) => text.split(from).join(to),value)
    : Array.isArray(value) ? value.map(replace) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,replace(item)])) : value;
   const entries = replace(input.entries) as SessionEntry[];
   const unsigned = { ...input, entries, formatVersion: 1 as const, createdAt: new Date().toISOString(), assets };
   const snapshot: ConversationSnapshot = { ...unsigned, transcriptHash: snapshotHash(unsigned) };
   if(assets.reduce((total,asset)=>total+asset.bytes,0)>128*1024*1024)throw new Error("snapshot_assets_too_large");
   await durableFile(path.join(temp, "manifest.json"), JSON.stringify(snapshot));
   await syncDir(path.join(temp, "assets")); await syncDir(temp);
   await rename(temp, target); await syncDir(this.root);
   return snapshot;
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
 }
 async load(id: string): Promise<ConversationSnapshot> {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("invalid snapshot id");
  const snapshot = JSON.parse(await readFile(path.join(this.root,id,"manifest.json"),"utf8")) as ConversationSnapshot;
  const {transcriptHash,...unsigned}=snapshot;
  if (snapshot.id !== id || snapshot.formatVersion !== 1 || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.assets) || transcriptHash !== snapshotHash(unsigned)) throw new Error("snapshot_integrity_failed");
  for (const asset of snapshot.assets) {
   if (path.dirname(asset.ref) !== path.join(this.root,id,"assets")) throw new Error("snapshot_integrity_failed");
   const bytes = await readFile(asset.ref);
   if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.contentHash) throw new Error("snapshot_integrity_failed");
  }
  return snapshot;
 }
}
