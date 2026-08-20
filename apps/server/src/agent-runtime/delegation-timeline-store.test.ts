import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DelegationTimelineStore } from "./delegation-timeline-store.js";

function activity(title: string) {
	return {
		source: "test",
		sourceEvent: "test.event",
		kind: "lifecycle" as const,
		status: "running" as const,
		title,
	};
}

test("DelegationTimelineStore：事件按 delegationId+seq 追加且重启可回放", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-timeline-"));
	const first = new DelegationTimelineStore(dir);
	await first.init();
	await first.append("d-1", activity("one"));
	await first.append("d-1", activity("two"));
	await first.append("d-2", activity("other"));

	const restarted = new DelegationTimelineStore(dir);
	await restarted.init();
	assert.deepEqual((await restarted.list("d-1")).map((event) => [event.seq, event.title]), [[1, "one"], [2, "two"]]);
	assert.deepEqual((await restarted.list("d-1", 1)).map((event) => event.title), ["two"]);
	const third = await restarted.append("d-1", activity("three"));
	assert.equal(third.seq, 3);
});

test("DelegationTimelineStore：历史快照与实时订阅之间不丢事件", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-timeline-sub-"));
	const store = new DelegationTimelineStore(dir);
	await store.init();
	await store.append("d-live", activity("before"));
	const live: string[] = [];
	const subscription = await store.subscribeFrom("d-live", 0, (event) => live.push(event.title));
	assert.deepEqual(subscription.events.map((event) => event.title), ["before"]);
	await store.append("d-live", activity("after"));
	assert.deepEqual(live, ["after"]);
	subscription.unsubscribe();
	await store.append("d-live", activity("detached"));
	assert.deepEqual(live, ["after"]);
});
