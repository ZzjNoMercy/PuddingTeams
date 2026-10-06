import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
test("calendar loading overlay handles local/external/both and stays outside the inert content", () => {
	const overlay = read("calendar-loading.tsx"), app = read("calendar-app.tsx");
	assert.match(overlay, /if \(!local && !external\) return null/);
	assert.match(overlay, /external \? "正在读取外部日程…" : "正在加载日历…"/);
	assert.match(overlay, /role="status" aria-live="polite" aria-atomic="true"/);
	assert.match(app, /busy = loading \|\| externalLoading/);
	assert.match(app, /className=\{styles\.mainContent\} inert=\{busy\} aria-busy=\{busy\}/);
	assert.match(app, /<\/div><CalendarLoading local=\{loading\} external=\{externalLoading\} \/><\/div>/);
	assert.equal((app.match(/onLoadingChange=\{setExternalLoading\}/g) ?? []).length, 2, "both desktop and mobile report external loading");
});
test("external request replacement/unmount resets loading and stale responses cannot close a newer mask", () => {
	const source = read("external-calendars.tsx");
	assert.match(source, /onLoadingChange\(Boolean\(ready && selected\.length && start && end\)\)/);
	assert.match(source, /Promise\.allSettled/);
	assert.match(source, /if \(state\.current !== serial\) return/);
	assert.match(source, /setEventsErrors\([^\n]+onLoadingChange\(false\)/);
	assert.match(source, /return \(\) => \{ state\.current\+\+; onLoadingChange\(false\); \}/);
	assert.doesNotMatch(source, /正在读取外部日程/);
});
test("mask covers its calendar panel without viewport-fixed layout or large loading cards", () => {
	const css = read("calendar.module.css");
	assert.match(css, /\.main\{position:relative;min-height:0;isolation:isolate\}/);
	assert.match(css, /\.loadingOverlay\{position:absolute;inset:0;z-index:5/);
	assert.match(css, /backdrop-filter:blur\(3px\)/);
	assert.match(css, /prefers-reduced-motion:reduce.*loadingSpinner\{animation:none\}/);
});
