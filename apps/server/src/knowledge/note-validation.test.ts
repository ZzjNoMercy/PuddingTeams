import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTeamsNote } from "./note-validation.js";
import { copySchemaPreset } from "./schema-presets.js";

test("Teams note validation keeps unknown metadata and rejects invented required facts", () => {
	const schema = copySchemaPreset("people");
	const note = { id: "p-1", type: "person", title: "张三", customField: { preserved: true } };
	assert.deepEqual(validateTeamsNote(schema, note), []);
	assert.deepEqual(note.customField, { preserved: true });
	assert.ok(validateTeamsNote(schema, { ...note, title: undefined }).includes("missing:title"));
	assert.ok(validateTeamsNote(schema, { ...note, title: "  " }).includes("invalid:title"), "空白文本不是合法标题");
	assert.ok(validateTeamsNote(schema, { ...note, birthday: 1980 }).includes("invalid:birthday"));
});

test("证据型 Wiki 页面不写 id 也能通过，sources 缺失或类型不对会被拦下", () => {
	const research = copySchemaPreset("research");
	assert.deepEqual(validateTeamsNote(research, {
		type: "concept", title: "Harness", sources: ["raw/a-1.md", "raw/b-2.md"],
	}), []);
	assert.ok(validateTeamsNote(research, { type: "concept", title: "Harness" }).includes("missing:sources"));
	assert.ok(validateTeamsNote(research, { type: "concept", title: "Harness", sources: [] }).includes("missing:sources"));
	assert.ok(validateTeamsNote(research, { type: "concept", title: "Harness", sources: ["raw/a.md", 7] }).includes("invalid:sources"));
	assert.ok(validateTeamsNote(research, { type: "memory", title: "Harness", sources: ["raw/a.md"] }).includes("unknown_type"));
});

test("a field bound to a source field cannot be written without a real source ref", () => {
	// 人脉预置本身不落库 lastContact（由 Interactions 推导），这里用合成字段验证平台规则。
	const people = copySchemaPreset("people");
	const person = people.entities.find((item) => item.type === "person")!;
	person.fields.push(
		{ name: "lastContact", type: "datetime", required: false, requiresSourceField: "lastContactSource" },
		{ name: "lastContactSource", type: "source_refs", required: false },
	);
	const base = { id: "p-1", type: "person", title: "Person", lastContact: "2026-09-23T10:00:00Z" };
	assert.ok(validateTeamsNote(people, base).includes("missing_source:lastContact"));
	assert.ok(validateTeamsNote(people, { ...base, lastContactSource: [{ sourceId: "s-1" }] }).includes("invalid:lastContactSource"));
	assert.deepEqual(validateTeamsNote(people, { ...base, lastContactSource: [{ sourceId: "s-1", snapshotPath: "s-1/note.md" }] }), []);
	assert.deepEqual(validateTeamsNote(people, { id: "p-1", type: "person", title: "Person" }), []);
});

test("invalid dates are rejected", () => {
	const assistant = copySchemaPreset("personal-assistant");
	assert.ok(validateTeamsNote(assistant, { id: "d-1", type: "daily", title: "Day", date: "2026-02-30" }).includes("invalid:date"));
});

test("人脉库的往来与人物字段按预置校验", () => {
	const people = copySchemaPreset("people");
	assert.ok(validateTeamsNote(people, { id: "i-1", type: "interaction", title: "与张三 · 咖啡" }).includes("missing:occurredAt"));
	assert.deepEqual(validateTeamsNote(people, {
		id: "i-1", type: "interaction", title: "与张三 · 咖啡", kind: "in_person", status: "done", occurredAt: "2026-09-23T10:00:00Z",
	}), []);
	assert.ok(validateTeamsNote(people, { id: "i-2", type: "interaction", title: "与李四", kind: "电话" }).includes("invalid:kind"));
	assert.ok(validateTeamsNote(people, {
		id: "p-1", type: "person", title: "张三", importance: "6", intimacy: "3",
	}).includes("invalid:importance"));
	assert.ok(validateTeamsNote(people, { id: "p-1", type: "person", title: "张三", tags: ["投资人", ""] }).includes("invalid:tags"), "空标签不是合法标签");
	assert.ok(validateTeamsNote(people, { id: "t-1", type: "topic", title: "开源协作" }).includes("missing:angle"));
});
