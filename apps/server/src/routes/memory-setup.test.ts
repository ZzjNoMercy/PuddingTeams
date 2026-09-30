import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeObservationService } from "../knowledge/observation.js";
import { KnowledgeSearchIndex } from "../knowledge/search-index.js";
import { KnowledgeProbeStore } from "../knowledge/probes.js";
import { KnowledgePlanStore } from "../knowledge/plans.js";
import { MemorySetupService } from "../knowledge/memory-setup.js";
import { KnowledgeSelectionStore } from "../knowledge/selections.js";
import { copySchemaPreset } from "../knowledge/schema-presets.js";
import { schemaPresetAgents } from "../knowledge/schema-guidance.js";
import { registerKnowledgeRoutes } from "./knowledge.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(path.join(tmpdir(), "pt-memory-setup-"));
	const state = path.join(root, "state");
	const registry = new KnowledgeBindingRegistry(state);
	const objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"));
	const probes = new KnowledgeProbeStore();
	const plans = new KnowledgePlanStore(path.join(state, "plans"));
	const deps = { registry, objects, acceptance, probes, plans };
	const service = () => new MemorySetupService(state, deps);
	const selections = new KnowledgeSelectionStore(state, registry, async (owner) => {
		const status = await service().status(owner);
		return status.status === "configured" ? [status.binding.id] : [];
	});
	const app = Fastify();
	registerKnowledgeRoutes(app, registry, { ...deps, selections, memorySetup: service(),
		observation: new KnowledgeObservationService(acceptance, { objects }), searchIndex: new KnowledgeSearchIndex(path.join(root, "cache"), objects) });
	t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
	const get = () => app.inject({ method: "GET", url: "/api/knowledge/memory-setup" });
	const plan = (target: string) => app.inject({ method: "POST", url: "/api/knowledge/memory-setup/plan", payload: { path: target } });
	const apply = (planId: string) => app.inject({ method: "POST", url: "/api/knowledge/memory-setup/apply", payload: { planId } });
	return { root, app, get, plan, apply, registry, acceptance, service, plans };
}

test("首次提示、稍后设置持久化，初始化后重试不会重复建库", async (t) => {
	const f = await fixture(t);
	assert.equal((await f.get()).json().status, "pending");
	assert.equal((await f.app.inject({ method: "POST", url: "/api/knowledge/memory-setup/defer" })).json().status, "deferred");
	assert.equal((await f.get()).json().status, "deferred");
	const target = path.join(f.root, "memory");
	const preview = await f.plan(target);
	assert.equal(preview.statusCode, 200, preview.body);
	const plan = preview.json().plan;
	assert.equal(plan.schemaPresetId, "memory");
	assert.equal(plan.contentRoot, plan.canonicalBindingRoot);
	assert.equal(plan.linkRoot, plan.canonicalBindingRoot);
	await assert.rejects(readdir(target), /ENOENT/);
	assert.equal((await f.service().status(plan.ownerId)).status, "deferred");
	const result = await f.apply(plan.planId);
	assert.equal(result.statusCode, 200, result.body);
	const { status, binding } = result.json();
	assert.equal(status, "configured");
	const selection = (await f.app.inject("/api/knowledge-selection?contextKey=session:new")).json().selection;
	assert.deepEqual(selection.selectedBindingIds, [binding.id]);
	assert.equal((await f.app.inject({ method: "PUT", url: "/api/knowledge-selection", payload: {
		contextKey: "session:new", expectedRevision: selection.revision, selectedBindingIds: [],
	} })).statusCode, 200);
	assert.deepEqual((await f.app.inject("/api/knowledge-selection?contextKey=session:new")).json().selection.selectedBindingIds, []);
	assert.deepEqual(JSON.parse(await readFile(path.join(target, "wiki.schema.json"), "utf8")), copySchemaPreset("memory"));
	assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), schemaPresetAgents("memory"));
	assert.match(await readFile(path.join(target, "wiki", "index.md"), "utf8"), /长期记忆/);
	const ledger = await f.acceptance.getSnapshot(binding.id);
	assert.ok(Object.values(ledger.controlEntries ?? {}).some((item) => item.relativePath === "wiki/index.md"));
	const tree = (await f.app.inject(`/api/knowledge/${binding.id}/tree`)).json().tree;
	assert.ok(tree.some((item: { path: string; children?: Array<{ path: string }> }) =>
		item.path === "wiki" && item.children?.some((child) => child.path === "wiki/index.md")));
	assert.equal((await f.service().status(plan.ownerId)).status, "configured");
	assert.equal((await f.apply(plan.planId)).json().binding.id, binding.id);
	assert.equal((await f.registry.list(plan.ownerId)).length, 1);
	assert.equal((await f.service().defer(plan.ownerId)).status, "configured");
	// Removing a mounted drive does not prompt creation of another memory library.
	await rename(target, `${target}-offline`);
	const offline = await f.get();
	assert.equal(offline.json().status, "configured");
	assert.equal(offline.json().binding.availability, "offline");
});

test("非空文件夹与预览后新增文件不被覆盖，失败不完成首次引导", async (t) => {
	const f = await fixture(t);
	const target = path.join(f.root, "existing");
	await mkdir(target);
	await writeFile(path.join(target, "important.md"), "keep me");
	assert.equal((await f.plan(target)).statusCode, 400);
	assert.equal(await readFile(path.join(target, "important.md"), "utf8"), "keep me");
	const blank = path.join(f.root, "blank");
	await mkdir(blank);
	const plan = (await f.plan(blank)).json().plan;
	await writeFile(path.join(blank, "AGENTS.md"), "user-owned rules");
	const result = await f.apply(plan.planId);
	assert.equal(result.statusCode, 400, result.body);
	assert.equal(await readFile(path.join(blank, "AGENTS.md"), "utf8"), "user-owned rules");
	assert.equal((await f.get()).json().status, "pending");
});

test("并发确认串行化，外来用户和非 memory 计划不能完成引导", async (t) => {
	const f = await fixture(t);
	const first = (await f.plan(path.join(f.root, "first"))).json().plan;
	const second = (await f.plan(path.join(f.root, "second"))).json().plan;
	await assert.rejects(f.service().apply("another-owner", first.planId), /不存在/);
	await f.plans.save({ ...second, schemaPresetId: "research" });
	assert.equal((await f.apply(second.planId)).statusCode, 400);
	await f.plans.save(second);
	const responses = await Promise.all([f.apply(first.planId), f.apply(second.planId)]);
	assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
	assert.equal(responses[0]!.json().binding.id, responses[1]!.json().binding.id);
	assert.equal((await f.registry.list(first.ownerId)).length, 1);
});

test("从普通知识库向导创建 memory 后无需重复初始化", async (t) => {
	const f = await fixture(t);
	const plan = (await f.plan(path.join(f.root, "manual"))).json().plan;
	const result = await f.app.inject({ method: "POST", url: `/api/knowledge/plans/${plan.planId}/apply` });
	assert.equal(result.statusCode, 201, result.body);
	assert.equal((await f.get()).json().status, "configured");
});
