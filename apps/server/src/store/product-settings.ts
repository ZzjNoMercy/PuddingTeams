import { createHash, randomUUID } from "node:crypto";
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
	logging: LoggingSettings;
	harness: {
		codeSearch: { defaultProvider: HarnessCodeSearchProvider };
		workerResults: WorkerResultContextSettings;
		goalActivation: { solo: "user_explicit" | "disabled"; group: "user_explicit" | "disabled"; direct: "user_explicit" | "disabled" };
		goalRecovery: { mode: "safe_auto" | "manual"; directMode: "manual"; resumeLeaseMs: number; operationRetentionDays: number; maxOperationsPerSession: number };
		/** Global defaults for independent verification. These are frozen into a WorkItem at creation time. */
		verification: VerificationSettings;
		/** Global defaults for workspace ownership and the fail-closed settlement policies. */
		workspaceExecution: WorkspaceExecutionSettings;
	};
}

/** 平台日志级别。`silent` 只由开关产生，不作为用户可选级别。 */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type SelectableLogLevel = Exclude<LogLevel, "silent">;

export interface LoggingSettings {
	/** 总开关：关闭等价于 silent，后端不再写任何一行日志。 */
	enabled: boolean;
	/** 记录详细程度；`level` 与 `trace` 刻意不提供，避免正常使用下淹没有效信息。 */
	level: SelectableLogLevel;
}

export const LOG_LEVELS: readonly SelectableLogLevel[] = ["error", "warn", "info", "debug"];

/**
 * 默认 `info`：平台自身的启动/生命周期/降级告警都在这一档，默认 `warn` 会让
 * 「出了问题却什么都没有」成为常态（2026-10-15 停止超时事故的教训）。
 */
export const DEFAULT_LOGGING_SETTINGS: LoggingSettings = { enabled: true, level: "info" };

export function effectiveLogLevel(settings: LoggingSettings): LogLevel {
	return settings.enabled ? settings.level : "silent";
}

export function normalizeLoggingSettings(input: unknown): LoggingSettings {
	const value = (input ?? {}) as Partial<LoggingSettings>;
	const level = LOG_LEVELS.includes(value.level as SelectableLogLevel) ? value.level as SelectableLogLevel : DEFAULT_LOGGING_SETTINGS.level;
	return { enabled: value.enabled !== false, level };
}

export interface VerificationSettings {	enabled: boolean;
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

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)]));
	}
	return value;
}

export function harnessSettingsRevision(harness: ProductSettings["harness"]): string {
	return createHash("sha256").update(JSON.stringify(canonicalValue(harness))).digest("hex");
}

export class HarnessSettingsConflictError extends Error {
	constructor(readonly currentRevision: string) {
		super("Harness 设置已变化，请读取最新配置后核对草稿");
		this.name = "HarnessSettingsConflictError";
	}
}

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
				logging: normalizeLoggingSettings(parsed.logging),
				harness: {
					codeSearch: {
						defaultProvider: parsed.harness?.codeSearch?.defaultProvider === "fff" ? "fff" : "builtin",
					},
					workerResults: validateWorkerResultContext(parsed.harness?.workerResults ?? {}),
					goalActivation: {
						// 历史 manager_explicit / confirmWhenAmbiguous 值不再存在，解析时直接回退默认（未上线，不做迁移）。
						solo: enumOr(parsed.harness?.goalActivation?.solo, ["user_explicit", "disabled"], "user_explicit"),
						group: enumOr(parsed.harness?.goalActivation?.group, ["user_explicit", "disabled"], "user_explicit"),
						direct: enumOr(parsed.harness?.goalActivation?.direct, ["user_explicit", "disabled"], "user_explicit"),
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
				logging: DEFAULT_LOGGING_SETTINGS,
					harness: {
					codeSearch: { defaultProvider: "builtin" },
					workerResults: DEFAULT_WORKER_RESULT_CONTEXT,
					goalActivation: { solo: "user_explicit", group: "user_explicit", direct: "user_explicit" },
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

	/** 日志开关与级别：改动立即生效，不参与 Harness 的 revision/冲突协议。 */
	async setLogging(input: { enabled?: boolean; level?: string }): Promise<ProductSettings> {
		if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("logging.enabled 必须是布尔值");
		if (input.level !== undefined && !LOG_LEVELS.includes(input.level as SelectableLogLevel)) {
			throw new Error(`logging.level 必须是 ${LOG_LEVELS.join(" | ")}`);
		}
		const run = this.queue.then(async () => {
			const current = await this.get();
			const settings: ProductSettings = {
				...current,
				logging: {
					enabled: input.enabled ?? current.logging.enabled,
					level: (input.level as SelectableLogLevel | undefined) ?? current.logging.level,
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
	}, expectedRevision?: string): Promise<ProductSettings> {
		const run = this.queue.then(async () => {
			const current = await this.get();
			const currentRevision = harnessSettingsRevision(current.harness);
			if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw new HarnessSettingsConflictError(currentRevision);
			const codeSearch = { ...current.harness.codeSearch, ...(input.codeSearch ?? {}) };
			if (!["builtin", "fff"].includes(codeSearch.defaultProvider)) throw new Error("codeSearch.defaultProvider 无效");
			const activation = { ...current.harness.goalActivation, ...(input.goalActivation ?? {}) };
			if (!["user_explicit", "disabled"].includes(activation.solo)) throw new Error("goalActivation.solo 无效");
			if (!["user_explicit", "disabled"].includes(activation.group)) throw new Error("goalActivation.group 无效");
			if (!["user_explicit", "disabled"].includes(activation.direct)) throw new Error("goalActivation.direct 无效");
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
			return this.get();
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}
}

/**
 * 启动期读取日志设置：只读一个文件、失败即默认值。
 * 必须在 `Fastify({ logger })` 之前调用，否则首屏启动日志会按引导级别输出。
 */
export async function readLoggingSettings(configDir: string): Promise<LoggingSettings> {
	try {
		const parsed = JSON.parse(await readFile(path.join(configDir, "product.json"), "utf-8")) as { logging?: unknown };
		return normalizeLoggingSettings(parsed.logging);
	} catch {
		return DEFAULT_LOGGING_SETTINGS;
	}
}
