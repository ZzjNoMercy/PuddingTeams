import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("all event views omit source badges while retaining source names for hover and accessibility", () => {
	const source = read("calendar-app.tsx");
	assert.doesNotMatch(source, /SourceBadge|styles\.(?:sourceBadge|compactBadge)/);
	for (const view of ["monthEvent", "compactEvent", "event"]) {
		const button = source.split("<button").slice(1).map(part => part.split("</button>")[0]).find(part => part.includes(`styles.${view}}`));
		assert.ok(button, view);
		assert.match(button, /title=\{[^]*?event\.title[^]*?calendarSourceLabel\(event\)/);
		assert.match(button, /aria-label=\{[^]*?calendarSourceLabel\(event\)/);
		assert.match(button, /sourceStyle\(event\)/);
	}
	assert.match(source, /<h3>我的日历<\/h3>/);
	assert.match(source, /styles\.dot\} \/>平台日历/);
});

test("source colors and existing status indicators remain without obsolete badge styles", () => {
	const source = read("calendar-app.tsx"), css = read("calendar.module.css");
	assert.match(source, /event\.sourceId === "platform" \? "var\(--home-accent\)" : event\.color/);
	assert.match(css, /\.layout \.externalEvent\{[^}]*var\(--calendar-color/);
	for (const status of ["eventDone", "eventCancelled", "eventOverdue"]) assert.ok(css.includes(`.layout .${status}`));
	assert.doesNotMatch(css, /\.(?:sourceBadge|compactBadge)\{/);
});
