import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSearchSources, type SearchLoadEvent } from "./global-search-load.js";
import type { AgentConfig, ManagerWorkIndexItem, RoomSummary } from "./types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

test("慢来源不阻止已完成来源返回，失效请求不能补写旧结果", async () => {
	const rooms = deferred<RoomSummary[]>();
	const agents = deferred<AgentConfig[]>();
	const works = deferred<ManagerWorkIndexItem[]>();
	const events: SearchLoadEvent[] = [];
	let current = true;
	const finished = loadSearchSources(
		{ rooms: () => rooms.promise, agents: () => agents.promise, works: () => works.promise },
		() => current,
		(event) => events.push(event),
	);
	rooms.resolve([{ id: "direct-a" } as RoomSummary]);
	await Promise.resolve();
	assert.deepEqual(events.map((event) => event.source), ["rooms"], "其他来源未结束时对话已经可展示");
	agents.reject(new Error("agents offline"));
	await Promise.resolve();
	assert.deepEqual(events.map((event) => event.source), ["rooms", "agents"]);
	assert.equal(events[1]?.ok, false);
	current = false;
	works.resolve([{ sessionId: "old-a" } as ManagerWorkIndexItem]);
	await finished;
	assert.equal(events.length, 2, "关闭或重试后迟到的旧来源不能污染新结果");
});
