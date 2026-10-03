import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPropertyValue, splitFrontmatter } from "./markdown";

test("frontmatter displays quoted strings and YAML lists as text without changing the body", () => {
	const parsed = splitFrontmatter('---\nphone: "018918508255"\nbirthday: "1984"\nsources: ["source-a", "source-b"]\ntags:\n  - "Agent, Runtime"\n  - Wiki\nsummary: |\n  第一行\n  第二行\n---\n# 正文\n[[People/刘大强]]\n');
	assert.deepEqual(parsed.properties, [["phone", "018918508255"], ["birthday", "1984"], ["sources", "source-a、source-b"], ["tags", "Agent, Runtime、Wiki"], ["summary", "第一行\n第二行\n"]]);
	assert.equal(parsed.body, "# 正文\n[[People/刘大强]]\n");
});

test("timestamp display uses local calendar date and seconds; years and plain dates stay intact", () => {
	assert.equal(formatPropertyValue(new Date(2026, 9, 1, 21, 20, 51, 505).toISOString()), "2026-10-01 21:20:51");
	for (const value of ["1984", "2026-10-01", "not-a-date"]) assert.equal(formatPropertyValue(value), value);
});

test("empty lists, EOF metadata, quoted commas and malformed metadata remain readable", () => {
	assert.deepEqual(splitFrontmatter('---\ntags: ["hello, world", "second"]\nempty: []\n---').properties, [["tags", "hello, world、second"], ["empty", "—"]]);
	assert.equal(splitFrontmatter("ordinary text").body, "ordinary text");
	assert.deepEqual(splitFrontmatter("---\ntitle: [invalid\n---\nbody").properties, [["title", "[invalid"]]);
});
