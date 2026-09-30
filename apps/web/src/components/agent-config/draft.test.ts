import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigBody, draftAfterSave, draftFromAgent, serializeDraft } from "./draft.js";
import type { AgentConfig } from "../../lib/types.js";

test("保存响应只覆盖已提交的草稿，保留请求期间继续编辑的内容", () => {
	const submitted = draftFromAgent({ name: "worker", description: "旧描述" } as AgentConfig);
	const saved = { ...submitted, description: "服务端规范化描述" };
	assert.equal(draftAfterSave(submitted, submitted, saved), saved);
	const editedWhileSaving = { ...submitted, description: "请求期间的新修改" };
	assert.equal(draftAfterSave(editedWhileSaving, submitted, saved), editedWhileSaving);
	assert.notEqual(serializeDraft(draftAfterSave(editedWhileSaving, submitted, saved)), serializeDraft(saved));
});

test("Manager 页面清空模型与默认 thinking 时显式提交删除意图", () => {
	const agent = { name: "manager", pinned: true, manager: { model: "fixture/model", thinkingLevel: "high" } } as AgentConfig;
	const draft = draftFromAgent(agent);
	draft.manager.model = "";
	draft.manager.thinkingLevel = undefined;
	assert.deepEqual(buildConfigBody(agent, draft).manager, {
		codeSearch: "off", builtinTools: true, noExtensions: false,
		model: null, thinkingLevel: null,
	});
});
