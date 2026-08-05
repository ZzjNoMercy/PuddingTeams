import type { FastifyInstance } from "fastify";
import { TeamsStore, type AgentConfig } from "../store/teams.js";

/** Thin HTTP facade over the worker registry (teams.json). */
export function registerAgentsRoutes(app: FastifyInstance, teams: TeamsStore): void {
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
		return reply.code(204).send();
	});

	app.post<{ Params: { name: string } }>("/api/agents/:name/probe", async (req, reply) => {
		try {
			return { probe: await teams.probeAgent(req.params.name) };
		} catch (err) {
			return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});
}
