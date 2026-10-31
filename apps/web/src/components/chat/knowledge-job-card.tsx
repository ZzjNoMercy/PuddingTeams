"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronRightIcon, CircleAlertIcon, ClipboardCheckIcon, RocketIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getWikiBatch, type WikiBatchDetail } from "@/lib/api";
import { curatorFailureReason, curatorJobHref, curatorJobStatusLabel } from "@/lib/curator-job-presentation";

export interface KnowledgeJobCardDetails {
	jobId?: string;
	bindingId?: string;
	batchId?: string;
	status?: string;
	executionMode?: "worker" | "background";
	failureCode?: string;
}

const batchLabels: Record<string, string> = {
	pending_review: "候选待发布", approved: "已批准 · 待发布", publishing: "正在发布",
	published: "已入库", partial: "部分发布", conflict: "冲突或已过期", rejected: "已拒绝", returned: "已退回修改",
};

/** 发布状态以固定批次为事实源；这里只读展示，不代替 Publisher 回执。 */
function batchLabel(status: string): string {
	return batchLabels[status] ?? status;
}

/** 纯展示：会话内可见的入库结果与文件清单（Agent 代批后也应看到真实批次状态）。 */
export function KnowledgeDeliverySummary({ batch }: { batch: WikiBatchDetail }) {
	const files = batch.batch.files;
	const published = batch.status === "published";
	const failed = batch.status === "conflict" || batch.status === "partial";
	return (
		<div className={`mt-3 rounded-lg border px-3 py-2 ${failed ? "border-destructive/40 bg-destructive/5" : "border-border/70 bg-background/50"}`}>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				{published ? <RocketIcon size={14} className="text-primary" /> : failed ? <CircleAlertIcon size={14} className="text-destructive" /> : <ClipboardCheckIcon size={14} className="text-muted-foreground" />}
				<strong className="font-medium">{batchLabel(batch.status)}</strong>
				<span className="text-muted-foreground">{files.length} 项文件 · 版本 {batch.revision}</span>
				<span className="font-mono text-[11px] text-muted-foreground">{batch.manifestHash.slice(0, 12)}</span>
			</div>
			<ul className="mt-2 space-y-1">
				{files.slice(0, 8).map((file) => (
					<li key={file.targetPath} className="flex min-w-0 items-baseline gap-2 text-xs">
						<span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">{file.operation === "create" ? "新增" : file.operation === "delete" ? "删除" : "更新"}</span>
						<span className="truncate font-mono text-[11px]">{file.targetPath}</span>
					</li>
				))}
				{files.length > 8 ? <li className="text-xs text-muted-foreground">另有 {files.length - 8} 项</li> : null}
			</ul>
			<div className="mt-2 flex flex-wrap gap-3">
				<Link href={`/knowledge/review?batch=${encodeURIComponent(batch.id)}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">查看候选、审计与人工复核<ChevronRightIcon size={12} /></Link>
				{batch.bindingId ? <Link href={`/knowledge?vault=${encodeURIComponent(batch.bindingId)}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">打开知识库<ChevronRightIcon size={12} /></Link> : null}
			</div>
		</div>
	);
}

/** Terminal failures remain visible in the conversation, including saved cards. */
export function KnowledgeJobCard({ content, details }: { content: string; details?: KnowledgeJobCardDetails }) {
	const status = details?.status ?? "";
	const failed = status === "failed" || status === "needs_attention";
	const label = curatorJobStatusLabel(status, details?.failureCode);
	const reason = failed && details?.failureCode ? curatorFailureReason(details.failureCode, details.executionMode) : content;
	const [batch, setBatch] = useState<WikiBatchDetail | null>(null);
	useEffect(() => {
		if (!details?.batchId) return;
		const batchId = details.batchId;
		const settled = new Set(["published", "partial", "conflict", "rejected", "returned"]);
		let cancelled = false, attempts = 0, timer: ReturnType<typeof setTimeout> | undefined;
		// 批次状态是发布事实源：Agent 代批后同一轮内也要从“待发布”刷新到“已入库”。
		const load = async () => {
			attempts++;
			try {
				const next = await getWikiBatch(batchId);
				if (cancelled) return;
				setBatch(next);
				if (!settled.has(next.status) && attempts < 6) timer = setTimeout(load, 4000);
			} catch {
				// 读取失败保留上一次已知状态；用户可从审核入口重新核对。
			}
		};
		void load();
		return () => { cancelled = true; if (timer) clearTimeout(timer); };
	}, [details?.batchId]);
	return (
		<div role={failed ? "alert" : "status"} aria-label={`知识库整理：${batch ? batchLabel(batch.status) : label}`} className={`w-full rounded-xl border px-4 py-3 ${failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}>
			<div className="flex flex-wrap items-center gap-2">
				{failed ? <CircleAlertIcon size={16} className="text-destructive" /> : <ClipboardCheckIcon size={16} className="text-primary" />}
				<strong className="text-sm font-medium">知识整理</strong>
				<Badge variant={failed ? "outline" : "secondary"} className={failed ? "border-destructive/40 text-destructive" : undefined}>{batch ? batchLabel(batch.status) : label}</Badge>
			</div>
			<p className={`mt-2 whitespace-pre-wrap text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}>{reason}</p>
			{batch ? <KnowledgeDeliverySummary batch={batch} /> : null}
			{details?.jobId ? <Link href={curatorJobHref(details.jobId, details.bindingId)} className="mt-3 mr-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">{failed ? details.executionMode === "worker" ? "查看整理任务" : "查看任务并重试" : "查看整理任务与状态"}<ChevronRightIcon size={14} /></Link> : null}
			{details?.batchId ? <Link href={`/knowledge/review?batch=${encodeURIComponent(details.batchId)}`} className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">查看固定候选与审核状态<ChevronRightIcon size={14} /></Link> : !details?.jobId && details?.bindingId ? <Link href={`/knowledge?vault=${encodeURIComponent(details.bindingId)}&tasks=1`} className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">查看整理任务列表<ChevronRightIcon size={14} /></Link> : null}
		</div>
	);
}
