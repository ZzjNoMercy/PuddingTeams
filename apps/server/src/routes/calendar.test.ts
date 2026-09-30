import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { CalendarStore } from "../calendar/store.js";
import { registerCalendarRoutes } from "./calendar.js";

const timed = { title: "跨午夜专注", kind: "focus", busy: true, timeZone: "Asia/Shanghai", allDay: false, start: "2026-09-30T23:30:00+08:00", end: "2026-10-01T01:00:00+08:00" };
test("Calendar CRUD: lost-response replay, conflict, cancellation and cold reopen", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-calendar-")); const app = Fastify();
	registerCalendarRoutes(app, new CalendarStore(root), () => "owner");
	try {
		const create = { operationId: "create-1", expectedRevision: 0, event: timed };
		const first = await app.inject({ method: "POST", url: "/api/calendar/events", payload: create });
		assert.equal(first.statusCode, 200); const event = first.json().event;
		assert.equal(event.start, "2026-09-30T15:30:00.000Z");
		const replay = await app.inject({ method: "POST", url: "/api/calendar/events", payload: create }); assert.deepEqual(replay.json().event, event);
		assert.equal((await app.inject({ method: "POST", url: "/api/calendar/events", payload: { ...create, event: { ...timed, title: "不同内容" } } })).statusCode, 409);
		const url = `/api/calendar/events/${event.id}`;
		const updates = await Promise.all(["A", "B"].map((title) => app.inject({ method: "PUT", url, payload: { operationId: `update-${title}`, expectedRevision: 1, event: { ...timed, title } } })));
		assert.deepEqual(updates.map((r) => r.statusCode).sort(), [200, 409]);
		const fresh = (await new CalendarStore(root).list("owner"))[0]!; assert.equal(fresh.revision, 2);
		assert.deepEqual(await new CalendarStore(root).list("other-owner"), []);
		await assert.rejects(new CalendarStore(root).get("other-owner", event.id), { code: "not_found" });
		const cancel = { operationId: "cancel-1", expectedRevision: 2 };
		const cancelled = await app.inject({ method: "DELETE", url, payload: cancel }); assert.equal(cancelled.json().event.status, "cancelled");
		assert.equal((await app.inject({ method: "DELETE", url, payload: cancel })).statusCode, 200);
		assert.deepEqual(await new CalendarStore(root).list("owner"), []);
		assert.equal((await app.inject({ method: "PUT", url, payload: { operationId: "resurrect", expectedRevision: 3, event: timed } })).statusCode, 409);
		assert.equal((await app.inject({ method: "GET", url: "/api/calendar/sources" })).json().sources.length, 1);
	} finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("Calendar keeps all-day dates exclusive and rejects malformed time / timezone; corrupt store is not empty", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-calendar-dates-")); const app = Fastify(); registerCalendarRoutes(app, new CalendarStore(root), () => "owner");
	try {
		const event = { title: "假期", kind: "event", busy: false, timeZone: "America/New_York", allDay: true, startDate: "2026-10-01", endDateExclusive: "2026-10-04" };
		const response = await app.inject({ method: "POST", url: "/api/calendar/events", payload: { operationId: "all-day", expectedRevision: 0, event } });
		assert.equal(response.statusCode, 200); assert.equal(response.json().event.endDateExclusive, "2026-10-04"); assert.equal(response.json().event.start, undefined);
		for (const invalid of [{ ...event, startDate: "2026-02-30" }, { ...event, timeZone: "No/Zone" }, { ...event, endDateExclusive: event.startDate }, { ...timed, start: "2026-09-30T23:30:00" }, { ...timed, end: timed.start }]) {
			assert.equal((await app.inject({ method: "POST", url: "/api/calendar/events", payload: { operationId: "invalid", expectedRevision: 0, event: invalid } })).statusCode, 400);
		}
		await writeFile(path.join(root, "events.json"), "broken");
		assert.equal((await app.inject({ method: "GET", url: "/api/calendar/events" })).statusCode, 500);
	} finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
