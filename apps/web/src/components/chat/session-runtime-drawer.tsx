"use client";

import { useState } from "react";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	CircleIcon,
	Clock3Icon,
	ExternalLinkIcon,
	FileCheck2Icon,
	GitBranchIcon,
	HistoryIcon,
	PanelRightOpenIcon,
	ShieldCheckIcon,
	TargetIcon,
	XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WorkerProcessDialog } from "./worker-process-dialog";
import { useAgentLabel } from "@/lib/avatars";
import type {
	CompletionReview,
	CompletionReviewCriterion,
	DecisionRequest,
	DelegationTrace,
	SessionWorkState,
} from "@/lib/types";

const verdictText: Record<CompletionReview["verdict"], string> = {
	satisfied: "复核通过",
	not_satisfied: "未通过",
	needs_human: "需要人类确认",
};

const criterionText: Record<CompletionReviewCriterion["status"], string> = {
	satisfied: "已满足",
	unsatisfied: "未满足",
	uncertain: "待确认",
};

function boundaryLines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function formatTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

function Section({
	icon,
	title,
	metric,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	metric?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="runtime-section">
			<div className="mb-3 flex items-center gap-2">
				<span className="text-muted-foreground">{icon}</span>
				<h3 className="text-sm font-semibold">{title}</h3>
				{metric ? <span className="ml-auto text-[11px] text-muted-foreground">{metric}</span> : null}
			</div>
			{children}
		</section>
	);
}

function CriterionIcon({ status }: { status?: CompletionReviewCriterion["status"] }) {
	if (status === "satisfied") return <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />;
	if (status === "unsatisfied") return <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />;
	if (status === "uncertain") return <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />;
	return <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />;
}

function EvidenceRef({
	id,
	artifactIds,
	delegations,
	decisions,
}: {
	id: string;
	artifactIds: string[];
	delegations: DelegationTrace[];
	decisions: DecisionRequest[];
}) {
	const delegation = delegations.find((item) => item.id === id);
	const decision = decisions.find((item) => item.id === id);
	const label = artifactIds.includes(id)
		? `产物 · ${id}`
		: delegation
			? `委托 · ${delegation.agentId}`
			: decision
				? "人类决策"
				: `证据 · ${id}`;
	if (artifactIds.includes(id)) {
		return (
			<a
				href={`/api/artifacts/${encodeURIComponent(id)}/content`}
				target="_blank"
				rel="noreferrer"
				title={id}
				className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px] text-foreground hover:bg-muted"
			>
				<span className="truncate">{label}</span><ExternalLinkIcon className="size-2.5 shrink-0" />
			</a>
		);
	}
	return <span title={id} className="inline-flex max-w-full truncate rounded-full border bg-background px-2 py-0.5 text-[10px] text-foreground">{label}</span>;
}

export function SessionRuntimeDrawer({
	workState,
	decisions,
	delegations,
	answerById,
	submitting,
	onAnswerChange,
	onAnswer,
}: {
	workState: SessionWorkState;
	decisions: DecisionRequest[];
	delegations: DelegationTrace[];
	answerById: Record<string, string>;
	submitting: boolean;
	onAnswerChange: (decisionId: string, value: string) => void;
	onAnswer: (decision: DecisionRequest, value: string) => void;
}) {
	const conditions = boundaryLines(workState.completionBoundary);
	const reviews = [...workState.completionReviews].reverse();
	const latestCurrentReview = reviews.find((item) => item.goalRevision === workState.goalRevision);
	const currentCriteria = latestCurrentReview?.criteria ?? [];
	const satisfied = currentCriteria.filter((item) => item.status === "satisfied").length;
	const pending = decisions.filter((item) => item.status === "pending");
	// pi worker 执行过程查看器（委托链「执行过程」入口）。
	const [processViewId, setProcessViewId] = useState<string | null>(null);
	const processViewDelegation = delegations.find((item) => item.id === processViewId);
	const processViewLabel = useAgentLabel(processViewDelegation?.agentId ?? "");

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button size="sm" variant="outline" className="h-7 gap-1.5 rounded-full px-2.5 text-[11px]">
					<PanelRightOpenIcon className="size-3.5" />运行详情
					{pending.length > 0 ? <span className="flex size-4 items-center justify-center rounded-full bg-amber-500 text-[9px] text-white">{pending.length}</span> : null}
				</Button>
			</DialogTrigger>
			<DialogContent positionMode="drawer" className="context-drawer runtime-drawer grid grid-rows-[auto_minmax(0,1fr)] gap-0 p-0">
				<DialogHeader className="runtime-drawer-head px-5 py-4 pr-12">
					<div className="flex items-center gap-2 text-primary"><PanelRightOpenIcon className="size-4" /><span className="text-xs font-medium">Goal Runtime</span></div>
					<DialogTitle className="line-clamp-2 text-base leading-6">{workState.goal}</DialogTitle>
					<DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
						<span>{workState.status === "resolved" ? "已完成" : workState.status === "waiting_human" ? "等待人类" : workState.status === "cancelled" ? "已取消" : "进行中"}</span>
						<span>· Goal r{workState.goalRevision}</span>
						<span>· 状态 r{workState.revision}</span>
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
					<Section icon={<TargetIcon className="size-4" />} title="当前进度" metric={formatTime(workState.updatedAt)}>
						<div className="space-y-2 text-xs leading-5">
							<div><span className="text-muted-foreground">摘要</span><p className="mt-0.5 whitespace-pre-wrap text-foreground">{workState.currentBrief || "尚未记录"}</p></div>
							{workState.waitingOn ? <div><span className="text-muted-foreground">等待</span><p className="mt-0.5 text-foreground">{workState.waitingOn}</p></div> : null}
							{workState.nextAction ? <div><span className="text-muted-foreground">下一步</span><p className="mt-0.5 text-foreground">{workState.nextAction}</p></div> : null}
						</div>
					</Section>

					<Section icon={<FileCheck2Icon className="size-4" />} title="验收条件" metric={latestCurrentReview ? `${satisfied}/${conditions.length} 已满足` : `${conditions.length} 项 · 待复核`}>
						<div className="space-y-2.5">
							{conditions.map((condition, index) => {
								const criterion = currentCriteria[index];
								return (
									<div key={`${condition}-${index}`} className="flex items-start gap-2 text-xs">
										<CriterionIcon status={criterion?.status} />
										<div className="min-w-0 flex-1">
											<div className="whitespace-pre-wrap font-medium leading-5">{condition}</div>
											{criterion ? <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{criterionText[criterion.status]} · {criterion.explanation}</div> : <div className="mt-0.5 text-[11px] text-muted-foreground">尚未提交复核</div>}
										</div>
									</div>
								);
							})}
						</div>
					</Section>

					<Section icon={<HistoryIcon className="size-4" />} title="复核轨迹" metric={`${reviews.length} 次`}>
						{reviews.length === 0 ? <p className="text-xs text-muted-foreground">尚未提交完成复核。每次提交都会保留独立记录，不覆盖历史。</p> : (
							<div className="space-y-2">
								{reviews.map((review, index) => (
									<details key={review.id} open={index === 0} className="group runtime-review-item px-1 py-2.5">
										<summary className="cursor-pointer list-none select-none">
											<div className="flex items-center gap-2 text-xs">
												<CriterionIcon status={review.verdict === "satisfied" ? "satisfied" : review.verdict === "needs_human" ? "uncertain" : "unsatisfied"} />
												<span className="font-medium">{verdictText[review.verdict]}</span>
												<span className="ml-auto text-[10px] text-muted-foreground">Goal r{review.goalRevision} · {formatTime(review.reviewedAt)}</span>
											</div>
										</summary>
										<div className="mt-3 space-y-3 border-t pt-3">
											{review.criteria.map((item, criterionIndex) => (
												<div key={`${review.id}-${criterionIndex}`} className="flex items-start gap-2 text-xs">
													<CriterionIcon status={item.status} />
													<div className="min-w-0 flex-1">
														<div className="font-medium leading-5">{item.criterion}</div>
														<div className="text-[11px] leading-4 text-muted-foreground">{item.explanation}</div>
														{item.evidenceRefs.length > 0 ? <div className="mt-1.5 flex flex-wrap gap-1">{item.evidenceRefs.map((id) => <EvidenceRef key={id} id={id} artifactIds={workState.artifactIds} delegations={delegations} decisions={decisions} />)}</div> : null}
													</div>
												</div>
											))}
											{review.gaps.length > 0 ? <div className="rounded-lg bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">缺口：{review.gaps.join("；")}</div> : null}
											<div className="space-y-0.5 text-[10px] text-muted-foreground">
												<div>Reviewer：{review.reviewerModel}</div>
												<div className="truncate" title={review.reviewerSessionId}>Session：{review.reviewerSessionId}</div>
											</div>
										</div>
									</details>
								))}
							</div>
						)}
					</Section>

					{decisions.length > 0 ? (
						<Section icon={<AlertCircleIcon className="size-4" />} title="人工决策" metric={pending.length > 0 ? `${pending.length} 项待回答` : `${decisions.length} 条记录`}>
							<div className="space-y-2">
								{decisions.map((decision) => (
									<div key={decision.id} className={`rounded-xl border p-3 text-xs ${decision.status === "pending" ? "border-amber-500/30 bg-amber-500/5" : "bg-muted/20"}`}>
										<div className="font-medium">{decision.question}</div>
										{decision.context ? <div className="mt-1 text-muted-foreground">{decision.context}</div> : null}
										{decision.status === "answered" ? <div className="mt-2 rounded-md bg-background px-2 py-1.5"><span className="text-muted-foreground">回答：</span>{decision.answer}</div> : null}
										{decision.status === "pending" ? (
											<div className="mt-2 space-y-2">
												<div className="flex flex-wrap gap-1.5">{decision.options?.map((option) => <Button key={option.id} size="sm" variant="outline" disabled={submitting} onClick={() => onAnswer(decision, option.id)}>{option.label}</Button>)}</div>
												<div className="flex gap-1.5"><Input value={answerById[decision.id] ?? ""} onChange={(event) => onAnswerChange(decision.id, event.target.value)} placeholder="输入其他决定" className="h-8 text-xs" /><Button size="sm" disabled={submitting || !(answerById[decision.id] ?? "").trim()} onClick={() => onAnswer(decision, answerById[decision.id] ?? "")}>提交</Button></div>
											</div>
										) : null}
									</div>
								))}
							</div>
						</Section>
					) : null}

					{delegations.length > 0 ? (
						<Section icon={<GitBranchIcon className="size-4" />} title="委托链" metric={`${delegations.length} 步`}>
							<div className="space-y-3 border-l pl-3">
								{delegations.map((item) => (
									<div key={item.id} className="relative text-xs before:absolute before:-left-[17px] before:top-1 before:size-2 before:rounded-full before:border before:bg-background">
										<div className="flex items-center gap-1.5">
											<span className="font-medium">{item.agentId}</span>
											<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.status}</span>
											{item.processView && item.sessionHandle ? (
												<button
													type="button"
													className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
													onClick={() => setProcessViewId(item.id)}
												>
													执行过程
													<ExternalLinkIcon className="size-2.5" />
												</button>
											) : null}
										</div>
										<div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{item.intent || item.expectedOutcome || "普通委托"}</div>
										<div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/70" title={item.id}>{item.id}</div>
									</div>
								))}
							</div>
						</Section>
					) : null}

					{workState.artifactIds.length > 0 ? (
						<Section icon={<ShieldCheckIcon className="size-4" />} title="产物证据" metric={`${workState.artifactIds.length} 项`}>
							<div className="space-y-1.5">{workState.artifactIds.map((id) => <a key={id} href={`/api/artifacts/${encodeURIComponent(id)}/content`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-xs hover:bg-muted"><FileCheck2Icon className="size-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono text-[10px]">{id}</span><ExternalLinkIcon className="size-3 text-muted-foreground" /></a>)}</div>
						</Section>
					) : null}

					<div className="flex items-center justify-center gap-1.5 py-2 text-[10px] text-muted-foreground"><Clock3Icon className="size-3" />运行事实来自当前 Session 控制面，不展示模型私有推理。</div>
				</div>
			</DialogContent>
			<WorkerProcessDialog
				delegationId={processViewId}
				workerName={processViewLabel || undefined}
				open={processViewId !== null}
				onOpenChange={(open) => {
					if (!open) setProcessViewId(null);
				}}
			/>
		</Dialog>
	);
}
