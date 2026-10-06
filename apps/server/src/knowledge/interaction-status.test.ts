import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeObservationService } from "./observation.js";
import { KnowledgeSearchIndex } from "./search-index.js";
import { copySchemaPreset } from "./schema-presets.js";
import { PublishJournal } from "./wiki/publish-journal.js";
import { CalendarStore } from "../calendar/store.js";
import { setInteractionStatus, rewriteInteractionFrontmatter, type CalendarStatusSync, type InteractionStatusDeps } from "./interaction-status.js";
import { registerKnowledgeRoutes } from "../routes/knowledge.js";
import { localViewerIdentity } from "../routes/identity.js";
import Fastify from "fastify";

const owner = "interaction-status-owner";

async function fixture(notes: Record<string, string>, ownerId = owner) {
	const base = await mkdtemp(path.join(tmpdir(), "pt-interaction-status-")), root = path.join(base, "wiki");
	await mkdir(path.join(root, "Interactions"), { recursive: true });
	await writeFile(path.join(root, "wiki.schema.json"), JSON.stringify(copySchemaPreset("people")));
	for (const [file, content] of Object.entries(notes)) await writeFile(path.join(root, file), content);
	const bindings = new KnowledgeBindingRegistry(path.join(base, "bindings")), objects = new KnowledgeObjectStore(path.join(base, "objects")), acceptance = new KnowledgeAcceptanceStore(path.join(base, "accepted"));
	const journal = new PublishJournal(path.join(base, "operations")), searchIndex = new KnowledgeSearchIndex(path.join(base, "cache"), objects);
	const observation = new KnowledgeObservationService(acceptance, { objects, journal, searchIndex });
	const binding = await bindings.create({ ownerId, name: "状态测试", description: "隔离测试", rootPath: root });
	const calendarStore = new CalendarStore(path.join(base, "calendar"));
	const calendar: CalendarStatusSync = {
		get: async (ownerId, eventId) => { const event = await calendarStore.get(ownerId, eventId); return { revision: event.revision, status: event.status }; },
		setStatus: (ownerId, eventId, operationId, expectedRevision, status) => calendarStore.setStatus(ownerId, eventId, operationId, expectedRevision, status),
	};
	const deps: InteractionStatusDeps = { bindings, observation, acceptance, calendar };
	return { base, root, bindings, binding, acceptance, observation, calendarStore, deps };
}

const plannedNote = (extra = "") => `---\nid: note-1\ntype: interaction\ntitle: 北京饭局\nstatus: planned\noccurredAt: "2026-10-01T12:00:00.000Z"\nupdated: "2026-09-01T00:00:00.000Z"\n${extra}---\n\n# 北京饭局\n\n正文保持不变。\n`;

test("wiki 直写改状态：手术式改写 frontmatter，正文与其他字段不动", async () => {
	const f = await fixture({ "Interactions/a.md": plannedNote() });
	try {
		const result = await setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/a.md", status: "done" });
		assert.equal(result.changed, true);
		assert.equal(result.calendarSync, undefined, "无 calendarEventId 不同步日程");
		const text = await readFile(path.join(f.root, "Interactions/a.md"), "utf8");
		assert.match(text, /status: done\n/);
		assert.match(text, /occurredAt: "2026-10-01T12:00:00.000Z"/, "occurredAt 未显式传入时不变");
		assert.ok(!text.includes(`updated: "2026-09-01T00:00:00.000Z"`), "updated 刷新");
		assert.match(text, /正文保持不变。/);
		assert.match(text, /title: 北京饭局/);
		// 幂等：同状态不再写入
		const again = await setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/a.md", status: "done" });
		assert.equal(again.changed, false);
		assert.equal(again.note.contentHash, result.note.contentHash);
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("标 done 缺 occurredAt 报错；非 interaction 笔记拒绝；路径缺失报 not_found", async () => {
	const f = await fixture({
		"Interactions/no-date.md": `---\nid: note-2\ntype: interaction\ntitle: 未定\nstatus: planned\n---\n\n正文\n`,
		"Interactions/person.md": `---\nid: note-3\ntype: person\ntitle: 人物\n---\n`,
	});
	try {
		await assert.rejects(
			setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/no-date.md", status: "done" }),
			(error: unknown) => error instanceof Error && (error as { code?: string }).code === "invalid_input" && /发生日期/.test((error as Error).message));
		const ok = await setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/no-date.md", status: "done", occurredAt: "2026-10-02T20:00:00+08:00" });
		assert.equal(ok.note.occurredAt, "2026-10-02T12:00:00.000Z");
		assert.match(await readFile(path.join(f.root, "Interactions/no-date.md"), "utf8"), /occurredAt: "2026-10-02T12:00:00.000Z"/, "缺失的 occurredAt 被插入");
		await assert.rejects(
			setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/person.md", status: "cancelled" }),
			/仅往来/);
		await assert.rejects(
			setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/missing.md", status: "done", occurredAt: "2026-10-01T00:00:00Z" }),
			(error: unknown) => (error as { code?: string }).code === "not_found" || (error as { code?: string }).code === "invalid_path");
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("带 calendarEventId 的笔记双写日程状态；日程侧失败如实上报不回滚 wiki", async () => {
	const f = await fixture({});
	try {
		const event = await f.calendarStore.mutate(owner, "create", undefined, "create-1", 0,
			{ title: "饭局", description: "", location: "", kind: "event", busy: true, timeZone: "Asia/Shanghai", allDay: false, start: "2026-10-05T20:00:00+08:00", end: "2026-10-05T21:00:00+08:00" });
		const linked = plannedNote(`calendarEventId: "${event.id}"\ncalendarRevision: 1\n`);
		await writeFile(path.join(f.root, "Interactions/linked.md"), linked);
		const cancelled = await setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/linked.md", status: "cancelled" });
		assert.deepEqual(cancelled.calendarSync, { ok: true, eventId: event.id, status: "cancelled", changed: true });
		assert.equal((await f.calendarStore.get(owner, event.id)).status, "cancelled");
		const restored = await setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/linked.md", status: "planned" });
		assert.equal(restored.calendarSync?.ok, true);
		assert.equal((await f.calendarStore.get(owner, event.id)).status, "confirmed", "planned 映射回 confirmed");
		// 日程不存在：wiki 已写，calendarSync 报错
		await writeFile(path.join(f.root, "Interactions/orphan.md"), plannedNote(`calendarEventId: "no-such-event"\n`));
		const orphan = await setInteractionStatus(f.deps, { ownerId: owner, bindingId: f.binding.id, path: "Interactions/orphan.md", status: "cancelled" });
		assert.equal(orphan.changed, true, "wiki 侧照常生效");
		assert.equal(orphan.calendarSync?.ok, false);
		assert.match(await readFile(path.join(f.root, "Interactions/orphan.md"), "utf8"), /status: cancelled/);
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("POST /api/knowledge/interactions/status 直写生效并映射错误码", async () => {
	const routeOwner = localViewerIdentity().user.id;
	const f = await fixture({ "Interactions/a.md": plannedNote() }, routeOwner);
	const app = Fastify();
	registerKnowledgeRoutes(app, f.bindings, {
		objects: new KnowledgeObjectStore(path.join(f.base, "objects")),
		acceptance: f.acceptance, observation: f.observation,
		searchIndex: new KnowledgeSearchIndex(path.join(f.base, "cache"), new KnowledgeObjectStore(path.join(f.base, "objects"))),
		setInteractionStatus: (input) => setInteractionStatus(f.deps, input),
	});
	try {
		const ok = await app.inject({ method: "POST", url: "/api/knowledge/interactions/status",
			payload: { bindingId: f.binding.id, path: "Interactions/a.md", status: "cancelled" } });
		assert.equal(ok.statusCode, 200, ok.body);
		assert.equal(ok.json().note.status, "cancelled");
		assert.match(await readFile(path.join(f.root, "Interactions/a.md"), "utf8"), /status: cancelled/);
		const invalid = await app.inject({ method: "POST", url: "/api/knowledge/interactions/status",
			payload: { bindingId: f.binding.id, path: "Interactions/a.md", status: "archived" } });
		assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().code, "invalid_input");
		const done = await app.inject({ method: "POST", url: "/api/knowledge/interactions/status",
			payload: { bindingId: f.binding.id, path: "Interactions/a.md", status: "done" } });
		assert.equal(done.statusCode, 200, "笔记已有 occurredAt 时标 done 直接生效"); assert.equal(done.json().note.status, "done");
		const missing = await app.inject({ method: "POST", url: "/api/knowledge/interactions/status",
			payload: { bindingId: f.binding.id, path: "Interactions/absent.md", status: "done", occurredAt: "2026-10-01T00:00:00Z" } });
		assert.equal(missing.statusCode, 404, "笔记不存在映射 404");
	} finally { await app.close(); await rm(f.base, { recursive: true, force: true }); }
});

test("frontmatter 手术保留引号风格并支持缺失字段插入", () => {
	const single = `---\r\ntype: interaction\r\nstatus: 'planned'\r\n---\r\n正文\r\n`;
	const rewritten = rewriteInteractionFrontmatter(single, { status: "done", updated: "2026-10-05T00:00:00.000Z", occurredAt: "2026-10-04T00:00:00.000Z" });
	assert.match(rewritten, /status: 'done'\r\n/);
	assert.match(rewritten, /updated: "2026-10-05T00:00:00.000Z"\r\n/, "缺失 updated 插入在 status 之后");
	assert.match(rewritten, /occurredAt: "2026-10-04T00:00:00.000Z"\r\n/);
	assert.ok(rewritten.endsWith("正文\r\n"));
	assert.throws(() => rewriteInteractionFrontmatter("# 无 frontmatter\n", { status: "done", updated: "x" }), /frontmatter/);
});
