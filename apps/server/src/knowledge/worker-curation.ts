import { createHash } from "node:crypto";
import path from "node:path";
import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCurationStatusTool, type CurationStatusSnapshot } from "./curation-status.js";
import { curatorJobFeedback, type CuratorJob, type CuratorJobStore, type WikiCuratorService } from "./curator-jobs.js";
import type { KnowledgeMountSurface } from "./runtime-service.js";
import type { DecideAndPublishResult } from "./wiki/decide.js";
import { TaskWorkspace } from "./task-files.js";
import type { TaskDescriptor } from "./curator-jobs.js";

type Pages = Parameters<WikiCuratorService["submit"]>[1];
type Input = Parameters<WikiCuratorService["requestSurface"]>[1];
interface Host {
	listTasks(): Promise<CuratorJob[]>;
	resume(id: string, bindingId: string): Promise<CuratorJob>;
	create(input: Parameters<WikiCuratorService["create"]>[0]): ReturnType<WikiCuratorService["create"]>;
	jobs: CuratorJobStore;
	prepare(job: CuratorJob, modelRef?: string): Promise<CuratorJob>;
	context(job: CuratorJob): Promise<unknown>;
	submit(job: CuratorJob, pages: Pages, ids?: string[], evidence?: unknown[]): Promise<CuratorJob>;
	notify(job: CuratorJob): Promise<void>;
	/** 模型代批：同一审核账本，审计 actorKind=agent。 */
	approve(job: CuratorJob, reason?: string): Promise<DecideAndPublishResult>;
	/** 宿主是否装配了发布器；未装配时不延长模型轮次。 */
	canApprove(): boolean;
	/** 物化/复用本次任务目录（file as API）。 */
	task(job: CuratorJob): Promise<TaskDescriptor>;
	/** 一个任务组内每个目标库一个独立 Job。 */
	createGroup(input: Parameters<WikiCuratorService["createGroup"]>[0]): ReturnType<WikiCuratorService["createGroup"]>;
	registerAbort(id: string, abort?: () => Promise<void>): void;
	readStatus(ownerId: string, jobId: string): Promise<CurationStatusSnapshot | undefined>;
	assertAuthority(job: CuratorJob): Promise<void>;
	invalidate(id: string, code?: string): void;
	timeoutMs: number;
}

/** The current chat Worker owns generation; the host owns immutable evidence and review. */
export function workerCurationSurface(surface: KnowledgeMountSurface, input: Input, host: Host): KnowledgeMountSurface {
	const tasks = new Map<string, CuratorJob>();
	const workspaces = new Map<string, TaskWorkspace>();
	const groups = new Map<string, { groupId: string; jobs: CuratorJob[]; task: TaskDescriptor }>();
	let groupPrep: Promise<{ groupId: string; jobs: CuratorJob[]; task: TaskDescriptor }> | undefined;
	const preparations = new Map<string, Promise<CuratorJob>>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let session: AgentSession | undefined;
	let stoppedReason: string | undefined;
	let publishExtensionUsed = false;
	const currentJobs = () => Promise.all([...tasks.values()].map(async job => await host.jobs.get(job.id) ?? job));
	const stop = async (code: string) => {
		stoppedReason ??= code;
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		for (const job of tasks.values()) host.invalidate(job.id, stoppedReason);
		for (const job of await currentJobs()) {
			if (job.status !== "running") continue;
			let stopped: CuratorJob;
			try { stopped = await host.jobs.transition(job.id, ["running"], {
				status: code === "cancelled" ? "cancelled" : "failed", failureCode: code,
			}); } catch (error) {
				if ((await host.jobs.get(job.id))?.status === "running") throw error;
				continue; // Another terminal transition won the CAS.
			}
			if (stopped) await host.notify(stopped).catch(() => undefined);
		}
	};
	const abortExecution = () => { void session?.abort().catch(() => undefined); };
	const contextTool = surface.tools.find(tool => tool.name === "knowledge_context");
	const context = contextTool && { ...contextTool, execute: async (...args: Parameters<typeof contextTool.execute>) => {
		await surface.assertCurrent();
		const result = await contextTool.execute(...args);
		const block = result.content.find(entry => entry.type === "text");
		if (block?.type !== "text") return result;
		const payload = JSON.parse(block.text) as { mounts: Array<{ bindingId: string }> };
		const mounted = new Set(payload.mounts.map(mount => mount.bindingId));
		const jobs = (await host.listTasks()).filter(job => mounted.has(job.targetBindingId))
			.sort((a, b) => Number(["no_changes", "pending_review"].includes(a.status)) - Number(["no_changes", "pending_review"].includes(b.status)) || b.createdAt.localeCompare(a.createdAt));
		const sourceMessages = await input.listSourceMessages?.();
		await surface.assertCurrent();
		return { ...result, content: [{ type: "text" as const, text: JSON.stringify({ ...payload,
			sourceMessages,
			curationTasks: jobs.map(job => ({ bindingId: job.targetBindingId, task: job.task,
				createdAt: job.createdAt, ...curatorJobFeedback(job), resumable: job.status === "failed" && job.failureCode === "server_restart" && !job.frozenCandidate })) }) }] };
	} };
	const prepare = defineTool({
		name: "knowledge_prepare_candidate", label: "准备知识候选",
		description: "把本轮素材冻结到任务组，并为每个目标库物化任务目录（只读 AGENTS.md/schema/sources，可写 library）。默认处理本轮挂载的全部知识库；bindingIds 可明确收窄。返回每个库的 bindingId、任务目录与来源 ID。",
		parameters: Type.Object({ bindingId: Type.Optional(Type.String()), task: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })), jobId: Type.Optional(Type.String({ minLength: 1 })),
			sourceMessageIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 })),
			bindingIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8 })) }),
		execute: async (toolCallId, args, signal) => {
			await surface.assertCurrent();
			if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
			const contextTool = surface.tools.find(tool => tool.name === "knowledge_context");
			if (!contextTool) throw new Error("本轮未挂载知识库");
			const result = await contextTool.execute(toolCallId, {}, undefined, undefined, {} as never);
			const block = result.content.find(entry => entry.type === "text");
			const mounts = block?.type === "text" ? JSON.parse(block.text).mounts as Array<{ bindingId: string; name?: string }> : [];
			const mounted = new Set(mounts.map((mount) => mount.bindingId));
			if (args.jobId) {
				// 恢复单个中断任务：保持原有语义，不重新选择目标库。
				const bindingId = args.bindingId;
				if (!bindingId) throw new Error("恢复中断任务需要 bindingId");
				if (!mounted.has(bindingId)) throw new Error("目标知识库不在本轮授权范围内");
				const resumed = await host.resume(args.jobId, bindingId);
				const ready = resumed.status === "running" ? await host.prepare(resumed) : resumed;
				tasks.set(bindingId, ready);
				preparations.set(bindingId, Promise.resolve(ready));
				const task = await host.task(ready);
				const target = task.targets.find((entry) => entry.bindingId === bindingId);
				workspaces.set(bindingId, new TaskWorkspace(target ? path.dirname(target.library) : path.join(task.root, "targets", bindingId), { sourcesRoot: task.sources }));
				const context = ready.status === "running" ? await host.context(ready).catch(() => undefined) : undefined;
				return { content: [{ type: "text" as const, text: JSON.stringify({ ...curatorJobFeedback(ready), groupId: ready.groupId ?? ready.id,
					targets: [{ bindingId, name: mounts.find((mount) => mount.bindingId === bindingId)?.name, jobId: ready.id, status: ready.status, ...(ready.candidateBatchId ? { batchId: ready.candidateBatchId } : {}) }], task, ...(context ? { context } : {}) }) }], details: { jobId: ready.id, groupId: ready.groupId ?? ready.id } };
			}
			if (!args.task?.trim()) throw new Error("新任务需要整理要求");
			if (args.sourceMessageIds && !input.listSourceMessages) throw new Error("当前通道不支持选择历史消息素材");
			const bindingIds = args.bindingIds?.length ? [...new Set(args.bindingIds)] : mounts.map((mount) => mount.bindingId);
			if (!bindingIds.length) throw new Error("本轮没有挂载知识库");
			if (bindingIds.length > 8) throw new Error("一次最多处理 8 个目标库");
			if (bindingIds.some((bindingId) => !mounted.has(bindingId))) throw new Error("目标知识库不在本轮授权范围内");
			if (groupPrep) {
				const group = await groupPrep;
				const preparedIds = group.jobs.map((job) => job.targetBindingId).sort();
				if (JSON.stringify(preparedIds) !== JSON.stringify([...bindingIds].sort())) throw new Error("当前会话已准备另一组目标库");
				if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
				const first = group.jobs[0]!;
				const context = group.jobs.length === 1 && first.status === "running" ? await host.context(first).catch(() => undefined) : undefined;
				return { content: [{ type: "text" as const, text: JSON.stringify({ ...curatorJobFeedback(first), groupId: group.groupId,
					targets: group.jobs.map((job) => ({ bindingId: job.targetBindingId, name: mounts.find((mount) => mount.bindingId === job.targetBindingId)?.name, jobId: job.id, status: job.status, ...(job.candidateBatchId ? { batchId: job.candidateBatchId } : {}) })),
					task: group.task, ...(context ? { context } : {}) }) }], details: { jobId: first.id, groupId: group.groupId } };
			}
			groupPrep = (async () => {
				const admitted = input.resolveSources ? await input.resolveSources(toolCallId, args.sourceMessageIds) : {
					sourceIds: input.sourceIds, operationId: input.operationId, windowId: input.windowId,
				};
				if (!admitted?.sourceIds?.length && !input.sourceText) throw new Error("本轮没有获准的用户素材");
				await surface.assertCurrent();
				const operationId = createHash("sha256").update(JSON.stringify(["worker-group", input.operationId, admitted?.operationId, ...bindingIds])).digest("hex");
				if (signal?.aborted || stoppedReason) {
					if (!stoppedReason) await stop("cancelled");
					throw new Error(stoppedReason ?? "model_aborted");
				}
				const created = await host.createGroup({ ownerId: input.ownerId, operationId, bindingIds, agentId: "wiki", task: args.task!,
					...(input.sourceText ? { sourceText: input.sourceText } : {}), ...(admitted?.sourceIds ? { sourceIds: admitted.sourceIds } : {}),
					origin: { sessionId: input.sessionId, windowId: admitted?.windowId ?? input.windowId, toolCallId, channel: "agent_task" } });
				for (const job of created.jobs) tasks.set(job.targetBindingId, job);
				if (signal?.aborted || stoppedReason) {
					if (stoppedReason === "cancelled" || signal?.aborted) {
						// abort 可能发生在 createGroup 返回之前：stop 当时看不到任务，这里补一次取消。
						if (!stoppedReason) stoppedReason = "cancelled";
						await stop("cancelled");
					}
					throw new Error(stoppedReason ?? "model_aborted");
				}
				const jobs: CuratorJob[] = [];
				for (const job of created.jobs) {
					tasks.set(job.targetBindingId, job);
					if (job.status !== "running") { jobs.push(job); preparations.set(job.targetBindingId, Promise.resolve(job)); continue; }
					host.registerAbort(job.id, async () => { abortExecution(); });
					timers.set(job.id, setTimeout(() => { void stop("model_timeout").finally(abortExecution).catch(() => undefined); }, host.timeoutMs));
					const modelRef = session?.model ? `${session.model.provider}/${session.model.id}` : undefined;
					const ready = await host.prepare(job, modelRef);
					tasks.set(job.targetBindingId, ready);
					preparations.set(job.targetBindingId, Promise.resolve(ready));
					jobs.push(ready);
					if (signal?.aborted || stoppedReason) {
						// 定时器发起的 stop 正在收敛 Job；这里不能再 await 同一收敛（否则与终态 CAS 互等）。
						if (!stoppedReason) await stop("cancelled");
						throw new Error(stoppedReason ?? "model_aborted");
					}
				}
				let task: TaskDescriptor | undefined;
				for (const job of jobs) {
					const descriptor = await host.task(job);
					task ??= descriptor;
					const target = descriptor.targets.find((entry) => entry.bindingId === job.targetBindingId);
					workspaces.set(job.targetBindingId, new TaskWorkspace(target ? path.dirname(target.library) : path.join(descriptor.root, "targets", job.targetBindingId), { sourcesRoot: descriptor.sources }));
				}
				if (!task) throw new Error("任务目录未生成");
				const group = { groupId: operationId, jobs, task };
				groups.set(operationId, group);
				return group;
			})();
			void groupPrep.catch(() => { groupPrep = undefined; });
			const group = await groupPrep;
			const first = group.jobs[0]!;
			const context = group.jobs.length === 1 && first.status === "running" ? await host.context(first).catch(() => undefined) : undefined;
			return { content: [{ type: "text" as const, text: JSON.stringify({ ...curatorJobFeedback(first), groupId: group.groupId,
				targets: group.jobs.map((job) => ({ bindingId: job.targetBindingId, jobId: job.id, status: job.status, ...(job.candidateBatchId ? { batchId: job.candidateBatchId } : {}) })),
				task: group.task, ...(context ? { context } : {}) }) }], details: { jobId: first.id, groupId: group.groupId } };
		},
	});
	const submit = defineTool({
		name: "knowledge_submit_candidate", label: "提交审核候选",
		description: "扫描任务组内各目标库的 library/ Markdown 候选，逐库冻结并登记审核批次；正式库尚未修改。默认扫描全部目标库，bindingIds 可收窄。pages 仅供没有文件工具的通道兜底。",
		parameters: Type.Object({ bindingId: Type.Optional(Type.String()), summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
			bindingIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8 })),
			pages: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String(), reason: Type.String() }), { maxItems: 100 })) }),
		execute: async (_toolCallId, args, signal) => {
			await surface.assertCurrent();
			if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
			if (args.pages) {
				// 兼容没有文件工具的通道：仍要求显式目标库。
				const bindingId = args.bindingId;
				if (!bindingId) throw new Error("pages 模式需要 bindingId");
				const preparation = preparations.get(bindingId);
				if (!preparation) throw new Error("请先调用knowledge_prepare_candidate冻结该目标库的素材与基线");
				const job = await preparation;
				const done = await host.submit(job, args.pages, surface.readSourceIds?.(), surface.readEvidence?.());
				tasks.set(bindingId, done);
				const timer = timers.get(job.id); if (timer) clearTimeout(timer);
				await host.notify(done).catch(() => undefined);
				return { content: [{ type: "text" as const, text: JSON.stringify(curatorJobFeedback(done)) }], details: { jobId: done.id, batchId: done.candidateBatchId as string | undefined, status: done.status, groupId: done.groupId ?? done.id } };
			}
			const group = groupPrep ? await groupPrep : undefined;
			let jobs = group?.jobs ?? (await host.listTasks());
			if (!group) {
				const latest = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
				const groupId = latest?.groupId;
				jobs = groupId ? jobs.filter((job) => job.groupId === groupId) : latest ? [latest] : [];
			}
			if (args.bindingIds?.length) jobs = jobs.filter((job) => args.bindingIds!.includes(job.targetBindingId));
			if (args.bindingId) jobs = jobs.filter((job) => job.targetBindingId === args.bindingId);
			if (!jobs.length) throw new Error("没有可提交的任务组，请先 prepare");
			const results: Array<Record<string, unknown>> = [];
			for (const job of jobs) {
				tasks.set(job.targetBindingId, job);
				try {
					const current = await host.jobs.get(job.id) ?? job;
					if (["pending_review", "no_changes"].includes(current.status)) {
						results.push({ bindingId: job.targetBindingId, jobId: job.id, status: current.status, ...(current.candidateBatchId ? { batchId: current.candidateBatchId } : {}) });
						continue;
					}
					let workspace = workspaces.get(job.targetBindingId);
					if (!workspace) {
						const descriptor = await host.task(job);
						const target = descriptor.targets.find((entry) => entry.bindingId === job.targetBindingId);
						workspace = new TaskWorkspace(target ? path.dirname(target.library) : path.join(descriptor.root, "targets", job.targetBindingId), { sourcesRoot: descriptor.sources });
						workspaces.set(job.targetBindingId, workspace);
					}
					if (await workspace.isSealed()) throw new Error("候选已提交；继续修改请开始新的整理任务");
					const scanned = await workspace.scanPages();
					const pages = scanned.map(page => ({ path: page.path, content: page.content, reason: args.summary?.trim() || "按任务整理" }));
					const evidence = [...(surface.readEvidence?.() ?? []), ...(await workspace.evidence())];
					const done = await host.submit(job, pages, surface.readSourceIds?.(), evidence);
					if (["pending_review", "no_changes"].includes(done.status)) await workspace.seal();
					tasks.set(job.targetBindingId, done);
					const timer = timers.get(job.id); if (timer) clearTimeout(timer);
					await host.notify(done).catch(() => undefined);
					results.push({ bindingId: job.targetBindingId, jobId: done.id, status: done.status,
						...(done.candidateBatchId ? { batchId: done.candidateBatchId, reviewUrl: `/knowledge/review?batch=${encodeURIComponent(done.candidateBatchId)}` } : {}) });
				} catch (error) {
					results.push({ bindingId: job.targetBindingId, jobId: job.id, status: "error", error: error instanceof Error ? error.message : String(error) });
				}
			}
			const failures = results.filter((result) => result.status === "error");
			const groupId = group?.groupId ?? jobs[0]?.groupId ?? jobs[0]?.id ?? "";
			const payload = { groupId, results,
				message: failures.length === 0 ? `已提交 ${results.length} 个目标库的候选；下一步逐库批准并发布。` : `${failures.length}/${results.length} 个目标库提交失败；按每项诊断修正后重新提交，已成功项不会重复冻结。` };
			return { content: [{ type: "text" as const, text: JSON.stringify(payload) }],
				details: { jobId: jobs[0]!.id, batchId: undefined as string | undefined, groupId, status: failures.length ? "partial" : "submitted" } };
		},
	});
	/** 模型代批：只批准本会话刚提交且仍待审核的批次；审计以 agent 通道留痕。 */
	const publish = defineTool({
		name: "knowledge_publish_candidate", label: "批准并发布候选",
		description: "以当前 Agent 身份批准本会话刚提交的待审核候选并立即发布，不需要用户再点击审核。只能批准本会话产生、仍处于 pending_review 且未过期的批次；平台仍重验结构、来源、基线与发布目标。只有 publish.accepted 且批次 published 才表示已入库；partial/conflict/失败必须如实报告并给出审核入口。",
		parameters: Type.Object({ batchId: Type.String({ minLength: 1 }), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })) }),
		execute: async (_toolCallId, args, signal) => {
			await surface.assertCurrent();
			if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
			// 以持久任务为准：同一会话后续轮次仍可批准之前提交的候选。
			const job = (await host.listTasks()).find(task => task.candidateBatchId === args.batchId);
			if (!job) throw new Error("该候选不属于当前会话的整理任务");
			if (job.status !== "pending_review") throw new Error(`候选当前状态为 ${job.status}，不能批准发布`);
			const result = await host.approve(job, args.reason);
			const payload = { jobId: job.id, batchId: args.batchId, status: result.record.status,
				publish: result.publish ?? null, ...(result.auditWarning ? { auditWarning: result.auditWarning } : {}),
				reviewUrl: `/knowledge/review?batch=${encodeURIComponent(args.batchId)}`,
				message: result.publish?.accepted && result.record.status === "published"
					? "已按固定候选发布到正式库；以 Publisher 回执为准。"
					: `候选已批准，但发布未完成（批次 ${result.record.status}）；不得声称已入库。` };
			return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: { jobId: job.id, batchId: args.batchId, status: result.record.status } };
		},
	});
	const workspaceFor = (bindingId?: string): TaskWorkspace => {
		if (bindingId) {
			const workspace = workspaces.get(bindingId);
			if (!workspace) throw new Error("该知识库还没有任务目录，请先 prepare");
			return workspace;
		}
		if (workspaces.size === 1) return [...workspaces.values()][0]!;
		throw new Error(workspaces.size === 0 ? "还没有任务目录，请先 prepare" : "存在多个任务目录，请指定 bindingId");
	};
	const taskTool = (name: string, label: string, description: string, parameters: ReturnType<typeof Type.Object>, run: (workspace: TaskWorkspace, args: any) => Promise<unknown>) => defineTool({
		name, label, description, parameters,
		execute: async (_toolCallId: string, args: any, signal?: AbortSignal) => {
			await surface.assertCurrent();
			if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
			const workspace = workspaceFor(args.bindingId);
			const payload = await run(workspace, args);
			return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: {} };
		},
	});
	const taskLs = taskTool("knowledge_task_ls", "列出任务文件", "列出任务目录或 library 子目录；路径相对任务根，默认 '.'。", Type.Object({ bindingId: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }), (workspace, args) => workspace.list(args.path ?? "."));
	const taskRead = taskTool("knowledge_task_read", "读取任务文件", "读取任务目录中的文件（AGENTS.md、sources/**、library/**）；读取会记录证据。", Type.Object({ bindingId: Type.Optional(Type.String()), path: Type.String() }), (workspace, args) => workspace.read(args.path));
	const taskWrite = taskTool("knowledge_task_write", "写入候选文件", "写入 library/ 下的 Markdown 候选（只能写 .md，提交后封存）。", Type.Object({ bindingId: Type.Optional(Type.String()), path: Type.String(), content: Type.String({ maxLength: 2_000_000 }) }), (workspace, args) => workspace.write(args.path, args.content));
	const taskEdit = taskTool("knowledge_task_edit", "编辑候选文件", "在 library/ 的 Markdown 中替换唯一一段文本；old_text 必须恰好出现一次。", Type.Object({ bindingId: Type.Optional(Type.String()), path: Type.String(), old_text: Type.String({ minLength: 1 }), new_text: Type.String({ maxLength: 2_000_000 }) }), (workspace, args) => workspace.edit(args.path, args.old_text, args.new_text));
	const taskGrep = taskTool("knowledge_task_grep", "检索任务文件", "在 library/ 中按字面检索，返回命中行与行号。", Type.Object({ bindingId: Type.Optional(Type.String()), query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()) }), (workspace, args) => workspace.grep(args.query, args.path ?? "library"));
	const taskFind = taskTool("knowledge_task_find", "查找任务文件", "按路径子串查找 library/ 中的文件。", Type.Object({ bindingId: Type.Optional(Type.String()), pattern: Type.String({ minLength: 1 }) }), (workspace, args) => workspace.find(args.pattern));

	const publishTask = defineTool({
		name: "knowledge_publish_task", label: "批准并发布任务组",
		description: "逐库批准本任务组仍待审核的候选并发布；一个库失败不影响其他库，逐库返回 Publisher 回执。只有 publish.accepted 且批次 published 才表示该库已入库；部分成功必须如实报告。",
		parameters: Type.Object({ bindingIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8 })), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })) }),
		execute: async (_toolCallId, args, signal) => {
			await surface.assertCurrent();
			if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
			const group = groupPrep ? await groupPrep : undefined;
			const allJobs = group?.jobs ?? await host.listTasks();
			const latest = [...allJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
			const sourceJobs = group ? group.jobs : latest?.groupId ? allJobs.filter((job) => job.groupId === latest.groupId) : latest ? [latest] : [];
			const jobs: CuratorJob[] = [];
			for (const job of sourceJobs) {
				const current = await host.jobs.get(job.id) ?? job;
				if (current.status === "pending_review" && current.candidateBatchId && (!args.bindingIds?.length || args.bindingIds.includes(current.targetBindingId))) jobs.push(current);
			}
			if (!jobs.length) throw new Error("没有待审核的任务组候选");
			const results: Array<Record<string, unknown>> = [];
			for (const job of jobs) {
				try {
					const result = await host.approve(job, args.reason);
					results.push({ bindingId: job.targetBindingId, jobId: job.id, batchId: job.candidateBatchId, status: result.record.status,
						publish: result.publish ?? null, ...(result.auditWarning ? { auditWarning: result.auditWarning } : {}) });
				} catch (error) {
					results.push({ bindingId: job.targetBindingId, jobId: job.id, batchId: job.candidateBatchId, status: "error", error: error instanceof Error ? error.message : String(error) });
				}
			}
			const failed = results.filter((result) => result.status === "error" || result.status !== "published");
			return { content: [{ type: "text" as const, text: JSON.stringify({ groupId: group?.groupId ?? jobs[0]?.groupId ?? jobs[0]?.id,
				results, message: failed.length ? `${failed.length}/${results.length} 个库未完成发布；不得把部分成功说成全部入库。` : `已发布 ${results.length} 个库的固定候选。` }) }],
				details: { jobId: jobs[0]!.id, groupId: group?.groupId ?? jobs[0]!.groupId ?? jobs[0]!.id, status: failed.length ? "partial" : "published" } };
		},
	});
	return {
		...surface,
		fingerprint: createHash("sha256").update(JSON.stringify([surface.fingerprint, "wiki-worker-file-task-v1"])).digest("hex"),
		prompt: `${surface.prompt}\n你直接负责当前会话的知识整理。纯查询使用读取工具；新增、更新或整理先调用knowledge_prepare_candidate获取宿主冻结素材和结构，再检索查重、生成完整Markdown并调用knowledge_submit_candidate。默认把本轮挂载的全部知识库作为一个任务组；用户明确限制时才传 bindingIds。各目标库分别在 library/ 下用 knowledge_task_write/edit 写文件，提交前用 knowledge_task_read/grep 查重与自检。候选进入 pending_review 后，调用knowledge_publish_task逐库批准并发布（允许部分成功），不要停在等待用户点击；只有 publish.accepted 且批次 published 才是入库成功，partial/conflict/失败如实说明并给出审核入口。续聊先用knowledge_context查看当前聊天的整理任务；恢复中断任务传jobId，不把继续指令当新素材，不重解释原素材的相对日期。不要另开或申请后台整理。schema与操作契约由准备工具直接提供，不循环找定义文件。自然语言声称完成不代替发布回执。`,
		tools: [...surface.tools.map(tool => tool.name === "knowledge_context" && context ? context : tool), prepare, taskLs, taskRead, taskWrite, taskEdit, taskGrep, taskFind, submit, publish, publishTask, createCurationStatusTool(async () => ({ surface, ownerId: input.ownerId }), host.readStatus)],
		assertCurrent: async () => {
			await surface.assertCurrent();
			for (const job of await currentJobs()) {
				if (job.status !== "running") continue;
				await host.assertAuthority(job);
			}
		},
		workerExecution: {
			bind(active) { session = active; },
			async abort() { await stop("cancelled"); abortExecution(); },
			async shouldStop() {
				const jobs = await currentJobs();
				if (!jobs.length) return false;
				if (jobs.some(job => ["queued", "running", "submitting"].includes(job.status))) return false;
				// 候选生成后给同一 Agent 一次继续调 knowledge_publish_candidate 的机会；
				// 只延长一轮，避免停在 pending_review 时无限续跑。
				if (jobs.some(job => job.status === "pending_review") && host.canApprove() && !publishExtensionUsed) {
					publishExtensionUsed = true;
					return false;
				}
				return true;
			},
			async finish(reason) {
				if (!tasks.size) return undefined;
				try {
					await stop(reason);
					const jobs = await currentJobs();
					const success = jobs.every(job => ["pending_review", "no_changes"].includes(job.status));
					return { status: success ? "completed" as const : jobs.every(job => job.status === "cancelled") ? "cancelled" as const : "failed" as const,
						content: jobs.map(job => JSON.stringify(curatorJobFeedback(job))).join("\n"),
						...(!success ? { errorCode: jobs.find(job => !["pending_review", "no_changes"].includes(job.status))?.failureCode ?? "candidate_not_registered" } : {}),
					};
				} finally {
					for (const timer of timers.values()) clearTimeout(timer);
					for (const job of tasks.values()) { host.registerAbort(job.id); host.invalidate(job.id); }
				}
			},
		},
	};
}
