"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { AlertCircleIcon, CheckCircle2Icon, CircleIcon, Clock3Icon, ExternalLinkIcon, GitBranchIcon, HistoryIcon, ListTreeIcon, PauseCircleIcon, PlayIcon, RotateCcwIcon, ShieldCheckIcon, SquareIcon, TargetIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cancelDelegation, interruptGoal, resumeGoal, reviewWorkItem } from "@/lib/api";
import type { CompletionReview, CompletionReviewCriterion, DecisionRequest, DelegationTrace, SessionGoalSummary, SessionWorkState, WorkItem, WorkItemStatus } from "@/lib/types";
import { useWorkerProcessDrawer } from "./worker-process-context";

const verdictText: Record<CompletionReview["verdict"], string> = { satisfied: "复核通过", not_satisfied: "未通过", needs_human: "需要人类确认" };
const itemStatusText: Record<WorkItemStatus, string> = {
	planned: "等待前置任务验收", ready: "可开始", in_progress: "运行中", waiting_input: "等待输入", submitted: "待验收",
	revision: "需返修", accepted: "已验收", blocked: "已阻塞", cancelled: "已取消",
};
const itemStatusClass: Record<WorkItemStatus, string> = {
	planned: "is-muted", ready: "is-ready", in_progress: "is-live", waiting_input: "is-waiting",
	submitted: "is-submitted", revision: "is-revision", accepted: "is-accepted", blocked: "is-blocked", cancelled: "is-muted",
};
function boundaryLines(value: string): string[] { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) }
function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
function CriterionIcon({ status }: { status?: CompletionReviewCriterion["status"] }) {
	if (status === "satisfied") return <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />;
	if (status === "unsatisfied") return <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />;
	if (status === "uncertain") return <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />;
	return <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />;
}
function Section({ icon, title, metric, children, className = "" }: { icon: React.ReactNode; title: string; metric?: string; children: React.ReactNode; className?: string }) {
	return <section className={"runtime-section " + className}><div className="runtime-section-head"><span>{icon}</span><h3>{title}</h3>{metric ? <span className="runtime-section-metric">{metric}</span> : null}</div>{children}</section>;
}
function planLevels(items: WorkItem[]): WorkItem[][] {
	const depth = new Map<string, number>();
	const byId = new Map(items.map((item) => [item.id, item]));
	const find = (item: WorkItem, stack = new Set<string>()): number => {
		if (depth.has(item.id)) return depth.get(item.id)!;
		if (stack.has(item.id)) return 0;
		stack.add(item.id);
		const value = item.dependsOn.length ? Math.max(...item.dependsOn.map((id) => byId.get(id)).filter(Boolean).map((parent) => find(parent!, stack))) + 1 : 0;
		depth.set(item.id, value); stack.delete(item.id); return value;
	};
	for (const item of items) find(item);
	const levels: WorkItem[][] = [];
	for (const item of items) (levels[depth.get(item.id) ?? 0] ??= []).push(item);
	return levels;
}
type PlanFilter = "all" | "action" | "running";
function executionIsLive(status: SessionWorkState["execution"]["status"]): boolean {
	return status === "running" || status === "recovering" || status === "reviewing";
}
function executionText(state: SessionWorkState): string {
	if (state.status === "resolved") return "已完成";
	if (state.status === "cancelled") return "已取消";
	return { idle: "待推进", running: "执行中", waiting_human: "等待决定", interrupted: "已暂停", recovering: "恢复中", reviewing: "复核中" }[state.execution.status];
}
function matchesFilter(item: WorkItem, filter: PlanFilter, live = true): boolean {
	if (filter === "action") return ["submitted", "revision", "blocked", "waiting_input"].includes(item.status);
	if (filter === "running") return live && item.status === "in_progress";
	return true;
}
function WorkPlanGraph({ goal, items, selectedId, filter, executionStatus, onSelect }: { goal: string; items: WorkItem[]; selectedId?: string; filter: PlanFilter; executionStatus: SessionWorkState["execution"]["status"]; onSelect: (id: string) => void }) {
	const levels = useMemo(() => planLevels(items), [items]);
	const accepted = items.filter((item) => item.status === "accepted").length;
	const live = executionIsLive(executionStatus);
	return <div className="goal-work-tree" role="group" aria-label="Goal WorkItem 依赖图">
		<div className="goal-root-node"><span className="goal-root-icon"><TargetIcon /></span><div><small>GOAL</small><strong title={goal}>{goal}</strong></div><b>{accepted}/{items.length}</b></div>
		{levels.map((level, index) => <Fragment key={level.map((item) => item.id).join("-")}>
			<div className={"goal-stage-connector " + (level.length > 1 ? "is-fork" : "")} aria-hidden="true"><span /></div>
			<div className="goal-plan-stage" style={{ gridTemplateColumns: `repeat(${level.length}, minmax(0, 1fr))` }}>
				{level.map((item) => { const paused = item.status === "in_progress" && executionStatus === "interrupted"; const recovering = item.status === "in_progress" && executionStatus === "recovering"; const visibleStatus = paused ? "已暂停" : recovering ? "恢复中" : itemStatusText[item.status]; return <button type="button" key={item.id} className={"goal-plan-node " + itemStatusClass[item.status] + (paused ? " is-paused" : "") + (selectedId === item.id ? " is-selected" : "") + (!matchesFilter(item, filter, live) ? " is-filtered" : "")} onClick={() => onSelect(item.id)} title={item.id + " · " + visibleStatus + " · 上游 " + (item.dependsOn.join("、") || "无")} aria-pressed={selectedId === item.id}>
					<span className="goal-node-status">{item.status === "accepted" ? "✓" : paused ? "Ⅱ" : item.status === "in_progress" ? "●" : item.status === "submitted" ? "◷" : item.status === "blocked" ? "!" : "○"}</span>
					<span className="goal-node-copy"><strong><i>{item.id}</i>{item.title}</strong><small>{item.assignedAgentId ?? "待分配"} · {item.delegationIds.length} 次执行</small></span>
					<em>{visibleStatus}</em>
				</button>})}
			</div>
			{index < levels.length - 1 && level.length > 1 ? <div className="goal-join-hint">{level.map((item) => item.id).join(" + ")} · 验收后继续</div> : null}
		</Fragment>)}
	</div>;
}

export function SessionRuntimeDrawer({
	workState, initialWorkItemId, activeGoalId, goals, selectedGoalId, goalLoading, goalLoadError, decisions, delegations, answerById, submitting, open, onOpenChange, onGoalSelect, onRetryGoal, onCreateNextGoal, onAnswerChange, onAnswer, onWorkStateChange,
}: {
	workState: SessionWorkState; activeGoalId: string | null; goals: SessionGoalSummary[]; decisions: DecisionRequest[]; delegations: DelegationTrace[]; answerById: Record<string, string>;
	initialWorkItemId?: string;
	selectedGoalId: string; goalLoading: boolean; goalLoadError?: string;
	submitting: boolean; open: boolean; onOpenChange: (open: boolean) => void;
	onGoalSelect: (goalId: string) => void; onRetryGoal: () => void; onCreateNextGoal: () => void;
	onAnswerChange: (decisionId: string, value: string) => void; onAnswer: (decision: DecisionRequest, value: string) => void;
	onWorkStateChange: (state: SessionWorkState) => void;
}) {
	const items = useMemo(() => Object.values(workState.plan?.items ?? {}), [workState.plan]);
	const [selectedId, setSelectedId] = useState<string>();
	const [selectedDelegationId, setSelectedDelegationId] = useState<string>();
	const [reviewSummary, setReviewSummary] = useState("");
	const [working, setWorking] = useState(false);
	const [filter, setFilter] = useState<PlanFilter>("all");
	const { openWorkerProcess } = useWorkerProcessDrawer();
	const pendingDecisions = decisions.filter((item) => item.status === "pending");
	const accepted = items.filter((item) => item.status === "accepted").length;
	const selected = workState.plan?.items[selectedId ?? ""]
		?? workState.plan?.items[initialWorkItemId ?? ""]
		?? items.find((item) => item.status === "submitted")
		?? items.find((item) => item.status === "in_progress" || item.status === "waiting_input")
		?? items.find((item) => item.status === "revision" || item.status === "blocked")
		?? items[0];
	const selectedDelegations = selected ? selected.delegationIds.map((id) => delegations.find((item) => item.id === id)).filter((item): item is DelegationTrace => Boolean(item)) : [];
	const effectiveDelegationId = selectedDelegationId && selectedDelegations.some((item) => item.id === selectedDelegationId)
		? selectedDelegationId
		: selectedDelegations.at(-1)?.id;
	const unplanned = delegations.filter((item) => !item.workItemId && item.goalEpoch === workState.execution.epoch);
	const conditions = boundaryLines(workState.completionBoundary);
	const reviews = [...workState.completionReviews].reverse();
	const latestReview = reviews.find((item) => item.goalRevision === workState.goalRevision);
	const executionLive = executionIsLive(workState.execution.status);
	const workItemActions = items.filter((item) => matchesFilter(item, "action")).length;
	const running = items.filter((item) => matchesFilter(item, "running", executionLive)).length;
	const readOnly = workState.goalId !== activeGoalId;
	const canInterrupt = !readOnly && workState.status === "active" && ["running", "waiting_human", "reviewing"].includes(workState.execution.status);
	useEffect(() => {
		try { localStorage.setItem("puddingteams:goal-selection:" + workState.sessionId + ":" + workState.goalId, JSON.stringify({ workItemId: selected?.id, delegationId: effectiveDelegationId })) } catch { /* private mode */ }
	}, [effectiveDelegationId, selected?.id, workState.goalId, workState.sessionId]);

	const review = async (verdict: "accepted" | "revision" | "blocked") => {
		if (!selected || !reviewSummary.trim()) return;
		setWorking(true);
		try {
			const next = await reviewWorkItem(workState.sessionId, selected.id, { expectedGoalId: workState.goalId, expectedRevision: workState.revision, expectedEpoch: workState.execution.epoch, verdict, summary: reviewSummary.trim(), evidenceRefs: effectiveDelegationId ? [effectiveDelegationId] : [] });
			onWorkStateChange(next); setReviewSummary(""); toast.success(verdict === "accepted" ? "已接受交付" : verdict === "revision" ? "已要求返修" : "已标记阻塞");
		} catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } finally { setWorking(false) }
	};
	const changeRecovery = async (action: "interrupt" | "resume") => {
		setWorking(true);
		try {
			const next = action === "interrupt" ? await interruptGoal(workState.sessionId, workState.goalId, workState.revision) : await resumeGoal(workState.sessionId, workState.goalId, workState.revision);
			onWorkStateChange(next); toast.success(action === "interrupt" ? "Goal 已暂停，可稍后继续" : "Goal 正在从安全点继续");
		} catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } finally { setWorking(false) }
	};
	const terminateDelegation = async (delegationId: string) => {
		setWorking(true);
		try {
			await cancelDelegation(delegationId, workState.goalId);
			toast.success("已终止当前 Worker 任务");
		} catch (error) { toast.error(error instanceof Error ? error.message : "无法终止任务") } finally { setWorking(false) }
	};
	const openProcess = (id: string) => { onOpenChange(false); setTimeout(() => openWorkerProcess(id), 0) };

	return <Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent positionMode="drawer" overlayClassName="goal-runtime-overlay" className="context-drawer runtime-drawer goal-runtime-drawer grid grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-0 p-0">
			<DialogHeader className="runtime-drawer-head goal-drawer-head">
				<div className="goal-drawer-title-row"><DialogTitle><ListTreeIcon />目标与执行</DialogTitle><span className={"goal-state-label is-" + (goalLoading ? "loading" : workState.status === "active" ? workState.execution.status : workState.status)}><i />{goalLoading ? "载入中" : executionText(workState)}</span>{goals.length > 1 ? <select className="goal-history-select" aria-label="选择当前或历史 Goal" title={goals.find((goal) => goal.goalId === selectedGoalId)?.goal} value={selectedGoalId} disabled={goalLoading} onChange={(event) => onGoalSelect(event.target.value)}>{goals.map((goal) => <option key={goal.goalId} value={goal.goalId}>{goal.goalId === activeGoalId ? "当前" : goal.status === "resolved" ? "已完成" : "已取消"} · {formatTime(goal.createdAt)} · {goal.goal}</option>)}</select> : null}</div>
				<DialogDescription className="sr-only">查看当前目标的计划、验收与执行记录</DialogDescription>
				<span className="goal-progress-label">{goalLoading ? "加载中" : `${accepted}/${items.filter((item) => item.status !== "cancelled").length || conditions.length} 已验收`}</span>
			</DialogHeader>
			{goalLoading || goalLoadError ? <div className="goal-view-loading" role="status"><strong>{goalLoadError ? "Goal 加载失败" : "正在加载 Goal…"}</strong>{goalLoadError ? <><span>{goalLoadError}</span><Button size="sm" variant="outline" onClick={onRetryGoal}>重新加载</Button></> : null}</div> : <>
			<div className="goal-plan-summary">
				<div className="goal-summary-copy"><span>SESSION GOAL</span><strong title={workState.goal}>{workState.goal}</strong><small>{workState.currentBrief || "尚未记录当前进度"}</small></div>
				<div className="goal-summary-metrics"><span><b>{workItemActions}</b>需处理</span><span><b>{running}</b>执行中</span><span><b>{items.filter((item) => item.status === "planned").length}</b>等待依赖</span></div>
			</div>
			<div className="goal-drawer-tabs" role="tablist" aria-label="WorkItem 筛选">
				<span className="goal-filter-label">筛选</span>
				<button type="button" role="tab" title="显示全部 WorkItem" aria-selected={filter === "all"} className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>全部 <span>{items.length}</span></button>
				<button type="button" role="tab" title="仅筛选需要验收、返修、输入或解除阻塞的 WorkItem；不会继续执行" aria-selected={filter === "action"} className={filter === "action" ? "is-active" : ""} onClick={() => { setFilter("action"); const target = items.find((item) => matchesFilter(item, "action")); if (target) { setSelectedId(target.id); setSelectedDelegationId(undefined) } }}>需处理 <span>{workItemActions}</span></button>
				<button type="button" role="tab" title="仅筛选当前真正执行中的 WorkItem；不会启动任务" aria-selected={filter === "running"} className={filter === "running" ? "is-active" : ""} onClick={() => { setFilter("running"); const target = items.find((item) => matchesFilter(item, "running", executionLive)); if (target) { setSelectedId(target.id); setSelectedDelegationId(undefined) } }}>执行中 <span>{running}</span></button>
			</div>
			<div className="goal-drawer-scroll">
				{!activeGoalId ? <div className="goal-next-row"><span>当前 Goal 已结束，可以在本 Session 继续创建新目标。</span><Button size="sm" onClick={onCreateNextGoal}>创建下一个 Goal</Button></div> : null}
				{workState.plan?.needsReconcile ? <div className="goal-recovery-banner"><AlertCircleIcon className="size-4" /><div><strong>WorkPlan 需要重新对账</strong><p>Goal 契约已更新；现有 accepted 仅是旧版本历史，不能用于完成当前 Goal。Manager 必须更新条件映射后再继续。</p></div></div> : null}
				{!readOnly && (workState.execution.status === "interrupted" || workState.execution.status === "recovering") ? <div className="goal-recovery-banner"><RotateCcwIcon className="size-4" /><div className="min-w-0 flex-1"><strong>{workState.execution.status === "interrupted" ? "Goal 已暂停" : "正在继续"}</strong><p>暂停不会删除 Goal；继续后会从当前 WorkItem 创建新的执行尝试。</p></div>{workState.execution.status === "interrupted" ? <Button size="sm" disabled={working} onClick={() => void changeRecovery("resume")}><PlayIcon className="size-3.5" />继续 Goal</Button> : null}</div> : canInterrupt ? <div className="goal-interrupt-row"><span>暂停当前 Goal，保留计划和已完成结果</span><Button size="sm" variant="ghost" title="暂停当前 Goal，可稍后继续" disabled={working} onClick={() => void changeRecovery("interrupt")}><PauseCircleIcon className="size-3.5" />暂停 Goal</Button></div> : null}
				{items.length ? <Section icon={<GitBranchIcon />} title="Goal 任务树" metric={workState.plan?.needsReconcile ? "需对账" : "层级主干 · 依赖合流"} className="goal-tree-section"><WorkPlanGraph goal={workState.goal} items={items} selectedId={selected?.id} filter={filter} executionStatus={workState.execution.status} onSelect={(id) => { setSelectedId(id); setSelectedDelegationId(undefined) }} /></Section> : <Section icon={<GitBranchIcon />} title="执行结构"><p className="text-xs text-muted-foreground">{delegations.length ? "当前是 direct Goal 或尚未建立 Manager WorkPlan；只展示真实 Delegation，不推测 Worker 私有 Todo。" : "尚无 WorkPlan。Manager 会在需要多步骤、依赖或多 Worker 时建立计划。"}</p></Section>}
				{selected ? <section className="runtime-section goal-selected-detail">
					{selected.description ? <p className="mb-3 text-xs text-muted-foreground">{selected.description}</p> : null}
					{selected.lastChange ? <p className="mb-3 rounded-lg bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">最近计划变更：{selected.lastChange.reason} · {formatTime(selected.lastChange.changedAt)}</p> : null}
					<div className="goal-criteria"><div className="runtime-section-head"><h3>本项验收条件</h3><span className="runtime-section-metric">{selected.acceptanceCriteria.length} 项</span></div>{selected.acceptanceCriteria.map((criterion, index) => <div key={criterion} className="goal-criterion"><span>{index + 1}</span><p>{criterion}</p></div>)}</div>
					{selectedDelegations.length ? <div className="mt-4"><label className="text-[11px] font-medium" htmlFor="goal-attempt">执行尝试</label><div className="mt-1.5 flex gap-2"><select id="goal-attempt" className="goal-attempt-select" value={effectiveDelegationId ?? ""} onChange={(event) => setSelectedDelegationId(event.target.value)}>{selectedDelegations.map((item, index) => <option key={item.id} value={item.id}>D{index + 1} · {item.agentId} · {item.status}</option>)}</select><Button size="sm" variant="outline" disabled={!effectiveDelegationId} onClick={() => { if (effectiveDelegationId) openProcess(effectiveDelegationId) }}>执行过程</Button>{!readOnly && effectiveDelegationId && selectedDelegations.find((item) => item.id === effectiveDelegationId && (item.status === "running" || item.status === "waiting_input")) ? <Button size="sm" variant="destructive" disabled={working} onClick={() => void terminateDelegation(effectiveDelegationId)}><SquareIcon className="size-3 fill-current" />终止任务</Button> : null}</div></div> : null}
					{!readOnly && selected.status === "submitted" ? <div className="goal-review-box"><div className="text-xs font-semibold">Submission 待 Manager 验收</div><Textarea value={reviewSummary} onChange={(event) => setReviewSummary(event.target.value)} rows={3} placeholder="填写验收摘要与证据判断（必填）" /><div className="grid grid-cols-3 gap-2"><Button size="sm" disabled={working || !reviewSummary.trim()} onClick={() => void review("accepted")}>接受</Button><Button size="sm" variant="outline" disabled={working || !reviewSummary.trim()} onClick={() => void review("revision")}>要求返修</Button><Button size="sm" variant="destructive" disabled={working || !reviewSummary.trim()} onClick={() => void review("blocked")}>标记阻塞</Button></div></div> : null}
					{selected.submissions.length ? <div className="mt-3 space-y-2">{[...selected.submissions].reverse().map((submission) => <div key={submission.id} className="rounded-lg border p-2 text-[11px]"><div className="font-medium">尝试 {submission.attempt} · {submission.review?.verdict ?? "待验收"}</div><p className="mt-1 text-muted-foreground">{submission.review?.summary ?? submission.summary ?? "结果见 Delegation"}</p></div>)}</div> : null}
				</section> : null}
				<Section icon={<ShieldCheckIcon />} title="Goal 完成条件" metric={latestReview ? latestReview.criteria.filter((item) => item.status === "satisfied").length + "/" + conditions.length : conditions.length + " 项"} className="goal-secondary-section"><div className="space-y-2">{conditions.map((condition, index) => { const criterion = latestReview?.criteria[index]; return <div key={condition + "-" + index} className="flex items-start gap-2 text-xs"><CriterionIcon status={criterion?.status} /><div><div className="font-medium">{condition}</div>{criterion ? <div className="text-[11px] text-muted-foreground">{criterion.explanation}</div> : null}</div></div> })}</div></Section>
				{reviews.length ? <Section icon={<HistoryIcon className="size-4" />} title="复核轨迹" metric={reviews.length + " 次"}>{reviews.map((review) => <div key={review.id} className="mb-2 rounded-lg border p-2 text-xs"><strong>{verdictText[review.verdict]}</strong><span className="ml-2 text-[10px] text-muted-foreground">{formatTime(review.reviewedAt)}</span></div>)}</Section> : null}
				{pendingDecisions.length ? <Section icon={<AlertCircleIcon className="size-4" />} title="人工决策" metric={pendingDecisions.length + " 项待回答"}>{pendingDecisions.map((decision) => <div key={decision.id} className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs"><div className="font-medium">{decision.question}</div>{!readOnly ? <><div className="mt-2 flex flex-wrap gap-1.5">{decision.options?.map((option) => <Button key={option.id} size="sm" variant="outline" disabled={submitting} onClick={() => onAnswer(decision, option.id)}>{option.label}</Button>)}</div><div className="mt-2 flex gap-1.5"><Input value={answerById[decision.id] ?? ""} onChange={(event) => onAnswerChange(decision.id, event.target.value)} placeholder="输入决定" /><Button size="sm" disabled={submitting || !(answerById[decision.id] ?? "").trim()} onClick={() => onAnswer(decision, answerById[decision.id] ?? "")}>提交</Button></div></> : null}</div>)}</Section> : null}
				{unplanned.length ? <Section icon={<Clock3Icon className="size-4" />} title="本 Goal 未绑定 WorkItem 的执行" metric={unplanned.length + " 次"}>{unplanned.map((item) => <button key={item.id} type="button" className="goal-unplanned-row" title="当前 Goal 内未绑定 WorkItem 的委托；不包含本 Session 的历史任务" onClick={() => openProcess(item.id)}><span>{item.agentId} · {item.status}</span><ExternalLinkIcon className="size-3" /></button>)}</Section> : null}
			</div>
			</>}
		</DialogContent>
	</Dialog>;
}
