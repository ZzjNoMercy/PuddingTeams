import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
test("event editor keeps its header outside the form and actions outside the scroll body", () => {
	const source = read("event-editor.tsx");
	assert.match(source, /<DialogHeader className=\{styles.editorHeader\}>/);
	assert.ok(source.indexOf("</DialogHeader>") < source.indexOf("<form"));
	assert.match(source, /<div className=\{styles.editorBody\}>[\s\S]*<fieldset disabled=\{locked \|\| settled\}>/);
	assert.match(source, /<\/div>\s*<\/div>\s*<div className=\{styles.actions\}>/);
	assert.match(source, /type="submit"/);
	assert.match(source, /showCloseButton=\{!locked\}/);
	assert.match(source, /feedbackRef.current\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
});
test("editor scopes scrolling to the middle and reserves scrollbar space", () => {
	const css = read("calendar.module.css");
	assert.match(css, /\.dialog\.editorDialog\{display:flex;flex-direction:column;overflow:hidden\}/);
	assert.match(css, /\.editorDialog \.form\{min-height:0;flex:1;overflow:hidden\}/);
	assert.match(css, /\.editorBody\{[^}]*min-height:0;overflow-y:auto/);
	assert.match(css, /\.editorBody\{[^}]*scrollbar-gutter:stable;padding-inline-end:16px/);
	assert.match(css, /\.editorHeader\{flex-shrink:0/);
	assert.match(css, /\.editorDialog \.actions\{flex-shrink:0\}/);
	assert.match(css, /\.dialog\{max-height:90dvh;overflow:auto/);
});
