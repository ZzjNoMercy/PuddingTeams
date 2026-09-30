import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerWebStatic } from "./web-static.js";

test("发行态静态托管可刷新查询参数深链，API 与非法路径保持 404", async () => {
	const out = mkdtempSync(path.join(tmpdir(), "pt-web-static-"));
	mkdirSync(path.join(out, "agents"));
	mkdirSync(path.join(out, "_next", "static"), { recursive: true });
	for (const [name, content] of [
		["index.html", "home-page"],
		["agents/config.html", "agent-config-page"],
		["settings.html", "settings-page"],
		["_next/static/app.js", "window.app = true"],
		["404.html", "missing-page"],
	] as const) writeFileSync(path.join(out, name), content);
	const app = Fastify({ logger: false });
	assert.equal(registerWebStatic(app, out), true);
	try {
		for (const [url, expected] of [
			["/", "home-page"],
			["/agents/config?name=alpha", "agent-config-page"],
			["/settings?section=harness&sub=search", "settings-page"],
			["/_next/static/app.js", "window.app = true"],
		]) {
			const response = await app.inject({ method: "GET", url });
			assert.equal(response.statusCode, 200, url);
			assert.equal(response.body, expected, url);
		}
		for (const url of ["/api", "/api/missing", "/api%2Fmissing"]) {
			const response = await app.inject({ method: "GET", url });
			assert.equal(response.statusCode, 404, url);
			assert.equal(response.headers["content-type"]?.toString().startsWith("application/json"), true, url);
		}
		for (const url of ["/missing", "/%2e%2e/%2e%2e/secret.txt", "/bad%ZZ"]) {
			const response = await app.inject({ method: "GET", url });
			assert.equal(response.statusCode, 404, url);
			assert.equal(response.body.includes("secret"), false, url);
		}
	} finally {
		await app.close();
	}
});
