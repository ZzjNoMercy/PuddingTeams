import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { HarnessSettingsConflictError, harnessSettingsRevision } from "../store/product-settings.js";
import type { GoalActivationSettings, GoalRecoverySettings, HarnessCodeSearchSettings, ProductSettings, ProductSettingsStore, VerificationSettingsPatch, WorkspaceExecutionSettingsPatch } from "../store/product-settings.js";
import type { WorkerResultContextSettings } from "../store/large-worker-result.js";
import type { WorkStateStore } from "../store/work-state.js";

export async function registerSettingsRoutes(app: FastifyInstance, cwd: string, productSettings?: ProductSettingsStore, workStates?: WorkStateStore, onHarnessChange?: (settings: ProductSettings) => void, isActiveReviewer?: (name: string) => Promise<boolean>): Promise<void> {
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
		const { harness } = await productSettings.get();
		return { harness, revision: harnessSettingsRevision(harness) };
	});
	app.put<{ Body: {
		expectedRevision?: string;
		codeSearch?: Partial<HarnessCodeSearchSettings>;
		workerResults?: Partial<WorkerResultContextSettings>;
		goalActivation?: Partial<GoalActivationSettings>;
		goalRecovery?: Partial<GoalRecoverySettings>;
		verification?: VerificationSettingsPatch;
		workspaceExecution?: WorkspaceExecutionSettingsPatch;
	} }>("/api/settings/harness", async (req, reply) => {
		try {
			if (!productSettings) throw new Error("Product settings 未启用");
			if (!req.body || (!req.body.codeSearch && !req.body.workerResults && !req.body.goalActivation && !req.body.goalRecovery && !req.body.verification && !req.body.workspaceExecution)) return reply.code(400).send({ error: "至少提供一项 Harness 设置" });
			if (req.body.expectedRevision === undefined) return reply.code(428).send({ error: "缺少 Harness 设置版本，请重新读取配置" });
			if (typeof req.body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(req.body.expectedRevision)) return reply.code(400).send({ error: "Harness 设置版本格式无效" });
			const reviewerName = req.body.verification?.reviewers?.cliAgentId;
			if (reviewerName !== undefined && reviewerName !== "" && isActiveReviewer && !(await isActiveReviewer(reviewerName))) {
				return reply.code(409).send({ code: "harness_reviewer_unavailable", error: "CLI 复验 Worker 已停用或不存在，请重新选择" });
			}
			const settings = await productSettings.setHarness(req.body, req.body.expectedRevision);
			workStates?.configureOperationLedger(settings.harness.goalRecovery);
			workStates?.configureVerificationDefaults({
				minimumWorkItemMode: settings.harness.verification.defaultWorkItemMode,
				finalGoalMode: settings.harness.verification.defaultFinalGoalMode,
				trigger: settings.harness.verification.trigger,
				workspaceExecution: {
					readOnlyMode: settings.harness.workspaceExecution.readOnlyDefault,
					gitWriteMode: settings.harness.workspaceExecution.gitWriteDefault,
					nonGitWriteMode: settings.harness.workspaceExecution.nonGitWriteDefault,
				},
			});
			onHarnessChange?.(settings);
			return { harness: settings.harness, revision: harnessSettingsRevision(settings.harness) };
		} catch (error) {
			if (error instanceof HarnessSettingsConflictError) return reply.code(409).send({ error: error.message, currentRevision: error.currentRevision });
			return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}
