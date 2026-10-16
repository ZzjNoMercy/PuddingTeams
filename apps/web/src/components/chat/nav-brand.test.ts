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

test("navigation owns its font instead of inheriting a route-specific shell font", () => {
	assert.match(css, /--home-font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text"/);
	for (const selector of [".nav-rail", ".home-shell"]) {
		assert.match(rule(selector), /font-family: var\(--home-font-sans\)/);
	}
});

test("brand copy keeps its vertical rhythm without legacy nav-label display overrides", () => {
	const source = read("nav-rail.tsx");
	assert.match(source, /<span className="nav-brand-name">/);
	assert.doesNotMatch(source, /className="nav-brand-name[^\"]*nav-label/);
	assert.match(rule(".m1-app-shell .nav-brand-name"), /display:flex; flex-direction:column; gap:6px/);
	assert.match(rule(".m1-app-shell .nav-brand-caption"), /line-height:1\.4/);
	assert.match(rule(".nav-brand-name"), /display: none/);
	assert.match(css, /@media \(max-width:960px\)[^\n]*\.m1-app-shell \.nav-brand-name,[^{]+\{ display:none; \}/);
});
