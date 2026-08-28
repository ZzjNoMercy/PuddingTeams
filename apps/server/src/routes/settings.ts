import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import type { GoalActivationSettings, GoalRecoverySettings, HarnessCodeSearchSettings, ProductSettingsStore } from "../store/product-settings.js";
import type { WorkerResultContextSettings } from "../store/large-worker-result.js";
import type { WorkStateStore } from "../store/work-state.js";

export async function registerSettingsRoutes(app: FastifyInstance, cwd: string, productSettings?: ProductSettingsStore, workStates?: WorkStateStore, onHarnessChange?: () => void): Promise<void> {
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
	app.get("/api/settings/harness", async () => {
		if (!productSettings) return { harness: null };
		return { harness: (await productSettings.get()).harness };
	});
	app.put<{ Body: {
		codeSearch?: Partial<HarnessCodeSearchSettings>;
		workerResults?: Partial<WorkerResultContextSettings>;
		goalActivation?: Partial<GoalActivationSettings>;
		goalRecovery?: Partial<GoalRecoverySettings>;
	} }>("/api/settings/harness", async (req, reply) => {
		try {
			if (!productSettings) throw new Error("Product settings 未启用");
			if (!req.body || (!req.body.codeSearch && !req.body.workerResults && !req.body.goalActivation && !req.body.goalRecovery)) return reply.code(400).send({ error: "至少提供一项 Harness 设置" });
			const settings = await productSettings.setHarness(req.body);
			workStates?.configureOperationLedger(settings.harness.goalRecovery);
			onHarnessChange?.();
			return { harness: settings.harness };
		} catch (error) {
			return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}
