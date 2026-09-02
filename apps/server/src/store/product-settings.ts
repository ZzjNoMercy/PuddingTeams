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
		/** Global defaults for independent verification. These are frozen into a WorkItem at creation time. */
		verification: VerificationSettings;
		/** Global defaults for workspace ownership and the fail-closed settlement policies. */
		workspaceExecution: WorkspaceExecutionSettings;
	};
}

export interface VerificationSettings {
	enabled: boolean;
	defaultWorkItemMode: "manager_review" | "independent_evidence_review";
	defaultFinalGoalMode: "manager_review" | "independent_evidence_review" | "environment_verified";
	trigger: "manager_request" | "auto_on_submission";
	reviewers: { evidenceModel: string; cliAgentId: string; requireRoomMember: boolean };
	cliEnvironmentMode: "isolated_copy" | "same_target_guarded";
	isolation: { requireFreshSession: boolean; forbidExecutorContinuation: boolean; requireDifferentAgent: boolean };
	firstReleaseScope: "cli_code_first";
	unavailableAction: "block";
	artifactCaptureFailure: "partial_receipt_block";
	remoteRunUnknown: "observation_lost_effect_unknown";
	cancelUnconfirmed: "cancel_requested_observation_lost";
}

export interface WorkspaceExecutionSettings {
	readOnlyDefault: "read_only_shared";
	gitWriteDefault: "isolated_worktree" | "exclusive_write";
	nonGitWriteDefault: "exclusive_write";
	leaseTimeoutMs: number;
	promotion: { autoApplyAfterAcceptance: boolean; autoCommit: boolean; autoPush: boolean; conflictAction: "block_preserve_changes" };
	managerWritePolicy: "delegation_required";
}

export type GoalActivationSettings = ProductSettings["harness"]["goalActivation"];
export type GoalRecoverySettings = ProductSettings["harness"]["goalRecovery"];
export type HarnessCodeSearchSettings = ProductSettings["harness"]["codeSearch"];
export type VerificationSettingsPatch = Omit<Partial<VerificationSettings>, "reviewers" | "isolation"> & {
	reviewers?: Partial<VerificationSettings["reviewers"]>;
	isolation?: Partial<VerificationSettings["isolation"]>;
};
export type WorkspaceExecutionSettingsPatch = Omit<Partial<WorkspaceExecutionSettings>, "promotion"> & {
	promotion?: Partial<WorkspaceExecutionSettings["promotion"]>;
};

export const DEFAULT_VERIFICATION_SETTINGS: VerificationSettings = {
	enabled: true,
	defaultWorkItemMode: "manager_review",
	defaultFinalGoalMode: "independent_evidence_review",
	trigger: "manager_request",
	reviewers: { evidenceModel: "", cliAgentId: "", requireRoomMember: false },
	cliEnvironmentMode: "isolated_copy",
	isolation: { requireFreshSession: true, forbidExecutorContinuation: true, requireDifferentAgent: false },
	firstReleaseScope: "cli_code_first",
	unavailableAction: "block",
	artifactCaptureFailure: "partial_receipt_block",
	remoteRunUnknown: "observation_lost_effect_unknown",
	cancelUnconfirmed: "cancel_requested_observation_lost",
};
export const DEFAULT_WORKSPACE_EXECUTION_SETTINGS: WorkspaceExecutionSettings = {
	readOnlyDefault: "read_only_shared",
	gitWriteDefault: "isolated_worktree",
	nonGitWriteDefault: "exclusive_write",
	leaseTimeoutMs: 600_000,
	promotion: { autoApplyAfterAcceptance: true, autoCommit: false, autoPush: false, conflictAction: "block_preserve_changes" },
	managerWritePolicy: "delegation_required",
};

export class ProductSettingsStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly configDir: string) {
		this.file = path.join(configDir, "product.json");
	}

	async get(): Promise<ProductSettings> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<ProductSettings>;
			const verification = parsed.harness?.verification;
			const workspaceExecution = parsed.harness?.workspaceExecution;
			const enumOr = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
			const boundedNumber = (value: unknown, fallback: number, min: number, max: number): number => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(value, max)) : fallback;
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
						mode: enumOr(parsed.harness?.goalRecovery?.mode, ["safe_auto", "manual"], "safe_auto"),
						directMode: "manual",
						resumeLeaseMs: boundedNumber(parsed.harness?.goalRecovery?.resumeLeaseMs, 30_000, 5_000, 300_000),
						operationRetentionDays: boundedNumber(parsed.harness?.goalRecovery?.operationRetentionDays, 30, 7, 365),
						maxOperationsPerSession: boundedNumber(parsed.harness?.goalRecovery?.maxOperationsPerSession, 512, 128, 4096),
					},
					verification: {
						enabled: true,
						defaultWorkItemMode: enumOr(verification?.defaultWorkItemMode, ["manager_review", "independent_evidence_review"], DEFAULT_VERIFICATION_SETTINGS.defaultWorkItemMode),
						defaultFinalGoalMode: enumOr(verification?.defaultFinalGoalMode, ["manager_review", "independent_evidence_review", "environment_verified"], DEFAULT_VERIFICATION_SETTINGS.defaultFinalGoalMode),
						trigger: enumOr(verification?.trigger, ["manager_request", "auto_on_submission"], DEFAULT_VERIFICATION_SETTINGS.trigger),
						reviewers: {
							evidenceModel: typeof verification?.reviewers?.evidenceModel === "string" ? verification.reviewers.evidenceModel.trim() : DEFAULT_VERIFICATION_SETTINGS.reviewers.evidenceModel,
							cliAgentId: typeof verification?.reviewers?.cliAgentId === "string" ? verification.reviewers.cliAgentId.trim() : DEFAULT_VERIFICATION_SETTINGS.reviewers.cliAgentId,
							requireRoomMember: verification?.reviewers?.requireRoomMember === true,
						},
						cliEnvironmentMode: enumOr(verification?.cliEnvironmentMode, ["isolated_copy", "same_target_guarded"], DEFAULT_VERIFICATION_SETTINGS.cliEnvironmentMode),
						isolation: {
							requireFreshSession: verification?.isolation?.requireFreshSession !== false,
							forbidExecutorContinuation: verification?.isolation?.forbidExecutorContinuation !== false,
							requireDifferentAgent: verification?.isolation?.requireDifferentAgent === true,
						},
						firstReleaseScope: "cli_code_first",
						unavailableAction: "block",
						artifactCaptureFailure: "partial_receipt_block",
						remoteRunUnknown: "observation_lost_effect_unknown",
						cancelUnconfirmed: "cancel_requested_observation_lost",
					},
					workspaceExecution: {
						readOnlyDefault: "read_only_shared",
						gitWriteDefault: enumOr(workspaceExecution?.gitWriteDefault, ["isolated_worktree", "exclusive_write"], DEFAULT_WORKSPACE_EXECUTION_SETTINGS.gitWriteDefault),
						nonGitWriteDefault: "exclusive_write",
						leaseTimeoutMs: boundedNumber(workspaceExecution?.leaseTimeoutMs, DEFAULT_WORKSPACE_EXECUTION_SETTINGS.leaseTimeoutMs, 5_000, 3_600_000),
						promotion: {
							autoApplyAfterAcceptance: true,
							autoCommit: false,
							autoPush: false,
							conflictAction: "block_preserve_changes",
						},
						managerWritePolicy: "delegation_required",
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
					verification: DEFAULT_VERIFICATION_SETTINGS,
					workspaceExecution: DEFAULT_WORKSPACE_EXECUTION_SETTINGS,
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
		verification?: VerificationSettingsPatch;
		workspaceExecution?: WorkspaceExecutionSettingsPatch;
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
				if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`goalRecovery.${key} 必须是有限整数`);
			}
			const verificationInput = input.verification ?? {};
			const verification: VerificationSettings = {
				...current.harness.verification,
				...verificationInput,
				reviewers: { ...current.harness.verification.reviewers, ...(verificationInput.reviewers ?? {}) },
				isolation: { ...current.harness.verification.isolation, ...(verificationInput.isolation ?? {}) },
			};
			if (verification.enabled !== true) throw new Error("verification.enabled 必须为 true");
			if (!["manager_review", "independent_evidence_review"].includes(verification.defaultWorkItemMode)) throw new Error("verification.defaultWorkItemMode 无效");
			if (!["manager_review", "independent_evidence_review", "environment_verified"].includes(verification.defaultFinalGoalMode)) throw new Error("verification.defaultFinalGoalMode 无效");
			if (!["manager_request", "auto_on_submission"].includes(verification.trigger)) throw new Error("verification.trigger 无效");
			if (typeof verification.reviewers.evidenceModel !== "string" || verification.reviewers.evidenceModel.length > 200) throw new Error("verification.reviewers.evidenceModel 必须是短字符串");
			verification.reviewers.evidenceModel = verification.reviewers.evidenceModel.trim();
			if (typeof verification.reviewers.cliAgentId !== "string" || verification.reviewers.cliAgentId.length > 200) throw new Error("verification.reviewers.cliAgentId 必须是短字符串");
			if (typeof verification.reviewers.requireRoomMember !== "boolean") throw new Error("verification.reviewers.requireRoomMember 必须是布尔值");
			if (!["isolated_copy", "same_target_guarded"].includes(verification.cliEnvironmentMode)) throw new Error("verification.cliEnvironmentMode 无效");
			for (const [key, value] of Object.entries(verification.isolation)) if (typeof value !== "boolean") throw new Error(`verification.isolation.${key} 必须是布尔值`);
			if (verification.isolation.requireFreshSession !== true) throw new Error("verification.isolation.requireFreshSession 必须为 true");
			if (verification.isolation.forbidExecutorContinuation !== true) throw new Error("verification.isolation.forbidExecutorContinuation 必须为 true");
			if (verification.firstReleaseScope !== "cli_code_first") throw new Error("verification.firstReleaseScope 首期必须为 cli_code_first");
			for (const [key, value] of Object.entries({ unavailableAction: verification.unavailableAction, artifactCaptureFailure: verification.artifactCaptureFailure, remoteRunUnknown: verification.remoteRunUnknown, cancelUnconfirmed: verification.cancelUnconfirmed, managerWritePolicy: input.workspaceExecution?.managerWritePolicy ?? current.harness.workspaceExecution.managerWritePolicy, conflictAction: input.workspaceExecution?.promotion?.conflictAction ?? current.harness.workspaceExecution.promotion.conflictAction })) {
				if (key === "unavailableAction" && value !== "block") throw new Error("verification.unavailableAction 必须为 block");
				if (key === "artifactCaptureFailure" && value !== "partial_receipt_block") throw new Error("verification.artifactCaptureFailure 必须为 partial_receipt_block");
				if (key === "remoteRunUnknown" && value !== "observation_lost_effect_unknown") throw new Error("verification.remoteRunUnknown 必须为 observation_lost_effect_unknown");
				if (key === "cancelUnconfirmed" && value !== "cancel_requested_observation_lost") throw new Error("verification.cancelUnconfirmed 必须为 cancel_requested_observation_lost");
				if (key === "managerWritePolicy" && value !== "delegation_required") throw new Error("workspaceExecution.managerWritePolicy 必须为 delegation_required");
				if (key === "conflictAction" && value !== "block_preserve_changes") throw new Error("workspaceExecution.promotion.conflictAction 必须为 block_preserve_changes");
			}
			const workspaceInput = input.workspaceExecution ?? {};
			const workspaceExecution: WorkspaceExecutionSettings = {
				...current.harness.workspaceExecution,
				...workspaceInput,
				promotion: { ...current.harness.workspaceExecution.promotion, ...(workspaceInput.promotion ?? {}) },
			};
			if (workspaceExecution.readOnlyDefault !== "read_only_shared") throw new Error("workspaceExecution.readOnlyDefault 必须为 read_only_shared");
			if (!["isolated_worktree", "exclusive_write"].includes(workspaceExecution.gitWriteDefault)) throw new Error("workspaceExecution.gitWriteDefault 无效");
			if (workspaceExecution.nonGitWriteDefault !== "exclusive_write") throw new Error("workspaceExecution.nonGitWriteDefault 首期必须为 exclusive_write");
			if (!Number.isInteger(workspaceExecution.leaseTimeoutMs) || workspaceExecution.leaseTimeoutMs < 5_000 || workspaceExecution.leaseTimeoutMs > 3_600_000) throw new Error("workspaceExecution.leaseTimeoutMs 超出安全范围");
			for (const [key, value] of Object.entries(workspaceExecution.promotion)) if (typeof value !== "boolean" && key !== "conflictAction") throw new Error(`workspaceExecution.promotion.${key} 必须是布尔值`);
			if (workspaceExecution.promotion.conflictAction !== "block_preserve_changes") throw new Error("workspaceExecution.promotion.conflictAction 必须为 block_preserve_changes");
			if (workspaceExecution.promotion.autoApplyAfterAcceptance !== true) throw new Error("workspaceExecution.promotion.autoApplyAfterAcceptance 必须为 true");
			if (workspaceExecution.promotion.autoCommit !== false) throw new Error("workspaceExecution.promotion.autoCommit 必须为 false");
			if (workspaceExecution.promotion.autoPush !== false) throw new Error("workspaceExecution.promotion.autoPush 必须为 false");
			if (workspaceExecution.managerWritePolicy !== "delegation_required") throw new Error("workspaceExecution.managerWritePolicy 必须为 delegation_required");
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
					verification,
					workspaceExecution,
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
