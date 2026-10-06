import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("all authored focus-visible CSS observes the shared pointer marker", () => {
	for (const file of readdirSync(new URL("../", import.meta.url), { recursive: true }).filter((file): file is string => typeof file === "string" && file.endsWith(".css"))) {
		assert.equal(/:focus-visible(?!:not\(\[data-pointer-focus="true"\]\))/.test(source(file)), false, file);
	}
});
test("native controls, Tailwind utilities and radio wrappers follow one policy", () => {
	const css = source("app/globals.css");
	assert.match(css, /@custom-variant focus-visible \(&:focus-visible:not\(\[data-pointer-focus="true"\]\)\)/);
	assert.match(css, /:where\(button, a\[href\], select, summary.*\):focus \{ outline: none; \}/);
	assert.ok(css.includes('.knowledge-option:has(input:focus-visible:not([data-pointer-focus="true"]))'));
	assert.doesNotMatch(source("components/ui/dialog.tsx"), /\bfocus:ring/);
});
