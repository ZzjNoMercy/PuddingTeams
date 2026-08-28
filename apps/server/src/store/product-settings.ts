import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	DEFAULT_WORKER_RESULT_CONTEXT,
	validateWorkerResultContext,
	type WorkerResultContextSettings,
} from "./large-worker-result.js";
import type { HarnessCodeSearchProvider } from "../pi-bridge/code-search.js";

export interface ProductSettings {
	developerMode: boolean;
	harness: {
		codeSearch: { defaultProvider: HarnessCodeSearchProvider };
		workerResults: WorkerResultContextSettings;
		goalActivation: { solo: "manager_explicit" | "user_explicit" | "disabled"; group: "manager_explicit" | "user_explicit" | "disabled"; direct: "user_explicit" | "disabled"; confirmWhenAmbiguous: boolean };
		goalRecovery: { mode: "safe_auto" | "manual"; directMode: "manual"; resumeLeaseMs: number; operationRetentionDays: number; maxOperationsPerSession: number };
	};
}

export type GoalActivationSettings = ProductSettings["harness"]["goalActivation"];
export type GoalRecoverySettings = ProductSettings["harness"]["goalRecovery"];
export type HarnessCodeSearchSettings = ProductSettings["harness"]["codeSearch"];

export class ProductSettingsStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly configDir: string) {
		this.file = path.join(configDir, "product.json");
	}

	async get(): Promise<ProductSettings> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<ProductSettings>;
			return {
				developerMode: parsed.developerMode === true,
				harness: {
					codeSearch: {
						defaultProvider: parsed.harness?.codeSearch?.defaultProvider === "fff" ? "fff" : "builtin",
					},
					workerResults: validateWorkerResultContext(parsed.harness?.workerResults ?? {}),
					goalActivation: {
						solo: parsed.harness?.goalActivation?.solo ?? "manager_explicit",
						group: parsed.harness?.goalActivation?.group ?? "manager_explicit",
						direct: parsed.harness?.goalActivation?.direct ?? "user_explicit",
						confirmWhenAmbiguous: parsed.harness?.goalActivation?.confirmWhenAmbiguous !== false,
					},
					goalRecovery: {
						mode: parsed.harness?.goalRecovery?.mode ?? "safe_auto",
						directMode: "manual",
						resumeLeaseMs: Math.max(5_000, Math.min(parsed.harness?.goalRecovery?.resumeLeaseMs ?? 30_000, 300_000)),
						operationRetentionDays: Math.max(7, Math.min(parsed.harness?.goalRecovery?.operationRetentionDays ?? 30, 365)),
						maxOperationsPerSession: Math.max(128, Math.min(parsed.harness?.goalRecovery?.maxOperationsPerSession ?? 512, 4096)),
					},
				},
			};
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return {
				developerMode: false,
				harness: {
					codeSearch: { defaultProvider: "builtin" },
					workerResults: DEFAULT_WORKER_RESULT_CONTEXT,
					goalActivation: { solo: "manager_explicit", group: "manager_explicit", direct: "user_explicit", confirmWhenAmbiguous: true },
					goalRecovery: { mode: "safe_auto", directMode: "manual", resumeLeaseMs: 30_000, operationRetentionDays: 30, maxOperationsPerSession: 512 },
				},
			};
		}
	}

	async setDeveloperMode(enabled: boolean): Promise<ProductSettings> {
		const run = this.queue.then(async () => {
			const settings = { ...(await this.get()), developerMode: enabled };
			await mkdir(this.configDir, { recursive: true });
			const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
			await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
			await rename(tmp, this.file);
			return settings;
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	async setWorkerResultContext(input: Partial<WorkerResultContextSettings>): Promise<ProductSettings> {
		return this.setHarness({ workerResults: input });
	}

	async setHarness(input: {
		codeSearch?: Partial<HarnessCodeSearchSettings>;
		workerResults?: Partial<WorkerResultContextSettings>;
		goalActivation?: Partial<GoalActivationSettings>;
		goalRecovery?: Partial<GoalRecoverySettings>;
	}): Promise<ProductSettings> {
		const run = this.queue.then(async () => {
			const current = await this.get();
			const codeSearch = { ...current.harness.codeSearch, ...(input.codeSearch ?? {}) };
			if (!["builtin", "fff"].includes(codeSearch.defaultProvider)) throw new Error("codeSearch.defaultProvider 无效");
			const activation = { ...current.harness.goalActivation, ...(input.goalActivation ?? {}) };
			if (!["manager_explicit", "user_explicit", "disabled"].includes(activation.solo)) throw new Error("goalActivation.solo 无效");
			if (!["manager_explicit", "user_explicit", "disabled"].includes(activation.group)) throw new Error("goalActivation.group 无效");
			if (!["user_explicit", "disabled"].includes(activation.direct)) throw new Error("goalActivation.direct 无效");
			if (typeof activation.confirmWhenAmbiguous !== "boolean") throw new Error("goalActivation.confirmWhenAmbiguous 必须是布尔值");
			const recovery = { ...current.harness.goalRecovery, ...(input.goalRecovery ?? {}), directMode: "manual" as const };
			if (!["safe_auto", "manual"].includes(recovery.mode)) throw new Error("goalRecovery.mode 无效");
			for (const [key, value] of Object.entries({ resumeLeaseMs: recovery.resumeLeaseMs, operationRetentionDays: recovery.operationRetentionDays, maxOperationsPerSession: recovery.maxOperationsPerSession })) {
				if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`goalRecovery.${key} 必须是有限数字`);
			}
			const settings: ProductSettings = {
				...current,
				harness: {
					codeSearch,
					workerResults: input.workerResults ? validateWorkerResultContext({ ...current.harness.workerResults, ...input.workerResults }) : current.harness.workerResults,
					goalActivation: activation,
					goalRecovery: {
						...recovery,
						resumeLeaseMs: Math.max(5_000, Math.min(recovery.resumeLeaseMs, 300_000)),
						operationRetentionDays: Math.max(7, Math.min(recovery.operationRetentionDays, 365)),
						maxOperationsPerSession: Math.max(128, Math.min(recovery.maxOperationsPerSession, 4096)),
					},
				},
			};
			await mkdir(this.configDir, { recursive: true });
			const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
			await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
			await rename(tmp, this.file);
			return settings;
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}
}
