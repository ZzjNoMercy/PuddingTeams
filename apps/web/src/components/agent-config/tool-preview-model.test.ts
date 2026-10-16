import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ToolPreviewGroup } from "@/lib/types";
import { filterToolGroups, summarizeToolExposure } from "./tool-preview-model";

const groups: ToolPreviewGroup[] = [
	{ id: "native", tools: [{ name: "read", exposure: "direct" }, { name: "grep", exposure: "direct", condition: "已排除（codeSearch=off）" }] },
	{ id: "knowledge", note: "需会话挂载知识库", tools: [{ name: "tool_search", exposure: "model-only" }, { name: "knowledge_read", exposure: "deferred" }] },
	{ id: "mcp", tools: [{ name: "deepwiki", exposure: "direct", condition: "DeepWiki" }] },
];

test("search matches names case-insensitively and preserves source conditions", () => {
	assert.deepEqual(filterToolGroups(groups, " READ ").map((group) => group.tools.map((tool) => tool.name)), [["read"], ["knowledge_read"]]);
	assert.equal(filterToolGroups(groups, "CODESEARCH")[0].tools[0].condition, "已排除（codeSearch=off）");
	assert.equal(filterToolGroups(groups, "DeepWiki")[0].id, "mcp");
});
test("search supports category, note and exposure without mutating the directory", () => {
	const before = JSON.stringify(groups);
	assert.equal(filterToolGroups(groups, "原生")[0], groups[0]);
	assert.equal(filterToolGroups(groups, "挂载")[0], groups[1]);
	assert.deepEqual(filterToolGroups(groups, "渐进声明")[0].tools.map((tool) => tool.name), ["knowledge_read"]);
	assert.equal(filterToolGroups(groups, "  "), groups);
	assert.deepEqual(filterToolGroups(groups, "no-match"), []);
	assert.equal(JSON.stringify(groups), before);
});
test("exposure summary deduplicates labels without implying availability", () => {
	assert.equal(summarizeToolExposure(groups[0]), "直接");
	assert.equal(summarizeToolExposure(groups[1]), "仅模型 · 渐进声明");
	assert.equal(summarizeToolExposure({ id: "mcp", tools: [] }), "");
});
test("directory starts collapsed, searches open matches, and retains accessibility and scope", () => {
	const source = readFileSync(new URL("tool-preview-section.tsx", import.meta.url), "utf8");
	assert.match(source, /initiallyOpen=\{searching\}/);
	assert.match(source, /aria-expanded=\{open\} aria-controls=\{contentId\}/);
	assert.match(source, /hidden=\{!open\}/);
	assert.match(source, /tool.condition \? <p/);
	assert.match(source, /group.note \? <p/);
	assert.match(source, /const mixed = new Set/);
	assert.match(source, /role="alert"/);
	assert.match(source, /setAttempt\(\(value\) => value \+ 1\)/);
	assert.doesNotMatch(source, /<Badge|method:|putAgent|saveAgent/);
	const css = readFileSync(new URL("tool-preview-section.module.css", import.meta.url), "utf8");
	assert.match(css, /var\(--config-surface,var\(--card\)\)/);
	assert.match(css, /max-height:360px;overflow-y:auto/);
	assert.match(css, /\.tools\{[^}]*padding-inline-end:16px/);
	assert.match(css, /\.tools\{[^}]*scrollbar-gutter:stable/);
	assert.match(css, /overflow-wrap:anywhere/);
});
