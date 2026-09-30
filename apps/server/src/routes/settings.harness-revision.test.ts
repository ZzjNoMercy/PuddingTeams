import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ProductSettingsStore } from "../store/product-settings.js";
import { registerSettingsRoutes } from "./settings.js";

test("Harness HTTP 版本门禁在 Runtime 配置回调前拒绝旧写入", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-harness-route-revision-"));
	const store = new ProductSettingsStore(dir);
	const app = Fastify();
	let applied = 0;
	await registerSettingsRoutes(app, dir, store, undefined, () => { applied += 1; });
	try {
		const first = await app.inject({ method: "GET", url: "/api/settings/harness" });
		assert.equal(first.statusCode, 200);
		const initial = first.json() as { harness: unknown; revision: string };
		assert.match(initial.revision, /^[a-f0-9]{64}$/);
		const missing = await app.inject({ method: "PUT", url: "/api/settings/harness", payload: { codeSearch: { defaultProvider: "fff" } } });
		assert.equal(missing.statusCode, 428);
		const malformed = await app.inject({ method: "PUT", url: "/api/settings/harness", payload: { expectedRevision: 42, codeSearch: { defaultProvider: "fff" } } });
		assert.equal(malformed.statusCode, 400);
		const accepted = await app.inject({ method: "PUT", url: "/api/settings/harness", payload: { expectedRevision: initial.revision, codeSearch: { defaultProvider: "fff" } } });
		assert.equal(accepted.statusCode, 200);
		const next = accepted.json() as { revision: string };
		assert.notEqual(next.revision, initial.revision);
		assert.equal(applied, 1);
		const stale = await app.inject({ method: "PUT", url: "/api/settings/harness", payload: { expectedRevision: initial.revision, goalRecovery: { mode: "manual" } } });
		assert.equal(stale.statusCode, 409);
		assert.equal((stale.json() as { currentRevision: string }).currentRevision, next.revision);
		assert.equal(applied, 1, "拒绝的旧写入不能重配 Runtime");
		const latest = (await app.inject({ method: "GET", url: "/api/settings/harness" })).json() as { harness: { goalRecovery: { mode: string } }; revision: string };
		assert.equal(latest.revision, next.revision);
		assert.equal(latest.harness.goalRecovery.mode, "safe_auto");
		const normalized = await app.inject({ method: "PUT", url: "/api/settings/harness", payload: { expectedRevision: latest.revision, verification: { reviewers: { evidenceModel: "  provider/model  " } } } });
		assert.equal(normalized.statusCode, 200);
		assert.equal((normalized.json() as { revision: string }).revision, (await app.inject({ method: "GET", url: "/api/settings/harness" })).json().revision);
	} finally {
		await app.close();
	}
});

test("已停用或不存在的 CLI 复验 Worker 不能写入 Harness 策略", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-harness-reviewer-gate-"));
	const store = new ProductSettingsStore(dir);
	const app = Fastify();
	let applied = 0;
	await registerSettingsRoutes(app, dir, store, undefined, () => { applied += 1; }, async (name) => name === "worker-live");
	try {
		const initial = (await app.inject({ method: "GET", url: "/api/settings/harness" })).json() as { revision: string };
		const stale = await app.inject({ method: "PUT", url: "/api/settings/harness", payload: {
			expectedRevision: initial.revision, verification: { reviewers: { cliAgentId: "worker-disabled" } },
		} });
		assert.equal(stale.statusCode, 409);
		assert.equal(stale.json().code, "harness_reviewer_unavailable");
		assert.equal(applied, 0);
		assert.equal((await app.inject({ method: "GET", url: "/api/settings/harness" })).json().revision, initial.revision);
		const accepted = await app.inject({ method: "PUT", url: "/api/settings/harness", payload: {
			expectedRevision: initial.revision, verification: { reviewers: { cliAgentId: "worker-live" } },
		} });
		assert.equal(accepted.statusCode, 200);
		assert.equal(accepted.json().harness.verification.reviewers.cliAgentId, "worker-live");
		assert.equal(applied, 1);
	} finally {
		await app.close();
	}
});
