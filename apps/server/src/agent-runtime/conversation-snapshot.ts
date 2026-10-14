import { readdir } from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Export committed conversation facts, never source runtime authority. */
export function snapshotEntries(branch: SessionEntry[]): SessionEntry[] {
 const calls = new Set<string>(), results = new Set<string>();
 const entries: SessionEntry[] = [];
 for (const entry of branch) {
  if (entry.type === "message" && ["user","assistant","toolResult"].includes(entry.message.role)) {
   const message = structuredClone(entry.message);
   if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") { if (calls.has(block.id)) throw new Error("snapshot_incompatible_history: duplicate tool call"); calls.add(block.id); }
   if (message.role === "toolResult") { if (results.has(message.toolCallId) || !calls.has(message.toolCallId)) throw new Error("snapshot_incompatible_history: orphan tool result"); results.add(message.toolCallId); message.details = { historical: true }; }
   entries.push({ ...entry, message });
  } else if (entry.type === "compaction") entries.push({ type: "compaction", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore });
  else if (entry.type === "custom_message" && ["pudding:task_assign","pudding:task_result","pudding:session_goal"].includes(entry.customType)) entries.push({ ...entry, details: { historical: true, ...Object.fromEntries(Object.entries((entry.details??{}) as Record<string,unknown>).filter(([key])=>["worker","status","taskId","from"].includes(key))) }, display: true });
 }
 if ([...calls].some(id => !results.has(id))) throw new Error("fork_source_busy: unfinished tool call");
 return entries;
}

/** Convert Manager-only large-result pointers into Worker-readable immutable file references. */
export async function includeOffloadedResults(entries: SessionEntry[], original: SessionEntry[], roots:string[]) {
 const {stat}=await import("node:fs/promises");
 const sources=original.filter(entry=>entry.type==="message"&&entry.message.role==="toolResult");
 for(const entry of entries) {
  if(entry.type!=="message"||entry.message.role!=="toolResult")continue;
  const toolCallId=entry.message.toolCallId;
  const source=sources.find(item=>item.type==="message"&&item.message.role==="toolResult"&&item.message.toolCallId===toolCallId);
  if(!source||source.type!=="message"||source.message.role!=="toolResult")continue;
  const result=(source.message.details as {largeResult?:{offloaded?:boolean;delegationId?:string}})?.largeResult;
  if(!result?.offloaded||!result.delegationId||!/^[A-Za-z0-9_-]+$/.test(result.delegationId))continue;
  const root=roots.find(root=>path.basename(root)==="large-worker-results");if(!root)throw new Error("snapshot_asset_missing");
  const file=path.join(root,result.delegationId+".txt");await stat(file).catch(()=>{throw new Error("snapshot_asset_missing");});
  entry.message.content.push({type:"text",text:`历史完整结果文件：${file}（使用 read 分段读取）`});
 }
}
export async function referencedSnapshotFiles(entries: SessionEntry[], roots: string[]): Promise<string[]> {
 const text = JSON.stringify(entries), files: string[] = [];
 const walk = async (dir: string) => {
  for (const item of await readdir(dir,{withFileTypes:true}).catch((error: NodeJS.ErrnoException) => { if(error.code === "ENOENT") return []; throw error; })) {
   const file = path.join(dir,item.name);
   if (item.isDirectory()) await walk(file);
   else if (item.isFile() && text.includes(file)) files.push(file);
  }
 };
 for (const root of roots) await walk(root);
 return [...new Set(files)];
}
