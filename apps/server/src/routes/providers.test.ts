import { test, before, after } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { registerProvidersRoutes } from "./providers.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";

/**
 * Provider 探针路由测试（借鉴 PuddingClaw：GET /models 是最低成本带鉴权
 * 探针）。本地起 HTTP server 模拟 OpenAI-compatible 端点：
 * - 无/错 key → 401；正确 key → 200 + 模型清单。
 */

let upstream: Server;
let baseUrl: string;
let app: FastifyInstance;

before(async () => {
	upstream = createServer((req, res) => {
		if (req.url === "/v1/models" && req.headers.authorization === "Bearer good-key") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "m-b" }, { id: "m-a", name: "Model A" }] }));
			return;
		}
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized" }));
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

	app = Fastify();
	// delete 路径才用到 store.removeProviderKey；探针路由不碰，stub 即可。
	await registerProvidersRoutes(app, {
		removeProviderKey: async () => undefined,
	} as unknown as PiSessionStore);
});

after(async () => {
	await app.close();
	await new Promise((resolve) => upstream.close(resolve));
});

test("POST /api/providers/test：401 映射为鉴权失败；正确 key 返回 ok + latency", async () => {
	const noKey = await app.inject({
		method: "POST",
		url: "/api/providers/test",
		payload: { baseUrl, apiKey: "wrong" },
	});
	const noKeyBody = noKey.json() as { ok: boolean; status?: number; error?: string };
	assert.equal(noKeyBody.ok, false);
	assert.equal(noKeyBody.status, 401);
	assert.match(noKeyBody.error ?? "", /鉴权失败/);

	const good = await app.inject({
		method: "POST",
		url: "/api/providers/test",
		payload: { baseUrl, apiKey: "good-key" },
	});
	const goodBody = good.json() as { ok: boolean; latencyMs?: number };
	assert.equal(goodBody.ok, true);
	assert.equal(typeof goodBody.latencyMs, "number");
});

test("POST /api/providers/discover：返回排序后的模型 id 清单", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/api/providers/discover",
		payload: { baseUrl, apiKey: "good-key" },
	});
	const body = res.json() as { ok: boolean; models: Array<{ id: string; name?: string }> };
	assert.equal(body.ok, true);
	assert.deepEqual(body.models, [{ id: "m-a", name: "Model A" }, { id: "m-b" }]);
});

test("POST /api/providers/test：非法 baseUrl 直接 400/失败，不发请求", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/api/providers/test",
		payload: { baseUrl: "not-a-url", apiKey: "k" },
	});
	const body = res.json() as { ok?: boolean; error?: string };
	assert.equal(body.ok ?? false, false);
});
