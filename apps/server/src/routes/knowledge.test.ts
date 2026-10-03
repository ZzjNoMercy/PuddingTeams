import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeObservationService } from "../knowledge/observation.js";
import { KnowledgeSearchIndex } from "../knowledge/search-index.js";
import { registerKnowledgeRoutes, type KnowledgeRouteDeps } from "./knowledge.js";
import { KnowledgeSelectionStore } from "../knowledge/selections.js";
import { localViewerIdentity, readViewerIdentity, registerIdentityRoutes } from "./identity.js";
import { KnowledgeHistoryStore } from "../knowledge/history-store.js";

test("knowledge route creates a binding, reads a note, and revokes without writing the vault", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-knowledge-route-"));
	const root = path.join(base, "vault");
	await mkdir(root);
	await writeFile(path.join(root, "note.md"), "# Original\n");
	const app = Fastify();
	registerKnowledgeRoutes(app, new KnowledgeBindingRegistry(path.join(base, "state")));
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "Notes", description: "My notes" } });
	assert.equal(create.statusCode, 201);
	const binding = create.json().binding as { id: string; bindingRevision: number };
	const tree = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/tree` });
	assert.deepEqual(tree.json().tree.map((node: { name: string }) => node.name), ["note.md"]);
	const note = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/note?path=note.md` });
	assert.equal(note.json().note.content, "# Original\n");
	const escape = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/note?path=..%2Fsecret.md` });
	assert.equal(escape.statusCode, 400);
	const revoke = await app.inject({ method: "DELETE", url: `/api/knowledge/${binding.id}`, payload: { expectedRevision: binding.bindingRevision } });
	assert.equal(revoke.statusCode, 200);
	assert.equal((await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/tree` })).statusCode, 404);
	assert.equal((await app.inject({ method: "GET", url: "/api/knowledge" })).json().bindings.length, 0);
	await app.close();
});

interface M2Fixture {
	base: string;
	root: string;
	app: FastifyInstance;
	binding: { id: string; bindingRevision: number };
	deps: KnowledgeRouteDeps;
}

async function m2Fixture(suffix: string, files: Record<string, string | Buffer>): Promise<M2Fixture> {
	const base = await mkdtemp(path.join(tmpdir(), `pt-knowledge-m2-${suffix}-`));
	const root = path.join(base, "vault");
	await mkdir(root);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, ...relative.split("/"));
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const objects = new KnowledgeObjectStore(path.join(base, "objects"));
	const history = new KnowledgeHistoryStore(path.join(base, "history"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(base, "acceptance"), history);
	const profilePaths = { config: path.join(base, "config"), assets: path.join(base, "assets") };
	const deps: KnowledgeRouteDeps = {
		viewerIdentity: () => readViewerIdentity(localViewerIdentity, profilePaths),
		history,
		objects,
		acceptance,
		observation: new KnowledgeObservationService(acceptance, { objects }),
		searchIndex: new KnowledgeSearchIndex(path.join(base, "cache"), objects),
		selections: new KnowledgeSelectionStore(path.join(base, "selection-state"), registry),
	};
	const app = Fastify();
	registerIdentityRoutes(app, localViewerIdentity, profilePaths);
	registerKnowledgeRoutes(app, registry, deps);
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "Vault", description: "M2" } });
	assert.equal(create.statusCode, 201);
	return { base, root, app, binding: create.json().binding as M2Fixture["binding"], deps };
}

test("human note edits save directly, update search and history, and stale concurrent edits cannot overwrite", async () => {
	const f = await m2Fixture("edit", { "note.md": "---\nid: person-one\ntitle: 一个人\n---\n旧事实\n" });
	try {
		const before = (await f.app.inject(`/api/knowledge/${f.binding.id}/note?path=note.md`)).json().note;
		const url = `/api/knowledge/${f.binding.id}/note`;
		const content = before.content.replace("旧事实", "新事实");
		const saved = await f.app.inject({ method: "PUT", url, payload: { path: "note.md", content, expectedHash: before.contentHash } });
		assert.equal(saved.statusCode, 200, saved.body);
		assert.equal(saved.json().note.content, content);
		assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), content);
		assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=新事实`)).json().results.length, 1);
		assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=旧事实`)).json().results.length, 0);
		const history = (await f.app.inject(`/api/knowledge/${f.binding.id}/history?path=note.md`)).json().versions;
		assert.equal(history.length, 2);
		assert.equal(history[0].channel, "manual_edit");
		assert.equal(history[0].actorName, localViewerIdentity().user.displayName);
		await f.app.inject({ method: "PATCH", url: "/api/identity/profile", payload: { displayName: "Pet" } });
		const renamed = (await f.app.inject(`/api/knowledge/${f.binding.id}/history?path=note.md`)).json().versions;
		assert.equal(renamed[0].actorName, "Pet");
		assert.equal(renamed[0].actorId, history[0].actorId);
		const detail = (await f.app.inject(`/api/knowledge/${f.binding.id}/history/${renamed[0].id}`)).json();
		assert.equal(detail.version.actorName, "Pet");
		assert.match(history[0].actorId, /^local:/);
		assert.equal(history[0].previousHash, before.contentHash);
		const stale = await f.app.inject({ method: "PUT", url, payload: { path: "note.md", content: "过期覆盖", expectedHash: before.contentHash } });
		assert.equal(stale.statusCode, 409);
		assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), content);
		const competing = await Promise.all(["竞争甲", "竞争乙"].map(text => f.app.inject({ method: "PUT", url, payload: { path: "note.md", content: text, expectedHash: saved.json().note.contentHash } })));
		assert.deepEqual(competing.map(response => response.statusCode).sort(), [200, 409]);
	} finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }); }
});

test("human note edit validates path, ownership, size and symlinks; revoked binding cannot write", async () => {
	const f = await m2Fixture("edit-boundary", { "note.md": "原内容" });
	try {
		const before = (await f.app.inject(`/api/knowledge/${f.binding.id}/note?path=note.md`)).json().note;
		const put = (id: string, payload: Record<string, unknown>) => f.app.inject({ method: "PUT", url: `/api/knowledge/${id}/note`, payload });
		for (const relative of ["../outside.md", "/tmp/outside.md", "../note.md", ".hidden.md", "note.png"]) {
			assert.equal((await put(f.binding.id, { path: relative, content: "覆盖", expectedHash: before.contentHash })).statusCode, 400);
		}
		assert.equal((await put(f.binding.id, { path: "note.md", content: "x" })).statusCode, 400);
		assert.equal((await put("unowned-id", { path: "note.md", content: "x", expectedHash: before.contentHash })).statusCode, 404);
		assert.equal((await put(f.binding.id, { path: "note.md", content: "x".repeat(2 * 1024 * 1024 + 1), expectedHash: before.contentHash })).statusCode, 413);
		await symlink(path.join(f.root, "note.md"), path.join(f.root, "alias.md"));
		assert.notEqual((await put(f.binding.id, { path: "alias.md", content: "覆盖", expectedHash: before.contentHash })).statusCode, 200);
		await rm(path.join(f.root, "alias.md"));
		await f.app.inject({ method: "DELETE", url: `/api/knowledge/${f.binding.id}`, payload: { expectedRevision: f.binding.bindingRevision } });
		assert.equal((await put(f.binding.id, { path: "note.md", content: "覆盖", expectedHash: before.contentHash })).statusCode, 404);
		assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), "原内容");
	} finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }); }
});

test("written note retains manual edit identity after synchronization failure and a fresh store recovers it", async () => {
	const f = await m2Fixture("edit-recovery", { "note.md": "旧事实" });
	try {
		const before = (await f.app.inject(`/api/knowledge/${f.binding.id}/note?path=note.md`)).json().note;
		const original = f.deps.objects.put.bind(f.deps.objects);
		let calls = 0;
		f.deps.objects.put = async (...args) => { if (++calls > 1) throw new Error("injected object write failure"); return original(...args); };
		const saved = await f.app.inject({ method: "PUT", url: `/api/knowledge/${f.binding.id}/note`, payload: { path: "note.md", content: "已保存的新事实", expectedHash: before.contentHash } });
		assert.equal(saved.statusCode, 200, saved.body);
		assert.match(saved.json().syncWarning, /文件已保存/);
		assert.equal(await readFile(path.join(f.root, "note.md"), "utf8"), "已保存的新事实");
		f.deps.objects.put = original;
		const reloaded = new KnowledgeAcceptanceStore(path.join(f.base, "acceptance"), f.deps.history);
		const observation = new KnowledgeObservationService(reloaded, { objects: f.deps.objects });
		const registry = new KnowledgeBindingRegistry(path.join(f.base, "state"));
		const binding = (await registry.list(`local:${(await import("node:os")).userInfo().username}`))[0]!;
		await observation.scan(binding);
		const history = await f.deps.history!.list(binding.id, "note.md");
		assert.equal(history.versions.length, 2);
		assert.equal(history.versions[0]!.channel, "manual_edit");
		assert.equal(Object.keys((await reloaded.getSnapshot(binding.id)).pendingManualEdits ?? {}).length, 0);
	} finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }); }
});

test("knowledge selection is isolated by work context and revision guarded", async () => {
	const { app, binding } = await m2Fixture("selection", { "note.md": "# Note\n" });
	const contextKey = JSON.stringify(["manager", "workspace-a", "/tmp/workspace-a"]);
	const initial = await app.inject({ method: "GET", url: `/api/knowledge-selection?contextKey=${encodeURIComponent(contextKey)}` });
	assert.equal(initial.statusCode, 200);
	assert.equal(initial.json().selection.contextKey, contextKey);
	assert.deepEqual(initial.json().selection.selectedBindingIds, [binding.id]);
	assert.equal(initial.json().selection.revision, 0);

	const saved = await app.inject({
		method: "PUT", url: "/api/knowledge-selection",
		payload: { contextKey, expectedRevision: 0, selectedBindingIds: [binding.id] },
	});
	assert.equal(saved.statusCode, 200);
	assert.deepEqual(saved.json().selection.selectedBindingIds, [binding.id]);
	assert.equal(saved.json().selection.revision, 1);

	const conflict = await app.inject({
		method: "PUT", url: "/api/knowledge-selection",
		payload: { contextKey, expectedRevision: 0, selectedBindingIds: [] },
	});
	assert.equal(conflict.statusCode, 409);
	assert.equal(conflict.json().code, "revision_conflict");
	const cleared = await app.inject({ method: "PUT", url: "/api/knowledge-selection", payload: { contextKey, expectedRevision: 1, selectedBindingIds: [] } });
	assert.equal(cleared.statusCode, 200); assert.deepEqual(cleared.json().selection.selectedBindingIds, []);
	const refreshed = await app.inject({ method: "GET", url: `/api/knowledge-selection?contextKey=${encodeURIComponent(contextKey)}` });
	assert.deepEqual(refreshed.json().selection.selectedBindingIds, []);
	await app.close();
});


test("外部笔记无需采纳：搜索/正文/引用自动同步，不符合schema也生效且不写回", async () => {
 const f = await m2Fixture("auto", { "note.md": "---\nid: stable\ntitle: 外部笔记\n---\n原始事实\n", "ref.md": "参见 [[note]] 与 [笔记](note.md)\n", "wiki.schema.json": JSON.stringify({ formatVersion: 1, entities: [{ type: "fact", directory: "facts", fields: [{ name: "sources", type: "text_list", required: true }] }] }) });
 try {
  const absolute = path.join(f.root, "note.md"), before = await stat(absolute);
  const result = await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=原始事实`); assert.equal(result.statusCode, 200); assert.deepEqual(result.json().results.map((e: { path: string }) => e.path), ["note.md"]);
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/note?path=note.md`)).json().note.status, "current");
  const scan = await f.app.inject({ method: "POST", url: `/api/knowledge/${f.binding.id}/scan` }); assert.deepEqual(scan.json().counts, { current: 2, publishing: 0, unreadable: 0, missing: 0 });
  const revision = scan.json().acceptanceRevision;
  assert.equal((await f.app.inject({ method: "POST", url: `/api/knowledge/${f.binding.id}/scan` })).json().acceptanceRevision, revision);
  assert.equal((await stat(absolute)).mtimeMs, before.mtimeMs); assert.match(await readFile(absolute, "utf8"), /原始事实/);
  const backlink = await f.app.inject(`/api/knowledge/${f.binding.id}/backlinks?path=note.md`); assert.equal(backlink.statusCode, 200); assert(backlink.json().backlinks.some((e: { sourcePath: string }) => e.sourcePath === "ref.md"));
  await writeFile(absolute, "---\nid: stable\n---\n新的事实\n");
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=新的事实`)).json().results.length, 1);
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=原始事实`)).json().results.length, 0);
  assert.equal((await f.app.inject({ method: "POST", url: `/api/knowledge/${f.binding.id}/acceptances`, payload: {} })).statusCode, 404);
 } finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }); }
});

test("外部rename/delete立即进入当前查询：稳定noteId，旧路径和删除内容不复活", async () => {
 const f = await m2Fixture("rename", { "old.md": "---\nid: stable\n---\n可查事实\n" });
 try {
  await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=可查事实`);
  const old = Object.values((await f.deps.acceptance.getSnapshot(f.binding.id)).entries)[0]!;
  await rename(path.join(f.root, "old.md"), path.join(f.root, "new.md"));
  assert.deepEqual((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=可查事实`)).json().results.map((r: { path: string }) => r.path), ["new.md"]);
  const moved = Object.values((await f.deps.acceptance.getSnapshot(f.binding.id)).entries)[0]!; assert.equal(moved.noteId, old.noteId);
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/note?path=old.md`)).statusCode, 404);
  await rm(path.join(f.root, "new.md"));
  assert.deepEqual((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=可查事实`)).json().results, []);
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/note?path=new.md&version=accepted`)).statusCode, 404);
 } finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }); }
});

test("当前快照无需采纳，手动diff/采纳入口已移除，搜索仍有参数约束", async () => {
 const f = await m2Fixture("snapshot", { "note.md": "当前事实" });
 try {
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/note?path=note.md&version=accepted`)).statusCode, 200);
  const entry = Object.values((await f.deps.acceptance.getSnapshot(f.binding.id)).entries)[0]!;
  // Auto synchronization freezes disk bytes on every successful scan; a missing cache object is repairable.
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/note-diff?path=note.md`)).statusCode, 404);
  assert.equal(entry.availability, "current");
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=`)).statusCode, 400);
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=事实&limit=0`)).statusCode, 400);
  assert.equal((await f.app.inject(`/api/knowledge/${f.binding.id}/search?q=事实&limit=500`)).statusCode, 200);
 } finally { await f.app.close(); await rm(f.base, { recursive: true, force: true }); }
});

test("resolve：wiki ok/ambiguous/broken 与 md ok/out_of_scope", async () => {
	const { app, binding } = await m2Fixture("resolve", {
		"dir/note.md": "# A\n",
		"other/note.md": "# B\n",
		"unique.md": "# U\n",
	});
	await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/scan` });
	const ok = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/resolve?from=unique.md&link=${encodeURIComponent("[[dir/note]]")}&kind=wiki` });
	assert.equal(ok.json().status, "ok");
	assert.equal(ok.json().note.path, "dir/note.md");
	const ambiguous = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/resolve?from=unique.md&link=note&kind=wiki` });
	assert.equal(ambiguous.json().status, "ambiguous");
	assert.deepEqual(ambiguous.json().candidates.map((entry: { path: string }) => entry.path), ["dir/note.md", "other/note.md"]);
	const broken = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/resolve?from=unique.md&link=ghost&kind=wiki` });
	assert.equal(broken.json().status, "broken");
	const mdOk = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/resolve?from=${encodeURIComponent("dir/note.md")}&link=${encodeURIComponent("../unique.md")}&kind=md` });
	assert.equal(mdOk.json().status, "ok");
	assert.equal(mdOk.json().note.path, "unique.md");
	const mdOut = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/resolve?from=unique.md&link=${encodeURIComponent("../../escape.md")}&kind=md` });
	assert.equal(mdOut.json().status, "out_of_scope");
	await app.close();
});

test("撤权后 M2 端点立即 404（K08）", async () => {
	const { app, binding } = await m2Fixture("revoked", { "a.md": "甲\n" });
	const revoke = await app.inject({ method: "DELETE", url: `/api/knowledge/${binding.id}`, payload: { expectedRevision: binding.bindingRevision } });
	assert.equal(revoke.statusCode, 200);
	for (const [method, url] of [
		["POST", `/api/knowledge/${binding.id}/scan`],
		["GET", `/api/knowledge/${binding.id}/observations`],
		["POST", `/api/knowledge/${binding.id}/acceptances`],
		["GET", `/api/knowledge/${binding.id}/note-diff?path=a.md`],
		["GET", `/api/knowledge/${binding.id}/search?q=x`],
		["GET", `/api/knowledge/${binding.id}/resolve?from=a.md&link=b&kind=wiki`],
		["GET", `/api/knowledge/${binding.id}/backlinks?path=a.md`],
		["GET", `/api/knowledge/${binding.id}/asset?path=a.png`],
	] as const) {
		const response = await app.inject({ method, url, ...(method === "POST" && url.endsWith("acceptances") ? { payload: { paths: ["a.md"], observedHashes: {}, expectedAcceptanceRevision: 0 } } : {}) });
		assert.equal(response.statusCode, 404, `${method} ${url} 应 404，实得 ${response.statusCode}`);
	}
	await app.close();
});

test("asset：非图片 400；穿越 400；符号链接 404", async () => {
	const { root, app, binding } = await m2Fixture("asset", { "note.md": "# x\n", "real.png": Buffer.from([0x89]) });
	await symlink(path.join(root, "real.png"), path.join(root, "link.png"));
	const nonImage = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/asset?path=note.md` });
	assert.equal(nonImage.statusCode, 400);
	const traversal = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/asset?path=..%2Fsecret.png` });
	assert.equal(traversal.statusCode, 400);
	const link = await app.inject({ method: "GET", url: `/api/knowledge/${binding.id}/asset?path=link.png` });
	assert.equal(link.statusCode, 404);
	await app.close();
});

test("M2 端点在未装配 deps 时返回 422 capability_unavailable", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-knowledge-nodeps-"));
	const root = path.join(base, "vault");
	await mkdir(root);
	await writeFile(path.join(root, "a.md"), "x\n");
	const app = Fastify();
	registerKnowledgeRoutes(app, new KnowledgeBindingRegistry(path.join(base, "state")));
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "V", description: "d" } });
	const binding = create.json().binding as { id: string };
	const scan = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/scan` });
	assert.equal(scan.statusCode, 422);
	assert.equal(scan.json().code, "capability_unavailable");
	await app.close();
});
