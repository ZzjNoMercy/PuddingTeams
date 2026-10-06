import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeObservationService } from "../knowledge/observation.js";
import { KnowledgeSearchIndex } from "../knowledge/search-index.js";
import { KnowledgeProbeStore } from "../knowledge/probes.js";
import { KnowledgePlanStore } from "../knowledge/plans.js";
import { copySchemaPreset } from "../knowledge/schema-presets.js";
import { hashBufferSha256 } from "../knowledge/hashing.js";
import { registerKnowledgeRoutes, type KnowledgeRouteDeps } from "./knowledge.js";

interface Fixture {
	base: string;
	root: string;
	app: FastifyInstance;
	deps: KnowledgeRouteDeps;
}

async function fixture(suffix: string): Promise<Fixture> {
	const base = await mkdtemp(path.join(tmpdir(), `pt-knowledge-t20-${suffix}-`));
	const root = path.join(base, "vault");
	await mkdir(root);
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const objects = new KnowledgeObjectStore(path.join(base, "objects"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(base, "acceptance"));
	const deps: KnowledgeRouteDeps = {
		objects,
		acceptance,
		observation: new KnowledgeObservationService(acceptance, { objects }),
		searchIndex: new KnowledgeSearchIndex(path.join(base, "cache"), objects),
		probes: new KnowledgeProbeStore(),
		plans: new KnowledgePlanStore(path.join(base, "plans")),
	};
	const app = Fastify();
	registerKnowledgeRoutes(app, registry, deps);
	return { base, root, app, deps };
}

async function probe(app: FastifyInstance, root: string): Promise<string> {
	const response = await app.inject({ method: "POST", url: "/api/knowledge/probes", payload: { path: root } });
	assert.equal(response.statusCode, 201, JSON.stringify(response.json()));
	return response.json().probeId as string;
}

test("T20 全链路：probes → plans(create+preset) → apply 201，脚手架落盘且绑定带 schemaRef", async () => {
	const { root, app } = await fixture("flow");
	const probeId = await probe(app, root);
	const create = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId, name: "研究库", description: "研究描述", mode: "create", schemaPresetId: "research" },
	});
	assert.equal(create.statusCode, 201, JSON.stringify(create.json()));
	const plan = create.json().plan as { planId: string; filesToCreate: Array<{ relativePath: string; contentHash: string }>; rootIdentity: string };
	assert.equal(plan.filesToCreate.length, 3);
	// 刷新恢复：GET 计划
	const reload = await app.inject({ method: "GET", url: `/api/knowledge/plans/${plan.planId}` });
	assert.equal(reload.statusCode, 200);
	assert.equal(reload.json().plan.planId, plan.planId);

	const apply = await app.inject({ method: "POST", url: `/api/knowledge/plans/${plan.planId}/apply` });
	assert.equal(apply.statusCode, 201, JSON.stringify(apply.json()));
	const receipts = apply.json().receipts as Array<{ relativePath: string; status: string }>;
	assert.deepEqual(receipts.map((receipt) => [receipt.relativePath, receipt.status]), [
		["wiki/index.md", "created"],
		["wiki.schema.json", "created"],
		["AGENTS.md", "created"],
	]);
	const index = await readFile(path.join(root, "wiki", "index.md"), "utf8");
	assert.ok(index.includes("# 研究库"));
	assert.ok((await readFile(path.join(root, "AGENTS.md"), "utf8")).includes("研究 Wiki Agent 操作契约"));
	const binding = apply.json().binding as { id: string; schemaRef?: { originPresetId?: string } };
	assert.equal(binding.schemaRef?.originPresetId, "research");
	// 生效结构来自根目录声明
	const schema = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/schema` });
	assert.equal(schema.json().origin, "vault_declaration");
	assert.equal(schema.json().schema.schemaId, "research");
	assert.equal(schema.json().capabilities.structured, true);
	await app.close();
});

test("T20 bind 模式：probe → plan(filesToCreate 为空) → apply，目录零写入", async () => {
	const { root, app } = await fixture("bind");
	await writeFile(path.join(root, "note.md"), "原文\n");
	const before = await readdir(root);
	const probeId = await probe(app, root);
	const create = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId, name: "既有库", description: "只绑定", mode: "bind" },
	});
	assert.equal(create.statusCode, 201);
	assert.deepEqual(create.json().plan.filesToCreate, []);
	const apply = await app.inject({ method: "POST", url: `/api/knowledge/plans/${create.json().plan.planId}/apply` });
	assert.equal(apply.statusCode, 201);
	assert.deepEqual(apply.json().receipts, []);
	assert.deepEqual(await readdir(root), before);
	await app.close();
});

test("plans：未知/过期 probeId 404；obsidian 双候选未选 400；选择后 201", async () => {
	const { root, app } = await fixture("planerr");
	const missing = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId: "00000000-0000-0000-0000-000000000000", name: "n", description: "d", mode: "bind" },
	});
	assert.equal(missing.statusCode, 404);

	await mkdir(path.join(root, "wiki"));
	await mkdir(path.join(root, "raw"));
	await mkdir(path.join(root, ".obsidian"));
	await mkdir(path.join(root, "wiki", ".obsidian"));
	const probeId = await probe(app, root);
	const noChoice = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId, name: "n", description: "d", mode: "bind" },
	});
	assert.equal(noChoice.statusCode, 400);
	const probeRecord = (await app.inject({ method: "POST", url: "/api/knowledge/probes", payload: { path: root } })).json().probe;
	const candidates = probeRecord.obsidianRootCandidates as string[];
	assert.equal(candidates.length, 2);
	const chosen = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId, name: "n", description: "d", mode: "bind", obsidianRoot: candidates[1] },
	});
	assert.equal(chosen.statusCode, 201, JSON.stringify(chosen.json()));
	assert.equal(chosen.json().plan.obsidianRoot, candidates[1]);
	const apply = await app.inject({ method: "POST", url: `/api/knowledge/plans/${chosen.json().plan.planId}/apply` });
	assert.equal(apply.statusCode, 201);
	assert.equal(apply.json().binding.obsidianRoot, candidates[1]);
	await app.close();
});

test("apply：未知 planId 404；重叠根在计划阶段 409", async () => {
	const { root, app } = await fixture("applyerr");
	const missing = await app.inject({ method: "POST", url: "/api/knowledge/plans/00000000-0000-0000-0000-000000000000/apply" });
	assert.equal(missing.statusCode, 404);
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "已有", description: "d" } });
	assert.equal(create.statusCode, 201);
	const probeId = await probe(app, root);
	const overlap = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId, name: "n", description: "d", mode: "bind" },
	});
	assert.equal(overlap.statusCode, 409);
	assert.equal(overlap.json().code, "overlapping_root");
	await app.close();
});

test("probes intent=create：不存在目录返回待创建探测；bind 计划 400；create 计划→apply 创建目录并落盘", async () => {
	const { base, app } = await fixture("createroot");
	const target = path.join(base, "brand-new-vault");
	// 省略 intent：不存在目录仍 404 not_found
	const plain = await app.inject({ method: "POST", url: "/api/knowledge/probes", payload: { path: target } });
	assert.equal(plain.statusCode, 404);
	assert.equal(plain.json().code, "not_found");
	// 非法 intent → 400
	const badIntent = await app.inject({ method: "POST", url: "/api/knowledge/probes", payload: { path: target, intent: "wipe" } });
	assert.equal(badIntent.statusCode, 400);
	// intent=create：201 + targetExists:false
	const created = await app.inject({ method: "POST", url: "/api/knowledge/probes", payload: { path: target, intent: "create" } });
	assert.equal(created.statusCode, 201, JSON.stringify(created.json()));
	const probeRecord = created.json().probe as { probeId: string; targetExists: boolean; rootIdentity: string | null; canonicalBindingRoot: string };
	assert.equal(probeRecord.targetExists, false);
	assert.equal(probeRecord.rootIdentity, null);
	assert.equal(await stat(target).catch(() => null), null);
	// targetExists:false + mode=bind → 400
	const bindPlan = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId: created.json().probeId, name: "新库", description: "d", mode: "bind" },
	});
	assert.equal(bindPlan.statusCode, 400);
	assert.equal(bindPlan.json().code, "invalid_input");
	// create 计划：createRootDir:true → apply 201，目录与脚手架真实落盘
	const createPlan = await app.inject({
		method: "POST", url: "/api/knowledge/plans",
		payload: { probeId: created.json().probeId, name: "新库", description: "d", mode: "create" },
	});
	assert.equal(createPlan.statusCode, 201, JSON.stringify(createPlan.json()));
	assert.equal(createPlan.json().plan.createRootDir, true);
	assert.equal(createPlan.json().plan.rootIdentity, null);
	const apply = await app.inject({ method: "POST", url: `/api/knowledge/plans/${createPlan.json().plan.planId}/apply` });
	assert.equal(apply.statusCode, 201, JSON.stringify(apply.json()));
	assert.deepEqual(apply.json().receipts, [{ relativePath: "wiki/index.md", status: "created" }]);
	const index = await readFile(path.join(target, "wiki", "index.md"), "utf8");
	assert.ok(index.includes("# 新库"));
	assert.equal(apply.json().binding.canonicalBindingRoot, probeRecord.canonicalBindingRoot);
	await app.close();
});

test("K05 presets：五套预置只读清单，含稳定 hash", async () => {
	const { app } = await fixture("presets");
	const response = await app.inject({ method: "GET", url: "/api/knowledge/presets" });
	assert.equal(response.statusCode, 200);
	const presets = response.json().presets as Array<{ schemaId: string; revision: number; hash: string }>;
	assert.deepEqual(presets.map((preset) => preset.schemaId).sort(), ["memory", "people", "personal-assistant", "project", "research"]);
	for (const preset of presets) assert.match(preset.hash, /^[a-f0-9]{64}$/);
	const again = await app.inject({ method: "GET", url: "/api/knowledge/presets" });
	assert.deepEqual(again.json().presets.map((preset: { hash: string }) => preset.hash), presets.map((preset) => preset.hash));
	await app.close();
});

test("K05 schema：origin none 与 vault_declaration", async () => {
	const { root, app } = await fixture("schema");
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "V", description: "d" } });
	const binding = create.json().binding as { id: string };
	const none = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/schema` });
	assert.equal(none.json().origin, "none");
	assert.equal(none.json().capabilities.structured, false);
	assert.ok((none.json().warnings as string[]).length > 0);

	await writeFile(path.join(root, "wiki.schema.json"), `${JSON.stringify(copySchemaPreset("people"), null, 2)}\n`);
	const declared = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/schema` });
	assert.equal(declared.json().origin, "vault_declaration");
	assert.equal(declared.json().schema.schemaId, "people");
	await app.close();
});

test("K05 schema-plans：校验失败 400 schema_invalid；影响预览只读且统计正确", async () => {
	const { root, app, deps } = await fixture("impact");
	// 库内声明 personal-assistant；采纳一条 task 笔记（status: done）。
	await writeFile(path.join(root, "wiki.schema.json"), JSON.stringify(copySchemaPreset("personal-assistant")));
	await mkdir(path.join(root, "Tasks"));
	const noteContent = "---\ntype: task\nid: t1\ntitle: 甲\nstatus: done\n---\n# 甲\n";
	await writeFile(path.join(root, "Tasks", "a.md"), noteContent);
	await writeFile(path.join(root, "plain.md"), "无 frontmatter\n");
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "V", description: "d" } });
	const binding = create.json().binding as { id: string };
	await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/scan` });
	const observations = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/observations` });
	const hashes: Record<string, string> = {};
	for (const file of observations.json().files as Array<{ path: string; hash: string }>) hashes[file.path] = file.hash;
	assert.equal(Object.values((await deps.acceptance.getSnapshot(binding.id)).entries).filter(entry => entry.availability === "current").length, 2, "外部页无需schema采纳门即可同步");

	// 非法结构 → 400 schema_invalid 带逐条错误
	const invalid = copySchemaPreset("personal-assistant");
	invalid.entities = invalid.entities.map((entity) => ({ ...entity, fields: entity.fields.filter((field) => field.name !== "title") }));
	const rejected = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/schema-plans`, payload: { schema: invalid } });
	assert.equal(rejected.statusCode, 400);
	assert.equal(rejected.json().code, "schema_invalid");
	assert.ok((rejected.json().details as string[]).some((error) => error.startsWith("missing_common_field")));

	// 合法新结构：task 目录 Tasks→Todo、status 枚举收窄、新增必填 estimate
	const next = copySchemaPreset("personal-assistant");
	const task = next.entities.find((entity) => entity.type === "task")!;
	task.directory = "Todo";
	task.fields.find((field) => field.name === "status")!.values = ["todo", "doing"];
	task.fields.push({ name: "estimate", type: "text", required: true });
	const preview = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/schema-plans`, payload: { schema: next } });
	assert.equal(preview.statusCode, 200, JSON.stringify(preview.json()));
	const impact = preview.json().impact as {
		changes: Array<{ kind: string; entity?: string; field?: string }>;
		affectedFiles: Array<{ path: string; entity: string; reasons: string[] }>;
		unknownFieldsPreserved: boolean;
		note: string;
	};
	assert.ok(impact.changes.some((change) => change.kind === "entity_directory_changed" && change.entity === "task"));
	assert.ok(impact.changes.some((change) => change.kind === "field_added" && change.field === "estimate"));
	assert.deepEqual(impact.affectedFiles.length, 1);
	assert.equal(impact.affectedFiles[0]!.path, "Tasks/a.md");
	assert.ok(impact.affectedFiles[0]!.reasons.includes("missing_required:estimate"));
	assert.ok(impact.affectedFiles[0]!.reasons.includes("enum_narrowed:status"));
	assert.ok(impact.affectedFiles[0]!.reasons.includes("directory_changed:Tasks->Todo"));
	assert.equal(impact.unknownFieldsPreserved, true);
	assert.equal(impact.note, "影响预览只读，不产生任何写入");

	// 只读核对：账本 revision 不变、磁盘内容不变
	assert.equal((await deps.acceptance.getSnapshot(binding.id)).acceptanceRevision, 1);
	assert.equal(hashBufferSha256(await readFile(path.join(root, "Tasks", "a.md"))), hashBufferSha256(noteContent));
	assert.deepEqual((await readdir(path.join(root))).sort(), ["Tasks", "plain.md", "wiki.schema.json"]);
	const currentHash = (await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/schema` })).json().schemaRef.hash as string;
	const blocked = await app.inject({ method: "PUT", url: `/api/knowledge/${binding.id}/schema`, payload: { schema: next, expectedHash: currentHash, expectedAffectedFiles: impact.affectedFiles } });
	assert.equal(blocked.statusCode, 409);
	assert.equal(blocked.json().code, "baseline_conflict");
	const saved = await app.inject({ method: "PUT", url: `/api/knowledge/${binding.id}/schema`, payload: { schema: next, expectedHash: currentHash, expectedAffectedFiles: impact.affectedFiles, acknowledgeAffected: true } });
	assert.equal(saved.statusCode, 200, JSON.stringify(saved.json()));
	assert.equal(saved.json().schema.revision, 2);
	assert.equal(JSON.parse(await readFile(path.join(root, "wiki.schema.json"), "utf8")).entities.find((entity: { type: string }) => entity.type === "task").directory, "Todo");
	assert.equal(hashBufferSha256(await readFile(path.join(root, "Tasks", "a.md"))), hashBufferSha256(noteContent));
	await app.close();
});

test("schema save：entities/relations 配对保存后生效，旧 hash 不能覆盖", async () => {
	const { root, app } = await fixture("schema-edit");
	await mkdir(path.join(root, "wiki"));
	await mkdir(path.join(root, "raw"));
	await writeFile(path.join(root, "wiki", "keep.md"), "保持不变\n");
	await writeFile(path.join(root, "raw", "keep.txt"), "保持不变\n");
	await writeFile(path.join(root, "wiki.schema.json"), JSON.stringify(copySchemaPreset("research")));
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "V", description: "d" } });
	const id = create.json().binding.id as string;
	const before = (await app.inject({ method: "GET", url: `/api/knowledge/${id}/schema` })).json();
	const next = structuredClone(before.schema) as ReturnType<typeof copySchemaPreset>;
	next.entities.push({ type: "note", directory: "Notes", fields: [{ name: "type", type: "text", required: true }, { name: "title", type: "text", required: true }] });
	next.relations.push({ type: "supersedes", endpoints: [{ from: "note", to: "concept" }], requiresEvidence: true });
	const saved = await app.inject({ method: "PUT", url: `/api/knowledge/${id}/schema`, payload: { schema: next, expectedHash: before.schemaRef.hash, expectedAffectedFiles: [] } });
	assert.equal(saved.statusCode, 200, JSON.stringify(saved.json()));
	assert.equal(saved.json().schema.revision, 2);
	assert.deepEqual(saved.json().schema.relations.at(-1).endpoints, [{ from: "note", to: "concept" }]);
	const stale = await app.inject({ method: "PUT", url: `/api/knowledge/${id}/schema`, payload: { schema: next, expectedHash: before.schemaRef.hash, expectedAffectedFiles: [] } });
	assert.equal(stale.statusCode, 409);
	assert.equal(stale.json().code, "baseline_conflict");
	assert.equal(await readFile(path.join(root, "wiki", "keep.md"), "utf8"), "保持不变\n");
	assert.equal(await readFile(path.join(root, "raw", "keep.txt"), "utf8"), "保持不变\n");
	await app.close();
});


test("onboarding：已确认计划新建index冻结为控制快照，跳过外部index不授予采纳权", async () => {
	const { app, root, deps } = await fixture("control-snapshot");
	const probeId = await probe(app, root);
	const planResponse = await app.inject({ method: "POST", url: "/api/knowledge/plans", payload: { probeId, mode: "create", name: "New", description: "New wiki" } });
	const plan = planResponse.json().plan;
	const applied = await app.inject({ method: "POST", url: `/api/knowledge/plans/${plan.planId}/apply` });
	assert.equal(applied.statusCode, 201);
	const ledger = await deps.acceptance.getSnapshot(applied.json().binding.id);
	assert.deepEqual(ledger.entries, {});
	assert.equal(Object.keys(ledger.controlEntries!).length, 1);
	assert.equal((await deps.objects.get(Object.values(ledger.controlEntries!)[0]!.contentHash)).toString(), plan.filesToCreate[0].content);
	const listing = await app.inject({ method: "GET", url: `/api/knowledge/${applied.json().binding.id}/observations` });
	assert.equal(listing.statusCode, 200);
	const status = await app.inject({ method: "POST", url: `/api/knowledge/${applied.json().binding.id}/scan` });
	assert.equal(status.statusCode, 200);
	assert.deepEqual(status.json().counts, { current: 0, publishing: 0, unreadable: 0, missing: 0 });
	await app.close();
});


test("onboarding：既有index被计划跳过，不读取未采纳内容作为控制快照", async () => {
	const { app, root, deps } = await fixture("unaccepted-control");
	await mkdir(path.join(root, "wiki"));
	await writeFile(path.join(root, "wiki", "index.md"), "# External unreviewed\n");
	const probeId = await probe(app, root);
	const planResponse = await app.inject({ method: "POST", url: "/api/knowledge/plans", payload: { probeId, mode: "create", name: "External", description: "Existing wiki" } });
	const applied = await app.inject({ method: "POST", url: `/api/knowledge/plans/${planResponse.json().plan.planId}/apply` });
	assert.equal(applied.statusCode, 201);
	assert.deepEqual((await deps.acceptance.getSnapshot(applied.json().binding.id)).controlEntries, {});
	await app.close();
});
