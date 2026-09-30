import assert from "node:assert";
import { test } from "node:test";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("个人资料保存后仍保留稳定的本地用户 ID，头像可更换与移除", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "puddingteams-identity-"));
	const paths = { config: path.join(root, "config"), assets: path.join(root, "assets") };
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
	const app = Fastify({ logger: false });
	registerIdentityRoutes(app, () => localViewerIdentity("pet"), paths);
	try {
		const invalid = await app.inject({ method: "PATCH", url: "/api/identity/profile", payload: { displayName: " " } });
		assert.equal(invalid.statusCode, 400);
		const updated = await app.inject({ method: "PATCH", url: "/api/identity/profile", payload: { displayName: " 小布丁 " } });
		assert.equal(updated.statusCode, 200);
		assert.deepEqual(updated.json().user, { id: "local:pet", username: "pet", displayName: "小布丁" });
		const badAvatar = await app.inject({ method: "POST", url: "/api/identity/avatar", payload: { data: Buffer.from("<svg/>").toString("base64") } });
		assert.equal(badAvatar.statusCode, 400);
		const avatar = await app.inject({ method: "POST", url: "/api/identity/avatar", payload: { data: png.toString("base64") } });
		assert.equal(avatar.statusCode, 200);
		assert.equal(typeof avatar.json().user.avatarVersion, "number");
		const image = await app.inject({ method: "GET", url: "/api/identity/avatar" });
		assert.equal(image.headers["content-type"], "image/png");
		assert.deepEqual(image.rawPayload, png);
		const nextApp = Fastify({ logger: false });
		registerIdentityRoutes(nextApp, () => localViewerIdentity("pet"), paths);
		try {
			const persisted = await nextApp.inject({ method: "GET", url: "/api/identity" });
			assert.equal(persisted.json().user.displayName, "小布丁");
			assert.equal(typeof persisted.json().user.avatarVersion, "number");
		} finally { await nextApp.close(); }
		const removed = await app.inject({ method: "DELETE", url: "/api/identity/avatar" });
		assert.equal(removed.statusCode, 200);
		assert.equal(removed.json().user.avatarVersion, undefined);
		assert.equal((await app.inject({ method: "GET", url: "/api/identity/avatar" })).statusCode, 404);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
