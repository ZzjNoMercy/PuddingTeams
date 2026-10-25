import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextUsage } from "@/lib/types";
import { ContextUsageBadge } from "./context-usage-badge";

const usage: ContextUsage = { tokens: 32_000, contextWindow: 200_000, percent: 16 };
const render = (value: ContextUsage) => renderToStaticMarkup(createElement(ContextUsageBadge, { usage: value }));

test("默认只显示圆环和百分比，完整上下文提示只挂在圆环上", () => {
	const html = render(usage);
	assert.match(html, /class="home-chat-context-percent"[^>]*>16%/);
	assert.doesNotMatch(html, />上下文/);
	assert.doesNotMatch(html, />32,000/);
	assert.match(html, /aria-label="上下文已用 16% · 32,000 \/ 200,000 tokens"/);
	assert.match(html, new RegExp(`stroke-dashoffset="${2 * Math.PI * 6 * 0.84}"`));
	const triggers = html.match(/<span\b[^>]*data-slot="tooltip-trigger"[^>]*>/g) ?? [];
	assert.equal(triggers.length, 1);
	assert.match(triggers[0], /home-chat-context-ring-trigger/);
	assert.match(triggers[0], /tabindex="0"/);
});

test("压缩后未知状态保留窗口提示但不伪造 0%", () => {
	const html = render({ tokens: null, contextWindow: 200_000, percent: null });
	assert.match(html, /class="home-chat-context-percent"[^>]*>待更新/);
	assert.match(html, /aria-label="上下文窗口 200,000 tokens · 压缩后等待下一次模型响应更新"/);
	assert.doesNotMatch(html, />0%/);
});

test("圆环最多到 100%，文本保留真实百分比", () => {
	const html = render({ tokens: 250_000, contextWindow: 200_000, percent: 125 });
	assert.match(html, /class="home-chat-context-percent"[^>]*>125%/);
	assert.match(html, /stroke-dashoffset="0"/);
});
