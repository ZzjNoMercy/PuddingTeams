"use client";

import { useEffect, useMemo, useState } from "react";
import { LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	createWikiCompileJob,
	getKnowledgeObservations,
	getWikiCompileJob,
	listAgents,
	type WikiCompileJob,
} from "@/lib/api";
import { agentDisplayName, type AgentConfig } from "@/lib/types";
import { WikiCuratorDialog, type WikiCuratorDialogProps } from "./curator-dialog";

interface AcceptedSource {
	path: string;
	title?: string;
	acceptanceId: string | null;
}

type Phase =
	| { kind: "editing" }
	| { kind: "running"; job: WikiCompileJob }
	| { kind: "candidate_ready"; job: WikiCompileJob; batchId: string }
	| { kind: "failed"; job: WikiCompileJob }
	| { kind: "cancelled"; job: WikiCompileJob };

const TERMINAL = new Set(["candidate_ready", "failed", "cancelled"]);

/**
 * 编译入库对话框：整理指令 + 已同步来源多选 + codex Agent 选择 → POST 202 →
 * 轮询至终态。candidate_ready 后由父级跳转审核页。
 */
export function WikiCompileDialog(props: WikiCuratorDialogProps) {
	const [mode, setMode] = useState<"curator" | "compiler">("curator");
	const [wasOpen, setWasOpen] = useState(props.open);
	if (props.open !== wasOpen) { setWasOpen(props.open); if (props.open) setMode("curator"); }
	return mode === "curator" ? <WikiCuratorDialog {...props} onUseCompiler={() => setMode("compiler")} /> : <CodexCompileDialog {...props} onUseCurator={() => setMode("curator")} />;
}

function CodexCompileDialog({ bindingId, bindingName, open, onOpenChange, onCandidateReady, onUseCurator }: {
	bindingId: string;
	bindingName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCandidateReady: (batchId: string) => void;
	onUseCurator: () => void;
}) {
	const [task, setTask] = useState("");
	const [agents, setAgents] = useState<AgentConfig[] | null>(null);
	const [agentId, setAgentId] = useState("");
	const [sources, setSources] = useState<AcceptedSource[] | null>(null);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [loadError, setLoadError] = useState<string | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: "editing" });
	const [wasOpen, setWasOpen] = useState(open);

	// 打开沿 render-adjust 模式重置编辑态，避免在 effect 里同步 setState。
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setPhase({ kind: "editing" });
			setSubmitError(null);
			setLoadError(null);
		}
	}

	// 打开时加载 codex Agent 列表与已同步来源集。
	useEffect(() => {
		if (!open) return;
		let active = true;
		void Promise.all([listAgents(), getKnowledgeObservations(bindingId)])
			.then(([agentList, observations]) => {
				if (!active) return;
				const compilers = agentList.filter((agent) => agent.enabled !== false && agent.connector?.connectorId === "codex");
				setAgents(compilers);
				setAgentId((previous) => (previous && compilers.some((agent) => agent.name === previous) ? previous : compilers[0]?.name ?? ""));
				const accepted = observations.files
					.filter((file) => file.state === "current")
					.map((file) => ({
						path: file.path,
						...(file.title ? { title: file.title } : {}),
						acceptanceId: file.acceptanceId ?? null,
					}));
				setSources(accepted);
				setSelected(new Set(accepted.map((file) => file.path)));
			})
			.catch((cause) => { if (active) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [open, bindingId]);

	// 运行态轮询（1.5s），终态停；关闭对话框即停止。
	const runningJobId = phase.kind === "running" ? phase.job.id : null;
	useEffect(() => {
		if (!runningJobId || !open) return;
		const tick = async () => {
			try {
				const { job } = await getWikiCompileJob(runningJobId);
				if (!TERMINAL.has(job.status)) {
					setPhase({ kind: "running", job });
				} else if (job.status === "candidate_ready" && job.candidateBatchId) {
					setPhase({ kind: "candidate_ready", job, batchId: job.candidateBatchId });
				} else if (job.status === "cancelled") {
					setPhase({ kind: "cancelled", job });
				} else {
					setPhase({ kind: "failed", job });
				}
			} catch (cause) {
				setSubmitError(cause instanceof Error ? cause.message : String(cause));
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), 1500);
		return () => clearInterval(timer);
	}, [runningJobId, open]);

	const selectedSources = useMemo(() => (sources ?? []).filter((file) => selected.has(file.path)), [sources, selected]);
	// 防御：current 正常必带内部快照 acceptanceId；缺失说明数据异常，禁用提交。
	const unresolvedSources = selectedSources.filter((file) => !file.acceptanceId);
	const canSubmit = phase.kind === "editing" && task.trim().length > 0 && agentId.length > 0 &&
		selectedSources.length > 0 && unresolvedSources.length === 0;

	const submit = async () => {
		setSubmitError(null);
		try {
			const { job } = await createWikiCompileJob({
				operationId: crypto.randomUUID(),
				bindingId,
				agentId,
				task: task.trim(),
				sourceAcceptanceIds: selectedSources.map((file) => file.acceptanceId!),
			});
			setPhase(TERMINAL.has(job.status)
				? (job.status === "candidate_ready" && job.candidateBatchId
					? { kind: "candidate_ready", job, batchId: job.candidateBatchId }
					: { kind: "failed", job })
				: { kind: "running", job });
		} catch (cause) {
			setSubmitError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const toggle = (path: string) => {
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85dvh] max-w-lg flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>编译入库 · {bindingName}</DialogTitle>
					<DialogDescription>用 Codex Agent 把已同步笔记编译成知识库 Markdown，产出需人工审核后才会发布。</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4">
				<button type="button" disabled={phase.kind === "running"} onClick={onUseCurator} className="text-xs text-muted-foreground underline">返回 Wiki 管理员</button>
				{loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : null}
				{phase.kind === "editing" || phase.kind === "running" ? (
					<div className="space-y-4">
						<div>
							<label className="mb-1 block text-sm font-medium" htmlFor="wiki-compile-task">整理指令</label>
							<Textarea
								id="wiki-compile-task"
								value={task}
								onChange={(event) => setTask(event.target.value)}
								placeholder="例如：把本周日报整理成一篇周报，更新索引页"
								disabled={phase.kind === "running"}
							/>
						</div>
						<div>
							<label className="mb-1 block text-sm font-medium">编译 Agent</label>
							{!agents ? (
								<p className="text-sm text-muted-foreground">正在加载…</p>
							) : agents.length === 0 ? (
								<p className="text-sm text-destructive">没有可用的 Codex Agent（需要启用且连接器为 codex 的 Agent）。</p>
							) : (
								<Select value={agentId} onValueChange={setAgentId} disabled={phase.kind === "running"}>
									<SelectTrigger><SelectValue placeholder="选择 Agent" /></SelectTrigger>
									<SelectContent>
										{agents.map((agent) => (
											<SelectItem key={agent.name} value={agent.name}>{agentDisplayName(agent)}</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
						<div>
							<p className="mb-1 text-sm font-medium">来源笔记（当前同步集，{selectedSources.length}/{sources?.length ?? 0}）</p>
							{!sources ? (
								<p className="text-sm text-muted-foreground">正在加载…</p>
							) : sources.length === 0 ? (
								<p className="text-sm text-muted-foreground">该库还没有已同步笔记，请刷新知识库完成同步后再编译。</p>
							) : (
								<div className="max-h-48 space-y-1 overflow-y-auto rounded border border-border p-2">
									{sources.map((file) => (
										<label key={file.path} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
											<input
												type="checkbox"
												checked={selected.has(file.path)}
												disabled={phase.kind === "running"}
												onChange={() => toggle(file.path)}
											/>
											<span className="min-w-0 flex-1 truncate">{file.title ? `${file.title}（${file.path}）` : file.path}</span>
										</label>
									))}
								</div>
							)}
							{sources && sources.length > 0 && unresolvedSources.length > 0 ? (
								<p role="alert" className="mt-2 text-xs text-amber-600 dark:text-amber-400">
									{unresolvedSources.length} 条已同步来源尚未取得同步快照标识（数据异常），请刷新后重试；未恢复前无法提交编译。
								</p>
							) : null}
						</div>
						{submitError ? <p role="alert" className="text-sm text-destructive">{submitError}</p> : null}
						<div className="flex items-center justify-end gap-2">
							{phase.kind === "running" ? (
								<p className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
									<LoaderIcon size={14} className="animate-spin" />
									编译中（{phase.job.status === "running" ? "运行中" : "排队中"}）…
								</p>
							) : null}
							<Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
							<Button disabled={!canSubmit} onClick={() => void submit()}>开始编译</Button>
						</div>
					</div>
				) : phase.kind === "candidate_ready" ? (
					<div className="space-y-4">
						<p className="text-sm">编译完成，候选批次已生成（{phase.job.candidateBatchId}）。请人工审核后再发布。</p>
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => onOpenChange(false)}>稍后</Button>
							<Button onClick={() => { onOpenChange(false); onCandidateReady(phase.batchId); }}>去审核</Button>
						</div>
					</div>
				) : (
					<div className="space-y-4">
						<p role="alert" className="text-sm text-destructive">
							{phase.kind === "cancelled" ? "编译已取消。" : `编译失败${phase.job.failureCode ? `（${phase.job.failureCode}）` : ""}。`}
						</p>
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
							<Button onClick={() => setPhase({ kind: "editing" })}>重新发起</Button>
						</div>
					</div>
				)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
