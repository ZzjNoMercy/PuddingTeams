import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ArtifactStore } from "../agent-runtime/artifact-store.js";
import { registerArtifactsRoutes } from "./artifacts.js";

/** §15.6：交付物列表/下载 API；content 下载只读登记路径本身（防穿越）。 */

async function makeStack() {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-artifacts-api-"));
	const store = new ArtifactStore(dir);
	await store.init();
	const app = Fastify({ logger: false });
	registerArtifactsRoutes(app, store);
	return { app, store, dir };
}

const project = (cwd: string) => ({ workspaceId: "workspace-1", cwdSnapshot: realpathSync(cwd) });

test("GET /api/artifacts 按 windowId/delegationId 过滤", async () => {
	const { app, store, dir } = await makeStack();
	const file = path.join(dir, "a.md");
	writeFileSync(file, "a");
	await store.register({ ...project(dir), name: "a.md", path: file, origin: "push", producer: "puddingclaw", delegationId: "d1", windowId: "w1" });
	await store.register({ ...project(dir), name: "b.md", path: file, origin: "push", producer: "puddingclaw", delegationId: "d2", windowId: "w2" });

	const all = await app.inject({ method: "GET", url: "/api/artifacts" });
	assert.equal(all.statusCode, 200);
	assert.equal(all.json().artifacts.length, 2);

	const byWindow = await app.inject({ method: "GET", url: "/api/artifacts?windowId=w1" });
	assert.deepEqual(byWindow.json().artifacts.map((a: { delegationId: string }) => a.delegationId), ["d1"]);

	const byDelegation = await app.inject({ method: "GET", url: "/api/artifacts?delegationId=d2" });
	assert.equal(byDelegation.json().artifacts.length, 1);

	await app.close();
});

test("GET /api/artifacts/:id/content 下载冻结版本并返回 SHA-256", async () => {
	const { app, store, dir } = await makeStack();
	const file = path.join(dir, "报告.md");
	writeFileSync(file, "交付内容");
	const rec = await store.register({ ...project(dir), name: "报告.md", path: file, origin: "push", producer: "puddingclaw", delegationId: "d1", windowId: "w1" });

	const res = await app.inject({ method: "GET", url: `/api/artifacts/${rec.id}/content` });
	assert.equal(res.statusCode, 200);
	assert.equal(res.body, "交付内容");
	assert.equal(res.headers["x-content-sha256"], rec.contentHash);
	assert.ok(encodeURIComponent("报告.md") !== "报告.md" && res.headers["content-disposition"]?.toString().includes(encodeURIComponent("报告.md")));

	const missing = await app.inject({ method: "GET", url: "/api/artifacts/nope/content" });
	assert.equal(missing.statusCode, 404, "未登记的 id 一律 404，无任意路径读取面");

	await app.close();
});

test("登记拒绝 workspace 外路径；原文件删除后冻结版本仍可下载", async () => {
	const { app, store, dir } = await makeStack();
	// 工作区外的敏感文件 + 工作区内指向它的 symlink。
	const outside = path.join(dir, "outside-secret.txt");
	writeFileSync(outside, "secret");
	const wsDir = path.join(dir, "ws");
	mkdirSync(wsDir);
	const link = path.join(wsDir, "innocent.md");
	symlinkSync(outside, link);

	await assert.rejects(
		() => store.register({ ...project(wsDir), name: "innocent.md", path: link, origin: "push", producer: "x", delegationId: "d", windowId: "w" }),
		/outside delegation cwdSnapshot/,
		"symlink 指向项目外必须在登记时拒绝",
	);

	await assert.rejects(
		() => store.register({ ...project(wsDir), name: "s.txt", path: outside, origin: "observe", producer: "x", delegationId: "d", windowId: "w" }),
		/outside delegation cwdSnapshot/,
		"直接项目外路径也必须拒绝",
	);

	const ghostPath = path.join(wsDir, "ghost.md");
	writeFileSync(ghostPath, "ghost");
	const ghost = await store.register({ ...project(wsDir), name: "ghost.md", path: ghostPath, origin: "push", producer: "x", delegationId: "d", windowId: "w" });
	unlinkSync(ghostPath);
	const gone = await app.inject({ method: "GET", url: `/api/artifacts/${ghost.id}/content` });
	assert.equal(gone.statusCode, 200, "登记后原文件丢失不影响冻结版本");
	assert.equal(gone.body, "ghost");

	await app.close();
});
