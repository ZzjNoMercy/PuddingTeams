import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InteractionRequest, NormalizedResult } from "./types.js";

export interface DelegationRecord {
	id: string;
	windowId: string;
	managerSessionId: string;
	managerToolCallId?: string;
	agentId: string;
	operation: "run" | "continue";
	sessionHandle?: string;
	runHandle?: string;
	status: "running" | "waiting_input" | "completed" | "failed" | "cancelled";
	revision: number;
	createdAt: string;
	updatedAt: string;
	result?: NormalizedResult;
}

export interface InteractionRecord {
	id: string;
	delegationId: string;
	kind: "permission" | "question" | "confirmation";
	requests: InteractionRequest[];
	status: "pending" | "responding" | "approved" | "rejected" | "expired" | "failed";
	revision: number;
	/** 指向加密存储（InteractionSecretStore）中的 provider state。 */
	providerStateRef: string;
	/** 幂等键：已经消费的响应 request_id（重放时直接返回终态）。 */
	consumedRequestId?: string;
	expiresAt?: string;
	createdAt: string;
	updatedAt: string;
}

interface DelegationsFile {
	version: number;
	delegations: Record<string, DelegationRecord>;
}

interface InteractionsFile {
	version: number;
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

	constructor(private readonly teamsDir: string) {
		this.delegationsFile = path.join(teamsDir, "delegations.json");
		this.interactionsFile = path.join(teamsDir, "interactions.json");
	}

	async init(): Promise<void> {
		await mkdir(this.teamsDir, { recursive: true });
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

	private async readFile(file: string, version = 1): Promise<Record<string, unknown>> {
		try {
			const raw = await readFile(file, "utf-8");
			const parsed = JSON.parse(raw) as { [k: string]: unknown };
			return parsed ?? {};
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return {};
		}
	}

	private async writeFile(file: string, data: unknown): Promise<void> {
		await mkdir(this.teamsDir, { recursive: true });
		const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, file);
	}

	private async loadDelegations(): Promise<Record<string, DelegationRecord>> {
		const raw = await this.readFile(this.delegationsFile);
		return (raw.delegations ?? {}) as Record<string, DelegationRecord>;
	}

	private async loadInteractions(): Promise<Record<string, InteractionRecord>> {
		const raw = await this.readFile(this.interactionsFile);
		return (raw.interactions ?? {}) as Record<string, InteractionRecord>;
	}

	// ---- delegations ----

	async createDelegation(input: Omit<DelegationRecord, "id" | "status" | "revision" | "createdAt" | "updatedAt">): Promise<DelegationRecord> {
		const now = new Date().toISOString();
		const record: DelegationRecord = {
			...input,
			id: randomUUID(),
			status: "running",
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		await this.serialize(async () => {
			const all = await this.loadDelegations();
			all[record.id] = record;
			await this.writeFile(this.delegationsFile, { version: 1, delegations: all });
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
			await this.writeFile(this.delegationsFile, { version: 1, delegations: all });
		});
		return updated;
	}

	async listDelegations(windowId?: string, managerSessionId?: string): Promise<DelegationRecord[]> {
		const all = await this.loadDelegations();
		return Object.values(all)
			.filter((d) => (!windowId || d.windowId === windowId) && (!managerSessionId || d.managerSessionId === managerSessionId))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	// ---- interactions ----

	async createInteraction(input: Omit<InteractionRecord, "id" | "status" | "revision" | "createdAt" | "updatedAt">): Promise<InteractionRecord> {
		const now = new Date().toISOString();
		const record: InteractionRecord = {
			...input,
			id: randomUUID(),
			status: "pending",
			revision: 0,
			createdAt: now,
			updatedAt: now,
		};
		await this.serialize(async () => {
			const all = await this.loadInteractions();
			all[record.id] = record;
			await this.writeFile(this.interactionsFile, { version: 1, interactions: all });
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
			await this.writeFile(this.interactionsFile, { version: 1, interactions: all });
		});
		return updated;
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
