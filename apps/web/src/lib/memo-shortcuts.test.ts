import assert from "node:assert/strict";
import { test } from "node:test";
import { isCaptureShortcut, isGlobalSearchShortcut, shouldOpenCapture } from "./memo-shortcuts";

const event = (patch: Record<string, unknown> = {}) => ({ key: " ", code: "Space", metaKey: true, shiftKey: true, ...patch });

test("memo 快捷键：Meta/Ctrl+Shift+Space 触发，其余修饰键不触发", () => {
	assert.equal(isCaptureShortcut(event()), true);
	assert.equal(isCaptureShortcut(event({ metaKey: false, ctrlKey: true })), true);
	assert.equal(isCaptureShortcut(event({ shiftKey: false })), false);
	assert.equal(isCaptureShortcut(event({ altKey: true })), false);
	assert.equal(isCaptureShortcut(event({ metaKey: false, ctrlKey: false })), false);
	assert.equal(isCaptureShortcut(event({ code: "KeyK", key: "k" })), false);
});

test("memo 快捷键：重复、IME、已阻止与已有模态层都让路", () => {
	assert.equal(isCaptureShortcut(event({ repeat: true })), false);
	assert.equal(isCaptureShortcut(event({ isComposing: true })), false);
	assert.equal(isCaptureShortcut(event({ keyCode: 229 })), false);
	assert.equal(isCaptureShortcut(event({ defaultPrevented: true })), false);
	assert.equal(shouldOpenCapture(event(), { modalOpen: true }), false);
	assert.equal(shouldOpenCapture(event(), { modalOpen: false }), true);
});

test("memo 快捷键：⌘K 属于全局搜索，不被速记接管", () => {
	assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true }), true);
	assert.equal(isCaptureShortcut({ key: "k", code: "KeyK", metaKey: true, shiftKey: true }), false);
});
