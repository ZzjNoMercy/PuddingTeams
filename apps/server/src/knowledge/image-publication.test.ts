import assert from "node:assert/strict";
import { test } from "node:test";
import { attachSourceImages, assertImageAssetBytes, imageAssetPath, markdownImageTargets, resolveImagePath } from "./image-publication.js";
import { hashBufferSha256 } from "./hashing.js";
import type { KnowledgeSource } from "./sources.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
const asset = imageAssetPath(hashBufferSha256(png), "image/png");
const relative = `../../${asset}`;
const source = { id: "image-source", title: "原图", kind: "image", originalHash: hashBufferSha256(png), mediaType: "image/png" } as KnowledgeSource;

test("Markdown图片解析覆盖引用/shortcut/嵌套转义alt，排除代码示例", () => {
	const content = `![inline [nested] alt](${relative})\n![escaped \\[alt\\]](${relative})\n![reference][IMG]\n![shortcut]\n\n[img]: <${relative}> \"title\"\n[shortcut]: ${relative}\n\n\`![example](../../raw/no.png)\`\n\n    ![indented](../../raw/no.png)\n\n\`\`\`md\n![fenced](../../raw/no.png)\n\`\`\`\n`;
	assert.deepEqual(markdownImageTargets(content), [relative, relative, relative, relative]);
	assert.equal(attachSourceImages("facts/nested/page.md", content, [source.id], [source]).content, content);
});

test("仅该页采纳图片附原图相对路径；未采纳shortcut/HTML/Wiki或越界引用拒绝", () => {
	const attached = attachSourceImages("facts/nested/page.md", "# 页面\n", [source.id], [source]);
	assert.match(attached.content, new RegExp(`!\\[原图\\]\\(../../${asset.replaceAll(".", "\\.")}\\)`));
	assert.deepEqual(attachSourceImages("page.md", "# 页面\n", [], [source]).assets, []);
	for (const bad of [`![evil]\n\n[evil]: ../../raw/photo.png`, `![not-adopted](${relative})`, `<img src="${relative}">`, `![[${relative}]]`]) {
		assert.throws(() => attachSourceImages("facts/nested/page.md", bad, [], [source]), /图片|相对|原件/);
	}
	for (const target of ["../../../outside.png", "file:///tmp/x.png", `/${asset}`, `../../${asset}?x=1`, `../../${asset}#x`]) assert.throws(() => resolveImagePath("facts/nested/page.md", target));
	assert.equal(resolveImagePath("facts/nested/page.md", relative), asset);
});

test("原图签名、路径hash和格式绑定，不能把别的bytes放在批准图路径", () => {
	assert.equal(assertImageAssetBytes(asset, png, "image/png"), "image/png");
	assert.throws(() => assertImageAssetBytes(asset, Buffer.concat([png, Buffer.from("tampered")]), "image/png"));
	assert.throws(() => assertImageAssetBytes(asset.replace(".png", ".jpg"), png));
});
