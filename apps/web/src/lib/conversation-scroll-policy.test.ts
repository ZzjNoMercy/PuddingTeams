import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { conversationScrollTarget, shouldResumeConversationScroll } from "./conversation-scroll-policy";

test("Worker completion shrink, result growth and stream growth retain the paused reading target", () => {
	for (const bottom of [1502, 805, 1902, 2102]) assert.equal(conversationScrollTarget(true, 781, bottom), 781);
	assert.equal(conversationScrollTarget(false, 781, 1902), 1902);
});
test("near-bottom geometry alone never resumes a reader", () => {
	const reading = { paused: true, previousTop: 781, top: 782, bottom: 805, userGesture: false, resizing: false };
	assert.equal(shouldResumeConversationScroll(reading), false);
	assert.equal(shouldResumeConversationScroll({ ...reading, userGesture: true, resizing: true }), false);
	assert.equal(shouldResumeConversationScroll({ ...reading, userGesture: true, top: 780 }), false);
	assert.equal(shouldResumeConversationScroll({ ...reading, userGesture: true, bottom: 1902 }), false);
});
test("only an intentional downward scroll reaching bottom resumes follow", () => {
	assert.equal(shouldResumeConversationScroll({ paused: true, previousTop: 1000, top: 1880, bottom: 1902, userGesture: true, resizing: false }), true);
	assert.equal(shouldResumeConversationScroll({ paused: true, previousTop: 1000, top: 1877, bottom: 1902, userGesture: true, resizing: false }), false);
});
test("shared Conversation protects wheel/key/touch readers and explicit commands retain their owners", () => {
	const hook = readFileSync(new URL("../hooks/useConversationScroll.ts", import.meta.url), "utf8");
	const view = readFileSync(new URL("../components/ai-elements/conversation.tsx", import.meta.url), "utf8");
	assert.match(view, /instance=\{instance \?\? readingScroll\}/);
	assert.match(hook, /if \(preserve && pausedRef\.current\) return false/);
	assert.match(hook, /if \(!preserve\) changePaused\(false\)/);
	assert.match(hook, /ResizeObserver\(\(\) => \{ if \(pausedRef\.current\) originalStop\(\)/);
	for (const event of ["wheel", "keydown", "scroll", "touchmove"]) assert.ok(hook.includes(`addEventListener("${event}"`));
	assert.match(hook, /isAtBottom: !paused && instance\.isAtBottom/);
});
