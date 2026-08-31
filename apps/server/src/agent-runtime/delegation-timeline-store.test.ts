import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DelegationTimelineStore } from "./delegation-timeline-store.js";
import { redactText } from "./redaction.js";

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

test("DelegationTimelineStore：持久化边界递归脱敏环境凭证与认证文本", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-timeline-redaction-"));
	const store = new DelegationTimelineStore(dir);
	await store.init();
	await store.append("d-secret", {
		source: "test",
		sourceEvent: "tool.end",
		kind: "tool",
		status: "completed",
		title: "env API_KEY=top-secret-value",
		content: 'Authorization: Bearer abc.def.ghi {"access_token":"nested-secret"}',
		metadata: {
			env: { OPENAI_API_KEY: "sk-supersecret", SAFE_FLAG: "visible" },
			nested: [{ password: "hunter2", note: "TOKEN=plain-secret" }],
		},
	});

	const [event] = await store.list("d-secret");
	assert.ok(event);
	assert.equal((event.metadata?.env as Record<string, unknown>).SAFE_FLAG, "visible");
	const persisted = readFileSync(path.join(dir, "d-secret.jsonl"), "utf8");
	for (const secret of ["top-secret-value", "abc.def.ghi", "nested-secret", "sk-supersecret", "hunter2", "plain-secret"]) {
		assert.ok(!persisted.includes(secret), `timeline 不得持久化 ${secret}`);
	}
	assert.match(persisted, /\[redacted\]/);
});

test("脱敏文本可重复应用且结果保持幂等", () => {
	const once = redactText("Authorization: Bearer test-token; API_KEY=top-secret; sk-example-secret");
	assert.equal(once, "Authorization: [redacted]; API_KEY=[redacted]; [redacted]");
	assert.equal(redactText(once), once);
	assert.equal(redactText(redactText(redactText(once))), once);
	const markdown = '```json\n{"auth":"Authorization: Bearer test-token","api_key":"nested-secret"}\n```';
	const safeMarkdown = '```json\n{"auth":"Authorization: [redacted]","api_key":"[redacted]"}\n```';
	assert.equal(redactText(markdown), safeMarkdown, "脱敏不得吞掉 JSON 引号或 Markdown 围栏");
	assert.equal(redactText(safeMarkdown), safeMarkdown);
});
