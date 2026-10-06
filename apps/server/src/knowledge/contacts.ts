import { createHash } from "node:crypto";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import { parseNoteFrontmatterFields, type KnowledgeAcceptanceStore } from "./acceptance.js";
import type { KnowledgeObjectStore } from "./objects.js";
import type { KnowledgeObservationService } from "./observation.js";
import { KnowledgeSearchIndex, type IndexedNote } from "./search-index.js";
import { resolveEffectiveSchema } from "./schema-impact.js";
import { parseNoteLinks, resolveMarkdownLinkTarget, resolveWikiLink } from "./links.js";
import type { TeamsSchemaPreset } from "./schema-presets.js";
import { contactAvatarAsset, resolveContactAvatar, withContactAvatar } from "./contact-avatar.js";
import { relativeImagePath } from "./image-publication.js";
import { writeKnowledgeNote } from "./note-write.js";
import { readContactAvatarOption } from "../contact-avatar-defaults.js";
import { imageAssetPath } from "./image-publication.js";

export interface ContactSource { path: string; title: string; contentHash: string; anchor?: string }
export interface ContactAffiliation { org: ContactSource; role: string; status: "current" | "former" | null; startDate: string | null; endDate: string | null; source: ContactSource }
export interface ContactSummary {
 id: string; name: string; company: string; role: string; location: string; topics: string[]; groups: string[];
 lastContact: string | null; source: ContactSource; affiliations: ContactAffiliation[]; avatar?: string;
}
export interface ContactRelation { kind: string; label: string; source: ContactSource; snippet: string; description: string; occurredAt: string | null }
export interface ContactDetail extends ContactSummary { email: string; phone: string; summary: string; relations: ContactRelation[] }
export interface ContactGraphEdge { id: string; from: string; to: string; label: string; doneCount: number; plannedCount: number; lastInteractionAt: string | null; directCount: number }
export interface ContactParticipant { id: string; name: string; isSelf?: boolean }
export interface ContactInteraction { id: string; title: string; status: "done" | "planned" | "cancelled" | "unknown"; occurredAt: string | null; location: string; kind: string; summary: string; participants: ContactParticipant[]; source: ContactSource }
export interface ContactDirectRelation { from: string; to: string; kind: string; label: string; source: ContactSource; snippet: string }
export interface ContactGraphEvidence { edge: ContactGraphEdge; interactions: ContactInteraction[]; relations: ContactDirectRelation[] }
export class ContactsError extends Error {
 constructor(readonly code: "invalid_input" | "not_found" | "revision_conflict" | "context_unavailable", message: string) { super(message); }
}
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const texts = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : [];
const sourceOf = (note: IndexedNote, anchor?: string): ContactSource => ({ path: note.path, title: note.title, contentHash: note.contentHash, ...(anchor ? { anchor } : {}) });
const introOf = (note: IndexedNote) => note.text.split(/\n\s*\n/).find(part => part.trim() && !/^(?:#|```|~~~|[-*]\s*[A-Za-z_]+\s*:)/.test(part.trim()))?.trim().slice(0, 1500) ?? "";
const labels: Record<string, string> = { held_by: "任职关系", at_org: "关联公司", involves: "实际往来", has_participant: "参与会议", participants: "参与会议", owner: "负责", related_people: "明确关联", belongs_to: "所属圈层", participates_in: "共同项目", shares: "共同话题", introduced_by: "介绍人", mentions: "被提及" };
function recordedDate(value: unknown): string | null {
 const date = text(value);
 if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date)) return null;
 const parts = date.slice(0, 10).split("-").map(Number), day = new Date(`${date.slice(0, 10)}T12:00:00Z`);
 return Number.isFinite(Date.parse(date)) && day.getUTCFullYear() === parts[0] && day.getUTCMonth() + 1 === parts[1] && day.getUTCDate() === parts[2] ? date : null;
}
/** Only explicit relation labels form semantic edges; an unlabelled backlink is a mention. */
function relationKind(context: string, schema: TeamsSchemaPreset | undefined, from: string, to: string): string {
 const explicit = /^\s*(?:[-*]\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/.exec(context)?.[1];
 if (["participants", "owner", "related_people"].includes(explicit ?? "")) return explicit!;
 const relation = schema?.relations.find(item => item.type === explicit && (item.endpoints ?? [{ from: item.from!, to: item.to! }]).some(pair => pair.from === from && pair.to === to));
 return relation ? relation.type : "mentions";
}

export class ContactsProjection {
 constructor(private readonly deps: { bindings: KnowledgeBindingRegistry; acceptance: KnowledgeAcceptanceStore; observation: KnowledgeObservationService; objects: KnowledgeObjectStore; searchIndex: KnowledgeSearchIndex }) {}
 async setAvatar(ownerId: string, vault: string, id: string, input: { expectedHash: string; image: string | null } | { expectedHash: string; builtinId: string }) {
  const view = await this.load(ownerId, vault);
  const person = view.people.find(item => item.id === id);
  if (!person) throw new ContactsError("not_found", "此人物已移除或不可访问");
  if (person.source.contentHash !== input.expectedHash) throw new ContactsError("revision_conflict", "人物笔记已更新，请刷新后再更换头像");
  const content = (await this.deps.objects.get(person.source.contentHash)).toString("utf8");
  let asset;
  if ("builtinId" in input) {
   const preset = await readContactAvatarOption(input.builtinId);
   asset = { path: imageAssetPath(preset.hash, "image/png", person.source.path.startsWith("wiki/") ? "wiki/" : ""), bytes: preset.bytes };
  } else asset = input.image === null ? undefined : contactAvatarAsset(person.source.path, input.image);
  return writeKnowledgeNote(this.deps.bindings, this.deps.observation, this.deps.acceptance, ownerId, vault, {
   path: person.source.path, expectedHash: input.expectedHash,
   content: withContactAvatar(content, asset ? relativeImagePath(person.source.path, asset.path) : null),
  }, asset);
 }
 async load(ownerId: string, vault: string, expectedRevision?: number, scan = true) {
  if (!vault) throw new ContactsError("invalid_input", "请先选择人脉知识库");
  const binding = await this.deps.bindings.requireUsable(ownerId, vault);
  if (scan) await this.deps.observation.scan(binding);
  const ledger = await this.deps.acceptance.getSnapshot(vault);
  if (expectedRevision !== undefined && ledger.acceptanceRevision !== expectedRevision) throw new ContactsError("revision_conflict", "资料已更新，请刷新通讯录");
  const index = await this.deps.searchIndex.load(vault, ledger), effective = await resolveEffectiveSchema(binding);
  if (index.diagnostics.length) throw new ContactsError("context_unavailable", "部分来源快照不可读，请刷新后重试");
  const fields = new Map<string, Record<string, unknown>>();
  const allNotes = [...index.notes.values()];
  // Bounded concurrency; snapshots, never a second contact store or live-disk body.
  for (let offset = 0; offset < allNotes.length; offset += 32) await Promise.all(allNotes.slice(offset, offset + 32).map(async note => {
   const bytes = await this.deps.objects.get(note.contentHash);
   fields.set(note.path, parseNoteFrontmatterFields(bytes.toString("utf8")));
  }));
  const typeOf = (note: IndexedNote) => text(fields.get(note.path)?.type);
  const edges = new Map<string, ContactRelation[]>();
  const outgoing = new Map<string, Array<{ kind: string; target: IndexedNote; snippet: string }>>();
  for (const note of allNotes) {
   const f = fields.get(note.path)!;
   const seen = new Set<string>();
   // Relation examples in code are not facts; frontmatter note_refs are explicit.
   let fence = "";
   const body = note.text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n").filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker[0]!; else if (marker[0] === fence) fence = ""; return false; }
    return !fence;
   }).map(line => line.replace(/`+[^`]*`+/g, "")).join("\n");
   const asLink = (value: string) => /\[\[|\]\(/.test(value) ? value : `[[${value}]]`;
   const references = ["involves", "has_participant", "participants", "owner", "related_people"].flatMap(kind => texts(f[kind]).map(value => `${kind}: ${asLink(value)}`)).join("\n");
   const bareReferences = body.split("\n").flatMap(line => {
    const match = /^\s*[-*]?\s*(involves|has_participant|participants):\s*([^\[\]`]+?)\s*$/.exec(line);
    return match && !/[()]/.test(match[2]!) ? [`${match[1]}: ${asLink(match[2]!)}`] : [];
   }).join("\n");
   const parsed = parseNoteLinks(`${body}\n${references}\n${bareReferences}`);
   for (const link of [...parsed.wikiLinks, ...parsed.mdLinks]) {
    const resolved = link.kind === "wiki" ? resolveWikiLink([...index.notesByPath.keys()], link.target) : null;
    const resolvedPath = link.kind === "wiki" ? resolved?.status === "ok" ? resolved.path : undefined : resolveMarkdownLinkTarget(note.path, link.target);
    const target = resolvedPath ? index.notesByPath.get(resolvedPath) : undefined;
    if (!target || target.path === note.path) continue;
    const kind = relationKind(link.context, effective.schema, typeOf(note), typeOf(target));
    const key = `${kind}\0${target.path}`; if (seen.has(key)) continue; seen.add(key);
    outgoing.set(note.path, [...(outgoing.get(note.path) ?? []), { kind, target, snippet: link.context }]);
    const actual = (typeOf(note) === "interaction" && kind === "involves" || typeOf(note) === "meeting" && ["has_participant", "participants"].includes(kind)) && text(f.status) === "done";
    const candidateDate = actual ? recordedDate(f.occurredAt) : null;
    const date = candidateDate && Date.parse(candidateDate) <= Date.now() ? candidateDate : null;
    const isInteraction = ["involves", "has_participant", "participants"].includes(kind);
    const plannedAt = isInteraction && text(f.status) === "planned" ? recordedDate(f.occurredAt) : null;
    const label = isInteraction ? plannedAt && Date.parse(plannedAt) <= Date.now() ? "逾期" : text(f.status) === "planned" ? "计划" : text(f.status) === "cancelled" ? "已取消" : date ? labels[kind] ?? "实际往来" : "往来日期或状态未确认" : labels[kind] ?? "明确关联";
    edges.set(target.path, [...(edges.get(target.path) ?? []), { kind, label, source: sourceOf(note), snippet: link.context, description: text(f.summary) || introOf(note), occurredAt: date }]);
   }
  }
  const affiliationsByPerson = new Map<string, ContactAffiliation[]>();
  const warnings = [...effective.warnings];
  for (const note of allNotes.filter(note => typeOf(note) === "affiliation")) {
   const links = outgoing.get(note.path) ?? [];
   const holders = links.filter(link => link.kind === "held_by"), orgs = links.filter(link => link.kind === "at_org");
   if (holders.length !== 1 || orgs.length !== 1) { warnings.push(`任职关系 ${note.path} 需要唯一的人物和公司端点，未用于公司投影。`); continue; }
   const f = fields.get(note.path)!;
   const status = text(f.status);
   const affiliation: ContactAffiliation = { org: sourceOf(orgs[0]!.target), role: text(f.role), status: status === "current" || status === "former" ? status : null,
    startDate: recordedDate(f.startDate), endDate: recordedDate(f.endDate), source: sourceOf(note) };
   const holder = holders[0]!.target.path;
   affiliationsByPerson.set(holder, [...(affiliationsByPerson.get(holder) ?? []), affiliation]);
  }
  const people = allNotes.filter(note => typeOf(note) === "person").map((note): ContactDetail => {
   const f = fields.get(note.path)!, links = outgoing.get(note.path) ?? [];
   const affiliations = affiliationsByPerson.get(note.path) ?? [];
   const orgRelations = [...new Map(affiliations.map(item => [item.org.path, { kind: "at_org", label: "关联公司", source: item.org, snippet: "", description: "", occurredAt: null }])).values()];
   const relations = [...(edges.get(note.path) ?? []), ...orgRelations, ...links.map(({ kind, target }) => ({ kind, label: labels[kind] ?? "明确关联", source: sourceOf(target), snippet: "", description: text(fields.get(target.path)?.summary) || introOf(target), occurredAt: null }))];
   // One occurrence per note identity even when it contains several participant references.
   const dated = relations.filter(item => item.occurredAt).sort((a, b) => Date.parse(b.occurredAt!) - Date.parse(a.occurredAt!));
   const body = introOf(note);
   const id = createHash("sha256").update(JSON.stringify([vault, ledger.entries[note.identityKey]?.noteId ?? note.identityKey])).digest("hex");
   return { id, name: text(f.name) || text(f.title) || "姓名未记录", company: [...new Set(affiliations.map(item => item.org.title))].join(" / "),
    role: affiliations.map(item => `${item.org.title}：${item.role || "身份未记录"}${item.status === "former" ? "（历史）" : item.status === null ? "（状态未记录）" : ""}`).join(" / "), affiliations, location: text(f.location),
    topics: [...new Set([...texts(f.topics), ...texts(f.tags), ...links.filter(item => item.kind === "shares").map(item => item.target.title)])],
    groups: [...new Set(links.filter(item => item.kind === "belongs_to").map(item => item.target.title))],
    lastContact: dated[0]?.occurredAt ?? null, source: sourceOf(note), avatar: resolveContactAvatar(note.path, f.avatar), email: text(f.email), phone: text(f.phone), summary: text(f.summary) || body.slice(0, 1500), relations };
  });
  // Events remain the facts; unordered person pairs are a rebuildable projection.
  const personByPath = new Map(people.map(person => [person.source.path, person]));
  const self = { id: createHash("sha256").update(JSON.stringify([vault, "self", ownerId])).digest("hex"), name: "你", isSelf: true as const };
  const graphEvidence = new Map<string, ContactGraphEvidence>();
  const pair = (a: string, b: string) => {
   const [from, to] = [a, b].sort();
   const id = createHash("sha256").update(JSON.stringify([vault, from, to])).digest("hex");
   let result = graphEvidence.get(id);
   if (!result) {
    result = { edge: { id, from: from!, to: to!, label: "人物关联", doneCount: 0, plannedCount: 0, lastInteractionAt: null, directCount: 0 }, interactions: [], relations: [] };
    graphEvidence.set(id, result);
   }
   return result;
  };
  for (const person of people) for (const link of outgoing.get(person.source.path) ?? []) {
   const target = personByPath.get(link.target.path);
   if (!target) continue;
   pair(person.id, target.id).relations.push({ from: person.id, to: target.id, kind: link.kind, label: link.kind === "mentions" ? "人物链接" : labels[link.kind] ?? link.kind,
    source: person.source, snippet: link.snippet });
  }
  for (const note of allNotes) {
   const type = typeOf(note);
   if (type !== "interaction" && type !== "meeting") continue;
   const participantKinds = type === "interaction" ? ["involves"] : ["has_participant", "participants"];
   const participants: ContactParticipant[] = [...new Map((outgoing.get(note.path) ?? [])
    .filter(link => participantKinds.includes(link.kind)).flatMap(link => {
     const person = personByPath.get(link.target.path);
     return person ? [[person.id, { id: person.id, name: person.name }] as const] : [];
    })).values()];
   // The People interaction contract explicitly means the owner's participation.
   // Meeting notes and ordinary mentions do not imply the owner attended.
   if (type === "interaction") participants.push(self);
   if (participants.length < 2) continue;
   const f = fields.get(note.path)!, occurredAt = recordedDate(f.occurredAt), declared = text(f.status);
   const status = declared === "planned" || declared === "cancelled" ? declared : declared === "done" && occurredAt && Date.parse(occurredAt) <= Date.now() ? "done" : "unknown";
   const event: ContactInteraction = { id: createHash("sha256").update(JSON.stringify([vault, ledger.entries[note.identityKey]?.noteId ?? note.identityKey])).digest("hex"),
    title: note.title, status, occurredAt, location: text(f.location), kind: text(f.kind), summary: text(f.summary), participants, source: sourceOf(note) };
   for (let i = 0; i < participants.length; i++) for (let j = i + 1; j < participants.length; j++) pair(participants[i]!.id, participants[j]!.id).interactions.push(event);
  }
  for (const evidence of graphEvidence.values()) {
   evidence.interactions = [...new Map(evidence.interactions.map(item => [item.id, item])).values()]
    .sort((a, b) => (b.occurredAt ? Date.parse(b.occurredAt) : -Infinity) - (a.occurredAt ? Date.parse(a.occurredAt) : -Infinity) || a.id.localeCompare(b.id));
   const done = evidence.interactions.filter(item => item.status === "done");
   evidence.edge.doneCount = done.length;
   evidence.edge.plannedCount = evidence.interactions.filter(item => item.status === "planned").length;
   evidence.edge.lastInteractionAt = done[0]?.occurredAt ?? null;
   evidence.edge.directCount = evidence.relations.length;
   evidence.edge.label = done.length ? "共同往来" : evidence.edge.plannedCount ? "计划往来" : evidence.relations[0]?.label ?? "人物关联";
  }
  const graphEdges = [...graphEvidence.values()].filter(item => item.edge.doneCount || item.edge.plannedCount || item.edge.directCount).map(item => item.edge);
  const assertCurrent = async () => {
   this.deps.bindings.assertCurrentRevision(ownerId, vault, binding);
   const latest = await this.deps.bindings.requireUsable(ownerId, vault);
   if (latest.schemaRef?.hash !== effective.schemaRef?.hash) throw new ContactsError("revision_conflict", "人物结构已更新，请刷新通讯录");
   if ((await this.deps.acceptance.getSnapshot(vault)).acceptanceRevision !== ledger.acceptanceRevision) throw new ContactsError("revision_conflict", "资料在读取期间已更新，请重试");
   this.deps.bindings.assertCurrentRevision(ownerId, vault, binding);
  };
  await assertCurrent();
  return { binding, revision: ledger.acceptanceRevision, people, self, graphEdges, graphEvidence, warnings, assertCurrent, index };
 }
 async source(ownerId: string, vault: string, personId: string, relativePath: string, hash: string) {
  const view = await this.load(ownerId, vault);
  const person = view.people.find(person => person.id === personId);
  if (!person) throw new ContactsError("not_found", "此人物已移除或不可访问");
  const allowed = [person.source, ...person.relations.map(item => item.source)].find(source => source.path === relativePath && source.contentHash === hash);
  if (!allowed) throw new ContactsError("revision_conflict", "来源版本或关系已变化，请刷新通讯录");
  const content = (await this.deps.objects.get(hash)).toString("utf8");
  await view.assertCurrent();
  return { ...allowed, content };
 }
}
