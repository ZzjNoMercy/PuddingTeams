import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { KnowledgeProbeError, KnowledgeProbeStore } from "./probes.js";

const owner = "owner-1";

async function vault(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "pt-probes-"));
}

test("分级错误：相对路径 400 级 invalid_path，不存在 not_found，文件 invalid_path，无权限 invalid_path", async () => {
	const store = new KnowledgeProbeStore();
	await assert.rejects(() => store.create(owner, "relative/dir"), { code: "invalid_path" });
	await assert.rejects(() => store.create(owner, path.join(tmpdir(), "pt-probes-不存在的目录")), { code: "not_found" });
	const root = await vault();
	const file = path.join(root, "file.md");
	await writeFile(file, "x");
	await assert.rejects(() => store.create(owner, file), { code: "invalid_path" });
	const locked = path.join(root, "locked");
	await mkdir(locked);
	await chmod(locked, 0o000);
	try {
		await assert.rejects(() => store.create(owner, locked), { code: "invalid_path" });
	} finally {
		await chmod(locked, 0o755);
	}
});

test("managed-wiki 标记与四根：contentRoot/linkRoot 指向 wiki/", async () => {
	const root = await vault();
	await mkdir(path.join(root, "wiki"));
	await mkdir(path.join(root, "raw"));
	await writeFile(path.join(root, "raw", "manifest.jsonl"), "");
	const store = new KnowledgeProbeStore();
	const record = await store.create(owner, root);
	assert.equal(record.profile, "managed-wiki");
	assert.equal(record.markers.hasWiki, true);
	assert.equal(record.markers.hasRaw, true);
	assert.equal(record.markers.hasManifest, true);
	assert.equal(record.markers.hasSchema, false);
	const canonical = await realpath(root);
	assert.equal(record.canonicalBindingRoot, canonical);
	assert.equal(record.contentRoot, path.join(canonical, "wiki"));
	assert.equal(record.linkRoot, path.join(canonical, "wiki"));
	assert.match(record.rootIdentity!, /^\d+:\d+$/);
	assert.equal(record.capabilities.structuredPrepare, false);
	assert.equal(record.capabilities.publish, false);
	// TTL 内可取回同一条记录
	assert.equal(store.get(owner, record.probeId).probeId, record.probeId);
});

test("obsidian 根：仅根 / 仅 wiki / 双候选 / 都没有", async () => {
	const store = new KnowledgeProbeStore();
	const rootOnly = await vault();
	await mkdir(path.join(rootOnly, ".obsidian"));
	const onlyRoot = await store.create(owner, rootOnly);
	assert.equal(onlyRoot.obsidianRoot, await realpath(rootOnly));
	assert.equal(onlyRoot.obsidianRootCandidates, undefined);
	assert.equal(onlyRoot.markers.hasObsidianRoot, true);
	assert.equal(onlyRoot.markers.hasObsidianWiki, false);

	const wikiOnly = await vault();
	await mkdir(path.join(wikiOnly, "wiki"));
	await mkdir(path.join(wikiOnly, "raw"));
	await mkdir(path.join(wikiOnly, "wiki", ".obsidian"));
	const onlyWiki = await store.create(owner, wikiOnly);
	assert.equal(onlyWiki.obsidianRoot, path.join(await realpath(wikiOnly), "wiki"));
	assert.equal(onlyWiki.markers.hasObsidianRoot, false);
	assert.equal(onlyWiki.markers.hasObsidianWiki, true);

	const both = await vault();
	await mkdir(path.join(both, "wiki"));
	await mkdir(path.join(both, "raw"));
	await mkdir(path.join(both, ".obsidian"));
	await mkdir(path.join(both, "wiki", ".obsidian"));
	const dual = await store.create(owner, both);
	const canonical = await realpath(both);
	assert.equal(dual.obsidianRoot, undefined);
	assert.deepEqual(dual.obsidianRootCandidates, [canonical, path.join(canonical, "wiki")]);
	assert.ok(dual.warnings.some((warning) => warning.includes("显式选择 Obsidian 根")));

	const none = await store.create(owner, await vault());
	assert.equal(none.obsidianRoot, undefined);
	assert.equal(none.obsidianRootCandidates, undefined);
	assert.ok(none.warnings.some((warning) => warning.includes(".obsidian")));
});

test("TTL：过期后 get 抛 not_found（懒清理）", async () => {
	let now = 1_000_000;
	const store = new KnowledgeProbeStore(10 * 60 * 1000, () => now);
	const record = await store.create(owner, await vault());
	assert.equal(store.get(owner, record.probeId).probeId, record.probeId);
	now += 10 * 60 * 1000 + 1;
	assert.throws(() => store.get(owner, record.probeId), (error: unknown) => error instanceof KnowledgeProbeError && error.code === "not_found");
	// 其他所有者的 probeId 也不可见
	const fresh = await store.create(owner, await vault());
	assert.throws(() => store.get("another-owner", fresh.probeId), { code: "not_found" });
});

test("intent=create 且目标不存在：targetExists:false 空库形状，canonical 取 realpath(父)+末级名", async () => {
	const root = await vault();
	const target = path.join(root, "my-vault");
	const store = new KnowledgeProbeStore();
	const record = await store.create(owner, target, { intent: "create" });
	const canonical = await realpath(root);
	assert.equal(record.targetExists, false);
	assert.equal(record.canonicalBindingRoot, path.join(canonical, "my-vault"));
	assert.equal(record.rootIdentity, null);
	assert.equal(record.profile, "markdown");
	assert.equal(record.contentRoot, record.canonicalBindingRoot);
	assert.equal(record.linkRoot, record.canonicalBindingRoot);
	assert.deepEqual(record.markers, {
		hasWiki: false, hasRaw: false, hasManifest: false, hasSchema: false, hasObsidianRoot: false, hasObsidianWiki: false,
	});
	assert.deepEqual(record.capabilities, { read: false, layoutReady: false, structuredPrepare: false, publish: false });
	assert.ok(record.warnings.some((warning) => warning.includes("将在应用接入计划时创建")));
	// probe 记录照常入 Store，TTL 内可取回
	assert.equal(store.get(owner, record.probeId).probeId, record.probeId);
	// 磁盘未发生任何写入：目标目录仍未创建
	assert.equal(await stat(target).catch(() => null), null);
});

test("intent=create 且目标已存在：退化为普通探测（targetExists:true）", async () => {
	const root = await vault();
	await mkdir(path.join(root, "wiki"));
	const store = new KnowledgeProbeStore();
	const record = await store.create(owner, root, { intent: "create" });
	assert.equal(record.targetExists, true);
	assert.equal(record.canonicalBindingRoot, await realpath(root));
	assert.match(record.rootIdentity ?? "", /^\d+:\d+$/);
	assert.equal(record.markers.hasWiki, true);
	assert.equal(record.capabilities.read, true);
});

test("intent=create 父目录三态错误：父目录不存在 / 父路径是文件 / 父目录不可写", async () => {
	const store = new KnowledgeProbeStore();
	const root = await vault();
	await assert.rejects(
		() => store.create(owner, path.join(root, "missing-parent", "vault"), { intent: "create" }),
		(error: unknown) => error instanceof KnowledgeProbeError && error.code === "invalid_path" && error.message.includes("父目录不存在"),
	);
	const fileParent = path.join(root, "file.md");
	await writeFile(fileParent, "x");
	await assert.rejects(
		() => store.create(owner, path.join(fileParent, "vault"), { intent: "create" }),
		(error: unknown) => error instanceof KnowledgeProbeError && error.code === "invalid_path" && error.message.includes("不是目录"),
	);
	const locked = path.join(root, "locked");
	await mkdir(locked);
	await chmod(locked, 0o555);
	try {
		await assert.rejects(
			() => store.create(owner, path.join(locked, "vault"), { intent: "create" }),
			(error: unknown) => error instanceof KnowledgeProbeError && error.code === "invalid_path" && error.message.includes("无写入权限"),
		);
	} finally {
		await chmod(locked, 0o755);
	}
	// 相对路径与 .. 语义同样拒绝
	await assert.rejects(() => store.create(owner, "relative/dir", { intent: "create" }), { code: "invalid_path" });
	await assert.rejects(
		() => store.create(owner, `${root}/missing/../vault`, { intent: "create" }),
		(error: unknown) => error instanceof KnowledgeProbeError && error.code === "invalid_path" && error.message.includes(".."),
	);
});

test("bind 语义对不存在路径仍 not_found（省略 intent 与显式 bind 一致）", async () => {
	const store = new KnowledgeProbeStore();
	const missing = path.join(await vault(), "not-here");
	await assert.rejects(() => store.create(owner, missing), { code: "not_found" });
	await assert.rejects(() => store.create(owner, missing, { intent: "bind" }), { code: "not_found" });
});

test("~ 家目录简写：~ 展开为家目录，~/name 参与 intent=create 待创建探测", async () => {
	const home = homedir();
	const store = new KnowledgeProbeStore();
	const self = await store.create(owner, "~");
	assert.equal(self.targetExists, true);
	assert.equal(self.canonicalBindingRoot, await realpath(home));

	const name = `pt-probes-不存在-${process.pid}-${Date.now()}`;
	const record = await store.create(owner, `~/${name}`, { intent: "create" });
	assert.equal(record.targetExists, false);
	assert.equal(record.canonicalBindingRoot, path.join(await realpath(home), name));
	// 目录未发生任何写入
	assert.equal(await stat(path.join(home, name)).catch(() => null), null);
	// ~user 形式不展开，按非绝对路径拒绝
	await assert.rejects(() => store.create(owner, "~someone/vault"), { code: "invalid_path" });
});
