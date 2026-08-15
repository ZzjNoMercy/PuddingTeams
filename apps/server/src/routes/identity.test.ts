import assert from "node:assert";
import { test } from "node:test";
import Fastify from "fastify";
import { localViewerIdentity, registerIdentityRoutes } from "./identity.js";

test("本地身份按 user / tenant 分层，API 保留未来多租户契约", async () => {
	const identity = localViewerIdentity("pet");
	assert.deepEqual(identity, {
		mode: "local",
		user: { id: "local:pet", username: "pet", displayName: "pet" },
		tenant: { id: "local", name: "本机" },
	});

	const app = Fastify({ logger: false });
	registerIdentityRoutes(app, () => identity);
	const response = await app.inject({ method: "GET", url: "/api/identity" });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(response.json(), identity);
	await app.close();
});
