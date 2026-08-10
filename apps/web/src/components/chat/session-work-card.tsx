"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, CircleDotIcon, FlagIcon, PauseCircleIcon } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { answerDecisionRequest, getSessionWorkState, putSessionWorkState } from "@/lib/api";
import type { DecisionRequest, DelegationTrace, SessionWorkState } from "@/lib/types";

const statusText: Record<SessionWorkState["status"], string> = {
	active: "进行中",
	waiting_human: "等待人类",
	resolved: "已完成",
	cancelled: "已取消",
};

export function SessionWorkCard({ sessionId }: { sessionId: string }) {
	const [workState, setWorkState] = useState<SessionWorkState | null>(null);
	const [decisions, setDecisions] = useState<DecisionRequest[]>([]);
	const [delegations, setDelegations] = useState<DelegationTrace[]>([]);
	const [loading, setLoading] = useState(true);
	const [goalOpen, setGoalOpen] = useState(false);
	const [goal, setGoal] = useState("");
	const [completionBoundary, setCompletionBoundary] = useState("");
	const [answerById, setAnswerById] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);

	const refresh = useCallback(async () => {
		const result = await getSessionWorkState(sessionId);
		setWorkState(result.workState);
		setDecisions(result.decisions);
		setDelegations(result.delegations);
	}, [sessionId]);

	useEffect(() => {
		let cancelled = false;
		const initial = setTimeout(() => {
			void refresh()
				.catch((err: unknown) => {
					if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}, 0);
		const timer = setInterval(() => void refresh().catch(() => undefined), 8000);
		return () => {
			cancelled = true;
			clearTimeout(initial);
			clearInterval(timer);
		};
	}, [refresh]);

	const pending = useMemo(() => decisions.filter((item) => item.status === "pending"), [decisions]);

	const createGoal = useCallback(async () => {
		if (!goal.trim() || !completionBoundary.trim()) return;
		setSubmitting(true);
		try {
			setWorkState(
				await putSessionWorkState(sessionId, {
					goal: goal.trim(),
					completionBoundary: completionBoundary.trim(),
				}),
			);
			setGoalOpen(false);
			toast.success("该会话已设为 Goal");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}, [completionBoundary, goal, sessionId]);

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

	if (loading) return null;
	if (!workState) {
		return (
			<>
				<div className="border-y bg-muted/20 px-4 py-2">
					<div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<FlagIcon className="size-3.5" />
							普通会话：适合一次性问答；需要持续跟进时可设为 Goal。
						</div>
						<Button size="sm" variant="outline" onClick={() => setGoalOpen(true)}>设为 Goal</Button>
					</div>
				</div>
				<Dialog open={goalOpen} onOpenChange={setGoalOpen}>
					<DialogContent className="sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>把当前会话设为 Goal</DialogTitle>
							<DialogDescription>Goal 会由 manager 持续维护当前摘要、下一步和人类决策，直到满足完成边界。</DialogDescription>
						</DialogHeader>
						<label className="space-y-1.5 text-sm">
							<span className="font-medium">目标</span>
							<Textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} placeholder="要改变什么状态、为谁创造什么结果？" />
						</label>
						<label className="space-y-1.5 text-sm">
							<span className="font-medium">完成边界</span>
							<Textarea value={completionBoundary} onChange={(event) => setCompletionBoundary(event.target.value)} rows={3} placeholder="哪些可验证条件全部满足后才算完成？" />
						</label>
						<DialogFooter>
							<Button variant="ghost" onClick={() => setGoalOpen(false)}>取消</Button>
							<Button disabled={submitting || !goal.trim() || !completionBoundary.trim()} onClick={() => void createGoal()}>创建 Goal</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</>
		);
	}

	const StatusIcon = workState.status === "resolved" ? CheckCircle2Icon : workState.status === "waiting_human" ? PauseCircleIcon : CircleDotIcon;
	return (
		<div className="border-y bg-muted/20 px-4 py-2.5">
			<div className="mx-auto max-w-3xl space-y-2">
				<div className="flex items-start gap-2">
					<StatusIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="text-xs font-medium">当前工作 · {statusText[workState.status]}</span>
							<span className="text-[11px] text-muted-foreground">r{workState.revision}</span>
						</div>
						<div className="truncate text-sm font-medium" title={workState.goal}>{workState.goal}</div>
						<div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
							{workState.currentBrief || `完成边界：${workState.completionBoundary}`}
						</div>
						{workState.nextAction ? <div className="mt-1 text-xs"><span className="text-muted-foreground">下一步：</span>{workState.nextAction}</div> : null}
					</div>
				</div>
				{pending.map((decision) => (
					<div key={decision.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs">
						<div className="font-medium">需要你的决定：{decision.question}</div>
						{decision.context ? <div className="mt-1 text-muted-foreground">{decision.context}</div> : null}
						<div className="mt-2 flex flex-wrap gap-1.5">
							{decision.options?.map((option) => (
								<Button key={option.id} size="sm" variant="outline" disabled={submitting} onClick={() => void answer(decision, option.id)}>{option.label}</Button>
							))}
							<div className="flex min-w-56 flex-1 gap-1.5">
								<Input value={answerById[decision.id] ?? ""} onChange={(event) => setAnswerById((prev) => ({ ...prev, [decision.id]: event.target.value }))} placeholder="输入其他决定" className="h-8 text-xs" />
								<Button size="sm" disabled={submitting || !(answerById[decision.id] ?? "").trim()} onClick={() => void answer(decision, answerById[decision.id] ?? "")}>提交</Button>
							</div>
						</div>
					</div>
				))}
				{delegations.length > 0 ? (
					<details className="text-xs text-muted-foreground">
						<summary className="cursor-pointer select-none">委托链 · {delegations.length} 步</summary>
						<div className="mt-1.5 space-y-1 border-l pl-2.5">
							{delegations.slice(0, 5).map((item) => (
								<div key={item.id}>
									<span className="font-medium text-foreground">{item.agentId}</span>
									<span> · {item.handoffKind ?? "request"} · {item.intent || "普通委托"} · {item.status}</span>
									{item.parentDelegationId ? <span title={item.parentDelegationId}> · 接力</span> : null}
								</div>
							))}
						</div>
					</details>
				) : null}
			</div>
		</div>
	);
}
