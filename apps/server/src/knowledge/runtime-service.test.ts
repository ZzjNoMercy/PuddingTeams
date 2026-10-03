import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeamsStore } from "../store/teams.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSelectionStore } from "./selections.js";
import { KnowledgeRuntimeService, type KnowledgeMountSurface } from "./runtime-service.js";
import { copySchemaPreset } from "./schema-presets.js";
import { KnowledgeObservationService } from "./observation.js";

async function fixture(memory = false) {
	const root = await mkdtemp(path.join(tmpdir(), "pt-kb-runtime-")), vault = path.join(root, "vault"); await mkdir(vault);
	if (memory) await writeFile(path.join(vault, "wiki.schema.json"), JSON.stringify(copySchemaPreset("memory")));
	const teams = new TeamsStore({ state: path.join(root, "teams"), assets: path.join(root, "assets"), managedWorkspaces: path.join(root, "managed") }, root); await teams.init();
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state")), objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const binding = await bindings.create({ ownerId: "owner", rootPath: vault, name: "My Wiki", description: "Notes" });
	const acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance")), selections = new KnowledgeSelectionStore(path.join(root, "state"), bindings, async () => memory ? [binding.id] : []);
	const text = "# 已采纳\n事实日期为2026-10-23\n[[other]]\n", stored = await objects.put(Buffer.from(text));
	await acceptance.adopt(binding.id, [{ relativePath: "note.md", contentHash: stored.hash, snapshotRef: stored.hash, acceptedBy: "owner" }], 0);
	const currentText = "# 当前外部笔记\n事实日期2026-12-01";
	await writeFile(path.join(vault, "note.md"), currentText);
	const observation = new KnowledgeObservationService(acceptance, { objects });
	const runtime = new KnowledgeRuntimeService({ bindings, objects, acceptance, selections, teams, observation, stateDir: path.join(root, "state"), cacheDir: path.join(root, "cache") });
	await selections.set("owner", "session:test", 0, [binding.id]);
	const scope = { ownerId: "owner", windowId: "window", sessionId: "test", contextKey: "session:test" };
	return { root, vault, teams, bindings, binding, selections, runtime, scope, text: currentText, acceptance, objects };
}
async function call(surface: KnowledgeMountSurface, name: string, args: unknown): Promise<Record<string, unknown>> {
	const tool = surface.tools.find((tool) => tool.name === name)!;
	const result = await tool.execute("call", args, undefined, undefined, {} as never);
	return JSON.parse((result.content[0] as { text: string }).text);
}

test("Manager仅取得授权库路由元数据，知识检索与整理均委派，撤权仍阻断", async () => {
	const f = await fixture();
	try {
		f.runtime.forSession = async () => f.runtime.mount(f.scope);
		const worker = await f.runtime.forSession("test");
		const manager = await f.runtime.forManagerSession("test");
		assert.deepEqual(manager.tools, []);
		assert.notEqual(manager.fingerprint, worker.fingerprint, "工具职责收敛不能复用旧Manager上下文");
		assert.ok(manager.prompt.includes(f.binding.id)); assert.ok(manager.prompt.includes("My Wiki"));
		assert.ok(manager.prompt.includes("agent_wiki__delegate"));
		assert(!manager.prompt.includes("knowledge_read")); assert(!manager.prompt.includes(f.vault));
		assert(!manager.prompt.includes("事实日期2026-12-01"));
		assert.ok(worker.tools.some(tool => tool.name === "knowledge_read"));
		await f.selections.set("owner", f.scope.contextKey, 1, []);
		await assert.rejects(manager.assertCurrent(), /失效/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("新轮挂载立即同步增删；已运行轮保留授权事实，原子同字节保存不改变fingerprint", async () => {
	const f = await fixture();
	try {
		const frozen = await f.runtime.mount(f.scope);
		await writeFile(path.join(f.vault, "saved.tmp"), f.text); await rename(path.join(f.vault, "saved.tmp"), path.join(f.vault, "note.md"));
		assert.equal((await f.runtime.mount(f.scope)).fingerprint, frozen.fingerprint, "磁盘inode不属于知识事实身份");
		await writeFile(path.join(f.vault, "new.md"), "新轮独立事实");
		const added = await f.runtime.mount(f.scope); assert.equal((await call(added, "knowledge_read", { bindingId: f.binding.id, noteRef: "new.md" })).content, "新轮独立事实");
		await rm(path.join(f.vault, "note.md")); const afterDelete = await f.runtime.mount(f.scope);
		await assert.rejects(call(afterDelete, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md" }), /范围/);
		assert.equal((await call(frozen, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md" })).content, f.text, "已在运行的轮仍读明确授权固定版本");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("默认 memory 进入普通运行上下文，取消后旧工具失效，显式整理范围不自动扩库", async () => {
	const f = await fixture(true);
	try {
		const scope = { ...f.scope, contextKey: "session:default" };
		const surface = await f.runtime.mount(scope);
		assert.deepEqual(surface.memoryBindingIds, [f.binding.id]);
		assert.equal((await call(surface, "knowledge_context", {})).mounts instanceof Array, true);
		assert.equal((await call(surface, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md" })).content, f.text);
		const restricted = await f.runtime.mount(scope, []);
		assert.deepEqual(restricted.memoryBindingIds, []);
		assert.deepEqual((await call(restricted, "knowledge_context", {})).mounts, []);
		await f.selections.set("owner", scope.contextKey, 0, []);
		await assert.rejects(surface.assertCurrent(), /失效/);
		assert.deepEqual((await f.runtime.mount(scope)).memoryBindingIds, []);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("渐进发现不暴露根/正文，挂载前自动同步外部修改，本轮固定快照与阅读证据", async () => {
	const f = await fixture();
	try {
		const surface = await f.runtime.mount(f.scope);
		assert(!surface.prompt.includes(f.vault)); assert(!surface.prompt.includes("2026-10-23"));
		assert(!surface.tools.some((tool) => ["bash", "write", "edit", "publish"].includes(tool.name)));
		const search = await call(surface, "knowledge_search", { bindingId: f.binding.id, query: "事实" });
		assert.equal((search.results as unknown[]).length, 1);
		const read = await call(surface, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md" });
		assert.equal(read.content, f.text); assert(String(read.content).includes("12-01"));
		assert.equal(surface.readSourceIds?.().length, 1);
		await assert.rejects(call(surface, "knowledge_read", { bindingId: "other", noteRef: "note.md" }), /授权/);
		await assert.rejects(call(surface, "knowledge_read", { bindingId: f.binding.id, noteRef: "../secret.md" }), /范围/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("显式空选择不会回退，选择收窄或撤销使旧工具立即失败", async () => {
	const f = await fixture();
	try {
		const old = await f.runtime.mount(f.scope);
		await f.selections.set("owner", f.scope.contextKey, 1, []);
		await assert.rejects(call(old, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md" }), /失效/);
		const empty = await f.runtime.mount(f.scope);
		assert.deepEqual((await call(empty, "knowledge_context", {})).mounts, []);
		await f.selections.set("owner", f.scope.contextKey, 2, [f.binding.id]);
		const mounted = await f.runtime.mount(f.scope);
		await f.bindings.revoke("owner", f.binding.id, 1);
		await assert.rejects(call(mounted, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md" }));
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("内置Wiki身份注册到已有数据、禁用保留，自定义同名不提升权限", async () => {
	const f = await fixture();
	try {
		const wiki = (await f.teams.getAgent("wiki"))!; assert.equal(wiki.builtinId, "wiki");
		await f.teams.setEnabled("wiki", false);
		await f.teams.init(); assert.equal((await f.teams.getAgent("wiki"))?.enabled, false);
		const custom = await f.teams.upsertAgent({ name: "pretend", builtinId: "wiki", description: "custom", connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} } });
		assert.equal(custom.builtinId, undefined);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("控制文件用于导航而非事实来源，空读和超预算读不授予引用权", async () => {
	const f = await fixture();
	try {
		const stored = await f.objects.put(Buffer.from("# 索引\n事实见 [[note]]\n"));
		await f.acceptance.adoptPublished(f.binding.id, [{ relativePath: "index.md", contentHash: stored.hash, snapshotRef: stored.hash, acceptedBy: "owner" }], 1);
		await writeFile(path.join(f.vault, "index.md"), (await f.objects.get(stored.hash)).toString());
		const surface = await f.runtime.mount(f.scope);
		const search = await call(surface, "knowledge_search", { bindingId: f.binding.id, query: "事实" });
		assert.equal((search.navigation as unknown[]).length, 1);
		assert.equal((search.results as { path: string }[]).some((hit) => hit.path === "index.md"), false);
		const control = await call(surface, "knowledge_read", { bindingId: f.binding.id, noteRef: "index.md" });
		assert.equal(control.role, "navigation"); assert.deepEqual(surface.readSourceIds?.(), []);
		await assert.rejects(call(surface, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md", startLine: 99999 }), /超出/);
		assert.deepEqual(surface.readSourceIds?.(), []);
		for (let n = 0; n < 62; n++) await call(surface, "knowledge_context", {});
		await assert.rejects(call(surface, "knowledge_read", { bindingId: f.binding.id, noteRef: "note.md" }), /预算/);
		assert.deepEqual(surface.readSourceIds?.(), []);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});


test("Manager实际注册只读整理状态工具，不授予检索或提交能力", async () => {
 const f = await fixture();
 try {
  f.runtime.forSession = async () => f.runtime.mount(f.scope);
  f.runtime.scopeForSession = async () => f.scope;
  let reads = 0;
  f.runtime.setCurationStatusReader(async (owner, id) => {
   assert.equal(owner, "owner"); reads++;
   return { bindingId: f.binding.id, jobId: id, status: "running", message: "正在整理", jobUrl: "/knowledge?job=one", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", diagnostics: { modelId: "x".repeat(60_000), modelTurns: Infinity, submitAttempts: -1, submitErrors: 1, stopReason: "untrusted text", validationErrors: ["invalid:created", "untrusted text"] } };
  });
  const tools: KnowledgeMountSurface["tools"] = [];
  const extension = f.runtime.managerExtension(() => "test"); assert.equal(typeof extension, "function");
  if (typeof extension !== "function") throw new Error("expected factory");
  await extension({ on() {}, registerTool(tool: KnowledgeMountSurface["tools"][number]) { tools.push(tool); }, appendEntry() {} } as never);
  assert.deepEqual(tools.map(tool => tool.name), ["knowledge_curation_status"]);
  const manager = await f.runtime.forManagerSession("test");
  assert.deepEqual(manager.tools.map(tool => tool.name), ["knowledge_curation_status"]);
  const ctx = { sessionManager: { getEntries: () => [] } } as never;
  const result = await tools[0]!.execute("read", { jobId: "one" }, undefined, undefined, ctx);
  assert.equal(JSON.parse((result.content[0] as { text: string }).text).status, "running"); assert.equal(reads, 1);
  const output = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(output.diagnostics.modelId.length, 200); assert.equal(output.diagnostics.modelTurns, 0);
  assert.equal(output.diagnostics.submitAttempts, 0); assert.equal(output.diagnostics.stopReason, undefined);
  assert.deepEqual(output.diagnostics.validationErrors, ["invalid:created"]);
  assert(JSON.stringify(output).length < 4000);
  await f.selections.set("owner", f.scope.contextKey, 1, []);
  await assert.rejects(tools[0]!.execute("read", { jobId: "one" }, undefined, undefined, ctx), /变化|失效/);
 } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("全库默认挂载只注入简短路由，已挂载库的无效noteRef须重新定位且不误报未授权", async () => {
	const f = await fixture();
	try {
		const secondRoot = path.join(f.root, "second"); await mkdir(secondRoot);
		const secret = "ONLY_ON_DEMAND_BODY", description = "用途".repeat(200) + "FULL_DESCRIPTION_SUFFIX";
		await writeFile(path.join(secondRoot, "note.md"), `# 第二库\n${secret}`);
		const second = await f.bindings.create({ ownerId: "owner", rootPath: secondRoot, name: "AI Wiki", description });
		const runtime = new KnowledgeRuntimeService({ bindings: f.bindings, objects: f.objects, acceptance: f.acceptance,
			selections: new KnowledgeSelectionStore(path.join(f.root, "state"), f.bindings), teams: f.teams,
			observation: new KnowledgeObservationService(f.acceptance, { objects: f.objects }), stateDir: path.join(f.root, "state"), cacheDir: path.join(f.root, "cache") });
		const surface = await runtime.mount({ ...f.scope, contextKey: "session:default-all" });
		const context = await call(surface, "knowledge_context", {});
		assert.deepEqual((context.mounts as Array<{ bindingId: string }>).map(item => item.bindingId), [f.binding.id, second.id]);
		assert(surface.prompt.includes(second.id)); assert(!surface.prompt.includes(secret)); assert(!surface.prompt.includes("FULL_DESCRIPTION_SUFFIX"));
		runtime.forSession = async () => surface;
		const manager = await runtime.forManagerSession(f.scope.sessionId);
		assert(manager.prompt.includes(second.id)); assert(!manager.prompt.includes(secret)); assert(!manager.prompt.includes("FULL_DESCRIPTION_SUFFIX"));
		await assert.rejects(call(surface, "knowledge_read", { bindingId: second.id, noteRef: "invalid-old-ref" }), /笔记不在本轮当前同步范围内.*knowledge_glob/);
		const located = await call(surface, "knowledge_glob", { bindingId: second.id });
		const note = (located.notes as Array<{ noteRef: string; path: string }>).find(item => item.path === "note.md")!;
		assert.equal((await call(surface, "knowledge_read", { bindingId: second.id, noteRef: note.noteRef })).content, `# 第二库\n${secret}`);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});
