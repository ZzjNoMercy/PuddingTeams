import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const menu = read("knowledge-picker-menu.tsx");
test("knowledge multi-select is non-modal and only item selection prevents dismissal", () => {
	assert.match(menu, /<DropdownMenu modal=\{false\}>/);
	assert.match(menu, /onSelect=\{event => event\.preventDefault\(\)\}/);
	assert.doesNotMatch(menu, /on(?:Interact|PointerDown|Focus)Outside|onEscapeKeyDown|onOpenChange/);
	assert.match(menu, /checked=\{selected\.has\(binding\.id\)\}/);
	assert.match(menu, /onCheckedChange=\{checked => onToggle\(binding\.id, checked === true\)\}/);
});
test("workbench and session share menu while preserving availability/saving guards", () => {
	assert.match(read("session-knowledge-picker.tsx"), /<KnowledgePickerMenu[^>]*allowDeselectUnavailable/);
	assert.match(read("../../app/page.tsx"), /<KnowledgePickerMenu bindings=\{error \? \[\] : bindings\}/);
	assert.match(menu, /saving \|\| disabled \|\| \(binding\.availability !== "available" && !\(allowDeselectUnavailable && selected\.has\(binding\.id\)\)\)/);
	assert.match(read("session-knowledge-picker.tsx"), /updateKnowledgeSelection\(current\.selection, \[\.\.\.next\]\)/);
	assert.match(menu, /role="alert"/);
});
test("menu uses scoped, theme-aware styles and bounded overflow", () => {
	const css = read("knowledge-picker-menu.module.css");
	assert.match(css, /width:min\(320px,calc\(100vw - 24px\)\)/);
	assert.match(css, /border:1px solid var\(--home-line,var\(--border\)\)/);
	assert.match(css, /\.option>span:first-child\{left:auto;right:12px/);
	assert.match(css, /text-overflow:ellipsis/);
	assert.match(css, /font-weight:500/);
	assert.match(menu, /title=\{binding\.description \|\| binding\.name\}/);
});
