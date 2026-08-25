import assert from "node:assert/strict";
import test from "node:test";
import { thinkingElapsedSeconds } from "./thinking-timing";

test("thinking 计时由稳定 turn 时间戳计算，组件重挂载不会清零", () => {
	const startedAt = 1_000;
	assert.equal(thinkingElapsedSeconds(startedAt, 12_900), 11);
	assert.equal(thinkingElapsedSeconds(startedAt, 62_100), 61);
});

test("客户端时钟早于消息时间戳时不显示负数", () => {
	assert.equal(thinkingElapsedSeconds(10_000, 9_000), 0);
});
