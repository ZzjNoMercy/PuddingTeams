import assert from "node:assert/strict";
import { test } from "node:test";
import { historyActor, historyRecordedAt } from "./history-presentation.js";

test("external sync uses scanning time and never presents the observer as the actual author", () => {
	const version = { channel: "external_sync", actorId: "platform-observer", actorName: "平台观察", createdAt: "2026-09-30T08:00:00Z", acceptedAt: "2026-09-29T00:00:00Z" };
	assert.equal(historyActor(version), "实际作者未知 · 平台观察");
	assert.equal(historyRecordedAt(version), version.createdAt);
});

test("Agent publication retains its recorded publisher and decision time", () => {
	const version = { channel: "agent_publish", actorId: "publisher-a", createdAt: "2026-09-30T08:00:00Z", acceptedAt: "2026-09-30T07:00:00Z" };
	assert.equal(historyActor(version), "publisher-a（确认发布）");
	assert.equal(historyRecordedAt(version), version.acceptedAt);
});

test("history uses the profile display name and hides internal local account IDs", () => {
	const version = { channel: "agent_publish", actorId: "local:pet", actorName: "Pet", createdAt: "2026-10-01T08:00:00Z", acceptedAt: "2026-10-01T07:00:00Z" };
	assert.equal(historyActor(version), "Pet（确认发布）");
	assert.equal(historyActor({ ...version, actorId: "local:another", actorName: undefined }), "你（确认发布）");
	assert.equal(historyActor({ ...version, channel: "manual_edit" }), "Pet");
});
