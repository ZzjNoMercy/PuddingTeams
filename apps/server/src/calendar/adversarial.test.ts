import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { KnowledgeObservationService } from "../knowledge/observation.js";
import { KnowledgeSearchIndex } from "../knowledge/search-index.js";
import { KnowledgeSourceStore } from "../knowledge/sources.js";
import { ContactsProjection } from "../knowledge/contacts.js";
import { copySchemaPreset } from "../knowledge/schema-presets.js";
import { ReviewStore } from "../knowledge/wiki/review-store.js";
import { PublishJournal } from "../knowledge/wiki/publish-journal.js";
import { MarkdownWikiPublisher, PublishCrashError } from "../knowledge/wiki/publisher-markdown.js";
import type { PublishStepHook } from "../knowledge/wiki/publisher-markdown.js";
import { CalendarStore } from "./store.js";
import { CalendarService } from "./service.js";
import { calendarTools } from "./tools.js";

const owner = "calendar-adversarial-owner";

async function fixture() {
 const base = await mkdtemp(path.join(tmpdir(), "pt-calendar-adversarial-"));
 const root = path.join(base, "wiki");
 await mkdir(path.join(root, "People"), { recursive: true });
 await writeFile(path.join(root, "wiki.schema.json"), JSON.stringify(copySchemaPreset("people")));
 for (const [id, name] of [["a", "参与人甲"], ["b", "参与人乙"]]) {
  await writeFile(path.join(root, `People/${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${name}\n---\n`);
 }
 const bindings = new KnowledgeBindingRegistry(path.join(base, "bindings"));
 const objects = new KnowledgeObjectStore(path.join(base, "objects"));
 const acceptance = new KnowledgeAcceptanceStore(path.join(base, "accepted"));
 const binding = await bindings.create({ ownerId: owner, name: "隔离人脉", description: "审查夹具", rootPath: root });
 const reviews = new ReviewStore(path.join(base, "reviews"));
 const journal = new PublishJournal(path.join(base, "operations"));
 const searchIndex = new KnowledgeSearchIndex(path.join(base, "cache"), objects);
 const observation = new KnowledgeObservationService(acceptance, { objects, journal, searchIndex });
 const contacts = new ContactsProjection({ bindings, objects, acceptance, observation, searchIndex });
 const sources = new KnowledgeSourceStore({ stateDir: path.join(base, "sources"), objects });
 const store = new CalendarStore(path.join(base, "calendar"));
 const service = new CalendarService(store, { contacts, bindings, objects, acceptance, observation, sources, reviews });
 const makePublisher = (stepHook?: PublishStepHook) => new MarkdownWikiPublisher({
  bindings, objects, acceptance, observation, searchIndex, reviews, journal,
  operationsDir: path.join(base, "operations"), assertSourceCurrent: batch => service.assertPublicationCurrent(batch), stepHook,
 });
 const people = (await service.people(owner, "", binding.id)).sources[0]!.people;
 const input = {
  title: "饭局", kind: "event", busy: true, timeZone: "Asia/Shanghai", allDay: false,
  start: "2026-10-05T20:00:00+08:00", end: "2026-10-05T21:00:00+08:00",
  participants: people.map(person => ({ bindingId: binding.id, personId: person.personId })),
  interaction: { bindingId: binding.id, kind: "meal" },
 };
 async function approve(batchId: string) {
  const record = (await reviews.get(batchId))!;
  const { decision } = await reviews.decide({
   batchId, operationId: `approve-${batchId}`, actorId: owner, decision: "approve",
   manifestHash: record.batch.manifestHash,
   reviewedFiles: record.batch.files.map(file => file.targetPath),
  });
  return { batch: record.batch, decision };
 }
 return { base, root, binding, store, service, reviews, objects, acceptance, observation, makePublisher, input, approve };
}

test("calendar recovery does not adopt an uncommitted projection after the event is rescheduled", async () => {
 const f = await fixture();
 try {
  const event = await f.service.mutate(owner, "create", undefined, "create", 0, f.input, [f.binding.id]);
  const { batch, decision } = await f.approve(event.interactionState!.batchId!);
  const crashing = f.makePublisher(step => { if (step === "write") throw new PublishCrashError("after bytes, before ledger"); });
  await assert.rejects(crashing.onApproved(batch, decision), PublishCrashError);
  assert(!Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries).some(entry => entry.relativePath === batch.files[0]!.targetPath));
  await f.service.mutate(owner, "update", event.id, "reschedule", 1, {
   ...f.input, start: "2026-10-06T20:00:00+08:00", end: "2026-10-06T21:00:00+08:00",
  }, [f.binding.id]);
  await f.makePublisher().reconcileInterrupted();
  assert.equal((await f.store.get(owner, event.id)).revision, 2);
  assert.notEqual((await f.reviews.get(batch.id))!.status, "published");
  assert(!Object.values((await f.acceptance.getSnapshot(f.binding.id)).entries).some(entry => entry.relativePath === batch.files[0]!.targetPath && entry.contentHash === batch.files[0]!.candidateHash), "old revision must not enter the effective ledger");
  await assert.rejects(readFile(path.join(f.root, batch.files[0]!.targetPath)), { code: "ENOENT" });
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("calendar approval rejects a participant path replaced by another person after candidate generation", async () => {
 const f = await fixture();
 try {
  const event = await f.service.mutate(owner, "create", undefined, "create", 0, f.input, [f.binding.id]);
  await rename(path.join(f.root, "People/a.md"), path.join(f.root, "People/renamed.md"));
  await writeFile(path.join(f.root, "People/a.md"), "---\nid: newcomer\ntype: person\ntitle: 不在日程中的新人\n---\n");
  await f.observation.scan(f.binding);
  const { batch, decision } = await f.approve(event.interactionState!.batchId!);
  await f.makePublisher().onApproved(batch, decision);
  assert.equal((await f.reviews.get(batch.id))!.status, "conflict");
  await assert.rejects(readFile(path.join(f.root, batch.files[0]!.targetPath)), { code: "ENOENT" });
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("calendar details keep platform scheduling available without exposing unmounted Wiki participants or paths", async () => {
 const f = await fixture();
 try {
  const event = await f.service.mutate(owner, "create", undefined, "create", 0, f.input, [f.binding.id]);
  const tools = calendarTools(f.service, async () => ({ ownerId: owner, bindingIds: [], assertCurrent: async () => {} }));
  const detail = tools.find(tool => tool.name === "calendar_get_event")!;
  const result = await detail.execute("get", { eventId: event.id }, undefined, undefined, {} as never);
  const output = JSON.parse((result.content[0] as { text: string }).text).event;
  assert.equal(output.id, event.id);
  assert.deepEqual(output.participantDetails ?? [], []);
  assert.deepEqual(output.noteRefs ?? [], []);
  assert.equal(output.interactionState?.path, undefined);
  assert.equal(output.interactionState?.noteUrl, undefined);
  assert.equal(output.interactionState?.reviewUrl, undefined);
 } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("calendar lost-response replay returns the persisted receipt even if a participant has since been removed", async () => {
 const f = await fixture();
 try {
  const first = await f.service.mutate(owner, "create", undefined, "create", 0, f.input, [f.binding.id]);
  await rm(path.join(f.root, "People/b.md"));
  await f.observation.scan(f.binding);
  const replay = await f.service.mutate(owner, "create", undefined, "create", 0, f.input, [f.binding.id]);
  assert.equal(replay.id, first.id);
  assert.equal(replay.revision, first.revision);
  assert.equal((await f.store.list(owner)).length, 1);
  assert.equal((await f.reviews.list()).length, 1);
 } finally { await rm(f.base, { recursive: true, force: true }); }
});
