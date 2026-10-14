import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requiresReadOnlyEnforcement, type WorkspaceExecutionCoordinator, type WorkspaceExecutionScope, type WorkspaceChangeSet } from "../agent-runtime/workspace-execution.js";
import { workItemContractHash, type WorkStateStore } from "../store/work-state.js";
import type { TeamsStore } from "../store/teams.js";

export interface NativeExecution {
	id: string;
	sessionId: string;
	turnId: string;
	toolCallId: string;
	toolName: string;
	goalId?: string;
	goalEpoch?: number;
	goalRevision?: number;
	workPlanId?: string;
	workItemId?: string;
	workItemRevision?: number;
	attempt?: number;
	contractHash?: string;
	workspaceId?: string;
	scopeId?: string;
	inputRef: string;
	outputRef?: string;
	outputPreview?: string;
	status: "started" | "completed" | "failed" | "unknown";
	integrity: "clean" | "violation" | "unknown";
	changeSet?: WorkspaceChangeSet;
	startedAt: string;
	sealedAt?: string;
	issue?: string;
}

const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function canonicalToolPath(cwd: string, requested: string): Promise<string> {
	let candidate = path.resolve(cwd, requested);
	const missing: string[] = [];
	for (;;) {
		try { return path.join(await realpath(candidate), ...missing.reverse()); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(candidate);
			if (parent === candidate) throw error;
			missing.push(path.basename(candidate)); candidate = parent;
		}
	}
}

/** Host evidence, separate from model claims. One write lease per tool, never
 * across delegation waits. Isolated WorkItems retain their private checkout. */
export class NativeToolExecution {
	private ledgerQueue: Promise<unknown> = Promise.resolve();
	private readonly workspaceQueues = new Map<string, Promise<unknown>>();
	private readonly file: string;
	constructor(
		stateDir: string,
		private readonly coordinator: WorkspaceExecutionCoordinator,
		private readonly teams: TeamsStore,
		private readonly workStates?: WorkStateStore,
	) { this.file = path.join(stateDir, "native-executions.json"); }

	private async load(): Promise<NativeExecution[]> {
		try {
			const data = JSON.parse(await readFile(this.file, "utf8"));
			if (data.version !== 1 || !Array.isArray(data.executions)) throw new Error("Invalid native execution ledger");
			return data.executions;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
	private save(records: NativeExecution[]): Promise<void> {
		const run = this.ledgerQueue.then(async () => {
			const current = new Map((await this.load()).map((entry) => [entry.id, entry]));
			for (const record of records) current.set(record.id, structuredClone(record));
			const temporary = `${this.file}.${randomUUID()}.tmp`;
			await writeFile(temporary, JSON.stringify({ version: 1, executions: [...current.values()] }, null, 2) + "\n");
			await rename(temporary, this.file);
		});
		this.ledgerQueue = run.catch(() => undefined);
		return run;
	}

	async init(): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const records = await this.load();
		for (const scope of await this.coordinator.listScopes()) {
			if (scope.state === "active" && scope.ownerRefs.some((owner) => owner.kind === "native_session") && !records.some((record) => record.scopeId === scope.id)) await this.coordinator.fence(scope.id, scope.ownerToken);
		}
		// An interrupted process cannot certify that a shell stopped. Fence before
		// accepting new input; recovery never replays the native side effect.
		for (const record of records.filter((entry) => entry.status === "started")) {
			if (record.scopeId) {
				const scope = await this.coordinator.get(record.scopeId);
				if (scope && scope.state !== "released") await this.coordinator.fence(scope.id, scope.ownerToken);
			}
			record.status = "unknown"; record.integrity = "unknown";
			record.issue = "Process interrupted; effects require reconciliation";
			record.sealedAt = new Date().toISOString();
		}
		await this.save(records);
		this.workStates?.setNativeExecutionReader((sessionId, goalId, itemId) => this.forWorkItem(sessionId, goalId, itemId));
	}
	async forWorkItem(sessionId: string, goalId: string, itemId: string): Promise<NativeExecution[]> {
		return (await this.load()).filter((entry) => entry.sessionId === sessionId && entry.goalId === goalId && entry.workItemId === itemId);
	}
	async assertDelegationReady(sessionId: string): Promise<void> {
		if ((await this.load()).some((entry) => entry.sessionId === sessionId && (entry.status === "started" || entry.status === "unknown"))) {
			throw new Error("Manager 原生工具尚未封存或效果未知，不能委派 Worker；请先对账 NativeExecution");
		}
	}

	wrap<P extends TSchema, D>(factory: (cwd: string) => ToolDefinition<P, D>, fallbackCwd: string, identity: () => { sessionId: string; turnId: string }): ToolDefinition<P, D> {
		const definition = factory(fallbackCwd);
		return { ...definition, ...(["bash", "edit", "write"].includes(definition.name) ? { executionMode: "sequential" as const } : {}),
			execute: async (...args: Parameters<ToolDefinition<P, D>["execute"]>) => {
				const key = await realpath(fallbackCwd);
				const owner = identity();
				const run = (this.workspaceQueues.get(key) ?? Promise.resolve()).then(() => this.execute(factory, key, owner, args));
				const tail = run.catch(() => undefined);
				this.workspaceQueues.set(key, tail);
				try { return await run; } finally { if (this.workspaceQueues.get(key) === tail) this.workspaceQueues.delete(key); }
			} };
	}

	private async execute<P extends TSchema, D>(factory: (cwd: string) => ToolDefinition<P, D>, cwd: string, identity: { sessionId: string; turnId: string }, args: Parameters<ToolDefinition<P, D>["execute"]>): Promise<Awaited<ReturnType<ToolDefinition<P, D>["execute"]>>> {
		const [toolCallId, params, signal] = args;
		cwd = await realpath(cwd);
		if (signal?.aborted) throw new Error("Native tool cancelled before execution");
		const context = await this.teams.contextForSession(identity.sessionId);
		if (!context?.active || context.cwdSnapshot !== cwd) throw new Error("Manager Session Workspace 已变化或未激活");
		const state = await this.workStates?.getActive(identity.sessionId);
		if (state && (state.execution.status === "waiting_human" || state.execution.status === "interrupted" || state.execution.status === "recovering")) throw new Error("Goal 等待人类决策或恢复，不能执行原生工具");
		const items = Object.values(state?.plan?.items ?? {}).filter((item) => item.assignedAgentId === state?.responsibleAgentId && item.status === "in_progress");
		if (items.length > 1) throw new Error("同时有多个 Manager WorkItem 执行中，无法确定工具归属");
		const item = items[0];
		const toolName = factory(cwd).name;
		const mutating = ["bash", "write", "edit"].includes(toolName);
		const requestedPath = (params as Record<string, unknown>).path;
		const canonicalPath = typeof requestedPath === "string" ? await canonicalToolPath(cwd, requestedPath) : undefined;
		if (item && typeof requestedPath === "string" && ["edit", "write"].includes(toolName)) {
			const relative = path.relative(cwd, canonicalPath!);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("WorkItem 文件写入必须遵守当前 Workspace 执行策略");
		}
		if (state && mutating && !item) throw new Error("先将 Manager WorkItem 置为 in_progress，再执行写工具");
		if (item && mutating && requiresReadOnlyEnforcement(item.workspaceExecutionPolicy)) throw new Error("WorkItem 要求强制只读，不能使用 bash/edit/write");
		const records = await this.load();
		if (mutating && records.some((entry) => entry.sessionId === identity.sessionId && entry.status === "unknown")) throw new Error("NativeExecution 效果未知，先对账后再执行写工具");
		if (records.some((entry) => entry.sessionId === identity.sessionId && entry.toolCallId === toolCallId)) throw new Error("Native tool call 已有执行事实，不能自动重放");
		const record: NativeExecution = {
			id: `native:${randomUUID()}`, ...identity, toolCallId, toolName,
			workspaceId: context.workspaceId, inputRef: hash(params), status: "started", integrity: "unknown", startedAt: new Date().toISOString(),
			...(item && state?.plan ? { goalId: state.goalId, goalEpoch: state.execution.epoch, goalRevision: state.goalRevision,
				workPlanId: state.plan.id, workItemId: item.id, workItemRevision: item.revision, attempt: item.submissions.length + 1,
				contractHash: workItemContractHash(state, state.plan, item) } : {}),
		};
		records.push(record);
		await this.save([record]);
		let scope: WorkspaceExecutionScope | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		let renewalError: unknown;
		let renewing: Promise<unknown> = Promise.resolve();
		let result: Awaited<ReturnType<ToolDefinition<P, D>["execute"]>> | undefined;
		let failure: unknown;
		try {
			const isolated = item?.workspaceExecutionPolicy.mode === "isolated_worktree";
			const previous = isolated ? [...records].reverse().find((entry) => entry !== record && entry.workItemId === item.id
				&& entry.sessionId === identity.sessionId && entry.goalId === state?.goalId && entry.goalEpoch === state?.execution.epoch
				&& entry.workItemRevision === item.revision && entry.attempt === record.attempt && entry.scopeId && entry.integrity === "clean") : undefined;
			const inherited = previous?.scopeId ? await this.coordinator.get(previous.scopeId) : undefined;
			if (inherited && inherited.state !== "active") throw new Error(`Manager scope ${inherited.id} is ${inherited.state}`);
			scope = await this.coordinator.begin({
				workspacePath: cwd, workspaceId: context.workspaceId,
				mode: isolated ? "isolated_worktree" : "exclusive_write",
				owner: { kind: "native_session", ...identity, ...(item ? { workItemId: item.id } : {}) },
				goalId: record.goalId, goalEpoch: record.goalEpoch,
				executionScopeId: inherited?.id, ownerToken: inherited?.ownerToken,
			});
			record.scopeId = scope.id;
			await this.save([record]);
			if (state) {
				const current = await this.workStates!.getActive(identity.sessionId);
				if (!current || current.goalId !== state.goalId || current.execution.epoch !== state.execution.epoch || current.goalRevision !== state.goalRevision || ["waiting_human", "interrupted", "recovering"].includes(current.execution.status) || item && (current.plan?.items[item.id]?.revision !== item.revision || current.plan?.items[item.id]?.status !== "in_progress")) throw new Error("Native execution Goal epoch/contract 已变化");
			}
			const boundScope = scope;
			if (scope.lease) timer = setInterval(() => {
				renewing = renewing.then(() => this.coordinator.renewLease(boundScope.id, boundScope.ownerToken!)).catch((error) => { renewalError = error; });
			}, 1_000);
			await this.coordinator.assertLeaseActive(scope.id, scope.ownerToken!);
			const before = !mutating ? await this.coordinator.observeChanges(scope.id) : undefined;
			const input = params as Record<string, unknown>;
			let executionParams = params;
			if (typeof input.path === "string") {
				const relative = path.relative(cwd, canonicalPath!);
				const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
				if (outside) record.issue = "Path is outside Workspace; ChangeSet observes Workspace effects only";
				if (!outside && scope.mode === "isolated_worktree") executionParams = { ...input, path: path.resolve(scope.executionCwd, relative) } as typeof params;
			}
			try { result = await factory(scope.executionCwd).execute(args[0], executionParams, args[2], args[3], { ...args[4], cwd: scope.executionCwd }) as Awaited<ReturnType<ToolDefinition<P, D>["execute"]>>; }
			catch (error) { failure = error; }
			if (timer) clearInterval(timer);
			await renewing;
			await this.coordinator.assertLeaseActive(scope.id, scope.ownerToken!);
			record.changeSet = await this.coordinator.capture(scope.id, scope.ownerToken, { readOnlyExpected: !mutating || item?.workspaceExecutionPolicy.mode === "read_only_shared", readOnlyBaselineFingerprint: before?.outputFingerprint });
			record.integrity = record.changeSet.integrity;
			record.status = failure || (result as { isError?: boolean } | undefined)?.isError ? "failed" : "completed";
			if (result) {
				record.outputRef = hash(result);
				record.outputPreview = JSON.stringify(result.content).slice(0, 30_000);
			}
			if (failure) record.issue = message(failure);
			if (signal?.aborted || renewalError || record.integrity === "violation") {
				record.status = "unknown";
				if (record.integrity !== "violation") record.integrity = "unknown";
				record.issue = message(renewalError ?? failure ?? "Cancelled or integrity violation; reconcile effects");
				await this.coordinator.fence(scope.id, scope.ownerToken);
			} else if (scope.mode !== "isolated_worktree") await this.coordinator.release(scope.id, { ownerToken: scope.ownerToken, cleanup: false });
		} catch (error) {
			failure = error;
			record.status = scope ? "unknown" : "failed";
			record.integrity = scope ? "unknown" : "clean";
			record.issue = message(error);
			if (scope) await this.coordinator.fence(scope.id, scope.ownerToken);
		} finally {
			if (timer) clearInterval(timer);
			record.sealedAt = new Date().toISOString();
			// If evidence cannot be persisted, the scope cannot safely be certified.
			await this.save([record]).catch(async (error) => {
				if (scope) await this.coordinator.fence(scope.id, scope.ownerToken);
				throw error;
			});
		}
		if (failure) throw new Error(`${message(failure)}\nNativeExecution: ${record.id}`);
		if (record.status === "unknown") throw new Error(`${record.issue}\nNativeExecution: ${record.id}`);
		return { ...result!, content: [...result!.content, { type: "text", text: `\nNativeExecution: ${record.id}${record.changeSet ? `; ChangeSet: ${record.changeSet.id}; changedPaths: ${JSON.stringify(record.changeSet.changedPaths)}` : ""}` }],
			details: { ...((result!.details ?? {}) as object), nativeExecutionId: record.id, workspaceChangeSet: record.changeSet } } as Awaited<ReturnType<ToolDefinition<P, D>["execute"]>>;
	}
}
