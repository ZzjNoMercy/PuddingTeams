import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { hashBufferSha256 } from "./hashing.js";
import { applyKnowledgePlan, buildKnowledgePlan, cleanupPlannedFiles, KnowledgePlanStore, type KnowledgePlan, type ApplyReceipt } from "./plans.js";
import { KnowledgeProbeStore, type KnowledgeProbeRecord } from "./probes.js";
import { copySchemaPreset } from "./schema-presets.js";
import { schemaPresetAgents } from "./schema-guidance.js";

const owner = "owner-1";

async function fixture() {
	const base = await mkdtemp(path.join(tmpdir(), "pt-plans-"));
	const root = path.join(base, "vault");
	await mkdir(root);
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const probes = new KnowledgeProbeStore();
	const plans = new KnowledgePlanStore(path.join(base, "plans"));
	return { base, root, registry, probes, plans };
}

async function planFor(
	fixtureResult: Awaited<ReturnType<typeof fixture>>,
	input: { name?: string; description?: string; mode?: string; obsidianRoot?: string; schemaPresetId?: string },
	root = fixtureResult.root,
): Promise<KnowledgePlan> {
	const probe = await fixtureResult.probes.create(owner, root);
	return buildKnowledgePlan(owner, probe, input, await fixtureResult.registry.findOverlap(probe.canonicalBindingRoot));
}

test("名称/描述边界：去空白必填，描述 ≤500", async () => {
	const fixtureResult = await fixture();
	await assert.rejects(() => planFor(fixtureResult, { name: "  ", description: "d", mode: "bind" }), { code: "invalid_input" });
	await assert.rejects(() => planFor(fixtureResult, { name: "n", description: "", mode: "bind" }), { code: "invalid_input" });
	await assert.rejects(() => planFor(fixtureResult, { name: "n", description: "x".repeat(501), mode: "bind" }), { code: "invalid_input" });
	await assert.rejects(() => planFor(fixtureResult, { name: "n", description: "d", mode: "wipe" }), { code: "invalid_input" });
	const plan = await planFor(fixtureResult, { name: "  我的库  ", description: "  描述  ", mode: "bind" });
	assert.equal(plan.name, "我的库");
	assert.equal(plan.description, "描述");
});

test("重叠/嵌套根在计划阶段即拒绝 overlapping_root", async () => {
	const fixtureResult = await fixture();
	await fixtureResult.registry.create({ ownerId: owner, name: "已有", description: "d", rootPath: fixtureResult.root });
	await assert.rejects(() => planFor(fixtureResult, { name: "n", description: "d", mode: "bind" }), { code: "overlapping_root" });
	const nested = path.join(fixtureResult.root, "nested");
	await mkdir(nested);
	await assert.rejects(() => planFor(fixtureResult, { name: "n", description: "d", mode: "bind" }, nested), { code: "overlapping_root" });
});

test("bind 模式 filesToCreate 必须为空；计划持久化可重载", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "bind" });
	assert.equal(plan.filesToCreate.length, 0);
	assert.equal(plan.filesToSkip.length, 0);
	await fixtureResult.plans.save(plan);
	const reopened = new KnowledgePlanStore(path.join(fixtureResult.base, "plans"));
	const loaded = await reopened.get(owner, plan.planId);
	assert.deepEqual(loaded, plan);
	await assert.rejects(() => reopened.get(owner, "missing"), { code: "not_found" });
	await assert.rejects(() => reopened.get("another-owner", plan.planId), { code: "not_found" });
});

test("create 模式冻结脚手架内容与哈希；已存在文件列入 filesToSkip", async () => {
	const fixtureResult = await fixture();
	await mkdir(path.join(fixtureResult.root, "wiki"));
	await writeFile(path.join(fixtureResult.root, "wiki", "index.md"), "既有首页\n");
	const plan = await planFor(fixtureResult, { name: "项目库", description: "项目描述", mode: "create", schemaPresetId: "project" });
	assert.equal(plan.mode, "create");
	assert.deepEqual(plan.filesToSkip, [{ relativePath: "wiki/index.md", reason: "already_exists" }]);
	assert.equal(plan.filesToCreate.length, 1);
	const schemaFile = plan.filesToCreate[0]!;
	assert.equal(schemaFile.relativePath, "wiki.schema.json");
	const expectedContent = `${JSON.stringify(copySchemaPreset("project"), null, 2)}\n`;
	assert.equal(schemaFile.content, expectedContent);
	assert.equal(schemaFile.bytes, Buffer.byteLength(expectedContent, "utf8"));
	assert.equal(schemaFile.contentHash, hashBufferSha256(expectedContent));

	const empty = await fixture();
	const createPlan = await planFor(empty, { name: "空库", description: "全新的", mode: "create" });
	assert.equal(createPlan.filesToCreate.length, 1);
	const index = createPlan.filesToCreate[0]!;
	assert.equal(index.relativePath, "wiki/index.md");
	assert.ok(index.content.includes("# 空库"));
	assert.ok(index.content.includes("全新的"));
	assert.equal(index.contentHash, hashBufferSha256(index.content));
});

test("schemaPresetId 仅 create 模式可用且必须已知", async () => {
	const fixtureResult = await fixture();
	await assert.rejects(() => planFor(fixtureResult, { name: "n", description: "d", mode: "bind", schemaPresetId: "research" }), { code: "invalid_input" });
	await assert.rejects(() => planFor(fixtureResult, { name: "n", description: "d", mode: "create", schemaPresetId: "ghost" }), { code: "invalid_input" });
});

test("带操作契约的结构预置在库根一并生成 AGENTS.md", async () => {
	const fixtureResult = await fixture();
	for (const presetId of ["people", "research", "memory"]) {
		const plan = await planFor(fixtureResult, { name: "库", description: "d", mode: "create", schemaPresetId: presetId });
		assert.equal(plan.contentRoot, plan.canonicalBindingRoot);
		assert.equal(plan.linkRoot, plan.canonicalBindingRoot);
		assert.deepEqual(plan.filesToCreate.map((item) => item.relativePath), ["wiki/index.md", "wiki.schema.json", "AGENTS.md"]);
		const agents = plan.filesToCreate[2]!;
		assert.equal(agents.content, schemaPresetAgents(presetId));
		assert.equal(agents.bytes, Buffer.byteLength(agents.content, "utf8"));
		assert.equal(agents.contentHash, hashBufferSha256(agents.content));
	}

	const target = path.join(fixtureResult.base, "renmai");
	await mkdir(target);
	const plan = await planFor(fixtureResult, { name: "人脉库", description: "维护人脉", mode: "create", schemaPresetId: "people" }, target);
	const applied = await applyKnowledgePlan(plan, fixtureResult.registry);
	assert.deepEqual(applied.receipts.map((item) => item.relativePath), ["wiki/index.md", "wiki.schema.json", "AGENTS.md"]);
	assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), plan.filesToCreate[2]!.content);
	assert.equal(applied.binding.schemaRef?.originPresetId, "people");

	// 契约是脚手架不是托管块：用户改过就保留，重建库不会再覆盖。
	const edited = path.join(fixtureResult.base, "renmai-edited");
	await mkdir(edited);
	await writeFile(path.join(edited, "AGENTS.md"), "我自己改过的契约\n");
	const again = await planFor(fixtureResult, { name: "人脉库", description: "维护人脉", mode: "create", schemaPresetId: "people" }, edited);
	assert.deepEqual(again.filesToSkip, [{ relativePath: "AGENTS.md", reason: "already_exists" }]);
	assert.equal(again.filesToCreate.some((item) => item.relativePath === "AGENTS.md"), false);
});

test("没有操作契约的结构预置不生成 AGENTS.md", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "项目库", description: "项目", mode: "create", schemaPresetId: "project" });
	assert.deepEqual(plan.filesToCreate.map((item) => item.relativePath), ["wiki/index.md", "wiki.schema.json"]);
});

test("obsidian 双候选必须显式选择且在候选列表内", async () => {
	const fixtureResult = await fixture();
	await mkdir(path.join(fixtureResult.root, "wiki"));
	await mkdir(path.join(fixtureResult.root, "raw"));
	await mkdir(path.join(fixtureResult.root, ".obsidian"));
	await mkdir(path.join(fixtureResult.root, "wiki", ".obsidian"));
	const probe = await fixtureResult.probes.create(owner, fixtureResult.root);
	assert.ok(probe.obsidianRootCandidates);
	await assert.rejects(
		() => buildKnowledgePlan(owner, probe, { name: "n", description: "d", mode: "bind" }, undefined),
		{ code: "invalid_input" },
	);
	await assert.rejects(
		() => buildKnowledgePlan(owner, probe, { name: "n", description: "d", mode: "bind", obsidianRoot: "/etc" }, undefined),
		{ code: "invalid_input" },
	);
	const plan = await buildKnowledgePlan(owner, probe, { name: "n", description: "d", mode: "bind", obsidianRoot: probe.obsidianRootCandidates![0]! }, undefined);
	assert.equal(plan.obsidianRoot, probe.obsidianRootCandidates![0]);
});

test("apply bind：零磁盘写入，登记携带四根", async () => {
	const fixtureResult = await fixture();
	await writeFile(path.join(fixtureResult.root, "note.md"), "原文\n");
	const before = await readdir(fixtureResult.root);
	const plan = await planFor(fixtureResult, { name: "绑定库", description: "d", mode: "bind" });
	const { binding, receipts } = await applyKnowledgePlan(plan, fixtureResult.registry);
	assert.deepEqual(receipts, []);
	assert.deepEqual(await readdir(fixtureResult.root), before);
	assert.equal(await readFile(path.join(fixtureResult.root, "note.md"), "utf8"), "原文\n");
	const canonical = await realpath(fixtureResult.root);
	assert.equal(binding.canonicalBindingRoot, canonical);
	assert.equal(binding.contentRoot, canonical);
	assert.equal(binding.linkRoot, canonical);
	assert.equal(binding.schemaRef, undefined);
	assert.equal((await fixtureResult.registry.list(owner)).length, 1);
});

test("apply create：receipts 逐项回执，已存在文件 skipped_exists 且内容不被覆盖", async () => {
	const fixtureResult = await fixture();
	await mkdir(path.join(fixtureResult.root, "wiki"));
	await writeFile(path.join(fixtureResult.root, "wiki", "index.md"), "既有首页\n");
	const plan = await planFor(fixtureResult, { name: "项目库", description: "d", mode: "create", schemaPresetId: "project" });
	const { binding, receipts } = await applyKnowledgePlan(plan, fixtureResult.registry);
	assert.deepEqual(receipts, [
		{ relativePath: "wiki/index.md", status: "skipped_exists" },
		{ relativePath: "wiki.schema.json", status: "created" },
	]);
	assert.equal(await readFile(path.join(fixtureResult.root, "wiki", "index.md"), "utf8"), "既有首页\n");
	assert.equal(await readFile(path.join(fixtureResult.root, "wiki.schema.json"), "utf8"), plan.filesToCreate[0]!.content);
	assert.equal(binding.schemaRef?.originPresetId, "project");
	assert.equal(binding.schemaRef?.revision, 1);
	assert.match(binding.schemaRef?.hash ?? "", /^[a-f0-9]{64}$/);
});

test("apply：根身份变化 → root_changed；目录离线 → context_unavailable", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "bind" });
	await rename(fixtureResult.root, `${fixtureResult.root}-old`);
	await assert.rejects(() => applyKnowledgePlan(plan, fixtureResult.registry), { code: "context_unavailable" });
	await mkdir(fixtureResult.root);
	await assert.rejects(() => applyKnowledgePlan(plan, fixtureResult.registry), { code: "root_changed" });
});

test("apply create 部分失败：failed 继续尝试其余项，保守清理仅删本次创建且未改动的文件", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "create", schemaPresetId: "project" });
	// 让 wiki/ 成为普通文件：首页目录创建失败 → schema 仍成功创建，随后保守清理。
	await writeFile(path.join(fixtureResult.root, "wiki"), "占位\n");
	const error = await applyKnowledgePlan(plan, fixtureResult.registry).then(
		() => assert.fail("应抛出 partial"),
		(caught: unknown) => caught,
	);
	assert.equal((error as { code?: string }).code, "partial");
	const receipts = (error as { details?: ApplyReceipt[] }).details!;
	assert.equal(receipts.find((receipt) => receipt.relativePath === "wiki/index.md")?.status, "failed");
	assert.equal(receipts.find((receipt) => receipt.relativePath === "wiki.schema.json")?.status, "created");
	// 保守清理：本次创建且未被改动的 schema 被删除；外部占位文件保留。
	const remaining = await stat(path.join(fixtureResult.root, "wiki.schema.json")).catch(() => null);
	assert.equal(remaining, null);
	assert.equal(await readFile(path.join(fixtureResult.root, "wiki"), "utf8"), "占位\n");
	assert.equal((await fixtureResult.registry.list(owner)).length, 0);
});

test("apply：登记阶段失败（并发抢先绑定同根）→ 已建文件保守清理并报 409", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "create" });
	// 计划生成后另一个流程抢先绑定了同根。
	await fixtureResult.registry.create({ ownerId: owner, name: "抢先", description: "d", rootPath: fixtureResult.root });
	await assert.rejects(() => applyKnowledgePlan(plan, fixtureResult.registry), { code: "overlapping_root" });
	const remaining = await stat(path.join(fixtureResult.root, "wiki", "index.md")).catch(() => null);
	assert.equal(remaining, null);
	// 本次创建的空目录（wiki/）也一并回收，避免后续 probe 误判为既有布局。
	assert.deepEqual(await readdir(fixtureResult.root), []);
});

test("撤销后同目录可重新 plan 并 apply 成功", async () => {
	const fixtureResult = await fixture();
	const first = await planFor(fixtureResult, { name: "项目库", description: "d", mode: "create", schemaPresetId: "project" });
	const { binding } = await applyKnowledgePlan(first, fixtureResult.registry);
	await fixtureResult.registry.revoke(owner, binding.id, binding.bindingRevision);
	// 重新接入：计划与登记都不再与已撤销绑定重叠；既有脚手架文件列入 filesToSkip，不覆盖。
	const second = await planFor(fixtureResult, { name: "项目库v2", description: "d", mode: "create", schemaPresetId: "project" });
	assert.equal(second.filesToCreate.length, 0);
	assert.deepEqual(second.filesToSkip.map((item) => item.relativePath).sort(), ["wiki.schema.json", "wiki/index.md"]);
	const { binding: rebound, receipts } = await applyKnowledgePlan(second, fixtureResult.registry);
	assert.notEqual(rebound.id, binding.id);
	assert.ok(receipts.every((receipt) => receipt.status === "skipped_exists"));
	assert.equal(await readFile(path.join(fixtureResult.root, "wiki", "index.md"), "utf8"), first.filesToCreate.find((item) => item.relativePath === "wiki/index.md")!.content);
	assert.equal((await fixtureResult.registry.list(owner)).length, 1);
});

test("apply create 部分失败：本次创建的空目录一并回收，外部占位不受影响", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "create", schemaPresetId: "project" });
	// wiki 成为普通文件 → 首页项 failed，wiki.schema.json 创建后被保守清理。
	await writeFile(path.join(fixtureResult.root, "wiki"), "占位\n");
	const error = await applyKnowledgePlan(plan, fixtureResult.registry).then(
		() => assert.fail("应抛出 partial"),
		(caught: unknown) => caught,
	);
	assert.equal((error as { code?: string }).code, "partial");
	// 根目录只剩外部占位文件。
	assert.deepEqual(await readdir(fixtureResult.root), ["wiki"]);
	assert.equal(await readFile(path.join(fixtureResult.root, "wiki"), "utf8"), "占位\n");
	assert.equal((await fixtureResult.registry.list(owner)).length, 0);
});

test("cleanupPlannedFiles：只回收本次创建且为空的目录，有外部内容或未登记的目录保留", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "create", schemaPresetId: "project" });
	const wikiDir = path.join(fixtureResult.root, "wiki");
	const schemaDir = path.join(fixtureResult.root, "schema");
	const untouchedDir = path.join(fixtureResult.root, "untouched");
	await mkdir(wikiDir);
	await mkdir(schemaDir);
	await mkdir(untouchedDir);
	const indexItem = plan.filesToCreate.find((item) => item.relativePath === "wiki/index.md")!;
	await writeFile(path.join(wikiDir, "index.md"), indexItem.content);
	// 外部文件落进本次创建的 schema/ → 该目录非空，必须保留。
	await writeFile(path.join(schemaDir, "external.txt"), "外部文件\n");
	const receipts: ApplyReceipt[] = [{ relativePath: "wiki/index.md", status: "created" }];
	await cleanupPlannedFiles(plan, receipts, [wikiDir, schemaDir]);
	assert.equal(await stat(path.join(wikiDir, "index.md")).catch(() => null), null);
	assert.equal(await stat(wikiDir).catch(() => null), null);
	assert.ok(await stat(schemaDir));
	assert.equal(await readFile(path.join(schemaDir, "external.txt"), "utf8"), "外部文件\n");
	// 未登记进 createdDirs 的既有目录不碰。
	assert.ok(await stat(untouchedDir));
});

test("cleanupPlannedFiles：外部改动过的本次创建文件必须保留", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "create" });
	const item = plan.filesToCreate[0]!;
	const absolute = path.join(fixtureResult.root, "wiki", "index.md");
	await mkdir(path.dirname(absolute), { recursive: true });
	await writeFile(absolute, item.content);
	const receipts: ApplyReceipt[] = [{ relativePath: item.relativePath, status: "created" }];
	// 未改动 → 删除
	await cleanupPlannedFiles(plan, receipts);
	assert.equal(await stat(absolute).catch(() => null), null);
	// 外部后改 → 保留
	await writeFile(absolute, `${item.content}外部追加\n`);
	await cleanupPlannedFiles(plan, receipts);
	assert.equal(await readFile(absolute, "utf8"), `${item.content}外部追加\n`);
});

test("apply create：目标根被整体换成只读 → 全部 failed 且无遗留", async () => {
	const fixtureResult = await fixture();
	const plan = await planFor(fixtureResult, { name: "n", description: "d", mode: "create", schemaPresetId: "project" });
	await chmod(fixtureResult.root, 0o555);
	try {
		const error = await applyKnowledgePlan(plan, fixtureResult.registry).then(
			() => assert.fail("应抛出 partial"),
			(caught: unknown) => caught,
		);
		assert.equal((error as { code?: string }).code, "partial");
		const receipts = (error as { details?: ApplyReceipt[] }).details!;
		assert.ok(receipts.every((receipt) => receipt.status === "failed"));
	} finally {
		await chmod(fixtureResult.root, 0o755);
	}
	assert.deepEqual(await readdir(fixtureResult.root), []);
});

test("createRootDir：targetExists:false 的 probe 强制 create 模式，rootIdentity 为 null", async () => {
	const fixtureResult = await fixture();
	const target = path.join(fixtureResult.base, "new-vault");
	const probe = await fixtureResult.probes.create(owner, target, { intent: "create" });
	assert.equal(probe.targetExists, false);
	await assert.rejects(
		() => buildKnowledgePlan(owner, probe, { name: "n", description: "d", mode: "bind" }, undefined),
		{ code: "invalid_input" },
	);
	const plan = await buildKnowledgePlan(owner, probe, { name: "新库", description: "d", mode: "create" }, undefined);
	assert.equal(plan.mode, "create");
	assert.equal(plan.createRootDir, true);
	assert.equal(plan.rootIdentity, null);
	assert.equal(plan.filesToCreate.length, 1);
	assert.equal(plan.filesToCreate[0]!.relativePath, "wiki/index.md");
	assert.equal(plan.filesToSkip.length, 0);
	// 目录仍未被创建（计划阶段不写盘）
	assert.equal(await stat(target).catch(() => null), null);
});

test("createRootDir：plan→apply 端到端创建根目录与脚手架，绑定携带新根身份", async () => {
	const fixtureResult = await fixture();
	const target = path.join(fixtureResult.base, "new-vault");
	const probe = await fixtureResult.probes.create(owner, target, { intent: "create" });
	const plan = await buildKnowledgePlan(owner, probe, { name: "新库", description: "全新", mode: "create", schemaPresetId: "project" }, undefined);
	const { binding, receipts } = await applyKnowledgePlan(plan, fixtureResult.registry);
	assert.deepEqual(receipts, [
		{ relativePath: "wiki/index.md", status: "created" },
		{ relativePath: "wiki.schema.json", status: "created" },
	]);
	// 磁盘断言：根目录与脚手架真实创建
	const index = await readFile(path.join(target, "wiki", "index.md"), "utf8");
	assert.ok(index.includes("# 新库"));
	assert.equal(
		await readFile(path.join(target, "wiki.schema.json"), "utf8"),
		plan.filesToCreate.find((item) => item.relativePath === "wiki.schema.json")!.content,
	);
	// 绑定身份与落盘后的真实目录一致
	const canonical = await realpath(target);
	const info = await stat(canonical);
	assert.equal(binding.canonicalBindingRoot, canonical);
	assert.equal(binding.rootIdentity, `${info.dev}:${info.ino}`);
	assert.equal(binding.schemaRef?.originPresetId, "project");
	assert.equal((await fixtureResult.registry.list(owner)).length, 1);
});

test("createRootDir：apply 时目录已被外部创建且含同名文件 → skipped_exists 不覆盖", async () => {
	const fixtureResult = await fixture();
	const target = path.join(fixtureResult.base, "new-vault");
	const probe = await fixtureResult.probes.create(owner, target, { intent: "create" });
	const plan = await buildKnowledgePlan(owner, probe, { name: "新库", description: "d", mode: "create" }, undefined);
	// 计划生成后外部创建了目录与同名脚手架文件
	await mkdir(path.join(target, "wiki"), { recursive: true });
	await writeFile(path.join(target, "wiki", "index.md"), "外部首页\n");
	const { binding, receipts } = await applyKnowledgePlan(plan, fixtureResult.registry);
	assert.deepEqual(receipts, [{ relativePath: "wiki/index.md", status: "skipped_exists" }]);
	assert.equal(await readFile(path.join(target, "wiki", "index.md"), "utf8"), "外部首页\n");
	assert.equal(binding.canonicalBindingRoot, await realpath(target));
	assert.equal((await fixtureResult.registry.list(owner)).length, 1);
});

test("createRootDir：登记失败时回收本操作创建的空根目录", async () => {
	const fixtureResult = await fixture();
	const target = path.join(fixtureResult.base, "new-vault");
	const probe = await fixtureResult.probes.create(owner, target, { intent: "create" });
	const plan = await buildKnowledgePlan(owner, probe, { name: "新库", description: "d", mode: "create" }, undefined);
	// 计划生成后另一个流程抢先绑定了父目录（与目标根嵌套重叠）。
	await fixtureResult.registry.create({ ownerId: owner, name: "抢先", description: "d", rootPath: fixtureResult.base });
	await assert.rejects(() => applyKnowledgePlan(plan, fixtureResult.registry), { code: "overlapping_root" });
	// 本操作创建的根目录（及其下空目录）全部回收，如同 apply 从未发生
	assert.equal(await stat(target).catch(() => null), null);
	assert.equal((await fixtureResult.registry.list(owner)).length, 1);
});

test("createRootDir：目标路径被外部创建为文件 → context_unavailable，不写盘", async () => {
	const fixtureResult = await fixture();
	const target = path.join(fixtureResult.base, "new-vault");
	const probe = await fixtureResult.probes.create(owner, target, { intent: "create" });
	const plan = await buildKnowledgePlan(owner, probe, { name: "新库", description: "d", mode: "create" }, undefined);
	await writeFile(target, "占位文件\n");
	await assert.rejects(() => applyKnowledgePlan(plan, fixtureResult.registry), { code: "context_unavailable" });
	assert.equal(await readFile(target, "utf8"), "占位文件\n");
	assert.equal((await fixtureResult.registry.list(owner)).length, 0);
});
