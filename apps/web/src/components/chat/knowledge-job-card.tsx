import Link from "next/link";
import { ChevronRightIcon, CircleAlertIcon, ClipboardCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { curatorFailureReason, curatorJobHref, curatorJobStatusLabel } from "@/lib/curator-job-presentation";

export interface KnowledgeJobCardDetails {
	jobId?: string;
	bindingId?: string;
	batchId?: string;
	status?: string;
	executionMode?: "worker" | "background";
	failureCode?: string;
}

/** Terminal failures remain visible in the conversation, including saved cards. */
export function KnowledgeJobCard({ content, details }: { content: string; details?: KnowledgeJobCardDetails }) {
	const status = details?.status ?? "";
	const failed = status === "failed" || status === "needs_attention";
	const label = curatorJobStatusLabel(status, details?.failureCode);
	const reason = failed && details?.failureCode ? curatorFailureReason(details.failureCode, details.executionMode) : content;
	return (
		<div role={failed ? "alert" : "status"} aria-label={`知识库整理：${label}`} className={`w-full rounded-xl border px-4 py-3 ${failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}>
			<div className="flex flex-wrap items-center gap-2">
				{failed ? <CircleAlertIcon size={16} className="text-destructive" /> : <ClipboardCheckIcon size={16} className="text-primary" />}
				<strong className="text-sm font-medium">Wiki 管理员</strong>
				<Badge variant={failed ? "outline" : "secondary"} className={failed ? "border-destructive/40 text-destructive" : undefined}>{label}</Badge>
			</div>
			<p className={`mt-2 whitespace-pre-wrap text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}>{reason}</p>
			{details?.jobId ? <Link href={curatorJobHref(details.jobId, details.bindingId)} className="mt-3 mr-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">{failed ? details.executionMode === "worker" ? "查看整理任务" : "查看任务并重试" : "查看整理任务与状态"}<ChevronRightIcon size={14} /></Link> : null}
			{details?.batchId ? <Link href={`/knowledge/review?batch=${encodeURIComponent(details.batchId)}`} className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">查看固定候选与审核状态<ChevronRightIcon size={14} /></Link> : !details?.jobId && details?.bindingId ? <Link href={`/knowledge?vault=${encodeURIComponent(details.bindingId)}&tasks=1`} className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">查看整理任务列表<ChevronRightIcon size={14} /></Link> : null}
		</div>
	);
}
