import { test } from "node:test";
import assert from "node:assert/strict";
import { isControlDocument } from "./note-paths.js";

test("契约、首页与日志在任何库形态下都不是笔记", () => {
	// 纯 Markdown 库（contentRoot = 库根）与 managed-wiki 库（contentRoot = wiki/）都要覆盖。
	for (const relativePath of [
		"AGENTS.md", "agents.md", "CLAUDE.md", "index.md", "INDEX.md", "log.md",
		"wiki/index.md", "wiki/log.md", "wiki/agents.md",
	]) {
		assert.equal(isControlDocument(relativePath), true, `${relativePath} 是控制文档`);
	}
});

test("子目录里的同名文件与其它页面仍是笔记", () => {
	for (const relativePath of [
		"concepts/index.md", "concepts/log.md", "concepts/agents.md", "a.md",
		"index.markdown", "index", "wiki/concepts/index.md", "wikis/index.md",
	]) {
		assert.equal(isControlDocument(relativePath), false, `${relativePath} 是笔记页`);
	}
});
