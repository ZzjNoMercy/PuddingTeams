import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueuedNativeInput } from "@/lib/types";
import { QueuedInputList } from "./queued-input-list";

const item: QueuedNativeInput = { key: "pending-1", text: "你好", delivery: "followUp", attachmentNames: [], hasImages: false };
const render = (patch: Partial<QueuedNativeInput> = {}, canSteer = true, busyKey: string | null = null) => renderToStaticMarkup(createElement(QueuedInputList, { items: [{ ...item, ...patch }], canSteer, busyKey, onAction: () => {} }));

test("empty queue renders nothing; normal queue separates content, state and actions", () => {
	assert.equal(renderToStaticMarkup(createElement(QueuedInputList, { items: [], canSteer: true, busyKey: null, onAction: () => {} })), "");
	const html = render();
	assert.match(html, /aria-label="待处理消息"/);
	assert.match(html, /等待发送/);
	assert.match(html, /<p class="home-queued-text">你好<\/p>/);
	assert.match(html, /优先引导/);
	assert.match(html, /aria-label="删除排队消息"/);
});
test("steering availability respects capability, existing delivery and image restrictions", () => {
	for (const html of [render({}, false), render({ hasImages: true }), render({ delivery: "steer" })]) {
		assert.doesNotMatch(html, /优先引导/);
		assert.match(html, /aria-label="删除排队消息"/);
	}
	assert.match(render({ delivery: "steer" }), /等待引导/);
});
test("busy state disables both controls only for the affected queue key", () => {
	const busy = render({}, true, item.key);
	assert.match(busy, /aria-busy="true"/);
	assert.match(busy, /处理中…/);
	assert.equal((busy.match(/disabled=""/g) ?? []).length, 2);
	assert.doesNotMatch(render({}, true, "another-key"), /disabled=""/);
});
test("attachments remain visible alongside text, including attachment-only messages", () => {
	const both = render({ attachmentNames: ["文档.md", "图.png"] });
	assert.match(both, /你好/);
	assert.match(both, /文档.md、图.png/);
	const attachmentOnly = render({ text: "", attachmentNames: ["附件.pdf"] });
	assert.match(attachmentOnly, /附件.pdf/);
	assert.doesNotMatch(attachmentOnly, /class="home-queued-text"/);
	assert.match(render({ text: "<script>alert(1)</script>" }), /&lt;script&gt;/);
});
test("buttons retain the original queue identity and action mapping", () => {
	const calls: Array<[string, string]> = [];
	const buttons: Array<() => void> = [];
	const visit = (node: ReactNode) => Children.forEach(node, (child) => {
		if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
		if (child.type === "button" && child.props.onClick) buttons.push(child.props.onClick);
		visit(child.props.children);
	});
	visit(QueuedInputList({ items: [item], canSteer: true, busyKey: null, onAction: (key, action) => calls.push([key, action]) }));
	buttons.forEach((click) => click());
	assert.deepEqual(calls, [[item.key, "steer"], [item.key, "cancel"]]);
});
test("card keeps bounded text, solid theme skin and shared focus policy", () => {
	const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
	assert.match(css, /\.home-queued-message \{[^}]*width: min\(400px, 100%\)[^}]*border: 1px solid var\(--home-line\)/);
	assert.match(css, /\.home-queued-message \{[^}]*background: var\(--home-composer-surface\)/);
	assert.match(css, /\.home-queued-message \.home-queued-text \{[^}]*max-height: 128px; overflow-y: auto/);
	assert.match(css, /\.home-queued-action:focus-visible:not\(\[data-pointer-focus="true"\]\)/);
	assert.match(css, /\.home-queued-header \{[^}]*flex-wrap: wrap/);
	assert.match(css, /\.home-queued-status \{[^}]*white-space: nowrap/);
	const pane = readFileSync(new URL("chat-pane.tsx", import.meta.url), "utf8");
	assert.match(pane, /<QueuedInputList items=\{queuedInputs\} canSteer=\{canSteerQueued\} busyKey=\{queuedActionBusy\}/);
	assert.match(pane, /canSteerQueued = running && !inputCapability\?\.waiting.length/);
});
