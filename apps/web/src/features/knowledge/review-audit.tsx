"use client";

import { useEffect, useState } from "react";
import { ScrollTextIcon } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listKnowledgeAudit, type KnowledgeAuditEventView, type KnowledgeAuditKind } from "@/lib/api";

const kindLabels: Record<KnowledgeAuditKind, string> = {
	"candidate.submitted": "候选提交",
	"review.approved": "审核批准",
	"review.rejected": "审核拒绝",
	"review.returned": "退回修订",
	"publication.settled": "发布结算",
};
const channelLabels: Record<KnowledgeAuditEventView["channel"], string> = { chat: "会话内", review_page: "审核页", host: "后台" };

export function auditEventLabel(event: KnowledgeAuditEventView): string {
	const actor = event.actorKind === "user" ? "用户" : event.actorKind === "agent" ? `Agent · ${event.actorId}` : "平台发布器";
	return `${kindLabels[event.kind]} · ${actor}（${channelLabels[event.channel]}）`;
}

function time(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

/** 单个批次的入库证据链：素材→候选→审核（用户/Agent）→发布，只读展示。 */
export function ReviewAudit({ batchId }: { batchId: string }) {
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<{ batchId: string; events: KnowledgeAuditEventView[] } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		if (!open) return;
		let active = true;
		void listKnowledgeAudit({ batchId, limit: 100 }).then((value) => {
			if (active) { setState({ batchId, events: value.events }); setError(null); }
		}).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [batchId, open, nonce]);
	const events = state?.batchId === batchId ? state.events : null;
	return <><button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm"><ScrollTextIcon size={14} />查看审计</button>
		<Dialog open={open} onOpenChange={setOpen}><DialogContent positionMode="drawer" className="wiki-source-drawer flex flex-col overflow-hidden">
			<DialogHeader><DialogTitle>入库审计</DialogTitle><DialogDescription>候选、审核与发布的事实链。Agent 代批与用户确认分别记录，不互相伪装。</DialogDescription></DialogHeader>
			<DialogBody className="space-y-4">
				{error ? <p role="alert" className="text-sm text-destructive">{error} <button type="button" className="underline" onClick={() => setNonce((value) => value + 1)}>重试</button></p> : null}
				{!events && !error ? <p className="text-sm text-muted-foreground">正在读取审计记录…</p> : null}
				{events?.length === 0 ? <p className="text-sm text-muted-foreground">此批次还没有审计记录。</p> : null}
				{events?.length ? <ol className="space-y-3">{events.map((event) => <li key={event.id} className="rounded border border-border p-3">
					<div className="flex flex-wrap items-baseline gap-2"><strong className="text-sm">{auditEventLabel(event)}</strong><span className="text-xs text-muted-foreground">{time(event.at)}</span></div>
					<p className="mt-1 text-sm text-muted-foreground">{event.summary}</p>
					{event.manifestHash ? <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">manifest {event.manifestHash}</p> : null}
					{event.reviewedFiles?.length ? <p className="mt-1 text-xs text-muted-foreground">已核对 {event.reviewedFiles.length} 项：{event.reviewedFiles.slice(0, 6).join("、")}{event.reviewedFiles.length > 6 ? "…" : ""}</p> : null}
					{event.files?.length ? <details className="mt-2 text-xs text-muted-foreground"><summary>文件与哈希 · {event.files.length} 项</summary><ul className="mt-1 space-y-0.5">{event.files.map((file) => <li key={file.path} className="break-all">{file.operation} · {file.path}{file.candidateHash ? ` · ${file.candidateHash.slice(0, 12)}` : ""}</li>)}</ul></details> : null}
					{event.publication ? <p className="mt-1 text-xs text-muted-foreground">发布状态 {event.publication.state} · {event.publication.fileCount} 项 · {event.publication.committedGroups} 组已提交</p> : null}
				</li>)}</ol> : null}
			</DialogBody></DialogContent></Dialog></>;
}
