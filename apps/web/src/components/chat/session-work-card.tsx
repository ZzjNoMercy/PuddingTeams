"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldCheckIcon, TargetIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { answerDecisionRequest, getSessionWorkState, listModels, putSessionWorkState } from "@/lib/api";
import type { CompletionReviewMode, DecisionRequest, DelegationTrace, ModelSummary, SessionGoalSummary, SessionWorkState } from "@/lib/types";
import { SessionRuntimeDrawer } from "./session-runtime-drawer";

function isExecutionLive(status: SessionWorkState["execution"]["status"]): boolean {
	return status === "running" || status === "recovering" || status === "reviewing";
}

export function SessionWorkCard({
	sessionId,
	createOpen,
	onCreateOpenChange,
	initialGoal = "",
	onGoalStateChange,
	onGoalSummaryChange,
	workStateSignal,
	runtimeOpen,
	onRuntimeOpenChange,
}: {
	sessionId: string;
	createOpen: boolean;
	onCreateOpenChange: (open: boolean) => void;
	initialGoal?: string;
	onGoalStateChange?: (hasGoal: boolean) => void;
	onGoalSummaryChange?: (summary: { hasGoal: boolean; pending: number; running: boolean } | null) => void;
	workStateSignal?: string;
	runtimeOpen: boolean;
	onRuntimeOpenChange: (open: boolean) => void;
}) {
	const [workState, setWorkState] = useState<SessionWorkState | null>(null);
	const [activeGoalId, setActiveGoalId] = useState<string | null>(null);
	const [goals, setGoals] = useState<SessionGoalSummary[]>([]);
	const [viewedGoalId, setViewedGoalId] = useState<string>();
	const [decisions, setDecisions] = useState<DecisionRequest[]>([]);
	const [delegations, setDelegations] = useState<DelegationTrace[]>([]);
	const [loading, setLoading] = useState(true);
	const [goal, setGoal] = useState("");
	const [completionBoundary, setCompletionBoundary] = useState("");
	const [reviewMode, setReviewMode] = useState<CompletionReviewMode>("independent");
	const [reviewerModel, setReviewerModel] = useState("__manager__");
	const [models, setModels] = useState<ModelSummary[]>([]);
	const [answerById, setAnswerById] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);
	const [goalLoading, setGoalLoading] = useState(false);
	const [goalLoadError, setGoalLoadError] = useState<string>();
	const [autoFocusWorkItemId, setAutoFocusWorkItemId] = useState<string>();
	const requestSequence = useRef(0);
	const viewedGoalRef = useRef<string | undefined>(undefined);
	const autoOpenedWorkItems = useRef(new Set<string>());
	const autoOpenStartedWorkItem = useCallback((state: SessionWorkState | null, currentGoalId: string | null) => {
		if (!state || state.status !== "active" || state.goalId !== currentGoalId) return;
		const started = Object.values(state.plan?.items ?? {}).filter((item) => item.status === "in_progress" || item.status === "waiting_input");
		const unseen: typeof started = [];
		for (const item of started) {
			const key = `puddingteams:goal-auto-open:${state.goalId}:${item.id}`;
			if (autoOpenedWorkItems.current.has(key)) continue;
			let seen = false;
			try {
				seen = localStorage.getItem(key) === "1";
				if (!seen) localStorage.setItem(key, "1");
			} catch { /* private mode */ }
			autoOpenedWorkItems.current.add(key);
			if (!seen) unseen.push(item);
		}
		if (unseen.length) {
			const latest = unseen.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
			setAutoFocusWorkItemId(latest?.id);
			onRuntimeOpenChange(true);
		}
	}, [onRuntimeOpenChange]);

	const refresh = useCallback(async (goalIdOverride?: string) => {
		const requestedGoalId = goalIdOverride ?? viewedGoalRef.current;
		const requestId = ++requestSequence.current;
		try {
			const result = await getSessionWorkState(sessionId, requestedGoalId);
			if (requestId !== requestSequence.current || requestedGoalId !== viewedGoalRef.current) return;
			if (requestedGoalId && result.workState?.goalId !== requestedGoalId) return;
			setWorkState(result.workState);
			setActiveGoalId(result.activeGoalId);
			setGoals(result.goals);
			onGoalStateChange?.(Boolean(result.activeGoalId));
			setDecisions(result.decisions);
			setDelegations(result.delegations);
			autoOpenStartedWorkItem(result.workState, result.activeGoalId);
			setGoalLoadError(undefined);
			setAutoFocusWorkItemId(undefined);
			setGoalLoading(false);
			const activeSummary = result.goals.find((item) => item.goalId === result.activeGoalId);
			onGoalSummaryChange?.(result.goals.length ? {
				hasGoal: true,
				pending: activeSummary?.pending ?? 0,
				running: activeSummary?.running ?? false,
			} : null);
		} catch (error) {
			if (requestId === requestSequence.current) {
				setGoalLoading(false);
				setGoalLoadError(error instanceof Error ? error.message : String(error));
			}
			throw error;
		}
	}, [autoOpenStartedWorkItem, onGoalStateChange, onGoalSummaryChange, sessionId]);

	useEffect(() => {
		if (!createOpen) return;
		const reset = setTimeout(() => {
			setGoal(initialGoal);
			setCompletionBoundary("");
			setReviewMode("independent");
			setReviewerModel("__manager__");
			void listModels().then(setModels).catch(() => setModels([]));
		}, 0);
		return () => clearTimeout(reset);
	}, [createOpen, initialGoal]);

	useEffect(() => {
		let cancelled = false;
		const initial = setTimeout(() => {
			void refresh()
				.catch((err: unknown) => {
					if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					if (!cancelled) {
						setLoading(false);
					}
				});
		}, 0);
		const timer = setInterval(() => void refresh().catch(() => undefined), 2500);
		return () => {
			cancelled = true;
			clearTimeout(initial);
			clearInterval(timer);
		};
	}, [refresh]);

	useEffect(() => {
		if (!workStateSignal) return;
		void refresh().catch(() => undefined);
	}, [refresh, workStateSignal]);

	const pending = useMemo(() => decisions.filter((item) => item.status === "pending"), [decisions]);

	const createGoal = useCallback(async () => {
		if (!goal.trim() || !completionBoundary.trim()) return;
		if (activeGoalId) {
			toast.error("当前 Goal 已开始执行，请刷新后再创建下一个");
			return;
		}
		const hasHistory = goals.length > 0;
		setSubmitting(true);
		try {
			const next = await putSessionWorkState(sessionId, {
					goal: goal.trim(),
					completionBoundary: completionBoundary.trim(),
					reviewMode,
					...(reviewMode === "independent" && reviewerModel !== "__manager__" ? { reviewerModel } : {}),
				});
			setWorkState(next);
			setActiveGoalId(next.goalId);
			viewedGoalRef.current = undefined;
			setViewedGoalId(undefined);
			setGoalLoading(false);
			setGoalLoadError(undefined);
			setGoals((previous) => [{ goalId: next.goalId, goal: next.goal, status: next.status, executionStatus: next.execution.status, pending: 0, running: false, createdAt: next.createdAt, updatedAt: next.updatedAt }, ...previous.filter((item) => item.goalId !== next.goalId)]);
			setDecisions([]);
			setDelegations([]);
			setAnswerById({});
			onGoalStateChange?.(true);
			onGoalSummaryChange?.({ hasGoal: true, pending: 0, running: false });
			onCreateOpenChange(false);
			toast.success(hasHistory ? "已创建下一个 Goal，已切换到最新目标" : "已创建 Goal");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}, [activeGoalId, completionBoundary, goal, goals.length, onCreateOpenChange, onGoalStateChange, onGoalSummaryChange, reviewMode, reviewerModel, sessionId]);

	const selectGoal = useCallback((goalId: string) => {
		requestSequence.current += 1;
		viewedGoalRef.current = goalId;
		setViewedGoalId(goalId);
		setGoalLoading(true);
		setGoalLoadError(undefined);
		setAnswerById({});
		void refresh(goalId).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
	}, [refresh]);

	const retryGoal = useCallback(() => {
		requestSequence.current += 1;
		setGoalLoading(true);
		setGoalLoadError(undefined);
		void refresh(viewedGoalRef.current).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
	}, [refresh]);

	const answer = useCallback(async (decision: DecisionRequest, value: string) => {
		if (!value.trim()) return;
		setSubmitting(true);
		try {
			await answerDecisionRequest(decision.id, value.trim(), decision.authorizationScope);
			await refresh();
			toast.success("已回答，manager 将在同一 Goal 中继续");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}, [refresh]);

	const createDialog = (
		<Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
						<TargetIcon className="size-4.5" />
					</div>
					<DialogTitle><span className="font-mono text-primary">/goal</span> 创建持续目标</DialogTitle>
					<DialogDescription>manager 会持续推进这项工作；满足你确认的完成条件后才会结束。</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					{goalLoadError ? <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive"><span>目标状态加载失败，暂时不能创建：{goalLoadError}</span><Button size="sm" variant="outline" onClick={retryGoal}>重新加载</Button></div> : null}
					<label className="space-y-1.5 text-sm">
						<span className="font-medium">想达成什么？</span>
						<Textarea autoFocus value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} placeholder="例如：完成登录页改版并交付可测试版本" />
					</label>
					<label className="space-y-1.5 text-sm">
						<span className="font-medium">完成条件</span>
						<Textarea value={completionBoundary} onChange={(event) => setCompletionBoundary(event.target.value)} rows={3} placeholder={"每行一个可验证条件，例如：\n功能按需求实现\n相关测试通过\n给出可审核的最终结果"} />
						<span className="block text-xs text-muted-foreground">创建后即冻结为验收标准；验收者只能核对证据，不能降低标准。</span>
					</label>
					<div className="space-y-2">
						<div className="text-sm font-medium">完成验收</div>
						<div className="grid grid-cols-2 gap-2">
							<button type="button" aria-pressed={reviewMode === "independent"} onClick={() => setReviewMode("independent")} className={`rounded-xl border p-3 text-left transition-colors ${reviewMode === "independent" ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
								<div className="flex items-center gap-2 text-sm font-medium"><ShieldCheckIcon className="size-4" />独立验收</div>
								<div className="mt-1 text-xs text-muted-foreground">全新只读上下文，逐项核对证据</div>
							</button>
							<button type="button" aria-pressed={reviewMode === "manager"} onClick={() => setReviewMode("manager")} className={`rounded-xl border p-3 text-left transition-colors ${reviewMode === "manager" ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
								<div className="text-sm font-medium">Manager 验收</div>
								<div className="mt-1 text-xs text-muted-foreground">更快，不增加额外模型调用</div>
							</button>
						</div>
						{reviewMode === "independent" ? (
							<Select value={reviewerModel} onValueChange={setReviewerModel}>
								<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
								<SelectContent>
									<SelectItem value="__manager__">自动 · 与 manager 同模型，独立上下文</SelectItem>
									{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.provider} · {model.name}</SelectItem>)}
								</SelectContent>
							</Select>
						) : null}
						{reviewMode === "independent" && reviewerModel !== "__manager__" ? <div className="text-xs text-muted-foreground">冻结目标与证据摘要会发送给所选模型服务进行验收。</div> : null}
					</div>
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onCreateOpenChange(false)}>取消</Button>
					<Button disabled={submitting || Boolean(goalLoadError) || !goal.trim() || !completionBoundary.trim()} onClick={() => void createGoal()}>创建 Goal</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

	if (loading) return createDialog;
	if (!workState) {
		return <>{createDialog}<Dialog open={runtimeOpen} onOpenChange={onRuntimeOpenChange}><DialogContent positionMode="drawer" className="context-drawer runtime-drawer goal-runtime-drawer gap-0 p-0"><DialogHeader className="runtime-drawer-head goal-drawer-head"><DialogTitle>目标与执行</DialogTitle><DialogDescription className="sr-only">目标状态加载结果</DialogDescription></DialogHeader><div className="goal-view-loading" role="status"><strong>{goalLoading ? "正在加载 Goal…" : "Goal 加载失败"}</strong>{goalLoadError ? <span>{goalLoadError}</span> : null}{!goalLoading ? <Button size="sm" variant="outline" onClick={retryGoal}>重新加载</Button> : null}</div></DialogContent></Dialog></>;
	}

	return (
		<>
		{createDialog}
		<SessionRuntimeDrawer
			key={`${workState.goalId}:${autoFocusWorkItemId ?? ""}`}
			workState={workState}
			initialWorkItemId={autoFocusWorkItemId}
			activeGoalId={activeGoalId}
			goals={goals}
			selectedGoalId={viewedGoalId ?? workState.goalId}
			goalLoading={goalLoading}
			goalLoadError={goalLoadError}
			decisions={decisions}
			delegations={delegations}
			answerById={answerById}
			submitting={submitting}
			open={runtimeOpen}
			onOpenChange={onRuntimeOpenChange}
			onGoalSelect={selectGoal}
			onRetryGoal={retryGoal}
			onAnswerChange={(decisionId, value) => setAnswerById((prev) => ({ ...prev, [decisionId]: value }))}
			onAnswer={(decision, value) => void answer(decision, value)}
			onWorkStateChange={(state) => {
				setWorkState(state);
				setActiveGoalId(state.status === "active" ? state.goalId : null);
				onGoalStateChange?.(state.status === "active");
				const items = Object.values(state.plan?.items ?? {});
				const nextPending = pending.length + items.filter((item) => item.status === "submitted").length + (state.plan?.needsReconcile ? 1 : 0) + (state.execution.status === "interrupted" ? 1 : 0);
				const nextRunning = isExecutionLive(state.execution.status);
				setGoals((previous) => previous.map((item) => item.goalId === state.goalId ? { ...item, goal: state.goal, status: state.status, executionStatus: state.execution.status, pending: nextPending, running: nextRunning, updatedAt: state.updatedAt } : item));
				onGoalSummaryChange?.({
					hasGoal: true,
					pending: nextPending,
					running: nextRunning,
				});
			}}
		/>
		</>
	);
}
