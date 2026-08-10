import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
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
