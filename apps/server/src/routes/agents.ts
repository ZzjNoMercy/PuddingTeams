import type { FastifyInstance } from "fastify";
import { AVATAR_MAX_BYTES, TeamsStore, type AgentConfig } from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";

/** Thin HTTP facade over the worker registry (teams.json). */
export function registerAgentsRoutes(app: FastifyInstance, teams: TeamsStore, credentials?: CredentialsStore): void {
	app.get("/api/agents", async () => ({ agents: await teams.listAgents() }));

	app.post<{ Body: Partial<Record<string, unknown>> }>("/api/agents", async (req, reply) => {
		try {
			const agent = await teams.upsertAgent(req.body as unknown as AgentConfig);
			return { agent };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.put<{ Params: { name: string }; Body: Partial<Record<string, unknown>> }>(
		"/api/agents/:name",
		async (req, reply) => {
			try {
				const agent = await teams.upsertAgent({
					...(req.body as unknown as AgentConfig),
					name: req.params.name,
				});
				return { agent };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.delete<{ Params: { name: string } }>("/api/agents/:name", async (req, reply) => {
		const removed = await teams.removeAgent(req.params.name);
		if (!removed) return reply.code(404).send({ error: "agent not found" });
		// 连带清除该 worker 的加密密钥。
		await credentials?.removeAgentSecrets(req.params.name);
		return reply.code(204).send();
	});

	app.post<{ Params: { name: string } }>("/api/agents/:name/probe", async (req, reply) => {
		try {
			return { probe: await teams.probeAgent(req.params.name) };
		} catch (err) {
			return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	// ---- secrets（加密存储于 ~/.puddingteams，派活时注入 worker env）----

	app.get<{ Params: { name: string } }>("/api/agents/:name/secrets", async (req, reply) => {
		if (!credentials) return reply.code(501).send({ error: "secrets store not configured" });
		if (!(await teams.getAgent(req.params.name))) return reply.code(404).send({ error: "agent not found" });
		return { configured: await credentials.listConfigured(req.params.name) };
	});

	app.put<{ Params: { name: string }; Body: { secrets?: Record<string, string> } }>(
		"/api/agents/:name/secrets",
		async (req, reply) => {
			if (!credentials) return reply.code(501).send({ error: "secrets store not configured" });
			if (!(await teams.getAgent(req.params.name))) return reply.code(404).send({ error: "agent not found" });
			const secrets = req.body?.secrets;
			if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
				return reply.code(400).send({ error: "body must be { secrets: { KEY: value } }" });
			}
			for (const [k, v] of Object.entries(secrets)) {
				if (typeof v !== "string") return reply.code(400).send({ error: `secret "${k}" must be a string` });
				if (!/^[A-Z0-9_]+$/.test(k)) {
					return reply.code(400).send({ error: `secret key "${k}" must be UPPER_SNAKE (env var name)` });
				}
			}
			return { configured: await credentials.setSecrets(req.params.name, secrets) };
		},
	);

	app.delete<{ Params: { name: string; key: string } }>(
		"/api/agents/:name/secrets/:key",
		async (req, reply) => {
			if (!credentials) return reply.code(501).send({ error: "secrets store not configured" });
			await credentials.removeSecret(req.params.name, req.params.key);
			return reply.code(204).send();
		},
	);

	// ---- avatars (§11): files under .teams/avatars/, field on teams.json ----

	// base64 of a 2MB image is ~2.7MB; Fastify's default 1MB body limit would
	// reject legitimate uploads, so this route opts into a larger cap.
	app.post<{ Params: { name: string }; Body: { data?: string; mediaType?: string } }>(
		"/api/agents/:name/avatar",
		{ bodyLimit: 4 * 1024 * 1024 },
		async (req, reply) => {
			const data = req.body?.data;
			if (typeof data !== "string" || data.length === 0) {
				return reply.code(400).send({ error: "body must be { data: base64 }" });
			}
			// Cheap pre-decode bound so a huge base64 string is rejected early.
			if (data.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 8) {
				return reply.code(413).send({ error: `avatar exceeds ${AVATAR_MAX_BYTES / 1024 / 1024}MB limit` });
			}
			try {
				const agent = await teams.saveAvatar(req.params.name, Buffer.from(data, "base64"));
				return { agent };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return reply.code(msg.includes("not found") ? 404 : 400).send({ error: msg });
			}
		},
	);

	app.delete<{ Params: { name: string } }>("/api/agents/:name/avatar", async (req, reply) => {
		try {
			await teams.removeAvatar(req.params.name);
			return reply.code(204).send();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return reply.code(msg.includes("not found") ? 404 : 400).send({ error: msg });
		}
	});

	app.get<{ Params: { name: string } }>("/api/agents/:name/avatar", async (req, reply) => {
		const avatar = await teams.readAvatar(req.params.name);
		if (!avatar) return reply.code(404).send({ error: "no avatar" });
		// Frontend busts the cache with ?v=<n> on upload/delete, so a long
		// max-age is safe.
		return reply
			.header("content-type", avatar.mime)
			.header("cache-control", "public, max-age=3600")
			.send(avatar.buf);
	});
}
