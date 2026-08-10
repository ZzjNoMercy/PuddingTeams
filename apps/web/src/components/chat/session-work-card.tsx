"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, CircleDotIcon, PauseCircleIcon, ShieldCheckIcon, TargetIcon } from "lucide-react";
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
import type { CompletionReviewMode, DecisionRequest, DelegationTrace, ModelSummary, SessionWorkState } from "@/lib/types";
import { SessionRuntimeDrawer } from "./session-runtime-drawer";

const statusText: Record<SessionWorkState["status"], string> = {
	active: "进行中",
	waiting_human: "等待人类",
	resolved: "已完成",
	cancelled: "已取消",
};

export function SessionWorkCard({
	sessionId,
	createOpen,
	onCreateOpenChange,
	initialGoal = "",
	onGoalStateChange,
	onReady,
}: {
	sessionId: string;
	createOpen: boolean;
	onCreateOpenChange: (open: boolean) => void;
	initialGoal?: string;
	onGoalStateChange?: (hasGoal: boolean) => void;
	onReady?: () => void;
}) {
	const [workState, setWorkState] = useState<SessionWorkState | null>(null);
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

	const refresh = useCallback(async () => {
		const result = await getSessionWorkState(sessionId);
		setWorkState(result.workState);
		onGoalStateChange?.(Boolean(result.workState));
		setDecisions(result.decisions);
		setDelegations(result.delegations);
	}, [onGoalStateChange, sessionId]);

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
		let readyFrame: number | null = null;
		const initial = setTimeout(() => {
			void refresh()
				.catch((err: unknown) => {
					if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					if (!cancelled) {
						setLoading(false);
						readyFrame = requestAnimationFrame(() => {
							if (!cancelled) onReady?.();
						});
					}
				});
		}, 0);
		const timer = setInterval(() => void refresh().catch(() => undefined), 8000);
		return () => {
			cancelled = true;
			clearTimeout(initial);
			if (readyFrame !== null) cancelAnimationFrame(readyFrame);
			clearInterval(timer);
		};
	}, [onReady, refresh]);

	const pending = useMemo(() => decisions.filter((item) => item.status === "pending"), [decisions]);

	const createGoal = useCallback(async () => {
		if (!goal.trim() || !completionBoundary.trim()) return;
		setSubmitting(true);
		try {
			setWorkState(
				await putSessionWorkState(sessionId, {
					goal: goal.trim(),
					completionBoundary: completionBoundary.trim(),
					reviewMode,
					...(reviewMode === "independent" && reviewerModel !== "__manager__" ? { reviewerModel } : {}),
				}),
			);
			onGoalStateChange?.(true);
			onCreateOpenChange(false);
			toast.success("该会话已设为 Goal");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}, [completionBoundary, goal, onCreateOpenChange, onGoalStateChange, reviewMode, reviewerModel, sessionId]);

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
					<label className="space-y-1.5 text-sm">
						<span className="font-medium">想达成什么？</span>
						<Textarea autoFocus value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} placeholder="例如：完成登录页改版并交付可测试版本" />
					</label>
					<label className="space-y-1.5 text-sm">
						<span className="font-medium">完成条件</span>
						<Textarea value={completionBoundary} onChange={(event) => setCompletionBoundary(event.target.value)} rows={3} placeholder={"每行一个可验证条件，例如：\n功能按需求实现\n相关测试通过\n给出可审核的最终结果"} />
						<span className="block text-xs text-muted-foreground">创建后作为冻结的验收语义；reviewer 只能解释和核对，不能降低条件。</span>
					</label>
					<div className="space-y-2">
						<div className="text-sm font-medium">完成复核</div>
						<div className="grid grid-cols-2 gap-2">
							<button type="button" aria-pressed={reviewMode === "independent"} onClick={() => setReviewMode("independent")} className={`rounded-xl border p-3 text-left transition-colors ${reviewMode === "independent" ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
								<div className="flex items-center gap-2 text-sm font-medium"><ShieldCheckIcon className="size-4" />独立复核</div>
								<div className="mt-1 text-xs text-muted-foreground">全新只读上下文，逐项核对证据</div>
							</button>
							<button type="button" aria-pressed={reviewMode === "manager"} onClick={() => setReviewMode("manager")} className={`rounded-xl border p-3 text-left transition-colors ${reviewMode === "manager" ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
								<div className="text-sm font-medium">manager 自审</div>
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
						{reviewMode === "independent" && reviewerModel !== "__manager__" ? <div className="text-xs text-muted-foreground">冻结目标与证据摘要会发送给所选模型服务进行复核。</div> : null}
					</div>
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onCreateOpenChange(false)}>取消</Button>
					<Button disabled={submitting || !goal.trim() || !completionBoundary.trim()} onClick={() => void createGoal()}>创建 Goal</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

	if (loading) return createDialog;
	if (!workState) {
		return createDialog;
	}

	const StatusIcon = workState.status === "resolved" ? CheckCircle2Icon : workState.status === "waiting_human" ? PauseCircleIcon : CircleDotIcon;
	return (
		<>
		{createDialog}
		<div className="border-b bg-muted/15 px-4 py-2.5">
			<div className="mx-auto max-w-3xl space-y-2">
				<div className="flex items-start gap-2">
					<StatusIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="text-xs font-medium">当前工作 · {statusText[workState.status]}</span>
							<span className="text-[11px] text-muted-foreground">r{workState.revision}</span>
							{workState.reviewMode === "independent" ? <span className="inline-flex items-center gap-1 rounded-full bg-primary/8 px-1.5 py-0.5 text-[10px] text-primary"><ShieldCheckIcon className="size-3" />独立复核</span> : null}
						</div>
						<div className="truncate text-sm font-medium" title={workState.goal}>{workState.goal}</div>
						<div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{workState.currentBrief || "尚未记录当前进度"}</div>
						{workState.nextAction ? <div className="mt-1 text-xs"><span className="text-muted-foreground">下一步：</span>{workState.nextAction}</div> : null}
						<div className="mt-2 flex items-center gap-2">
							<SessionRuntimeDrawer
								workState={workState}
								decisions={decisions}
								delegations={delegations}
								answerById={answerById}
								submitting={submitting}
								onAnswerChange={(decisionId, value) => setAnswerById((prev) => ({ ...prev, [decisionId]: value }))}
								onAnswer={(decision, value) => void answer(decision, value)}
							/>
							<span className="text-[10px] text-muted-foreground">{workState.completionBoundary.split(/\r?\n/).filter((item) => item.trim()).length} 项验收条件 · {workState.completionReviews.length} 次复核</span>
						</div>
					</div>
				</div>
				{pending.length > 0 ? <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-800">需要你的决定：{pending[0]?.question}。请在“运行详情”中处理。</div> : null}
			</div>
		</div>
		</>
	);
}
