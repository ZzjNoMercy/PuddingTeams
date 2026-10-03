import { createHash } from "node:crypto";
import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCurationStatusTool, type CurationStatusSnapshot } from "./curation-status.js";
import { curatorJobFeedback, type CuratorJob, type CuratorJobStore, type WikiCuratorService } from "./curator-jobs.js";
import type { KnowledgeMountSurface } from "./runtime-service.js";

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
	registerAbort(id: string, abort?: () => Promise<void>): void;
	readStatus(ownerId: string, jobId: string): Promise<CurationStatusSnapshot | undefined>;
	assertAuthority(job: CuratorJob): Promise<void>;
	invalidate(id: string, code?: string): void;
	timeoutMs: number;
}

/** The current chat Worker owns generation; the host owns immutable evidence and review. */
export function workerCurationSurface(surface: KnowledgeMountSurface, input: Input, host: Host): KnowledgeMountSurface {
	const tasks = new Map<string, CuratorJob>();
	const preparations = new Map<string, Promise<CuratorJob>>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let session: AgentSession | undefined;
	let stoppedReason: string | undefined;
	const currentJobs = () => Promise.all([...tasks.values()].map(async job => await host.jobs.get(job.id) ?? job));
	const stop = async (code: string) => {
		stoppedReason ??= code;
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
		description: "新整理用task冻结本轮素材；恢复服务重启中断的整理用knowledge_context提供的jobId，沿用原素材、原日期与基线。依据聊天历史重新整理时，用sourceMessageIds引用knowledge_context列出的原消息；不把当前继续指令当作事实。返回来源正文、来源ID与路径规则。当前Worker继续整理并提交，不启动后台Agent。",
		parameters: Type.Object({ bindingId: Type.String(), task: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })), jobId: Type.Optional(Type.String({ minLength: 1 })), sourceMessageIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 })) }),
		execute: async (toolCallId, args, signal) => {
			await surface.assertCurrent();
			if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
			const contextTool = surface.tools.find(tool => tool.name === "knowledge_context");
			if (!contextTool) throw new Error("本轮未挂载知识库");
			const result = await contextTool.execute(toolCallId, {}, undefined, undefined, {} as never);
			const block = result.content.find(entry => entry.type === "text");
			const mounts = block?.type === "text" ? JSON.parse(block.text).mounts as Array<{ bindingId: string }> : [];
			if (!mounts.some(mount => mount.bindingId === args.bindingId)) throw new Error("目标知识库不在本轮授权范围内");
			let prepared = preparations.get(args.bindingId);
			if (args.jobId && args.sourceMessageIds) throw new Error("恢复任务与重新选择原消息不能同时指定");
			if (args.sourceMessageIds && !input.listSourceMessages) throw new Error("当前通道不支持选择历史消息素材");
			if (!args.jobId && !args.task?.trim()) throw new Error("新任务需要整理要求，恢复任务需要jobId");
			if (prepared && args.jobId && (await prepared).id !== args.jobId) throw new Error("当前知识库已准备另一任务");
			if (!prepared) {
				prepared = (async () => {
					const admitted = args.jobId ? undefined : input.resolveSources ? await input.resolveSources(toolCallId, args.sourceMessageIds) : {
						sourceIds: input.sourceIds, operationId: input.operationId, windowId: input.windowId,
					};
					if (!args.jobId && !admitted?.sourceIds?.length && !input.sourceText) throw new Error("本轮没有获准的用户素材");
					await surface.assertCurrent();
					const operationId = createHash("sha256").update(JSON.stringify(["worker-candidate", input.operationId, admitted?.operationId, args.bindingId])).digest("hex");
					const job = args.jobId ? await host.resume(args.jobId, args.bindingId) : (await host.create({ ownerId: input.ownerId, operationId, bindingId: args.bindingId,
						agentId: "wiki", task: args.task!, sourceText: input.sourceText, sourceIds: admitted?.sourceIds,
						origin: { sessionId: input.sessionId, windowId: admitted?.windowId ?? input.windowId, toolCallId, channel: "agent_task" } })).job;
					tasks.set(args.bindingId, job);
					if (stoppedReason) host.invalidate(job.id, stoppedReason);
					if (signal?.aborted || stoppedReason) {
						await stop(stoppedReason ?? "cancelled");
						throw new Error(stoppedReason ?? "model_aborted");
					}
					if (job.status !== "running") return job;
					host.registerAbort(job.id, async () => { abortExecution(); });
					timers.set(job.id, setTimeout(() => {
						void stop("model_timeout").finally(abortExecution).catch(() => undefined);
					}, host.timeoutMs));
					const modelRef = session?.model ? `${session.model.provider}/${session.model.id}` : undefined;
					const ready = await host.prepare(job, modelRef);
					tasks.set(args.bindingId, ready);
					if (signal?.aborted || stoppedReason) { await stop(stoppedReason ?? "cancelled"); throw new Error(stoppedReason ?? "model_aborted"); }
					return ready;
				})();
				preparations.set(args.bindingId, prepared);
				void prepared.catch(() => { if (preparations.get(args.bindingId) === prepared) preparations.delete(args.bindingId); });
			}
			const job = await prepared;
			if (signal?.aborted || stoppedReason) { await stop(stoppedReason ?? "cancelled"); throw new Error(stoppedReason ?? "model_aborted"); }
			const current = await host.jobs.get(job.id) ?? job;
			const payload = current.status === "running" ? await host.context(current) : undefined;
			await surface.assertCurrent();
			if (payload) {
				if (signal?.aborted || stoppedReason) { await stop(stoppedReason ?? "cancelled"); throw new Error(stoppedReason ?? "model_aborted"); }
				if ((await host.jobs.get(job.id))?.status !== "running") throw new Error("整理任务已停止");
				await host.assertAuthority(current);
			}
			return { content: [{ type: "text" as const, text: JSON.stringify({ ...curatorJobFeedback(current), context: payload }) }], details: { jobId: job.id, status: current.status } };
		},
	});
	const submit = defineTool({
		name: "knowledge_submit_candidate", label: "提交审核候选",
		description: "在当前会话提交完整Markdown候选和修改理由。须先准备该目标库；平台验证、冻结并登记供用户审核，正式库尚未修改。确实无需修改时提交pages=[]。",
		parameters: Type.Object({ bindingId: Type.String(), pages: Type.Array(Type.Object({ path: Type.String(), content: Type.String(), reason: Type.String() }), { maxItems: 100 }) }),
		execute: async (_toolCallId, args, signal) => {
			await surface.assertCurrent();
			if (signal?.aborted || stoppedReason) throw new Error(stoppedReason ?? "model_aborted");
			const preparation = preparations.get(args.bindingId);
			if (!preparation) throw new Error("请先调用knowledge_prepare_candidate冻结该目标库的素材与基线");
			const job = await preparation;
			const current = await host.jobs.get(job.id) ?? job;
			const done = ["pending_review", "no_changes"].includes(current.status) ? current :
				await host.submit(job, args.pages, surface.readSourceIds?.(), surface.readEvidence?.());
			const timer = timers.get(job.id); if (timer) clearTimeout(timer);
			await host.notify(done).catch(() => undefined);
			return { content: [{ type: "text" as const, text: JSON.stringify(curatorJobFeedback(done)) }], details: { jobId: done.id, batchId: done.candidateBatchId, status: done.status } };
		},
	});
	return {
		...surface,
		fingerprint: createHash("sha256").update(JSON.stringify([surface.fingerprint, "wiki-worker-candidate-v2"])).digest("hex"),
		prompt: `${surface.prompt}\n你直接负责当前会话的知识整理。纯查询使用读取工具；新增、更新或整理先调用knowledge_prepare_candidate获取宿主冻结素材和结构，再检索查重、生成完整Markdown并调用knowledge_submit_candidate。续聊先用knowledge_context查看当前聊天的整理任务；恢复中断任务传jobId，不把继续指令当新素材，不重解释原素材的相对日期。不要另开或申请后台整理。schema与操作契约由准备工具直接提供，不循环找定义文件。自然语言声称完成不代替提交；仅宿主pending_review回执且带reviewUrl才表示已生成审核候选。提交成功后停止，等待用户审核。`,
		tools: [...surface.tools.map(tool => tool.name === "knowledge_context" && context ? context : tool), prepare, submit, createCurationStatusTool(async () => ({ surface, ownerId: input.ownerId }), host.readStatus)],
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
				return jobs.length > 0 && jobs.every(job => !["queued", "running", "submitting"].includes(job.status));
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
