import assert from "node:assert/strict";
import test from "node:test";
import { installFocusModality, isKeyboardInteraction } from "./focus-modality";

// A small event/element harness exercises document delegation without a DOM dependency.
function harness() {
	const listeners = new Map<string, Set<(event: KeyboardEvent) => void>>();
	const doc = {
		activeElement: null as ReturnType<typeof element> | null,
		addEventListener(type: string, fn: (event: KeyboardEvent) => void) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(fn);
		},
		removeEventListener(type: string, fn: (event: KeyboardEvent) => void) { listeners.get(type)?.delete(fn); },
	};
	const fire = (type: string, event = {}) => listeners.get(type)?.forEach(fn => fn(event as KeyboardEvent));
	const dispose = installFocusModality(doc as unknown as Document);
	return { doc, fire, dispose, listeners };
}
function element(discrete = true) {
	const attributes = new Map<string, string>();
	return {
		matches: (selector: string) => discrete && selector.includes("select"),
		setAttribute: (key: string, value: string) => attributes.set(key, value),
		removeAttribute: (key: string) => attributes.delete(key),
		pointerFocus: () => attributes.get("data-pointer-focus"),
	};
}

test("mouse/touch focus and programmatic menu return do not require blur", () => {
	const h = harness(); const trigger = element();
	h.fire("pointerdown"); h.doc.activeElement = trigger; h.fire("focusin");
	assert.equal(trigger.pointerFocus(), "true");
	h.fire("focusout"); assert.equal(trigger.pointerFocus(), undefined);
	h.fire("focusin"); assert.equal(trigger.pointerFocus(), "true");
	assert.equal(h.doc.activeElement, trigger);
	h.dispose();
});
test("Tab, Shift+Tab, Escape and arrow navigation clear pointer focus", () => {
	for (const key of ["Tab", "Escape", "ArrowDown", "Enter", " "]) {
		const h = harness(); const trigger = element(); h.doc.activeElement = trigger;
		h.fire("pointerdown"); h.fire("keydown", { key, shiftKey: key === "Tab" });
		assert.equal(trigger.pointerFocus(), undefined);
		h.fire("focusout"); h.fire("focusin"); assert.equal(trigger.pointerFocus(), undefined);
		h.dispose();
	}
});
test("editing inputs are never marked as pointer-only focus", () => {
	const h = harness(); const editor = element(false);
	h.fire("pointerdown"); h.doc.activeElement = editor; h.fire("focusin");
	assert.equal(editor.pointerFocus(), undefined); h.dispose();
});
test("modifiers, shortcuts and IME do not switch input modality", () => {
	for (const event of [{key:"Shift"}, {key:"Alt"}, {key:"k",metaKey:true}, {key:"a",ctrlKey:true}, {key:"x",altKey:true}, {key:"Process",isComposing:true}]) {
		assert.equal(isKeyboardInteraction(event), false);
	}
	assert.equal(isKeyboardInteraction({key:"Tab"}), true);
});
test("initial keyboard/programmatic focus remains visible", () => {
	const h = harness(); const trigger = element(); h.doc.activeElement = trigger;
	h.fire("focusin"); assert.equal(trigger.pointerFocus(), undefined); h.dispose();
});
test("moving focus and unmounting clear markers and all listeners", () => {
	const h = harness(); const first = element(); const next = element();
	h.doc.activeElement = first; h.fire("pointerdown");
	h.doc.activeElement = next; h.fire("focusin");
	assert.equal(first.pointerFocus(), undefined); assert.equal(next.pointerFocus(), "true");
	h.dispose(); assert.equal(next.pointerFocus(), undefined);
	assert.ok([...h.listeners.values()].every(set => set.size === 0));
});
