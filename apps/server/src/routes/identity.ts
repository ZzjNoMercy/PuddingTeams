import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PuddingTeamsPaths } from "../paths.js";

export interface ViewerIdentity {
	mode: "local" | "authenticated";
	user: {
		id: string;
		username: string;
		displayName: string;
		avatarVersion?: number;
	};
	tenant: {
		id: string;
		name: string;
	};
}

/** Local-first identity adapter. The API shape already separates user and
 * tenant so a future authenticated provider can replace this implementation
 * without changing navigation consumers or telemetry dimensions. */
export function localViewerIdentity(username = os.userInfo().username): ViewerIdentity {
	const normalized = username.trim() || "local-user";
	return {
		mode: "local",
		user: {
			id: `local:${normalized}`,
			username: normalized,
			displayName: normalized,
		},
		tenant: {
			id: "local",
			name: "本机",
		},
	};
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = [
	{ ext: "png", mime: "image/png", matches: (b: Buffer) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ ext: "jpg", mime: "image/jpeg", matches: (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ ext: "webp", mime: "image/webp", matches: (b: Buffer) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
];

async function existingAvatar(assets: string): Promise<{ file: string; mime: string; version: number } | null> {
	for (const type of AVATAR_TYPES) {
		const file = path.join(assets, `viewer-avatar.${type.ext}`);
		try { return { file, mime: type.mime, version: (await stat(file)).mtimeMs }; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return null;
}

/** Only presentation fields are editable; the OS username and owner ID remain stable. */
export function registerIdentityRoutes(
	app: FastifyInstance,
	identityProvider: () => ViewerIdentity = localViewerIdentity,
	paths?: Pick<PuddingTeamsPaths, "config" | "assets">,
): void {
	const profileFile = paths && path.join(paths.config, "viewer-profile.json");
	const current = async (): Promise<ViewerIdentity> => {
		const identity = identityProvider();
		if (!paths || !profileFile || identity.mode !== "local") return identity;
		let displayName = identity.user.displayName;
		try {
			const saved = JSON.parse(await readFile(profileFile, "utf8")) as { displayName?: unknown };
			if (typeof saved.displayName === "string" && saved.displayName.trim()) displayName = saved.displayName;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const avatar = await existingAvatar(paths.assets);
		return { ...identity, user: { ...identity.user, displayName, ...(avatar ? { avatarVersion: avatar.version } : {}) } };
	};
	app.get("/api/identity", current);
	if (!paths || !profileFile) return;
	app.patch<{ Body: { displayName?: unknown } }>("/api/identity/profile", async (request, reply) => {
		if (typeof request.body?.displayName !== "string") return reply.code(400).send({ error: "请输入显示名称" });
		const displayName = request.body.displayName.trim();
		if (!displayName || Array.from(displayName).length > 40 || /[\u0000-\u001f\u007f]/.test(displayName)) {
			return reply.code(400).send({ error: "显示名称需为 1–40 个字符，不能包含控制字符" });
		}
		await mkdir(paths.config, { recursive: true });
		const temporary = `${profileFile}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify({ displayName }), { mode: 0o600 });
		await rename(temporary, profileFile);
		return current();
	});
	app.post<{ Body: { data?: unknown } }>("/api/identity/avatar", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
		const data = request.body?.data;
		if (typeof data !== "string" || !data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
			return reply.code(400).send({ error: "头像数据无效" });
		}
		if (data.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 8) return reply.code(413).send({ error: "头像不能超过 2 MB" });
		const bytes = Buffer.from(data, "base64");
		if (bytes.length > AVATAR_MAX_BYTES) return reply.code(413).send({ error: "头像不能超过 2 MB" });
		const type = AVATAR_TYPES.find((candidate) => candidate.matches(bytes));
		if (!type) return reply.code(400).send({ error: "请选择 PNG、JPEG 或 WebP 图片" });
		await mkdir(paths.assets, { recursive: true });
		const temporary = path.join(paths.assets, `viewer-avatar.${randomUUID()}.tmp`);
		await writeFile(temporary, bytes, { mode: 0o600 });
		await rename(temporary, path.join(paths.assets, `viewer-avatar.${type.ext}`));
		for (const file of await readdir(paths.assets)) {
			if (file !== `viewer-avatar.${type.ext}` && AVATAR_TYPES.some((candidate) => file === `viewer-avatar.${candidate.ext}`)) await rm(path.join(paths.assets, file));
		}
		return current();
	});
	app.delete("/api/identity/avatar", async () => {
		for (const type of AVATAR_TYPES) await rm(path.join(paths.assets, `viewer-avatar.${type.ext}`), { force: true });
		return current();
	});
	app.get("/api/identity/avatar", async (_request, reply) => {
		const avatar = await existingAvatar(paths.assets);
		if (!avatar) return reply.code(404).send({ error: "未设置头像" });
		return reply.header("content-type", avatar.mime).header("cache-control", "private, no-cache").send(await readFile(avatar.file));
	});
}
