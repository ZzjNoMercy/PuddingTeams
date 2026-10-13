import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("calendar.module.css", import.meta.url), "utf8");
const declaration = (selector: string) => {
	const start = css.indexOf(`${selector}{`);
	assert.notEqual(start, -1, selector);
	return Object.fromEntries(css.slice(start + selector.length + 1, css.indexOf("}", start)).split(";").filter(Boolean).map(entry => entry.split(":")));
};
test("calendar heading overrides generic button centering and gap", () => {
	const heading = declaration(".layout .dayHeading");
	assert.equal(heading["justify-content"], "flex-start");
	assert.equal(heading.gap, "3px");
	assert.equal(heading["box-sizing"], "border-box");
	assert.equal(heading["white-space"], "nowrap");
	assert.equal(heading["flex-direction"], "column");
});
test("weekday and date line boxes fit within the 64px heading on desktop and mobile", () => {
	const heading = declaration(".layout .dayHeading"), weekday = declaration(".layout .dayHeading span"), date = declaration(".layout .dayHeading strong");
	assert.equal(weekday["flex-shrink"], "0");
	assert.equal(date["flex-shrink"], "0");
	const textHeight = parseFloat(weekday["font-size"]) * Number(weekday["line-height"]) + parseFloat(date["font-size"]) * Number(date["line-height"]);
	assert.ok(textHeight + parseFloat(heading.gap) + 2 * 8 + 1 <= parseFloat(heading.height), "line boxes + gap + vertical padding + border must fit");
	assert.match(css, /@media\(max-width:700px\)[^\n]*\.layout \.dayHeading\{height:64px;padding:8px\}/);
});
