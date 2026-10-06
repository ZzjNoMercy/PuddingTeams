import type { CalendarEvent, PublicationBatch } from "../knowledge/contracts.js";
import { publicationManifestHash } from "../knowledge/contracts.js";
import type { ContactsProjection } from "../knowledge/contacts.js";
import type { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import type { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { parseNoteFrontmatterFields } from "../knowledge/acceptance.js";
import type { KnowledgeObservationService } from "../knowledge/observation.js";
import type { KnowledgeObjectStore } from "../knowledge/objects.js";
import type { KnowledgeSourceStore } from "../knowledge/sources.js";
import type { ReviewStore } from "../knowledge/wiki/review-store.js";
import { resolveEffectiveSchema } from "../knowledge/schema-impact.js";
import { schemaContentPrefix } from "../knowledge/schema-layout.js";
import { validateTeamsNote } from "../knowledge/note-validation.js";
import { readKnowledgeOperationContract } from "../knowledge/operation-contract.js";
import { withKnowledgeMutation } from "../knowledge/mutation-lock.js";
import { readNoteBytes, resolveNoteAbsolutePath } from "../knowledge/observation.js";
import { hashBufferSha256 } from "../knowledge/hashing.js";
import { CalendarError, CalendarStore, normalizeCalendarInput } from "./store.js";

export interface CalendarInteractionState { status: "pending_review" | "published" | "needs_attention"; bindingId: string; path?: string; batchId?: string; reviewUrl?: string; noteUrl?: string; message: string }
export type LinkedCalendarEvent = CalendarEvent & { interactionState?: CalendarInteractionState };
export type WikiStatusSyncOutcome =
 | { ok: true; skipped: string }
 | { ok: true; path: string; changed: boolean }
 | { ok: false; error: string; path?: string };
export type StatusSyncedCalendarEvent = LinkedCalendarEvent & { wikiSync?: WikiStatusSyncOutcome };
/** One-hop wiki sync hook; wired in index.ts to setInteractionStatus with source "calendar". */
export type WikiInteractionStatusSync = (args: { ownerId: string; bindingId: string; path: string; status: "planned" | "done" | "cancelled"; occurredAt?: string }) => Promise<{ changed: boolean }>;
type Scope = readonly string[] | undefined;

/** Note filenames stay human-readable; the event id fallback keeps unusable titles safe. */
function interactionNoteSlug(title: string): string | undefined {
 const cleaned = [...title.replace(/[/\\:*?"<>|#[\]^]/g, " ").replace(/\s+/g, "-").replace(/^[.-]+|[.-]+$/g, "")].slice(0, 60).join("").replace(/[.-]+$/, "");
 return cleaned || undefined;
}

/** Calendar is the scheduling authority; Wiki receives immutable, reviewed projections. */
export class CalendarService {
 private tail: Promise<unknown> = Promise.resolve();
 private wikiStatusSync?: WikiInteractionStatusSync;
 setInteractionStatusSync(sync: WikiInteractionStatusSync): void { this.wikiStatusSync = sync; }
 constructor(readonly store: CalendarStore, private readonly deps: { contacts: ContactsProjection; bindings: KnowledgeBindingRegistry; acceptance: KnowledgeAcceptanceStore; observation: KnowledgeObservationService; objects: KnowledgeObjectStore; sources: KnowledgeSourceStore; reviews: ReviewStore }) {}
 private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.catch(() => undefined); return next; }
 private allowed(bindingId: string, scope: Scope) { if (scope && !scope.includes(bindingId)) throw new CalendarError("invalid_input", "这个人脉库未在当前会话挂载"); }
 async people(ownerId: string, query: string, vault?: string, scope?: Scope) {
  if (typeof query !== "string" || query.length > 200) throw new CalendarError("invalid_input", "搜索关键词无效");
  const bindings = (await this.deps.bindings.list(ownerId)).filter(b => b.availability === "available" && (!scope || scope.includes(b.id)) && (!vault || vault === b.id));
  if (vault && !bindings.length) throw new CalendarError("not_found", "人脉库不可访问");
  const result = [];
  for (const binding of bindings) {
   const schema = (await resolveEffectiveSchema(binding)).schema;
   if (!schema?.entities.some(e => e.type === "person")) continue;
   const view = await this.deps.contacts.load(ownerId, binding.id);
   const q = query.trim().toLowerCase();
   const people = view.people.filter(p => [p.name, p.company, p.role].join(" ").toLowerCase().includes(q));
   result.push({ bindingId: binding.id, name: binding.name, people: people.slice(0, 50).map(p => ({ personId: p.id, name: p.name, company: p.company, path: p.source.path })), total: people.length });
   await view.assertCurrent();
  }
  return { sources: result };
 }
 private async participants(ownerId: string, event: CalendarEvent, scope?: Scope, scan = true) {
  const people = [];
  for (const vault of new Set((event.participants ?? []).map(p => p.bindingId))) {
   this.allowed(vault, scope);
   const view = await this.deps.contacts.load(ownerId, vault, undefined, scan);
   for (const ref of event.participants ?? []) if (ref.bindingId === vault) {
    const person = view.people.find(p => p.id === ref.personId);
    if (!person) throw new CalendarError("revision_conflict", "参与人已移除或不可访问，请重新选择");
    if (!scan && hashBufferSha256(await readNoteBytes(await resolveNoteAbsolutePath(view.binding, person.source.path))) !== person.source.contentHash) throw new CalendarError("revision_conflict", "参与人页面已变化，请刷新后重试");
    people.push({ ...ref, name: person.name, path: person.source.path, contentHash: person.source.contentHash });
   }
   await view.assertCurrent();
  }
  return people;
 }
 async list(ownerId: string, scope?: Scope) { return Promise.all((await this.store.list(ownerId)).map(e => this.decorate(ownerId, e, scope))); }
 async get(ownerId: string, id: string, scope?: Scope) { const event = await this.store.get(ownerId, id); const visible = await this.decorate(ownerId, event, scope); return { ...visible, participantDetails: await this.participants(ownerId,visible,scope).catch(() => []) }; }
 private batchId(event: CalendarEvent) { return `calendar:${event.id}:${event.revision}`; }
 private async interactionHistory(ownerId: string, event: CalendarEvent) {
  return (await this.deps.reviews.list())
   .filter(r => r.ownerId === ownerId && r.batch.compilerVersion === "calendar-interaction-v1" && r.batch.id.startsWith(`calendar:${event.id}:`))
   .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
 }
 private async decorate(ownerId: string, event: CalendarEvent, scope?: Scope): Promise<LinkedCalendarEvent> {
  if (scope) {
   const { interaction, ...plain } = event;
   event = { ...plain, participants: event.participants?.filter(p => scope.includes(p.bindingId)), noteRefs: event.noteRefs.filter(p => scope.includes(p.bindingId)), ...(interaction && scope.includes(interaction.bindingId) ? { interaction } : {}) };
  }
  if (!event.interaction) return event;
  const { bindingId } = event.interaction;
  // Status transitions bump the revision without a new candidate; fall back to
  // the latest known batch so the linked note stays reachable.
  let record = await this.deps.reviews.get(this.batchId(event));
  if (!record) {
   const history = await this.interactionHistory(ownerId, event);
   record = history.find(r => r.status === "published") ?? history[0];
  }
  const usable = await this.deps.bindings.requireUsable(ownerId, bindingId).catch(() => null);
  if (!usable) return { ...event, interactionState: { bindingId, status: "needs_attention", message: "关联人脉库暂不可访问；日程已保存" } };
  const file = record?.batch.files[0], path = file?.targetPath;
  const status = record?.status === "published" ? "published" : record?.status === "pending_review" || record?.status === "approved" || record?.status === "publishing" ? "pending_review" : "needs_attention";
  return { ...event, noteRefs: path ? [{ bindingId, normalizedRelativePath: path }] : event.noteRefs,
   interactionState: { bindingId, status, ...(path ? { path, noteUrl: `/knowledge?${new URLSearchParams({ vault: bindingId, note: path })}` } : {}),
    ...(record ? { batchId: record.batch.id, reviewUrl: `/knowledge/review?batch=${encodeURIComponent(record.batch.id)}` } : {}),
    message: status === "published" ? "往来记录已发布" : status === "pending_review" ? "往来记录等待审核；日程已保存" : "日程已保存，往来记录尚未同步。请重试或在知识库处理" } };
 }
 async mutate(ownerId: string, action: "create" | "update" | "cancel", id: string | undefined, operationId: unknown, expectedRevision: unknown, input?: unknown, scope?: Scope, guard?: () => Promise<void>): Promise<StatusSyncedCalendarEvent> {
  // Cancellation is a status transition: it syncs the linked wiki note directly
  // and never creates a review candidate. Candidates remain a create/reschedule affair.
  if (action === "cancel") {
   if (typeof id !== "string" || !id) throw new CalendarError("invalid_input", "缺少日程 id");
   return this.setStatus(ownerId, id, operationId, expectedRevision, "cancelled", { scope, guard });
  }
  return this.serial(async () => {
   const normalized = normalizeCalendarInput(input);
   const replay = await this.store.replay(ownerId, action, id, operationId, expectedRevision, normalized);
   if (replay) {
    await guard?.();
    if (replay.interaction && (await this.store.get(ownerId,replay.id)).revision === replay.revision) await this.prepareInteraction(ownerId,replay,scope,guard).catch(() => undefined);
    return this.decorate(ownerId,replay,scope);
   }
   const prior = action === "create" ? undefined : await this.store.get(ownerId, id ?? "");
   if (prior?.interaction && (normalized && JSON.stringify(normalized.interaction) !== JSON.stringify(prior.interaction))) throw new CalendarError("invalid_input", "已有往来关联不能移除或改换目标库及类型；可调整日程和参与人");
   const preview = { ...(prior ?? {}), ...normalized } as CalendarEvent;
   await this.participants(ownerId, preview, scope);
   const vault = preview.interaction?.bindingId;
   if (vault) this.allowed(vault, scope);
   const commit = async () => {
    const refs = new Set([...(preview.participants ?? []).map(p => p.bindingId), ...(vault ? [vault] : [])]);
    return this.store.mutate(ownerId, action, id, operationId, expectedRevision, normalized, async () => {
     await guard?.();
     for (const ref of refs) { this.allowed(ref,scope); await this.deps.bindings.requireUsable(ownerId,ref); }
    });
   };
   // Same lock as Publisher: an old calendar revision cannot publish across a new commit.
   const event = vault ? await withKnowledgeMutation(vault, commit) : await commit();
   if (event.interaction) {
    try { await this.prepareInteraction(ownerId, event, scope, guard); }
    catch (error) { return { ...await this.decorate(ownerId, event, scope), interactionState: { bindingId: event.interaction.bindingId, status: "needs_attention" as const, message: `日程已保存；往来记录未同步：${error instanceof Error ? error.message : "请重试"}` } }; }
   }
   return this.decorate(ownerId, event, scope);
  });
 }
 /** Status transitions (confirmed ↔ done ↔ cancelled) take effect directly; the linked
  *  wiki interaction note is synced one hop and never enters the review pipeline. */
 async setStatus(ownerId: string, id: string, operationId: unknown, expectedRevision: unknown, status: CalendarEvent["status"], options: { scope?: Scope; guard?: () => Promise<void>; source?: "wiki" } = {}): Promise<StatusSyncedCalendarEvent> {
  return this.serial(async () => {
   if (status !== "confirmed" && status !== "done" && status !== "cancelled") throw new CalendarError("invalid_input", "日程状态无效");
   const prior = await this.store.get(ownerId, id);
   const vault = prior.interaction?.bindingId;
   if (vault) this.allowed(vault, options.scope);
   const commit = async () => this.store.setStatus(ownerId, id, operationId, expectedRevision, status, async () => {
    await options.guard?.();
    if (vault) { this.allowed(vault, options.scope); await this.deps.bindings.requireUsable(ownerId, vault); }
   });
   const event = vault ? await withKnowledgeMutation(vault, commit) : await commit();
   let wikiSync: WikiStatusSyncOutcome | undefined;
   if (event.interaction && options.source !== "wiki") {
    try { wikiSync = await this.syncWikiStatus(ownerId, event); }
    catch (error) { wikiSync = { ok: false, error: error instanceof Error ? error.message : "往来状态同步失败" }; }
   }
   const decorated = await this.decorate(ownerId, event, options.scope);
   return wikiSync ? { ...decorated, wikiSync } : decorated;
  });
 }
 private async syncWikiStatus(ownerId: string, event: CalendarEvent): Promise<WikiStatusSyncOutcome> {
  const bindingId = event.interaction?.bindingId;
  if (!bindingId) return { ok: true, skipped: "no_interaction" };
  if (!this.wikiStatusSync) return { ok: true, skipped: "sync_unavailable" };
  const published = (await this.interactionHistory(ownerId, event)).find(r => r.status === "published");
  const path = published?.batch.files[0]?.targetPath;
  if (!path) return { ok: true, skipped: "no_published_note" };
  const status = event.status === "confirmed" ? "planned" as const : event.status;
  const occurredAt = status === "done" ? (event.allDay ? `${event.startDate}T00:00:00.000Z` : event.start) : undefined;
  const result = await this.wikiStatusSync({ ownerId, bindingId, path, status, ...(occurredAt ? { occurredAt } : {}) });
  return { ok: true, path, changed: result.changed };
 }
 async retry(ownerId: string, id: string, scope?: Scope, guard?: () => Promise<void>) {
  return this.serial(async () => { const event = await this.store.get(ownerId, id); await this.prepareInteraction(ownerId, event, scope, guard); return this.decorate(ownerId, event, scope); });
 }
 private async prepareInteraction(ownerId: string, event: CalendarEvent, scope?: Scope, guard?: () => Promise<void>): Promise<void> {
  if (!event.interaction) throw new CalendarError("invalid_input", "此日程未关联往来记录");
  if (event.status !== "confirmed") throw new CalendarError("invalid_input", "已取消或已完成的日程不再生成往来候选；状态变更已直接同步往来笔记");
  const { bindingId } = event.interaction;
  this.allowed(bindingId, scope);
  if (await this.deps.reviews.get(this.batchId(event))) return;
  const people = await this.participants(ownerId, event, scope);
  const binding = await this.deps.bindings.requireUsable(ownerId, bindingId);
  await this.deps.observation.scan(binding);
  await withKnowledgeMutation(bindingId, async () => {
   if ((await this.store.get(ownerId, event.id)).revision !== event.revision) return;
   const effective = await resolveEffectiveSchema(binding), schema = effective.schema;
   const entity = schema?.entities.find(e => e.type === "interaction");
   if (!schema || !entity || event.allDay) throw new CalendarError("invalid_input", "此人脉库不支持定时往来记录，请在知识库配置结构");
   const prefix = await schemaContentPrefix(binding, schema);
   const ledger = await this.deps.acceptance.getSnapshot(bindingId);
   const batches = (await this.deps.reviews.list()).filter(r => r.ownerId === ownerId && r.batch.bindingId === bindingId);
   const history = batches.filter(r => r.batch.compilerVersion === "calendar-interaction-v1" && r.batch.id.startsWith(`calendar:${event.id}:`)).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
   const prior = history.find(r => r.status === "published");
   let path = history[0]?.batch.files[0]?.targetPath;
   if (!path) {
    const slug = interactionNoteSlug(event.title) ?? `calendar-${event.id}`;
    const taken = (p: string) => Object.values(ledger.entries).some(e => e.relativePath === p) || batches.some(r => r.batch.files.some(f => f.targetPath === p));
    path = `${prefix}${entity.directory}/${slug}.md`;
    if (taken(path)) path = `${prefix}${entity.directory}/${slug}-${event.id.slice(0, 8)}.md`;
    if (taken(path)) path = `${prefix}${entity.directory}/calendar-${event.id}.md`;
   }
   const base = Object.values(ledger.entries).find(e => e.relativePath === path);
   if (base && (!prior || prior.batch.files[0]?.candidateHash !== base.contentHash)) throw new CalendarError("revision_conflict", "往来页面已有独立修改，平台保留原文，请在知识库手动调整");
   if (!base && prior) throw new CalendarError("revision_conflict", "往来页面已移动或删除，平台不会重新创建");
   const time = new Intl.DateTimeFormat("zh-CN", { timeZone: event.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
   const timed = event as Extract<CalendarEvent, { allDay: false }>;
   const summary = `## 安排\n\n- 时间：${time.format(new Date(timed.start))} — ${time.format(new Date(timed.end))}（${event.timeZone}）\n- 地点：${event.location || "未填写"}\n- 参与人：你、${people.map(p => p.name.replace(/[\r\n]/g," ")).join("、")}\n- 状态：计划中，尚未确认实际发生\n`;
   const description = (event.description || "日历安排，尚未确认实际发生。").split(/\r?\n/).map(line => `> ${line}`).join("\n");
   const body = `# ${event.title.replace(/[\r\n]/g," ")}\n\n${summary}\n## 备注\n\n${description}\n\n[查看日程](/calendar?event=${encodeURIComponent(event.id)})\n`;
   const source = await this.deps.sources.createText(ownerId, `${body}\n日程版本：${event.revision}\n`, { channel: "agent_task" });
   const now = new Date().toISOString();
   const original = base ? parseNoteFrontmatterFields((await this.deps.objects.get(base.contentHash)).toString("utf8")) : {};
   const fields = { id: `calendar-${event.id}`, type: "interaction", title: event.title, created: original.created ?? now, updated: now, kind: event.interaction!.kind,
    status: "planned", occurredAt: event.start, endsAt: event.end, timeZone: event.timeZone, location: event.location,
    involves: people.map(p => p.path.replace(/\.md$/i, "")), sources: entity.fields.find(f => f.name === "sources")?.type === "text_list" ? [source.id] : [{ sourceId: source.id, snapshotPath: source.id }], calendarEventId: event.id, calendarRevision: event.revision };
   const errors = validateTeamsNote(schema, fields);
   if (errors.length) throw new CalendarError("invalid_input", `往来结构要求补充信息：${errors.join("、")}`);
   const content = `---\n${Object.entries(fields).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${body}`;
   const object = await this.deps.objects.put(Buffer.from(content));
   const contract = await readKnowledgeOperationContract(binding);
   const batch: PublicationBatch = { id: this.batchId(event), revision: 1, bindingId, manifestHash: "", rootIdentity: binding.rootIdentity,
    files: [{ operation: base ? "update" : "create", targetPath: path, expectedHashOrAbsent: base?.contentHash ?? null, candidateHash: object.hash }],
    sourceSnapshots: [source.originalHash, ...people.map(p => p.contentHash)], schemaHash: effective.schemaRef?.hash, contractHash: contract?.hash ?? null,
    bindingRevision: binding.bindingRevision, trustRevision: binding.trustRevision, dependencyGroups: [[path]], compilerVersion: "calendar-interaction-v1", status: "candidate",
    validationReceipt: JSON.stringify({ version: 1, sources: [source], reasons: { [path]: "根据日历安排生成往来记录；实际发生状态须人工确认" }, calendar: { ownerId, eventId: event.id, revision: event.revision, participants: people } }) };
   batch.manifestHash = publicationManifestHash(batch);
   await guard?.();
   this.deps.bindings.assertCurrentRevision(ownerId, bindingId, binding);
   await this.deps.reviews.registerCandidate(batch, ownerId);
  });
 }
 /** Called while Publisher holds the same binding mutation lock as calendar commits. */
 async assertPublicationCurrent(batch: PublicationBatch): Promise<void> {
  if (batch.compilerVersion !== "calendar-interaction-v1") return;
  const receipt = JSON.parse(batch.validationReceipt) as { calendar: { ownerId: string; eventId: string; revision: number; participants: Array<{ bindingId: string; personId: string; path: string; contentHash: string }> } };
  const event = await this.store.get(receipt.calendar.ownerId, receipt.calendar.eventId);
  if (event.revision !== receipt.calendar.revision || event.interaction?.bindingId !== batch.bindingId) throw new CalendarError("revision_conflict", "日程已改期或取消，此往来候选已过时，请审核最新日程对应的记录");
  const current = await this.participants(receipt.calendar.ownerId, event, undefined, false);
  const frozen = receipt.calendar.participants;
  if (!Array.isArray(frozen) || frozen.length !== current.length || frozen.some(p => !current.some(c => c.bindingId === p.bindingId && c.personId === p.personId && c.path === p.path && c.contentHash === p.contentHash))) throw new CalendarError("revision_conflict", "参与人资料或路径已变化，此往来候选已过时，请重新整理后审核");
 }
}
