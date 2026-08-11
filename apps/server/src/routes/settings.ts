import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";

export async function registerSettingsRoutes(app: FastifyInstance, cwd: string): Promise<void> {
	app.get("/api/settings", async () => {
		const settings = SettingsManager.create(cwd, getAgentDir());
		return {
			defaultProvider: settings.getDefaultProvider(),
			defaultModel: settings.getDefaultModel(),
		};
	});

	app.post<{ Body: { provider?: string; model?: string } }>(
		"/api/settings/model",
		async (req, reply) => {
			const provider = req.body?.provider;
			const model = req.body?.model;
			if (!provider || !model) {
				return reply.code(400).send({ error: "provider and model are required" });
			}
			const settings = SettingsManager.create(cwd, getAgentDir());
			settings.setDefaultModelAndProvider(provider, model);
			return { ok: true, defaultProvider: provider, defaultModel: model };
		},
	);
}
