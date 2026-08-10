import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureHandoffGuidance, handoffDirFor, handoffRelativePath, upsertManagedBlock } from "./handoff.js";

/** §15.3 目录约定与 §15.5.1 AGENTS.md/CLAUDE.md 托管块软引导。 */

test("handoffDirFor 按 <workspace>/.pudding/handoff/<delegationId>/ 生成导出目录", () => {
	assert.equal(
		handoffDirFor("/tmp/ws", "del-1"),
		path.join("/tmp/ws", ".pudding", "handoff", "del-1"),
	);
});

test("handoffRelativePath 统一为 posix 的 workspace 相对路径", () => {
	assert.equal(handoffRelativePath("del-1", "report.md"), ".pudding/handoff/del-1/report.md");
	assert.equal(handoffRelativePath("del-1", "sub/dir/report.md"), ".pudding/handoff/del-1/sub/dir/report.md");
	// Windows 分隔符也归一。
	assert.equal(handoffRelativePath("del-1", "sub\\report.md"), ".pudding/handoff/del-1/sub/report.md");
});

test("upsertManagedBlock 幂等：重复写入只替换托管块，不破坏用户内容", () => {
	const user = "# 我的项目\n\n用户自己的说明。\n";
	const once = upsertManagedBlock(user);
	assert.ok(once.includes("<!-- pudding:handoff-begin -->"));
	assert.ok(once.includes(".pudding/handoff/"));
	assert.ok(once.startsWith(user.trimEnd()), "用户内容必须原样保留在托管块之前");

	const twice = upsertManagedBlock(once);
	assert.equal(twice, once, "重复写入不得产生任何变化（幂等）");
	assert.equal(twice.match(/pudding:handoff-begin/g)!.length, 1, "不得出现第二个托管块");
});

test("upsertManagedBlock 空内容直接生成托管块", () => {
	const out = upsertManagedBlock("");
	assert.ok(out.startsWith("<!-- pudding:handoff-begin -->"));
	assert.ok(out.endsWith("<!-- pudding:handoff-end -->\n"));
});

test("ensureHandoffGuidance 同时写 AGENTS.md 与 CLAUDE.md，且幂等不动用户内容", async () => {
	const ws = mkdtempSync(path.join(tmpdir(), "pt-handoff-"));
	writeFileSync(path.join(ws, "AGENTS.md"), "# 用户规则\n");

	await ensureHandoffGuidance(ws);
	const agents1 = readFileSync(path.join(ws, "AGENTS.md"), "utf-8");
	const claude1 = readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
	assert.ok(agents1.includes("# 用户规则"));
	assert.ok(agents1.includes("pudding:handoff-begin"));
	assert.ok(claude1.includes("pudding:handoff-begin"), "CLAUDE.md 同样要写入（§15.5.1）");

	await ensureHandoffGuidance(ws);
	assert.equal(readFileSync(path.join(ws, "AGENTS.md"), "utf-8"), agents1, "重复解析不得改写文件");
	assert.equal(readFileSync(path.join(ws, "CLAUDE.md"), "utf-8"), claude1);
});
