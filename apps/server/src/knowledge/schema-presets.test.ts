import { test } from "node:test";
import assert from "node:assert/strict";
import { copySchemaPreset, TEAMS_SCHEMA_PRESETS, validateTeamsSchema } from "./schema-presets.js";
import { validateTeamsNote } from "./note-validation.js";

test("memory 六类明文记忆均要求来源、范围、状态与依据，库内副本独立", () => {
	const schema = copySchemaPreset("memory");
	assert.deepEqual(schema.entities.map((item) => item.type), ["fact", "preference", "context", "decision", "episode", "procedure"]);
	for (const item of schema.entities) {
		const note = { type: item.type, title: "记忆", sources: ["source-1"], scope: "user:me", status: "active", basis: "stated", key: "topic", occurredOn: "2026-09-30", trigger: "再次遇到问题时" };
		assert.deepEqual(validateTeamsNote(schema, note), []);
		assert.ok(validateTeamsNote(schema, { ...note, sources: [] }).includes("missing:sources"));
		assert.ok(validateTeamsNote(schema, { ...note, status: "unknown" }).includes("invalid:status"));
	}
	schema.entities[0]!.fields[0]!.required = false;
	assert.equal(copySchemaPreset("memory").entities[0]!.fields[0]!.required, true);
});

test("five versioned presets have valid entities, directories and relations", () => {
	assert.deepEqual(Object.keys(TEAMS_SCHEMA_PRESETS).sort(), ["memory", "people", "personal-assistant", "project", "research"]);
	for (const [id, preset] of Object.entries(TEAMS_SCHEMA_PRESETS)) {
		assert.equal(preset.schemaId, id);
		assert.deepEqual(validateTeamsSchema(preset), []);
	}
});

test("per-vault copy can change independently of the built-in template", () => {
	const copy = copySchemaPreset("project");
	copy.entities[0]!.directory = "NewSpecs";
	assert.equal(copy.entities[0]!.directory, "NewSpecs");
	assert.equal(TEAMS_SCHEMA_PRESETS.project!.entities[0]!.directory, "Specs");
	assert.throws(() => { TEAMS_SCHEMA_PRESETS.project!.entities[0]!.directory = "mutated"; }, TypeError);
});

test("invalid directory, duplicate field and missing relation endpoint are rejected", () => {
	const copy = copySchemaPreset("research");
	copy.entities[0]!.directory = "../concepts";
	copy.entities[0]!.fields.push({ name: "title", type: "text", required: true });
	copy.relations[0]!.endpoints![0]!.to = "unknown";
	const errors = validateTeamsSchema(copy);
	assert.ok(errors.some((item) => item.startsWith("invalid_directory")));
	assert.ok(errors.some((item) => item.startsWith("duplicate_or_empty_field")));
	assert.ok(errors.some((item) => item.startsWith("unknown_endpoint")));
});

test("研究预置是路径即身份的证据型 Wiki：九类页面、无 id、sources 必填", () => {
	const copy = copySchemaPreset("research");
	assert.deepEqual(copy.entities.map((item) => item.type).sort(), [
		"analysis", "company", "concept", "engineering_practice", "media",
		"research_paper", "software_framework", "source", "system",
	]);
	for (const item of copy.entities) {
		assert.deepEqual(item.fields.map((field) => field.name), ["type", "title", "created", "updated", "sources"]);
		assert.equal(item.fields.find((field) => field.name === "sources")?.type, "text_list");
		assert.equal(item.fields.find((field) => field.name === "sources")?.required, true);
		assert.equal(item.fields.some((field) => field.name === "id"), false, "文件路径就是身份，不必在 frontmatter 重复 id");
	}
	// 目录用类型名的复数，wikilink 的目录前缀与类型一一对应。
	assert.deepEqual(copy.entities.map((item) => item.directory), [
		"concepts", "systems", "frameworks", "practices", "papers", "media", "sources", "companies", "analysis",
	]);
	assert.deepEqual(validateTeamsSchema(copy), []);
});

test("人脉预置只保存不可推导的判断与承诺，不落库可从往来推导的字段", () => {
	const copy = copySchemaPreset("people");
	const person = copy.entities.find((item) => item.type === "person")!;
	const names = person.fields.map((item) => item.name);
	assert.ok(!names.includes("lastContact"), "最近一次往来应由 Interactions 推导，不落库");
	assert.ok(!names.includes("interactionCount"), "互动次数由 Interactions 推导，不落库");
	assert.ok(names.includes("nextContactAt"), "下次联系是承诺与判断，无法推导，必须落库");
	assert.ok(!person.fields.some((item) => item.requiresSourceField), "人脉库 frontmatter 表达不了 source_refs 对象，不能强制成对来源字段");
	const interaction = copy.entities.find((item) => item.type === "interaction")!;
	assert.equal(interaction.fields.find((item) => item.name === "occurredAt")?.required, true);
	// 关联只走关系 wikilink，不另设参与者字段。
	assert.equal(person.fields.some((item) => item.type === "note_refs"), false);
	assert.equal(interaction.fields.some((item) => item.type === "note_refs"), false);
	assert.deepEqual(validateTeamsSchema(copy), []);
});

test("人脉v2将公司独立为org，身份与日期属于affiliation，端点不形成交叉乘积", () => {
	const schema = copySchemaPreset("people");
	assert.equal(schema.revision, 2);
	const person = schema.entities.find(item => item.type === "person")!;
	assert(!person.fields.some(field => ["org", "company", "role"].includes(field.name)));
	assert.equal(schema.entities.find(item => item.type === "org")?.directory, "Orgs");
	assert(!schema.entities.some(item => item.type === "company"));
	const affiliation = schema.entities.find(item => item.type === "affiliation")!;
	assert(affiliation.fields.some(field => field.name === "role"));
	assert.deepEqual(schema.relations.find(item => item.type === "held_by"), { type: "held_by", from: "affiliation", to: "person", requiresEvidence: true });
	assert.deepEqual(schema.relations.find(item => item.type === "at_org"), { type: "at_org", from: "affiliation", to: "org", requiresEvidence: true });
	assert.deepEqual(validateTeamsNote(schema, { id: "a", type: "affiliation", title: "任职", role: "创始人", status: "current", startDate: "2026-09-30" }), []);
	assert(validateTeamsNote(schema, { id: "a", type: "affiliation", title: "任职", status: "guess" }).includes("invalid:status"));
});

test("关系名可以跨端点复用，且每个端点都必须指向已声明实体", () => {
	const copy = copySchemaPreset("people");
	const discusses = copy.relations.find((item) => item.type === "discusses")!;
	assert.deepEqual(discusses.endpoints, [{ from: "interaction", to: "topic" }, { from: "record", to: "topic" }]);
	discusses.endpoints!.push({ from: "interaction", to: "memory" });
	assert.ok(validateTeamsSchema(copy).includes("unknown_endpoint:discusses"));
});

test("requiresSourceField 必须指向同实体的 source_refs 字段", () => {
	const copy = copySchemaPreset("people");
	const person = copy.entities.find((item) => item.type === "person")!;
	person.fields.push({ name: "lastContact", type: "datetime", required: false, requiresSourceField: "lastContactSource" });
	assert.ok(validateTeamsSchema(copy).includes("invalid_source_requirement:person:lastContact"));
	person.fields.push({ name: "lastContactSource", type: "source_refs", required: false });
	assert.deepEqual(validateTeamsSchema(copy), []);
});

test("one relation name can declare exact endpoint pairs without admitting cross-product pairs", () => {
	const copy = copySchemaPreset("research");
	copy.relations[0] = {
		type: "extends", requiresEvidence: true,
		endpoints: [{ from: "concept", to: "source" }, { from: "analysis", to: "source" }],
	};
	assert.deepEqual(validateTeamsSchema(copy), []);
	copy.relations[0]!.endpoints!.push({ from: "concept", to: "missing" });
	assert.ok(validateTeamsSchema(copy).includes("unknown_endpoint:extends"));
	// from/to 与 endpoints 同时出现即为非法端点声明。
	copy.relations[0] = { type: "extends", from: "concept", to: "source", endpoints: [{ from: "concept", to: "source" }], requiresEvidence: true };
	assert.ok(validateTeamsSchema(copy).includes("invalid_relation_endpoints:extends"));
});
