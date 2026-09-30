import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNoteLinks, resolveMarkdownLinkTarget, resolveWikiLink, splitWikiLinkTarget } from "./links.js";

test("wiki 链接解析：别名/锚点/块引用", () => {
	assert.deepEqual(splitWikiLinkTarget("note"), { target: "note" });
	assert.deepEqual(splitWikiLinkTarget("note|别名"), { target: "note", alias: "别名" });
	assert.deepEqual(splitWikiLinkTarget("dir/note#章节"), { target: "dir/note", anchor: "章节" });
	assert.deepEqual(splitWikiLinkTarget("note#^block1"), { target: "note", anchor: "^block1" });
	assert.deepEqual(splitWikiLinkTarget("note#锚点|别名"), { target: "note", anchor: "锚点", alias: "别名" });

	const parsed = parseNoteLinks("见 [[a.md|甲]] 与 [[b#sec]] 与 [[c#^blk]]\n");
	assert.deepEqual(parsed.wikiLinks.map((link) => [link.target, link.alias, link.anchor]), [["a.md", "甲", undefined], ["b", undefined, "sec"], ["c", undefined, "^blk"]]);
});

test("md 行内链接仅收相对路径；跳过 http(s)/mailto/#/绝对路径与图片", () => {
	const parsed = parseNoteLinks([
		"[相对](./sub/note.md)",
		"[带标题](other/note.md \"标题\")",
		"[外链](https://example.com)",
		"[邮件](mailto:a@b.c)",
		"[页内](#anchor)",
		"[绝对](/etc/passwd)",
		"![图片](img/pic.png)",
		"[带锚](sibling.md#部分)",
	].join("\n"));
	assert.deepEqual(parsed.mdLinks.map((link) => [link.target, link.anchor]), [
		["./sub/note.md", undefined],
		["other/note.md", undefined],
		["sibling.md", "部分"],
	]);
});

test("标题行收集为锚点，闭合 # 被去除", () => {
	const parsed = parseNoteLinks("# 一级\n\n## 二级 ##\n正文 # 不是标题\n");
	assert.deepEqual(parsed.headings, ["一级", "二级"]);
});

test("resolveWikiLink：精确路径 > basename；0 broken / 1 ok / 多 ambiguous", () => {
	const all = ["dir/note.md", "other/note.md", "unique.md", "dir/sub/deep.md"];
	assert.deepEqual(resolveWikiLink(all, "dir/note"), { status: "ok", path: "dir/note.md" });
	assert.deepEqual(resolveWikiLink(all, "unique.md"), { status: "ok", path: "unique.md" });
	assert.deepEqual(resolveWikiLink(all, "note"), { status: "ambiguous", candidates: ["dir/note.md", "other/note.md"] });
	assert.deepEqual(resolveWikiLink(all, "deep"), { status: "ok", path: "dir/sub/deep.md" });
	assert.deepEqual(resolveWikiLink(all, "ghost"), { status: "broken" });
	assert.deepEqual(resolveWikiLink(all, ""), { status: "broken" });
});

test("resolveMarkdownLinkTarget 相对 from 目录解析，越界返回 null", () => {
	assert.equal(resolveMarkdownLinkTarget("a/b.md", "c.md"), "a/c.md");
	assert.equal(resolveMarkdownLinkTarget("a/b.md", "../top.md"), "top.md");
	assert.equal(resolveMarkdownLinkTarget("top.md", "../escape.md"), null);
	assert.equal(resolveMarkdownLinkTarget("top.md", "/abs.md"), null);
});
