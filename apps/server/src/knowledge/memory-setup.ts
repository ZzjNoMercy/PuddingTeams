import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import type { KnowledgeAcceptanceStore } from "./acceptance.js";
import type { KnowledgeObjectStore } from "./objects.js";
import { applyAndAcceptKnowledgePlan } from "./apply-plan.js";
import { buildKnowledgePlan, KnowledgePlanError, type KnowledgePlanStore } from "./plans.js";
import type { KnowledgeProbeStore } from "./probes.js";

type SetupRecord = { status: "deferred" } | { status: "configured"; bindingId: string };
interface SetupFile { version: 1; owners: Record<string, SetupRecord> }
export type MemorySetupStatus = { status: "pending" | "deferred" } | { status: "configured"; binding: KnowledgeBinding };

/** Installation-local first-run state. The Wiki registry remains the authority for the library. */
export class MemorySetupService {
	private pending: Promise<void> = Promise.resolve();
	private readonly file: string;
	constructor(stateDir: string, private readonly deps: {
		registry: KnowledgeBindingRegistry; probes: KnowledgeProbeStore; plans: KnowledgePlanStore;
		acceptance: KnowledgeAcceptanceStore; objects: KnowledgeObjectStore;
	}) { this.file = path.join(stateDir, "memory-setup.json"); }

	private async load(): Promise<SetupFile> {
		const raw = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (raw === null) return { version: 1, owners: {} };
		const value = JSON.parse(raw) as SetupFile;
		if (value.version !== 1 || !value.owners || typeof value.owners !== "object") throw new Error("长期记忆设置无法读取");
		return value;
	}
	private async save(ownerId: string, record: SetupRecord): Promise<void> {
		const data = await this.load();
		data.owners[ownerId] = record;
		await mkdir(path.dirname(this.file), { recursive: true });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, this.file);
	}
	private serial<T>(action: () => Promise<T>): Promise<T> {
		const result = this.pending.then(action);
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}
	async status(ownerId: string): Promise<MemorySetupStatus> {
		const stored = (await this.load()).owners[ownerId];
		const bindings = await this.deps.registry.list(ownerId);
		const binding = (stored?.status === "configured" ? bindings.find((item) => item.id === stored.bindingId) : undefined)
			?? bindings.find((item) => item.schemaRef?.id === "memory" || item.schemaRef?.originPresetId === "memory");
		// A manually created Memory Wiki also fulfils onboarding. Offline libraries aren't recreated.
		if (binding) return { status: "configured", binding };
		return { status: stored?.status === "deferred" ? "deferred" : "pending" };
	}
	defer(ownerId: string): Promise<MemorySetupStatus> {
		return this.serial(async () => {
			const status = await this.status(ownerId);
			if (status.status === "configured") return status;
			await this.save(ownerId, { status: "deferred" });
			return { status: "deferred" };
		});
	}
	private async requireEmpty(root: string): Promise<void> {
		const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		if (entries.length) throw new KnowledgePlanError("invalid_input", "请选择空文件夹或新的文件夹路径；已有 Wiki 请从知识库页面接入。");
	}
	async plan(ownerId: string, root: string) {
		const probe = await this.deps.probes.create(ownerId, root, { intent: "create" });
		await this.requireEmpty(probe.canonicalBindingRoot);
		const plan = await buildKnowledgePlan(ownerId, probe, {
			name: "长期记忆", description: "记录可复用的事实、偏好、长期上下文、决策、关键经历与方法；修改交给 Wiki 管理员并经审核发布。",
			mode: "create", schemaPresetId: "memory",
		}, await this.deps.registry.findOverlap(probe.canonicalBindingRoot));
		return this.deps.plans.save(plan);
	}
	apply(ownerId: string, planId: string): Promise<MemorySetupStatus> {
		return this.serial(async () => {
			const plan = await this.deps.plans.get(ownerId, planId);
			if (plan.mode !== "create" || plan.schemaPresetId !== "memory" || plan.filesToSkip.length) {
				throw new KnowledgePlanError("invalid_input", "请重新生成长期记忆初始化计划");
			}
			const current = await this.status(ownerId);
			// Handles response loss, app restart, and two client windows confirming concurrently.
			if (current.status === "configured") return current;
			await this.requireEmpty(plan.canonicalBindingRoot);
			const { binding } = await applyAndAcceptKnowledgePlan(plan, this.deps.registry, this.deps);
			await this.save(ownerId, { status: "configured", bindingId: binding.id });
			return { status: "configured", binding };
		});
	}
}
