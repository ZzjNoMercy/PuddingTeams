import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiSessionStore } from "./session-store.js";
import type { MessageSubmissionOperations, NativeMessageReceipt } from "../store/message-submission-operations.js";
import type { ChatKnowledgeIntake, ChatSourceRefs } from "../knowledge/chat-intake.js";

type Pending = { key: string; hash: string; contextHash: string; text: string; refs?: ChatSourceRefs; prior: Set<string>; receipt?: NativeMessageReceipt };
const textOf = (content: unknown) => typeof content === "string" ? content.trim() : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n").trim() : "";

/** Observes the SDK queue. It never schedules or replays a queued message. */
export class NativeInput {
 readonly processId = randomUUID();
 private pending = new Map<string, Map<string, Pending>>();
 private observing = new Map<string, Promise<void>>();
 private watched = new Map<string,()=>void>();
 private seen = new Map<string, Set<string>>();
 constructor(private store: PiSessionStore, private operations?: MessageSubmissionOperations, private intakes?: ChatKnowledgeIntake) {
  store.setNativeInputLifecycle(id => this.hasPending(id), id => this.cancel(id));
  store.setBeforeNativeStream(async session => { await store.ensureSessionFile(session.sessionId); await this.observe(session); await intakes?.admitManager(session); });
 }
 async hasPending(id: string) {
  for (const record of await this.operations?.pending(id) ?? []) {
   const entry = await this.store.messageAdmission(id,record.key,record.requestHash,record.contextHash);
   if (entry) { await this.operations!.markAccepted(record.key,id,record.requestHash,{ ...record.receipt!, persistence:"durable", userEntryId:entry }); this.pending.get(id)?.delete(record.key); }
  }
  return Boolean(this.pending.get(id)?.size || (await this.operations?.pending(id))?.length);
 }
 async cancel(id: string) {
  for (const row of await this.operations?.pending(id) ?? []) await this.operations!.markAccepted(row.key, id, row.requestHash, { ...row.receipt!, terminal: "cancelled_unconfirmed" });
  this.pending.delete(id);this.seen.delete(id);this.watched.get(id)?.();this.watched.delete(id);
 }
 async replay(key: string) {
  const record = await this.operations?.get(key);
  let receipt = record?.receipt;
  if (record && receipt?.persistence === "pending") { const entry = await this.store.messageAdmission(record.sessionId,key,record.requestHash,record.contextHash); if(entry) { receipt={...receipt,persistence:"durable",userEntryId:entry}; await this.operations!.markAccepted(key,record.sessionId,record.requestHash,receipt); } }
  if (!receipt) return undefined;
  if (receipt.terminal || receipt.persistence === "pending" && receipt.processId !== this.processId) throw new Error("message_delivery_unconfirmed");
  return receipt;
 }
 reject(id: string, key: string) { this.pending.get(id)?.delete(key); }
 track(session: AgentSession, input: Omit<Pending, "prior"> & {delivery: "followUp" | "steer"}) {
  let entries = this.pending.get(session.sessionId); if (!entries) this.pending.set(session.sessionId, entries = new Map());
  entries.set(input.key, { ...input, receipt:{operationId:input.key,processId:this.processId,disposition:"queued",delivery:input.delivery,persistence:"pending"}, prior: new Set(session.sessionManager.getBranch().map(entry => entry.id)) });
 }
 async accept(id: string, key: string, hash: string, receipt: Omit<NativeMessageReceipt, "processId" | "operationId">) {
  const result: NativeMessageReceipt = { ...receipt, processId: this.processId, operationId: key };
  const pending = this.pending.get(id)?.get(key);
  if (pending) pending.receipt = result;
  if (result.disposition !== "queued") this.pending.get(id)?.delete(key);
  await this.operations?.markAccepted(key, id, hash, result);
  if (result.disposition === "queued") await this.observe(await this.store.open(id));
  return (await this.operations?.get(key))?.receipt ?? result;
 }
 watch(id: string) {
  if (this.watched.has(id)) return;
  const unsubscribe=this.store.subscribe(id, event => {
   if (event.type === "message_end" && event.message.role === "user") queueMicrotask(() => { void this.store.open(id).then(session => this.observe(session)).catch(() => {}); });
  });
  this.watched.set(id,unsubscribe);return unsubscribe;
 }
 private async observe(session: AgentSession) {
  const prior = this.observing.get(session.sessionId) ?? Promise.resolve();
  const action = prior.then(() => this.observeUnlocked(session), () => this.observeUnlocked(session));
  this.observing.set(session.sessionId, action.catch(() => {})); return action;
 }
 private async observeUnlocked(session: AgentSession) {
  const entries = this.pending.get(session.sessionId); if (!entries?.size || !session.sessionFile) return;
  const disk = new Set(readFileSync(session.sessionFile, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line).id; } catch { return undefined; } }));
  let seen = this.seen.get(session.sessionId); if (!seen) this.seen.set(session.sessionId, seen = new Set());
  for (const entry of session.sessionManager.getBranch()) {
   if (entry.type !== "message" || entry.message.role !== "user" || !disk.has(entry.id) || seen.has(entry.id)) continue;
   const userContent = entry.message.content;
   const matches = [...entries.values()].filter(item => item.receipt?.disposition === "queued" && !item.prior.has(entry.id) && item.text.trim() === textOf(userContent));
   // SDK users have no operationId. Identical queued intents are ambiguous;
   // leave both pending instead of inventing identity from text/order.
   if (matches.length !== 1) continue;
   const item = matches[0]!;
   if (item.refs) await this.intakes?.admitQueued(session, item.refs, entry.id);
   await this.store.appendMessageAdmission(session.sessionId, { operationId: item.key, requestHash: item.hash, contextHash: item.contextHash, userEntryId: entry.id });
   await this.operations?.markAccepted(item.key, session.sessionId, item.hash, { ...item.receipt!, persistence: "durable", userEntryId: entry.id });
   entries.delete(item.key); seen.add(entry.id);
  }
 }
}
