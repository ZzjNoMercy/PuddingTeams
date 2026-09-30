import { test } from "node:test";
import assert from "node:assert/strict";
import { diffNoteContent, MAX_DIFF_BYTES } from "./note-diff.js";

test("内容一致时无 hunk", () => {
	assert.deepEqual(diffNoteContent("a\nb\n", "a\nb\n"), { hunks: [], truncated: false });
});

test("基本增删行：插入、删除、修改各归其位", () => {
	const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
	const after = ["1", "2", "3x", "4", "5", "6", "7", "9", "10", "11"].join("\n");
	const { hunks, truncated } = diffNoteContent(before, after);
	assert.equal(truncated, false);
	// 修改 3→3x 与删除 8、新增 11 间隔 ≤2*context 被合并为一个 hunk 或两个，统一校验语义。
	const flat = hunks.flatMap((hunk) => hunk.lines);
	assert.ok(flat.some((line) => line.kind === "del" && line.text === "3"));
	assert.ok(flat.some((line) => line.kind === "add" && line.text === "3x"));
	assert.ok(flat.some((line) => line.kind === "del" && line.text === "8"));
	assert.ok(flat.some((line) => line.kind === "add" && line.text === "11"));
	for (const hunk of hunks) {
		assert.equal(hunk.aLines, hunk.lines.filter((line) => line.kind !== "add").length);
		assert.equal(hunk.bLines, hunk.lines.filter((line) => line.kind !== "del").length);
	}
});

test("相隔很远的改动分为多个 hunk，起止行号符合 unified diff 语义", () => {
	const a = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
	const b = [...a];
	b[1] = "changed-2";
	b[37] = "changed-38";
	const { hunks } = diffNoteContent(a.join("\n"), b.join("\n"));
	assert.equal(hunks.length, 2);
	assert.equal(hunks[0]!.aStart, 1);
	assert.equal(hunks[0]!.aLines, 5); // 行 1..5（context 3 + 改动行 + context 3 受文件头截断）
	assert.equal(hunks[1]!.lines.some((line) => line.kind === "add" && line.text === "changed-38"), true);
});

test("hunk 数超上限置 truncated", () => {
	const a = Array.from({ length: 8 * 210 }, (_, index) => `a${index}`);
	const b = [...a];
	for (let index = 0; index < 210; index++) b[index * 8] = `b${index}`;
	const { hunks, truncated } = diffNoteContent(a.join("\n"), b.join("\n"));
	assert.equal(truncated, true);
	assert.ok(hunks.length <= 200);
	assert.ok(hunks.length > 0);
});

test("输入超过 512 KiB 抛 too_large", () => {
	const big = "x".repeat(MAX_DIFF_BYTES + 1);
	assert.throws(() => diffNoteContent(big, "y"), { code: "too_large" });
	assert.throws(() => diffNoteContent("y", big), { code: "too_large" });
});
