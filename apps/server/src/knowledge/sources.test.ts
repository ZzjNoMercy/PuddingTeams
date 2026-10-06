import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSourceError, KnowledgeSourceStore, knowledgeSourceManifestHash } from "./sources.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-sources-"));
	const objects = new KnowledgeObjectStore(path.join(root, "source-objects"));
	const stateDir = path.join(root, "source-state");
	const store = new KnowledgeSourceStore({ stateDir, objects });
	return { root, objects, stateDir, store };
}

test("sources：文字原话和行定位冻结，用户权限与独立会话生命周期", async () => {
	const { root, objects, stateDir, store } = await fixture();
	const text = "用户原话\n第二行：2026-09-30\n";
	const source = await store.createText("owner", text, { sessionId: "deleted-chat", messageId: "message-1" });
	assert.equal(source.status, "ready");
	assert.equal(source.kind, "text");
	assert.equal((await objects.get(source.originalHash)).toString(), text);
	assert.equal((await store.readText("owner", source.id)).text, text);
	assert.deepEqual(source.locations, [{ kind: "lines", startLine: 1, endLine: 3 }]);
	assert.equal(await store.get("other", source.id), undefined);
	await assert.rejects(() => store.readText("other", source.id), (error: unknown) => error instanceof KnowledgeSourceError && error.code === "not_found");
	await mkdir(path.join(root, "uploads", "deleted-chat"), { recursive: true });
	await rm(path.join(root, "uploads", "deleted-chat"), { recursive: true });
	const restarted = new KnowledgeSourceStore({ stateDir, objects });
	assert.equal((await restarted.readText("owner", source.id)).text, text);
	assert.equal((await restarted.get("owner", source.id))!.origin!.sessionId, "deleted-chat");
});

test("sources：MD/txt fatal UTF8，不把替换字符或二进制空提取冒充成功", async () => {
	const { objects, store } = await fixture();
	const inputs = [
		{ filename: "资料.md", mediaType: "text/markdown", data: Buffer.from("# 人物\r\n原话").toString("base64") },
		{ filename: "bad.txt", mediaType: "text/plain", data: Buffer.from([0xc3, 0x28]).toString("base64") },
		{ filename: "binary.txt", data: Buffer.from([65, 0, 66]).toString("base64") },
	];
	const sources = await store.createUploads("owner", inputs);
	assert.equal(sources[0]!.status, "ready");
	assert.equal(sources[0]!.kind, "markdown");
	assert.equal((await store.readText("owner", sources[0]!.id)).text, "# 人物\r\n原话");
	for (const source of sources.slice(1)) {
		assert.equal(source.status, "failed");
		assert.equal(source.textHash, undefined);
		assert.equal(source.warnings.length, 1);
		await objects.get(source.originalHash);
		await assert.rejects(() => store.readText("owner", source.id), (error: unknown) => error instanceof KnowledgeSourceError && error.code === "source_unavailable");
	}
});

test("sources：图片/PDF真实 magic 冻结原件，缺提取能力明确 needs_attention", async () => {
	const { objects, store } = await fixture();
	const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
	const pdf = Buffer.from("%PDF-1.7\nNot parsed, no fake OCR\n");
	const sources = await store.createUploads("owner", [
		{ filename: "photo.png", mediaType: "image/png", data: png.toString("base64") },
		{ filename: "scan.pdf", mediaType: "application/pdf", data: pdf.toString("base64") },
	]);
	assert.deepEqual(sources.map((source) => source.kind), ["image", "pdf"]);
	for (const [index, source] of sources.entries()) {
		assert.equal(source.status, "needs_attention");
		assert.equal(source.textHash, undefined);
		assert.deepEqual(source.locations, []);
		assert.match(source.warnings[0]!, source.kind === "image" ? /尚未提取/ : /尚未接入/);
		assert.deepEqual(await objects.get(source.originalHash), index === 0 ? png : pdf);
	}
});

test("sources：拒绝声明类型伪造、任意磁盘path、上传配额与非法payload", async () => {
	const { store } = await fixture();
	await assert.rejects(() => store.createUploads("owner", [{ filename: "fake.pdf", mediaType: "application/pdf", data: Buffer.from("text").toString("base64") }]), KnowledgeSourceError);
	await assert.rejects(() => store.createUploads("owner", [{ filename: "fake.txt", mediaType: "text/plain", data: Buffer.from("%PDF-1.7").toString("base64") }]), KnowledgeSourceError);
	await assert.rejects(() => store.createUploads("owner", [{ filename: "file.md", data: "not-base64!" }]), KnowledgeSourceError);
	await assert.rejects(() => store.createUploads("owner", [{ filename: "file.md", path: "/etc/passwd" } as never]), KnowledgeSourceError);
	await assert.rejects(() => store.createUploads("owner", Array.from({ length: 6 }, () => ({ filename: "a.md", data: "eA==" }))), KnowledgeSourceError);
	await assert.rejects(() => store.createText("owner", " "), KnowledgeSourceError);
});

test("sources：聊天无后缀附件仍按真实图片签名或明确文本MIME校验", async () => {
	const { store } = await fixture();
	const [text, image] = await store.createUploads("owner", [
		{ filename: "资料", mediaType: "text/plain", data: Buffer.from("原话，不是模型委派文本").toString("base64") },
		{ filename: "截图", mediaType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") },
	]);
	assert.equal((await store.readText("owner", text!.id)).text, "原话，不是模型委派文本");
	assert.equal(image!.kind, "image"); assert.equal(image!.status, "needs_attention");
	const [invalid] = await store.createUploads("owner", [{ filename: "坏编码", mediaType: "text/plain", data: Buffer.from([0xc3, 0x28]).toString("base64") }]);
	assert.equal(invalid!.status, "failed");
});

test("sources：manifest固定原件/文本/定位/来源，顺序稳定且跨用户拒绝", async () => {
	const { store, objects } = await fixture();
	const first = await store.createText("owner", "# First", { sessionId: "one" });
	const second = await store.createText("owner", "# Second");
	const frozen = await store.manifest("owner", [first.id, second.id]);
	const reversed = await store.manifest("owner", [second.id, first.id]);
	assert.equal(knowledgeSourceManifestHash(frozen.sources), knowledgeSourceManifestHash(reversed.sources));
	assert.notEqual(knowledgeSourceManifestHash(frozen.sources), knowledgeSourceManifestHash([{ ...first, origin: { sessionId: "changed" } }, second]));
	assert.notEqual(knowledgeSourceManifestHash(frozen.sources), knowledgeSourceManifestHash([{ ...first, locations: [{ kind: "lines", startLine: 2, endLine: 2 }] }, second]));
	await assert.rejects(() => store.manifest("owner", [first.id, first.id]), KnowledgeSourceError);
	await assert.rejects(() => store.manifest("other", [first.id]), KnowledgeSourceError);
	const originalGet = objects.get.bind(objects);
	objects.get = async (hash) => { if (hash === first.originalHash) throw new Error("missing object"); return originalGet(hash); };
	await assert.rejects(() => store.manifest("owner", [first.id]), /missing object/);
});
