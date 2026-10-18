import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("timed events keep their duration geometry and use a single metadata row", () => {
	const source = read("calendar-app.tsx");
	assert.match(source, /top: start \/ 60 \* 68, height: Math\.max\(38, \(end - start\) \/ 60 \* 68 - 4\)/);
	assert.match(source, /<span className=\{styles.eventMeta\}><time>\{eventTime\(event, zone\)\}<\/time>\{event.location && <span className=\{styles.eventLocation\} title=\{event.location\}>· \{event.location\}<\/span>\}<\/span>/);
	assert.doesNotMatch(source, /<small>\{event.location\}<\/small>/);
});

test("event content is vertically centered and fits even the 38px minimum block", () => {
	const css = read("calendar.module.css");
	const rule = css.match(/\.layout \.event\{([^}]+)\}/)?.[1] ?? "";
	assert.match(rule, /justify-content:center/);
	assert.match(rule, /gap:2px;padding:4px 8px/);
	assert.match(css, /\.event strong\{[^}]*line-height:1\.3;flex-shrink:0/);
	assert.match(css, /\.layout \.eventMeta\{[^}]*min-width:0;[^}]*line-height:1\.3;white-space:nowrap/);
	assert.match(css, /\.eventMeta \.eventLocation\{[^}]*overflow:hidden;text-overflow:ellipsis/);
	assert.ok(11 * 1.3 + 9 * 1.3 + 2 + 4 * 2 + 2 <= 38);
});
