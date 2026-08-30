import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionReceipt, ExecutionState } from "./execution-receipt.js";
import type { DriverTransport, DriverWorkspaceCapabilities, InteractionRequest, NormalizedResult } from "./types.js";
import type { WorkspaceExecutionPolicy } from "./workspace-execution.js";

export interface DelegationRecord {
	id: string;
	/** Stable Runtime operation identity, also propagated as upstream idempotency key. */
	operationId?: string;
	contractHash?: string;
	windowId: string;
	/** 缺省表示该 Run 使用平台默认 cwd，而非显式项目。 */
	workspaceId?: string;
	/** Run/continue/respond/artifact 永远使用的不可变项目 cwd。 */
	cwdSnapshot: string;
	managerSessionId: string;
	managerToolCallId?: string;
	purpose: "execution" | "verification";
	verificationId?: string;
	verifiesSubmissionId?: string;
	environmentProfileId?: string;
	verificationEnvironmentId?: string;
	goalId?: string;
	workPlanId?: string;
	workItemId?: string;
	attempt?: number;
	/** Goal execution epoch captured when this immutable Run is created. */
	goalEpoch?: number;
	goalRevision?: number;
	workItemRevision?: number;
	/** Optional causal edge to an earlier delegation in the same manager Session. */
	parentDelegationId?: string;
	handoffKind?: "request" | "followup";
	/** Worker-facing task text, kept so the process index can name each run. */
	task?: string;
	/** Why this delegation exists, separate from the worker-facing task text. */
	intent?: string;
	expectedOutcome?: string;
	evidenceRequirements?: string[];
	completionBoundary?: string;
	agentId: string;
	/** Agent/Connector configuration generation captured when the Run starts. */
	agentRevision: number;
	driverId?: string;
	driverTransport?: DriverTransport;
	/** Driver capability snapshot used for the admission decision. */
	workspaceCapabilities?: DriverWorkspaceCapabilities;
	capabilityFingerprint?: string;
	readOnlyAssessment?: "verified" | "unverified_user_accepted" | "not_required";
	admissionInteractionId?: string;
	/**
	 * Durable proof that every replacement-specific lifecycle guard (including
	 * the WorkState reservation when present) committed before Driver start.
	 */
	replacementAdmissionReady?: boolean;
	workerStarted: boolean;
	/** Persisted business options required to start a pre-admission Delegation later. */
	options?: Record<string, unknown>;
	operation: "run" | "continue";
	sessionHandle?: string;
	runHandle?: string;
	executionState: ExecutionState;
	/** Durable boundary journal: written before cross-store evidence collection so restart seals the same result without rerunning the Worker. */
	pendingTerminal?: {
		executionState: "reported_completed" | "reported_failed" | "cancelled";
		result: Exclude<NormalizedResult, { status: "needs_input" }>;
		startedAt: string;
	};
	receipt?: ExecutionReceipt;
	workspaceExecutionPolicy?: WorkspaceExecutionPolicy;
	workspaceExecutionScopeId?: string;
	workspaceChangeSetId?: string;
	/** Actual cwd bound to the Driver; target cwdSnapshot remains immutable. */
	executionCwd?: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	result?: NormalizedResult;
}

export interface InteractionRecord {
	id: string;
	delegationId: string;
	source: "worker" | "platform_policy";
	kind: "permission" | "question" | "confirmation";
	requests: InteractionRequest[];
	status: "pending" | "responding" | "approved" | "rejected" | "expired" | "failed";
	revision: number;
	/** 指向加密存储（InteractionSecretStore）中的 provider state；仅 worker source 存在。 */
	providerStateRef?: string;
	policyContext?: {
		reasonCode: "read_only_not_enforceable" | "cwd_not_honored";
		capabilityFingerprint: string;
		allowedActions: Array<"cancel" | "proceed_with_worker" | "select_another_worker">;
		workerStarted: false;
	};
	decision?: {
		chosenAction: "cancel" | "proceed_with_worker" | "select_another_worker";
		replacementAgentId?: string;
		actorId: string;
		decidedAt: string;
		requestId: string;
	};
	application?: {
		operationId: string;
		status: "pending" | "applying" | "applied" | "failed";
		readOnlyAssessment?: "verified" | "unverified_user_accepted" | "not_required";
		failureCode?: string;
		replacementAgentId?: string;
		replacementDelegationId?: string;
		updatedAt: string;
	};
	/** 幂等键：已经消费的响应 request_id（重放时直接返回终态）。 */
	consumedRequestId?: string;
	/** Payload hash paired with consumedRequestId; same key + different answers is a conflict. */
	consumedPayloadHash?: string;
	expiresAt?: string;
	createdAt: string;
	updatedAt: string;
}

interface DelegationsFile {
	version: 2;
	delegations: Record<string, DelegationRecord>;
}

interface InteractionsFile {
	version: 2;
	interactions: Record<string, InteractionRecord>;
}

/**
 * DelegationStore 持久化 delegation / pending interaction 的公开记录。
 * 不保存任何 token：continuation token 等 provider state 单独走
 * InteractionSecretStore（AES-256 加密，0600）。参考方案 §7.2。
 */
export class DelegationStore {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly delegationsFile: string;
	private readonly interactionsFile: string;

	constructor(private readonly stateDir: string) {
		this.delegationsFile = path.join(stateDir, "delegations.json");
		this.interactionsFile = path.join(stateDir, "interactions.json");
	}

	async init(): Promise<void> {
		await mkdir(this.stateDir, { recursive: true });
	}

	/** Run `fn` after all previously queued mutations (in-process mutex). */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async readFile(file: string): Promise<Record<string, unknown>> {
		try {
			const raw = await readFile(file, "utf-8");
			const parsed = JSON.parse(raw) as { [k: string]: unknown };
			if (parsed.version !== 2) {
				throw new Error(`${path.basename(file)} 必须使用 v2；项目未上线，不读取其它结构，请移走不匹配文件后重启`);
			}
			return parsed ?? {};
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return {};
		}
	}

	private async writeFile(file: string, data: unknown): Promise<void> {
		await mkdir(this.stateDir, { recursive: true });
		const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, file);
	}

	private async loadDelegations(): Promise<Record<string, DelegationRecord>> {
		const raw = await this.readFile(this.delegationsFile);
		const records = (raw.delegations ?? {}) as Record<string, DelegationRecord>;
		return Object.fromEntries(Object.entries(records).map(([id, record]) => [id, {
			...record,
			// v2 gained this additive boundary flag; records written before the
			// boundary existed are necessarily pre-observation and therefore false.
			workerStarted: record.workerStarted === true,
		}])) as Record<string, DelegationRecord>;
	}

	private async loadInteractions(): Promise<Record<string, InteractionRecord>> {
		const raw = await this.readFile(this.interactionsFile);
		const records = (raw.interactions ?? {}) as Record<string, InteractionRecord>;
		return Object.fromEntries(Object.entries(records).map(([id, record]) => [id, {
			...record,
			// Existing v2 interactions predate Teams platform-policy admission and
			// are therefore Worker-originated.
			source: record.source ?? "worker",
		}])) as Record<string, InteractionRecord>;
	}

	// ---- delegations ----

	async createDelegation(
		input: Omit<DelegationRecord, "id" | "purpose" | "executionState" | "workerStarted" | "revision" | "createdAt" | "updatedAt">
			& { purpose?: DelegationRecord["purpose"] },
	): Promise<DelegationRecord> {
		const now = new Date().toISOString();
		const record: DelegationRecord = {
			...input,
			purpose: input.purpose ?? "execution",
			id: randomUUID(),
			executionState: "admitted",
			workerStarted: false,
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		await this.serialize(async () => {
			const all = await this.loadDelegations();
			if (record.operationId && Object.values(all).some((item) => item.operationId === record.operationId)) {
				throw new Error(`Delegation operationId 已存在：${record.operationId}`);
			}
			all[record.id] = record;
			await this.writeFile(this.delegationsFile, { version: 2, delegations: all } satisfies DelegationsFile);
		});
		return record;
	}

	async getDelegation(id: string): Promise<DelegationRecord | undefined> {
		return (await this.loadDelegations())[id];
	}

	async updateDelegation(id: string, patch: Partial<Omit<DelegationRecord, "id" | "createdAt">>): Promise<DelegationRecord | undefined> {
		let updated: DelegationRecord | undefined;
		await this.serialize(async () => {
			const all = await this.loadDelegations();
			const rec = all[id];
			if (!rec) return;
			this.assertReceiptImmutable(rec, patch);
			if (patch.executionState && ["reported_completed", "reported_failed", "cancelled"].includes(patch.executionState) && !patch.receipt && !rec.receipt) {
				throw new Error(`Delegation ${id} 的终态 ${patch.executionState} 必须与 ExecutionReceipt 原子封存`);
			}
			const next: DelegationRecord = {
				...rec,
				...patch,
				id: rec.id,
				createdAt: rec.createdAt,
				revision: patch.revision ?? rec.revision,
				updatedAt: new Date().toISOString(),
			};
			all[id] = next;
			updated = next;
			await this.writeFile(this.delegationsFile, { version: 2, delegations: all } satisfies DelegationsFile);
		});
		return updated;
	}

	private assertReceiptImmutable(
		record: DelegationRecord,
		patch: Partial<Omit<DelegationRecord, "id" | "createdAt">>,
	): void {
		if (!record.receipt) return;
		const immutableKeys: Array<keyof DelegationRecord> = [
			"operationId", "contractHash", "goalId", "workPlanId", "workItemId", "attempt", "goalEpoch",
			"goalRevision", "workItemRevision", "task", "intent", "expectedOutcome",
			"evidenceRequirements", "completionBoundary", "agentId", "agentRevision", "driverId",
			"driverTransport", "operation", "sessionHandle", "runHandle", "executionState", "result",
			"receipt", "workspaceExecutionScopeId", "workspaceChangeSetId", "purpose",
			"workspaceExecutionPolicy", "executionCwd",
			"workspaceCapabilities", "capabilityFingerprint", "readOnlyAssessment", "admissionInteractionId", "workerStarted", "options",
			"replacementAdmissionReady",
			"verificationId", "verifiesSubmissionId", "environmentProfileId", "verificationEnvironmentId",
		];
		for (const key of immutableKeys) {
			if (!(key in patch)) continue;
			const patchRecord = patch as Partial<DelegationRecord>;
			if (JSON.stringify(patchRecord[key]) !== JSON.stringify(record[key])) {
				throw new Error(`Delegation ${record.id} 的 ExecutionReceipt 已封存，禁止修改 ${String(key)}`);
			}
		}
	}

	/** Atomic execution-state compare-and-set used by Runtime lifecycle transitions. */
	async transitionDelegation(
		id: string,
		allowed: readonly ExecutionState[],
		patch: Partial<Omit<DelegationRecord, "id" | "createdAt" | "executionState">> & { executionState: ExecutionState },
	): Promise<{ applied: boolean; record?: DelegationRecord }> {
		let result: { applied: boolean; record?: DelegationRecord } = { applied: false };
		await this.serialize(async () => {
			const all = await this.loadDelegations();
			const rec = all[id];
			if (!rec) return;
			if (!allowed.includes(rec.executionState)) {
				result = { applied: false, record: rec };
				return;
			}
			this.assertReceiptImmutable(rec, patch);
			if (["reported_completed", "reported_failed", "cancelled"].includes(patch.executionState) && !patch.receipt && !rec.receipt) {
				throw new Error(`Delegation ${id} 的终态 ${patch.executionState} 必须与 ExecutionReceipt 原子封存`);
			}
			const next: DelegationRecord = {
				...rec,
				...patch,
				id: rec.id,
				createdAt: rec.createdAt,
				revision: patch.revision ?? rec.revision,
				updatedAt: new Date().toISOString(),
			};
			all[id] = next;
			await this.writeFile(this.delegationsFile, { version: 2, delegations: all } satisfies DelegationsFile);
			result = { applied: true, record: next };
		});
		return result;
	}

	async listDelegations(windowId?: string, managerSessionId?: string): Promise<DelegationRecord[]> {
		const all = await this.loadDelegations();
		return Object.values(all)
			.filter((d) => (!windowId || d.windowId === windowId) && (!managerSessionId || d.managerSessionId === managerSessionId))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	// ---- interactions ----

	async createInteraction(
		input: Omit<InteractionRecord, "id" | "source" | "status" | "revision" | "createdAt" | "updatedAt"> & { source?: InteractionRecord["source"] },
	): Promise<InteractionRecord> {
		const now = new Date().toISOString();
		const record: InteractionRecord = {
			...input,
			source: input.source ?? "worker",
			id: randomUUID(),
			status: "pending",
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		await this.serialize(async () => {
			const all = await this.loadInteractions();
			all[record.id] = record;
			await this.writeFile(this.interactionsFile, { version: 2, interactions: all } satisfies InteractionsFile);
		});
		return record;
	}

	async getInteraction(id: string): Promise<InteractionRecord | undefined> {
		return (await this.loadInteractions())[id];
	}

	async updateInteraction(id: string, patch: Partial<Omit<InteractionRecord, "id" | "createdAt">>): Promise<InteractionRecord | undefined> {
		let updated: InteractionRecord | undefined;
		await this.serialize(async () => {
			const all = await this.loadInteractions();
			const rec = all[id];
			if (!rec) return;
			const next: InteractionRecord = {
				...rec,
				...patch,
				id: rec.id,
				createdAt: rec.createdAt,
				revision: patch.revision ?? rec.revision,
				updatedAt: new Date().toISOString(),
			};
			all[id] = next;
			updated = next;
			await this.writeFile(this.interactionsFile, { version: 2, interactions: all } satisfies InteractionsFile);
		});
		return updated;
	}

	/** Atomic status/revision compare-and-set for consuming one human decision. */
	async transitionInteraction(
		id: string,
		expectedRevision: number,
		allowedStatuses: readonly InteractionRecord["status"][],
		patch: Partial<Omit<InteractionRecord, "id" | "createdAt">>,
	): Promise<{ applied: boolean; record?: InteractionRecord }> {
		let result: { applied: boolean; record?: InteractionRecord } = { applied: false };
		await this.serialize(async () => {
			const all = await this.loadInteractions();
			const rec = all[id];
			if (!rec) return;
			if (rec.revision !== expectedRevision || !allowedStatuses.includes(rec.status)) {
				result = { applied: false, record: rec };
				return;
			}
			const next: InteractionRecord = {
				...rec,
				...patch,
				id: rec.id,
				createdAt: rec.createdAt,
				revision: patch.revision ?? rec.revision,
				updatedAt: new Date().toISOString(),
			};
			all[id] = next;
			await this.writeFile(this.interactionsFile, { version: 2, interactions: all } satisfies InteractionsFile);
			result = { applied: true, record: next };
		});
		return result;
	}

	/** Atomic application-state CAS. A terminal application can never be
	 * rewritten by a later best-effort projection or recovery pass. */
	async transitionInteractionApplication(
		id: string,
		allowedStatuses: readonly NonNullable<InteractionRecord["application"]>["status"][],
		patch: Partial<NonNullable<InteractionRecord["application"]>>,
	): Promise<{ applied: boolean; record?: InteractionRecord }> {
		let result: { applied: boolean; record?: InteractionRecord } = { applied: false };
		await this.serialize(async () => {
			const all = await this.loadInteractions();
			const rec = all[id];
			if (!rec?.application || !allowedStatuses.includes(rec.application.status)) {
				result = { applied: false, record: rec };
				return;
			}
			const next: InteractionRecord = {
				...rec,
				application: { ...rec.application, ...patch, updatedAt: new Date().toISOString() },
				updatedAt: new Date().toISOString(),
			};
			all[id] = next;
			await this.writeFile(this.interactionsFile, { version: 2, interactions: all } satisfies InteractionsFile);
			result = { applied: true, record: next };
		});
		return result;
	}

	async listInteractions(windowId?: string): Promise<InteractionRecord[]> {
		const all = await this.loadInteractions();
		const delegations = windowId ? await this.loadDelegations() : undefined;
		const records = Object.values(all);
		if (!delegations) return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return records
			.filter((i) => delegations[i.delegationId]?.windowId === windowId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
}
