import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { probeKnowledgeRoot } from "../knowledge/probe.js";
import { localViewerIdentity } from "./identity.js";
import { registerKnowledgeRoutes } from "./knowledge.js";

interface ObsidianFixture {
	base: string;
	root: string;
	app: FastifyInstance;
	registry: KnowledgeBindingRegistry;
	binding: { id: string; bindingRevision: number };
}

async function obsidianFixture(suffix: string, files: Record<string, string>): Promise<ObsidianFixture> {
	const base = await mkdtemp(path.join(tmpdir(), `pt-knowledge-obsidian-${suffix}-`));
	const root = path.join(base, "vault");
	await mkdir(root);
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, ...relative.split("/"));
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const app = Fastify();
	registerKnowledgeRoutes(app, registry);
	const create = await app.inject({ method: "POST", url: "/api/knowledge", payload: { path: root, name: "Vault", description: "T24" } });
	assert.equal(create.statusCode, 201);
	return { base, root, app, registry, binding: create.json().binding as ObsidianFixture["binding"] };
}

test("obsidian-uri：happy path 返回精确编码的 obsidian://open URI", async () => {
	const { root, app, binding } = await obsidianFixture("happy", {
		"note.md": "# 根笔记\n",
		"sub dir/我的 笔记#2.md": "# 需要编码\n",
	});
	const canonical = await realpath(root);
	const top = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload: { path: "note.md" } });
	assert.equal(top.statusCode, 200);
	assert.equal(top.json().uri, `obsidian://open?path=${encodeURIComponent(path.join(canonical, "note.md"))}`);
	const nested = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload: { path: "sub dir/我的 笔记#2.md" } });
	assert.equal(nested.statusCode, 200);
	assert.equal(nested.json().uri, `obsidian://open?path=${encodeURIComponent(path.join(canonical, "sub dir", "我的 笔记#2.md"))}`);
	assert.ok(!nested.json().uri.includes("#"));
	await app.close();
});

test("obsidian-uri：穿越/绝对/隐藏段/非 md/缺参一律 400", async () => {
	const { app, binding } = await obsidianFixture("invalid", { "note.md": "# x\n" });
	for (const [payload, code] of [
		[{ path: "../secret.md" }, "invalid_path"],
		[{ path: "/etc/passwd.md" }, "invalid_path"],
		[{ path: ".obsidian/config.md" }, "invalid_path"],
		[{ path: "a\\b.md" }, "invalid_path"],
		[{ path: "note.txt" }, "invalid_path"],
		[{ path: "" }, "invalid_input"],
		[{}, "invalid_input"],
		[{ path: 42 }, "invalid_input"],
	] as const) {
		const response = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload });
		assert.equal(response.statusCode, 400, `${JSON.stringify(payload)} 应 400，实得 ${response.statusCode}`);
		assert.equal(response.json().code, code);
	}
	await app.close();
});

test("obsidian-uri：不存在与符号链接都是 404 not_found（不透露存在性）", async () => {
	const { root, app, binding } = await obsidianFixture("notfound", { "real.md": "# x\n" });
	await symlink(path.join(root, "real.md"), path.join(root, "link.md"));
	const missing = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload: { path: "ghost.md" } });
	assert.equal(missing.statusCode, 404);
	assert.equal(missing.json().code, "not_found");
	const link = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload: { path: "link.md" } });
	assert.equal(link.statusCode, 404);
	assert.equal(link.json().code, "not_found");
	assert.equal(link.json().error, missing.json().error);
	await app.close();
});

test("obsidian-uri：撤权与未知绑定 404；根替换 409", async () => {
	const { app, binding } = await obsidianFixture("revoke", { "note.md": "# x\n" });
	const unknown = await app.inject({ method: "POST", url: "/api/knowledge/no-such-id/obsidian-uri", payload: { path: "note.md" } });
	assert.equal(unknown.statusCode, 404);
	const revoke = await app.inject({ method: "DELETE", url: `/api/knowledge/${binding.id}`, payload: { expectedRevision: binding.bindingRevision } });
	assert.equal(revoke.statusCode, 200);
	const revoked = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload: { path: "note.md" } });
	assert.equal(revoked.statusCode, 404);
	await app.close();

	const replaced = await obsidianFixture("replaced", { "note.md": "# x\n" });
	await rm(replaced.root, { recursive: true, force: true });
	await mkdir(replaced.root);
	await writeFile(path.join(replaced.root, "note.md"), "# 同路径新库\n");
	const drifted = await replaced.app.inject({ method: "POST", url: `/api/knowledge/${replaced.binding.id}/obsidian-uri`, payload: { path: "note.md" } });
	assert.equal(drifted.statusCode, 409);
	assert.equal(drifted.json().code, "root_changed");
	await replaced.app.close();
});

test("obsidian-uri：obsidianRoot 在 wiki/ 子目录时根目录文件被拒", async () => {
	const base = await mkdtemp(path.join(tmpdir(), "pt-knowledge-obsidian-subroot-"));
	const root = path.join(base, "vault");
	await mkdir(path.join(root, "wiki", ".obsidian"), { recursive: true });
	await writeFile(path.join(root, "note.md"), "# 库外\n");
	await writeFile(path.join(root, "wiki", "inside.md"), "# 库内\n");
	const registry = new KnowledgeBindingRegistry(path.join(base, "state"));
	const probe = await probeKnowledgeRoot(root);
	assert.equal(probe.profile, "markdown");
	const binding = await registry.create({
		ownerId: localViewerIdentity().user.id, name: "Vault", description: "T24", rootPath: root,
		prepared: {
			canonicalRoot: probe.canonicalRoot, rootIdentity: probe.rootIdentity,
			contentRoot: probe.contentRoot, linkRoot: probe.contentRoot,
			obsidianRoot: path.join(probe.canonicalRoot, "wiki"),
		},
	});
	const app = Fastify();
	registerKnowledgeRoutes(app, registry);
	const inside = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload: { path: "wiki/inside.md" } });
	assert.equal(inside.statusCode, 200);
	assert.equal(inside.json().uri, `obsidian://open?path=${encodeURIComponent(path.join(probe.canonicalRoot, "wiki", "inside.md"))}`);
	const outside = await app.inject({ method: "POST", url: `/api/knowledge/${binding.id}/obsidian-uri`, payload: { path: "note.md" } });
	assert.equal(outside.statusCode, 400);
	assert.equal(outside.json().code, "invalid_path");
	await app.close();
});
