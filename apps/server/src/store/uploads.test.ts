import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UploadStore } from "./uploads.js";

test("附件上传：文件名净化、内容冻结与数量限制", async () => {
	const store = new UploadStore(mkdtempSync(path.join(tmpdir(), "pt-uploads-")));
	await store.init();
	const [stored] = await store.save("session/unsafe", [
		{ filename: "../report.txt", mediaType: "text/plain", data: Buffer.from("hello").toString("base64") },
	]);
	assert.equal(stored!.name, "report.txt");
	assert.equal(readFileSync(stored!.path, "utf-8"), "hello");
	assert.ok(!stored!.path.includes("session/unsafe"));
	await assert.rejects(
		() => store.save("s", Array.from({ length: 6 }, (_, i) => ({ filename: `${i}.txt`, data: "YQ==" }))),
		/最多上传 5/,
	);
});

test("外部本地文件冻结为 Session 所属不可变附件", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-uploads-"));
	const sourceDir = mkdtempSync(path.join(tmpdir(), "pt-source-"));
	const source = path.join(sourceDir, "outside.md");
	writeFileSync(source, "v1", "utf-8");
	const store = new UploadStore(root);
	await store.init();
	const [stored] = await store.saveWithLocalFiles("session-a", [], [source]);
	writeFileSync(source, "v2", "utf-8");
	assert.equal(readFileSync(stored!.path, "utf-8"), "v1");
	assert.equal(stored!.mediaType, "text/markdown");
	assert.ok(stored!.path.startsWith(path.join(root, "session-a") + path.sep));
});

test("冻结拒绝符号链接，并把浏览器与本地附件合并计算数量", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-uploads-"));
	const sourceDir = mkdtempSync(path.join(tmpdir(), "pt-source-"));
	const source = path.join(sourceDir, "real.txt");
	const link = path.join(sourceDir, "link.txt");
	writeFileSync(source, "secret", "utf-8");
	symlinkSync(source, link);
	const store = new UploadStore(root);
	await store.init();
	await assert.rejects(() => store.saveWithLocalFiles("s", [], [link]), /无法冻结外部文件/);
	await assert.rejects(
		() => store.saveWithLocalFiles("s", Array.from({ length: 5 }, (_, i) => ({ filename: `${i}.txt`, data: "YQ==" })), [source]),
		/最多上传 5/,
	);
});
