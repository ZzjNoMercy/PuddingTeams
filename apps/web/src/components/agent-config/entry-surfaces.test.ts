import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../../app/globals.css");
const rule = (selector: string) => {
	const start = css.indexOf(`${selector} {`);
	assert.notEqual(start, -1, selector);
	return css.slice(start, css.indexOf("}", start) + 1);
};

test("choice lists and toggles use the same theme surface and border as plugin entries", () => {
	for (const selector of [".agent-config-choice-list", ".agent-config-toggle", ".agent-plugin-binding-card", ".agent-plugin-add-card"]) {
		assert.match(rule(selector), /background: var\(--config-surface\)/);
		assert.match(rule(selector), /border: 1px solid var\(--config-line\)/);
	}
	assert.match(read("tool-preview-section.module.css"), /\.groups\{[^}]*background:var\(--config-surface,var\(--card\)\)/);
	assert.match(css, /--config-surface: #ffffff/);
	assert.match(css, /\.dark \.agent-config-shell \{[^}]*--config-surface: #12181d/);
});

test("rows have inset content and disabled-aware hover without changing selections", () => {
	assert.match(rule(".agent-config-choice"), /padding: 16px/);
	assert.match(rule(".agent-config-toggle"), /padding: 16px/);
	assert.match(css, /\.agent-config-choice:not\(:has\(input:disabled\)\):hover \{ background: var\(--config-raised\); \}/);
	assert.match(css, /\.agent-config-toggle:not\(:has\(input:disabled\)\):hover \{ background: var\(--config-raised\); \}/);
	for (const path of ["resource-library-section.tsx", "mcp-selection-section.tsx"]) {
		assert.match(read(path), /className="agent-config-choice-list"/);
		assert.match(read(path), /className="agent-config-choice"/);
	}
});
