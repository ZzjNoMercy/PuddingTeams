import assert from "node:assert/strict";
import { test } from "node:test";
import { assertValidObsidianUri, buildObsidianOpenUri, MAX_OBSIDIAN_URI_LENGTH } from "./obsidian-uri.js";

test("buildObsidianOpenUri 编码绝对路径且产出通过自检", () => {
	const abs = "/Users/alice/My Vault/我的 笔记#1.md";
	const uri = buildObsidianOpenUri(abs);
	assert.ok(uri.startsWith("obsidian://open?path="));
	assert.ok(!uri.includes("#"));
	assert.equal(new URL(uri).searchParams.get("path"), abs);
	assert.deepEqual(assertValidObsidianUri(uri), { ok: true });
});

test("合法 URI 通过：path 与 vault+file 两种形态", () => {
	assert.deepEqual(assertValidObsidianUri("obsidian://open?path=%2FUsers%2Falice%2Fnote.md"), { ok: true });
	assert.deepEqual(assertValidObsidianUri("obsidian://open?vault=main&file=notes%2Fa.md"), { ok: true });
	assert.deepEqual(assertValidObsidianUri("obsidian://open?path=a%0Ab"), { ok: true }); // 编码后的控制字符属于合法路径取值
	assert.deepEqual(assertValidObsidianUri("obsidian://open/?path=%2Fx.md"), { ok: true });
});

test("非 obsidian 协议伪装一律拒绝", () => {
	for (const uri of [
		"https://open?path=%2Fx.md",
		"http://obsidian://open?path=x",
		"file:///etc/passwd",
		"obsidian2://open?path=x",
		"OBSIDIANx://open?path=x",
	]) {
		const result = assertValidObsidianUri(uri);
		assert.equal(result.ok, false, uri);
	}
});

test("obsidian:// 其他命令与宿主伪装一律拒绝", () => {
	for (const uri of [
		"obsidian://new?path=x",
		"obsidian://hook-get?path=x",
		"obsidian:open?path=x",
		"obsidian://OPEN?path=x",
		"obsidian://open/sub?path=x",
		"obsidian://user:pass@open?path=x",
		"obsidian://open:8080?path=x",
		"obsidian://open.evil.com?path=x",
		"obsidian://open?path=x#frag",
	]) {
		const result = assertValidObsidianUri(uri);
		assert.equal(result.ok, false, uri);
	}
});

test("参数白名单：多余/缺失/重复/空值一律拒绝", () => {
	for (const uri of [
		"obsidian://open",
		"obsidian://open?",
		"obsidian://open?path=",
		"obsidian://open?path=%2Fx.md&evil=1",
		"obsidian://open?path=a&path=b",
		"obsidian://open?vault=main",
		"obsidian://open?file=a.md",
		"obsidian://open?vault=&file=a.md",
		"obsidian://open?vault=main&file=a.md&path=%2Fx",
	]) {
		const result = assertValidObsidianUri(uri);
		assert.equal(result.ok, false, uri);
	}
});

test("原始控制字符（含换行/制表）在解析前拒绝", () => {
	for (const uri of [
		"obsidian://open?path=/x\ny",
		"obsidian://open?path=/x\ry",
		"obsidian://open?path=/x\ty",
		"obsidian://open?path=/x\x00y",
		"obsidian://open?path=/x\x7fy",
	]) {
		const result = assertValidObsidianUri(uri);
		assert.equal(result.ok, false, uri);
		if (!result.ok) assert.equal(result.error, "URI 含有非法控制字符");
	}
});

test("超长与空输入拒绝，边界长度放行", () => {
	assert.equal(assertValidObsidianUri("").ok, false);
	// @ts-expect-error 运行期防御非字符串入参
	assert.equal(assertValidObsidianUri(undefined).ok, false);
	const overflow = buildObsidianOpenUri(`/${"a".repeat(MAX_OBSIDIAN_URI_LENGTH)}`);
	assert.ok(overflow.length > MAX_OBSIDIAN_URI_LENGTH);
	const result = assertValidObsidianUri(overflow);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /上限/);
	const exact = buildObsidianOpenUri("a".repeat(MAX_OBSIDIAN_URI_LENGTH - "obsidian://open?path=".length));
	assert.equal(exact.length, MAX_OBSIDIAN_URI_LENGTH);
	assert.deepEqual(assertValidObsidianUri(exact), { ok: true });
});
