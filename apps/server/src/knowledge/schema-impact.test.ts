import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import { assessAcceptedNote, diffTeamsSchemas, resolveEffectiveSchema } from "./schema-impact.js";
import { copySchemaPreset, hashTeamsSchema, TEAMS_SCHEMA_PRESETS } from "./schema-presets.js";

function bindingFor(root: string, schemaRef?: KnowledgeBinding["schemaRef"]): KnowledgeBinding {
	return {
		id: "b1", ownerId: "o", name: "n", description: "d", metadataMode: "registry",
		canonicalBindingRoot: root, rootIdentity: "1:1", contentRoot: root, linkRoot: root,
		...(schemaRef ? { schemaRef } : {}),
		readPolicy: "private", bindingRevision: 1, trustRevision: 1, availability: "available",
	};
}

test("diffTeamsSchemas：旧为 null 时全部 entity_added；字段/目录/关系增删改", async () => {
	const next = copySchemaPreset("project");
	const fromEmpty = diffTeamsSchemas(null, next);
	assert.ok(fromEmpty.length > 0);
	assert.ok(fromEmpty.every((change) => change.kind === "entity_added" || change.kind === "relation_added"));

	const old = copySchemaPreset("project");
	const modified = copySchemaPreset("project");
	const task = modified.entities.find((entity) => entity.type === "task")!;
	task.directory = "Todo";
	task.fields.push({ name: "estimate", type: "text", required: true });
	task.fields = task.fields.filter((field) => field.name !== "due");
	const status = task.fields.find((field) => field.name === "status")!;
	status.required = true;
	modified.relations = modified.relations.filter((relation) => relation.type !== "depends_on");
	modified.relations.push({ type: "tracks", from: "task", to: "deliverable", requiresEvidence: false });
	modified.entities = modified.entities.filter((entity) => entity.type !== "spec");

	const changes = diffTeamsSchemas(old, modified);
	const byKind = (kind: string) => changes.filter((change) => change.kind === kind);
	assert.deepEqual(byKind("entity_directory_changed").map((change) => [change.entity, change.from, change.to]), [["task", "Tasks", "Todo"]]);
	assert.deepEqual(byKind("field_added").map((change) => change.field), ["estimate"]);
	assert.deepEqual(byKind("field_removed").map((change) => change.field), ["due"]);
	assert.deepEqual(byKind("field_changed").map((change) => change.field), ["status"]);
	assert.deepEqual(byKind("entity_removed").map((change) => change.entity), ["spec"]);
	assert.deepEqual(byKind("relation_removed").map((change) => change.relation), ["depends_on"]);
	assert.deepEqual(byKind("relation_added").map((change) => change.relation), ["tracks"]);
	assert.deepEqual(diffTeamsSchemas(old, old), []);
});

test("assessAcceptedNote：新增必填缺失 / 枚举不再合法 / 目录映射变化 / 实体移除", () => {
	const old = copySchemaPreset("personal-assistant");
	const next = copySchemaPreset("personal-assistant");
	const task = next.entities.find((entity) => entity.type === "task")!;
	task.directory = "Todo";
	const status = task.fields.find((field) => field.name === "status")!;
	status.values = ["todo", "doing"];
	task.fields.push({ name: "estimate", type: "text", required: true });

	const note = { type: "task", id: "t1", title: "A", status: "done" };
	const affected = assessAcceptedNote("Tasks/a.md", note, old, next)!;
	assert.equal(affected.entity, "task");
	assert.ok(affected.reasons.includes("missing_required:estimate"));
	assert.ok(affected.reasons.includes("enum_narrowed:status"));
	assert.ok(affected.reasons.includes("directory_changed:Tasks->Todo"));

	// 不在旧目录下的同实体文件不标记目录归属变化
	const elsewhere = assessAcceptedNote("Inbox/a.md", note, old, next)!;
	assert.ok(!elsewhere.reasons.some((reason) => reason.startsWith("directory_changed:")));

	// 新结构移除该实体
	const removed = copySchemaPreset("personal-assistant");
	removed.entities = removed.entities.filter((entity) => entity.type !== "task");
	assert.ok(assessAcceptedNote("Tasks/a.md", note, old, removed)!.reasons.includes("entity_removed"));

	// 无 type 的普通 Markdown 不受影响；合规文件不列出
	assert.equal(assessAcceptedNote("random.md", { title: "x" }, old, next), undefined);
	const clean = assessAcceptedNote("Tasks/b.md", { type: "task", id: "t2", title: "B", status: "todo", estimate: "1d" }, old, next);
	assert.ok(clean === undefined || !clean.reasons.some((reason) => reason.startsWith("missing_required")));
});

test("resolveEffectiveSchema：三态 origin", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-schema-impact-"));
	const canonical = await realpath(root);
	// none：无任何声明
	const none = await resolveEffectiveSchema(bindingFor(canonical));
	assert.equal(none.origin, "none");
	assert.ok(none.warnings.length > 0);
	// vault_declaration：根目录唯一声明
	await writeFile(path.join(root, "wiki.schema.json"), JSON.stringify(copySchemaPreset("research")));
	const declared = await resolveEffectiveSchema(bindingFor(canonical));
	assert.equal(declared.origin, "vault_declaration");
	assert.equal(declared.schema?.schemaId, "research");
	assert.equal(declared.schemaRef?.hash, hashTeamsSchema(copySchemaPreset("research")));
	assert.deepEqual(declared.warnings, []);
	// 根目录声明优先于预置引用
	const presetRef = { format: "teams-schema", id: "project", revision: 1, hash: hashTeamsSchema(TEAMS_SCHEMA_PRESETS.project!), originPresetId: "project" };
	const preset = await resolveEffectiveSchema(bindingFor(canonical, presetRef));
	assert.equal(preset.origin, "vault_declaration");
	assert.equal(preset.schema?.schemaId, "research");
	// 无效根声明不能被预置掩盖
	await writeFile(path.join(root, "wiki.schema.json"), "{ not json");
	const invalid = await resolveEffectiveSchema(bindingFor(canonical, presetRef));
	assert.equal(invalid.origin, "none");
	assert.ok(invalid.warnings.some((warning) => warning.includes("合法 JSON")));
	// 未知预置引用也不能覆盖根目录声明
	await writeFile(path.join(root, "wiki.schema.json"), JSON.stringify(copySchemaPreset("research")));
	const ghost = await resolveEffectiveSchema(bindingFor(canonical, { ...presetRef, id: "ghost", originPresetId: "ghost" }));
	assert.equal(ghost.origin, "vault_declaration");
	assert.deepEqual(ghost.warnings, []);
	const noFileRoot = await realpath(await mkdtemp(path.join(tmpdir(), "pt-schema-no-file-")));
	assert.equal((await resolveEffectiveSchema(bindingFor(noFileRoot, presetRef))).origin, "none");
});
