import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UploadStore, identifyUploads } from "./uploads.js";

test("首发附件身份以冻结字节与顺序为准，恢复时拒绝被改写的文件", async () => {
	const store = new UploadStore(mkdtempSync(path.join(tmpdir(), "pt-uploads-")));
	await store.init();
	const inputs = [
		{ filename: "../first.txt", mediaType: "text/plain", data: Buffer.from("one").toString("base64") },
		{ filename: "second.txt", mediaType: "text/plain", data: Buffer.from("two").toString("base64") },
	];
	const identities = identifyUploads(inputs);
	const stored = await store.save("session-a", inputs);
	const content = "请检查附件";
	const message = `${content}\n\n用户附件（平台冻结路径，可按需读取并在委托任务中原样传递）：\n${stored.map((item) => `- ${item.name} (${item.mediaType}, ${item.size} bytes): ${item.path}`).join("\n")}`;
	assert.equal(await store.matchesFirstMessage("session-a", message, content, identities), true);
	assert.equal(await store.matchesFirstMessage("session-a", message, content, [...identities].reverse()), false);
	writeFileSync(stored[0]!.path, "bad");
	assert.equal(await store.matchesFirstMessage("session-a", message, content, identities), false);
	assert.throws(() => identifyUploads([{ filename: "x", mediaType: "text/plain\nattack", data: "YQ==" }]), /附件格式无效/);
});

test("外部路径首发从冻结文件名恢复字节摘要，原文件删除后仍能辨别同长篡改", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pt-external-first-work-"));
	const source = path.join(mkdtempSync(path.join(tmpdir(), "pt-external-source-")), "evidence.txt");
	writeFileSync(source, "original bytes");
	const store = new UploadStore(root);
	await store.init();
	const [stored] = await store.saveWithLocalFiles("first-session", [], [source]);
	const content = `请读 ${source}`;
	const message = `${content.replace(source, stored!.path)}\n\n用户附件（平台冻结路径，可按需读取并在委托任务中原样传递）：\n- ${stored!.name} (${stored!.mediaType}, ${stored!.size} bytes): ${stored!.path}`;
	assert.equal(await store.matchesFirstMessage("first-session", message, content, [], [{ token: source, required: true }]), true);
	const ambiguousContent = `先看 /workspace/missing.txt，再看 ${source}`;
	const ambiguousMessage = message.replace(content.replace(source, stored!.path), ambiguousContent.replace(source, stored!.path));
	assert.equal(await store.matchesFirstMessage("first-session", ambiguousMessage, ambiguousContent, [], [
		{ token: "/workspace/missing.txt", required: false }, { token: source, required: false },
	]), true, "恢复时可跳过未冻结的失效 Workspace 内路径");
	writeFileSync(stored!.path, "tampered bytes");
	assert.equal(await store.matchesFirstMessage("first-session", message, content, [], [{ token: source, required: true }]), false);
});

test("未接纳首发只回收本操作冻结批次，保留同 Session 其他文件", async () => {
	const store = new UploadStore(mkdtempSync(path.join(tmpdir(), "pt-first-work-reap-")));
	await store.init();
	const abandoned = await store.saveWithLocalFiles("session", [{ filename: "old.txt", data: "b2xk" }], [], "a".repeat(64));
	const other = await store.saveWithLocalFiles("session", [{ filename: "other.txt", data: "b3RoZXI=" }], [], "b".repeat(64));
	const ordinary = await store.save("session", [{ filename: "ordinary.txt", data: "b3JkaW5hcnk=" }]);
	assert.equal(await store.discardUnacceptedFirstWork("session", "a".repeat(64)), 1);
	assert.equal(existsSync(abandoned[0]!.path), false);
	assert.equal(existsSync(other[0]!.path), true);
	assert.equal(existsSync(ordinary[0]!.path), true);
	assert.equal(await store.discardUnacceptedFirstWork("session", "a".repeat(64)), 0);
});

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
