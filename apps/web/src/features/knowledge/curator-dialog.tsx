"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LoaderIcon, PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { retryWikiCuratorJob, cancelWikiCuratorJob, createWikiCuratorJob, getWikiCuratorJob, KnowledgeApiError, listWikiCuratorJobs, listAgents, type WikiCuratorJob, type MessageAttachmentInput } from "@/lib/api";
import { agentDisplayName, type AgentConfig } from "@/lib/types";
import { WIKI_REVIEW_CHANGED } from "@/lib/wiki-review-queue";

export interface WikiCuratorDialogProps {
	bindingId: string;
	bindingName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCandidateReady: (batchId: string) => void;
	taskPlaceholder?: string;
}

/** User instructions become an immutable candidate; this dialog never publishes. */
export function WikiCuratorDialog({ bindingId, bindingName, open, onOpenChange, onCandidateReady, onUseCompiler, taskPlaceholder }: WikiCuratorDialogProps & { onUseCompiler: () => void }) {
	const [task, setTask] = useState("");
	const [uploads, setUploads] = useState<File[]>([]);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const uploadInput = useRef<HTMLInputElement>(null);
	const [agents, setAgents] = useState<AgentConfig[] | null>(null);
	const [agentId, setAgentId] = useState("");
	const [job, setJob] = useState<WikiCuratorJob | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [cancelError, setCancelError] = useState<string | null>(null);
	const [reload, setReload] = useState(0);
	const request = useRef<{ key: string; operationId: string } | null>(null);
	const jobMutation = useRef(0);
	const busy = submitting || cancelling || job?.status === "queued" || job?.status === "running";
	const activeJobId = job?.status === "queued" || job?.status === "running" ? job.id : null;

	useEffect(() => {
		if (!open) return;
		let active = true;
		void Promise.all([listAgents(), listWikiCuratorJobs(bindingId)]).then(([items, jobs]) => {
			if (!active) return;
			setCancelError(null);
			const workers = items.filter((agent) => agent.enabled !== false && agent.builtinId === "wiki" && agent.connector?.connectorId === "pi" && agent.connector.transport === "sdk");
			setAgents(workers);
			setAgentId((previous) => workers.some((agent) => agent.name === previous) ? previous : workers.find((agent) => /wiki|知识库/i.test(`${agent.name} ${agent.displayName ?? ""}`))?.name ?? workers[0]?.name ?? "");
			const running = jobs.find((item) => item.status === "queued" || item.status === "running");
			const resumable = running ?? jobs.find((item) => item.status === "needs_attention" || item.status === "failed");
			setJob((previous) => running ?? jobs.find((item) => item.id === previous?.id) ?? resumable ?? null);
			if (resumable) { setTask(resumable.task); setAgentId(resumable.agentId); }
			setError(null);
		}).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [open, bindingId, reload]);

	useEffect(() => {
		if (!activeJobId || !open) return;
		let active = true;
		let loading = false;
		const tick = async () => {
			if (document.hidden || loading) return;
			loading = true;
			const mutation = jobMutation.current;
			try {
				const { job: next } = await getWikiCuratorJob(activeJobId);
				if (active && mutation === jobMutation.current) { setJob(next); setError(null); if (next.status === "pending_review") window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED)); }
			} catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
			finally { loading = false; }
		};
		void tick();
		const timer = window.setInterval(() => void tick(), 1500);
		document.addEventListener("visibilitychange", tick);
		return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
	}, [activeJobId, open]);

	const submit = async () => {
		if (busy || !task.trim() || !agentId || error) return;
		const key = JSON.stringify([bindingId, agentId, task.trim(), uploads.map((file) => [file.name, file.size, file.lastModified])]);
		if (request.current?.key !== key) request.current = { key, operationId: crypto.randomUUID() };
		setSubmitting(true);
		try {
			const attachments = await Promise.all(uploads.map((file) => new Promise<MessageAttachmentInput>((resolve, reject) => {
				const reader = new FileReader();
				reader.onerror = () => reject(new Error(`读取附件失败：${file.name}`));
				reader.onload = () => {
					const dataUrl = String(reader.result);
					resolve({ filename: file.name, mediaType: /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : /\.txt$/i.test(file.name) ? "text/plain" : file.type || "application/octet-stream", data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
				};
				reader.readAsDataURL(file);
			})));
			const response = await createWikiCuratorJob({ operationId: request.current.operationId, bindingId, agentId, task: task.trim(), ...(attachments.length ? { uploads: attachments } : {}) });
			setJob(response.job);
			setError(null);
			if (response.job.status === "pending_review") window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED));
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSubmitting(false); }
	};

	const retry = async () => {
		if (!job || busy || !["failed", "needs_attention"].includes(job.status)) return;
		const key = `retry:${job.id}`;
		if (request.current?.key !== key) request.current = { key, operationId: crypto.randomUUID() };
		setSubmitting(true); setError(null);
		try { const response = await retryWikiCuratorJob(job.id, request.current.operationId); setJob(response.job); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSubmitting(false); }
	};

	const cancel = async () => {
		if (!job || cancelling || !["queued", "running", "needs_attention"].includes(job.status)) return;
		setCancelling(true);
		setCancelError(null);
		jobMutation.current += 1;
		try {
			const response = await cancelWikiCuratorJob(job.id);
			jobMutation.current += 1;
			setJob(response.job);
			setError(null);
			request.current = null;
		} catch (cause) {
			setCancelError(cause instanceof KnowledgeApiError && cause.status === 409 ? "状态变化，请刷新。候选可能已进入审核。" : cause instanceof Error ? cause.message : String(cause));
		} finally { setCancelling(false); }
	};

	return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[85dvh] max-w-lg flex-col overflow-hidden">
		<DialogHeader><DialogTitle>Wiki 管理员 · {bindingName}</DialogTitle><DialogDescription>说明要补充或整理的内容。管理员生成候选，逐文件审核并确认后才会更新知识库。</DialogDescription></DialogHeader>
		<DialogBody className="space-y-4">
			{error ? <p role="alert" className="text-sm text-destructive">{error} <button type="button" onClick={() => setReload((value) => value + 1)} className="underline">重新加载</button></p> : null}
			{job?.status === "pending_review" && job.candidateBatchId ? <div className="space-y-4"><p className="text-sm">候选已生成，知识库尚未更新。</p><Button onClick={() => { onOpenChange(false); onCandidateReady(job.candidateBatchId!); }}>查看候选并审核</Button></div> : job?.status === "no_changes" || job?.status === "needs_attention" ? <div className="space-y-4"><p role="status" className="text-sm">{job.status === "needs_attention" ? "来源原件已保存，本次尚未生成候选。请处理解析问题，或补充可核对的文字后重新整理。" : "本次整理没有生成文件变更。"}</p>{job.status === "needs_attention" && job.failureCode ? <p role="alert" className="text-sm text-destructive">{job.failureCode}</p> : null}<Button variant="outline" disabled={busy} onClick={() => { setJob(null); request.current = null; }}>继续整理</Button></div> : <>
				{job?.status === "failed" || job?.status === "cancelled" ? <p role="alert" className="text-sm text-destructive">{job.status === "cancelled" ? "整理已取消。" : `整理失败${job.failureCode ? `（${job.failureCode}）` : ""}。`}<button type="button" onClick={() => { setJob(null); request.current = null; }} className="ml-2 underline">重新发起</button></p> : null}
				<div><label htmlFor="wiki-curator-task" className="mb-1 block text-sm font-medium">需要整理什么</label><Textarea id="wiki-curator-task" value={task} onChange={(event) => setTask(event.target.value)} disabled={busy} placeholder={taskPlaceholder ?? "例如：项目发布日期改为 10 月 22 日，请更新项目页、相关讨论和索引，并说明依据。"} className="min-h-32" /></div>
				<div><input ref={uploadInput} type="file" accept=".txt,.md,.markdown,.pdf,image/*" multiple hidden onChange={(event) => {
					const next = [...uploads, ...Array.from(event.target.files ?? [])];
					event.target.value = "";
					if (next.length > 5 || next.some((file) => file.size > 8 * 1024 * 1024) || next.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) { setUploadError("最多 5 个附件，每个不超过 8MB，合计不超过 20MB。"); return; }
					setUploads(next); setUploadError(null); request.current = null;
				}} /><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => uploadInput.current?.click()}><PaperclipIcon size={14} />添加来源附件</Button><p className="mt-2 text-xs text-muted-foreground">文字与 Markdown 可作为依据；图片会按管理员模型能力提取，并保留原件供核对。PDF 仅保留原件，解析尚未接入。</p>{uploadError ? <p role="alert" className="mt-2 text-xs text-destructive">{uploadError}</p> : null}<div className="mt-2 space-y-1">{uploads.map((file, index) => <div key={`${file.name}:${index}`} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs"><span className="min-w-0 truncate">{file.name}</span><button type="button" disabled={busy} onClick={() => { setUploads((previous) => previous.filter((_, at) => at !== index)); request.current = null; setUploadError(null); }} aria-label={`移除附件 ${file.name}`}><XIcon size={13} /></button></div>)}</div></div>
				<div><p className="mb-1 text-sm font-medium">Wiki 管理员</p>{!agents ? <p className="text-sm text-muted-foreground">正在加载…</p> : agents.length === 0 ? <p className="text-sm text-muted-foreground">内置 Wiki 管理员尚未启用。<Link href="/agents" className="ml-1 underline">配置智能体</Link></p> : <Select value={agentId} onValueChange={setAgentId} disabled={busy}><SelectTrigger aria-label="选择 Wiki 管理员"><SelectValue placeholder="选择管理员" /></SelectTrigger><SelectContent>{agents.map((agent) => <SelectItem key={agent.name} value={agent.name}>{agentDisplayName(agent)}</SelectItem>)}</SelectContent></Select>}</div>
				{busy ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderIcon size={14} className="animate-spin" />{submitting ? "正在提交…" : job?.status === "queued" ? "正在排队…" : "正在整理候选…"} 关闭后任务继续运行。</p> : null}
				<div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button><Button disabled={busy || !task.trim() || !agentId || Boolean(error) || job?.status === "failed" || job?.status === "cancelled"} onClick={() => void submit()}>生成审核候选</Button></div>
			</>}
			{job && ["needs_attention", "failed"].includes(job.status) ? <Button type="button" disabled={busy} onClick={() => void retry()}>{submitting ? "正在重试…" : "重试解析与整理"}</Button> : null}
			{job && ["queued", "running", "needs_attention"].includes(job.status) ? <Button type="button" variant="outline" size="sm" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在取消…" : "取消整理"}</Button> : null}
			{cancelError ? <p role="alert" className="text-sm text-destructive">{cancelError} <button type="button" onClick={() => setReload((value) => value + 1)} className="underline">刷新状态</button></p> : null}
			<button type="button" disabled={busy} onClick={onUseCompiler} className="text-xs text-muted-foreground underline disabled:opacity-40">使用 Codex 编译已同步笔记</button>
		</DialogBody>
	</DialogContent></Dialog>;
}
