import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStats } from "@/lib/session-stats";
import { ChatStatsBar } from "./chat-stats-bar";

const stats: SessionStats = {
	rounds: 2,
	steps: 3,
	inputTokens: 12_000,
	outputTokens: 800,
	cacheHitRate: 0.5,
};

const render = (props: Parameters<typeof ChatStatsBar>[0]) => renderToStaticMarkup(createElement(ChatStatsBar, props));

test("没有历史统计时不渲染", () => {
	assert.equal(render({ stats: null }), "");
});

test("统计条保留历史轮次、缓存和累计输入输出", () => {
	const html = render({ stats });
	assert.match(html, /2 轮 · 3 步/);
	assert.match(html, /缓存命中 50%/);
	assert.match(html, /输入 12K · 输出 800/);
	assert.doesNotMatch(html, /home-chat-context/);
});

test("上滑时统计条沿用原有隐藏状态", () => {
	const html = render({ stats, visible: false });
	assert.match(html, /home-chat-stats is-hidden/);
	assert.match(html, /aria-hidden="true"/);
});
