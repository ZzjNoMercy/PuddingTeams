"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, ListTreeIcon, RefreshCwIcon, TargetIcon } from "lucide-react";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { collaborationTrustOf, isObservationLost, type CollaborationProjectionSource, type WorkerProcessListItem } from "@/lib/api";
import { useAgentLabels } from "@/lib/avatars";
import { WorkerAvatar } from "./worker-avatar";

export type SessionRuntimeView = "activity" | "goal";

export interface SessionRuntimeSummary {
	hasGoal: boolean;
	sessionTotal: number;
	total: number;
	completed: number;
	pending: number;
	running: number;
}

export interface SessionExecutionTurn {
	id: string;
	index: number;
	startedAt: number;
	title: string;
}

interface ActivityTurnGroup {
	id: string;
	index: number;
	title: string;
	isCurrent: boolean;
	items: WorkerProcessListItem[];
}

function isActive(executionState: string): boolean {
	return executionState === "running" || executionState === "waiting_input" || executionState === "cancel_requested" || executionState === "reconciling";
}

const executionLabels: Record<string, string> = {
	admitted: "已接纳", waiting_admission: "等待 Teams 准入", running: "执行中", waiting_input: "等待输入", reported_completed: "Worker 已报告完成",
	reported_failed: "Worker 已报告失败", cancel_requested: "取消请求中", reconciling: "正在重挂原 Run", cancelled: "已取消", observation_lost: "失去观测 · effect_unknown",
};
const verificationLabels: Record<string, string> = {
	not_required: "无需复验", unverified: "未复验", pending: "待复验", running: "复验中", waiting_input: "复验等待输入",
	passed: "已复验", failed: "复验失败", blocked: "复验受阻", stale: "复验已过期",
};
const settlementLabels: Record<string, string> = {
	not_required: "无需结算", pending: "待结算", submitted: "已提交", accepted: "已接受", revision: "需返修", blocked: "已阻塞", cancelled: "已取消",
};
function axisClass(axis: "execution" | "verification" | "settlement", value: string): string {
	if (axis === "execution" && ["observation_lost", "reported_failed"].includes(value)) return "is-danger";
	if (axis === "execution" && value === "reported_completed") return "is-reported";
	if (axis === "verification" && ["failed", "blocked", "stale"].includes(value)) return "is-danger";
	if (axis === "verification" && value === "passed") return "is-good";
	if (axis === "settlement" && value === "accepted") return "is-good";
	if (axis === "settlement" && ["revision", "blocked"].includes(value)) return "is-danger";
	return "";
}

/** Explicit trust projection shared by the activity, goal and process drawers. */
export function CollaborationTrustAxes({ source, compact = false }: { source: CollaborationProjectionSource; compact?: boolean }) {
	const trust = collaborationTrustOf(source);
	const receipt = source.receipt;
	const unknown = isObservationLost(source);
	return (
		<div className={`collaboration-trust ${compact ? "is-compact" : ""}`} aria-label="Execution Verification Settlement 三轴状态">
			<div className="collaboration-trust-axes">
				<span className={`collaboration-trust-axis execution ${axisClass("execution", trust.execution)}`}><b>Execution</b><em>{executionLabels[trust.execution] ?? trust.execution}</em></span>
				<span className={`collaboration-trust-axis verification ${axisClass("verification", trust.verification)}`}><b>Verification</b><em>{verificationLabels[trust.verification] ?? trust.verification}</em></span>
				<span className={`collaboration-trust-axis settlement ${axisClass("settlement", trust.settlement)}`}><b>Settlement</b><em>{settlementLabels[trust.settlement] ?? trust.settlement}</em></span>
			</div>
			{!compact && receipt ? <div className="collaboration-receipt-meta">
				<span>Receipt {receipt.sealedAt ? "sealed" : "已记录"}</span>
				{receipt.contractHash ? <code title={receipt.contractHash}>contract {receipt.contractHash.slice(0, 12)}…</code> : null}
				{receipt.collectionStatus ? <span>证据 {receipt.collectionStatus === "complete" ? "完整" : receipt.collectionStatus === "partial" ? "部分" : "失败"}</span> : null}
				{receipt.integrity && receipt.integrity !== "clean" ? <span className="is-warning">integrity {receipt.integrity}</span> : null}
			</div> : null}
			{unknown ? <div className="collaboration-trust-warning" role="alert"><CircleAlertIcon />执行状态未可观测，真实副作用未知。请重新对账、确认外部状态或人工接管；不要直接重试。</div> : null}
		</div>
	);
}

function taskSummary(item: WorkerProcessListItem): string {
	return item.task?.trim() || item.intent?.trim() || item.expectedOutcome?.trim() || "未命名任务";
}

function orderActivities(items: WorkerProcessListItem[]): WorkerProcessListItem[] {
	return [...items].sort((a, b) => {
		const activeDelta = Number(isActive(b.executionState)) - Number(isActive(a.executionState));
		return activeDelta || b.updatedAt.localeCompare(a.updatedAt);
	});
}

export function groupActivitiesByTurn(items: WorkerProcessListItem[], turns: SessionExecutionTurn[]): ActivityTurnGroup[] {
	const orderedTurns = [...turns].sort((a, b) => a.startedAt - b.startedAt);
	if (orderedTurns.length === 0) {
		return [{ id: "current", index: 1, title: "当前会话", isCurrent: true, items: orderActivities(items) }];
	}
	const groups = new Map(orderedTurns.map((turn) => [turn.id, { ...turn, isCurrent: false, items: [] as WorkerProcessListItem[] }]));
	const orphaned: WorkerProcessListItem[] = [];
	for (const item of items) {
		const createdAt = Date.parse(item.createdAt);
		const owner = Number.isNaN(createdAt) ? undefined : [...orderedTurns].reverse().find((turn) => turn.startedAt <= createdAt);
		if (owner) groups.get(owner.id)?.items.push(item);
		else orphaned.push(item);
	}
	const currentId = orderedTurns.at(-1)!.id;
	const visible = [...groups.values()]
		.filter((group) => group.id === currentId || group.items.length > 0)
		.map((group) => ({ ...group, isCurrent: group.id === currentId, items: orderActivities(group.items) }))
		.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.startedAt - a.startedAt);
	if (orphaned.length > 0) visible.push({ id: "before-first-turn", index: 0, startedAt: 0, title: "会话早期任务", isCurrent: false, items: orderActivities(orphaned) });
	return visible;
}

function durationLabel(item: WorkerProcessListItem, now: number): string {
	const start = Date.parse(item.createdAt);
	const end = isActive(item.executionState) ? now : Date.parse(item.updatedAt);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder ? `${minutes}分${remainder}秒` : `${minutes} 分钟`;
}

export function RuntimeViewTabs({
	view,
	hasGoal,
	onViewChange,
}: {
	view: SessionRuntimeView;
	hasGoal: boolean;
	onViewChange: (view: SessionRuntimeView) => void;
}) {
	if (!hasGoal) return null;
	return (
		<div className="task-runtime-tabs" role="tablist" aria-label="任务与执行视图">
			<button type="button" role="tab" aria-selected={view === "activity"} className={view === "activity" ? "is-active" : ""} onClick={() => onViewChange("activity")}>
				<ListTreeIcon />执行动态
			</button>
			<button type="button" role="tab" aria-selected={view === "goal"} className={view === "goal" ? "is-active" : ""} onClick={() => onViewChange("goal")}>
				<TargetIcon />Goal
			</button>
		</div>
	);
}

export function SessionActivityDrawer({
	items,
	turns,
	loading,
	error,
	hasGoal,
	open,
	onOpenChange,
	onRetry,
	onViewChange,
	onOpenProcess,
}: {
	items: WorkerProcessListItem[];
	turns: SessionExecutionTurn[];
	loading: boolean;
	error?: string;
	hasGoal: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRetry: () => void;
	onViewChange: (view: SessionRuntimeView) => void;
	onOpenProcess: (delegationId: string) => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
	const labels = useAgentLabels();
	const groups = useMemo(() => groupActivitiesByTurn(items, turns), [items, turns]);
	const current = groups.find((group) => group.isCurrent) ?? groups[0]!;
	const selected = (selectedTurnId ? groups.find((group) => group.id === selectedTurnId) : undefined) ?? current;
	const running = current.items.filter((item) => item.executionState === "running" || item.executionState === "reconciling").length;
	const pending = current.items.filter((item) => item.executionState === "waiting_input" || item.executionState === "waiting_admission").length;
	const completed = current.items.filter((item) => item.executionState === "reported_completed").length;
	const selectedRunning = selected.items.filter((item) => item.executionState === "running" || item.executionState === "reconciling").length;
	const selectedPending = selected.items.filter((item) => item.executionState === "waiting_input" || item.executionState === "waiting_admission").length;
	const selectedCompleted = selected.items.filter((item) => item.executionState === "reported_completed").length;

	useEffect(() => {
		if (!open || running === 0) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [open, running]);

	const stateText = pending > 0 ? `${pending} 待处理` : running > 0 ? `${running} 运行中` : null;
	const renderActivities = (activities: WorkerProcessListItem[]) => activities.map((item) => {
		const summary = taskSummary(item);
		const duration = durationLabel(item, now);
		return (
			<button key={item.delegationId} type="button" title="查看执行过程" className={`task-activity-card is-${item.executionState} ${isObservationLost(item) ? "is-observation-lost" : ""}`} onClick={() => onOpenProcess(item.delegationId)}>
				<WorkerAvatar name={item.agentId} size={34} />
				<span className="task-activity-copy">
					<span className="task-activity-worker">{labels[item.agentId] ?? item.agentId}</span>
					<strong>{summary}</strong>
					<CollaborationTrustAxes source={item} compact />
				</span>
				<span className="task-activity-status"><i />{executionLabels[collaborationTrustOf(item).execution] ?? item.executionState}{duration ? ` · ${duration}` : ""}</span>
			</button>
		);
	});

	return (
		<Dialog modal={false} open={open} onOpenChange={onOpenChange}>
			<DialogContent positionMode="drawer" overlayClassName="goal-runtime-overlay" className={`context-drawer runtime-drawer task-runtime-drawer is-activity grid ${hasGoal ? "grid-rows-[auto_auto_minmax(0,1fr)]" : "grid-rows-[auto_minmax(0,1fr)]"} gap-0 p-0`}>
				<DialogHeader className="runtime-drawer-head goal-drawer-head task-runtime-head">
					<div className="goal-drawer-title-row">
						<DialogTitle><ListTreeIcon />任务与执行</DialogTitle>
						{stateText ? <span className={`goal-state-label ${running > 0 ? "is-running" : "is-waiting_human"}`}><i />{stateText}</span> : null}
					</div>
					<DialogDescription className="sr-only">查看当前会话的 Worker 执行动态</DialogDescription>
					{current.items.length > 0 ? <span className="goal-progress-label">{completed}/{current.items.length} 完成</span> : null}
				</DialogHeader>
				<RuntimeViewTabs view="activity" hasGoal={hasGoal} onViewChange={onViewChange} />
				<div className="task-activity-scroll">
					<div className="task-activity-section-head">
						<Select value={selected.id} onValueChange={(value) => setSelectedTurnId(value === current.id ? null : value)}>
							<SelectTrigger size="sm" className="task-turn-select" aria-label="选择执行轮次">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper" align="start" className="task-turn-select-content">
								{groups.map((group) => (
									<SelectItem key={group.id} value={group.id} className="task-turn-select-item">
										{group.isCurrent ? "本轮" : group.index ? `第 ${group.index} 轮` : "会话早期"} · {group.items.length} 个任务
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{selected.id !== current.id ? <span>{selectedPending > 0 ? `${selectedPending} 待处理` : selectedRunning > 0 ? `${selectedRunning} 运行中` : selected.items.length > 0 ? `${selectedCompleted}/${selected.items.length} 完成` : "无任务"}</span> : null}
					</div>
					{loading && items.length === 0 ? (
						<div className="task-activity-empty" role="status"><Loader size={14} />正在加载任务…</div>
					) : error && items.length === 0 ? (
						<div className="task-activity-empty is-error"><CircleAlertIcon /><span>{error}</span><Button size="sm" variant="outline" onClick={onRetry}><RefreshCwIcon />重试</Button></div>
					) : selected.items.length === 0 ? (
						<div className="task-activity-round-empty"><ListTreeIcon /><span>本轮没有派发 Worker 任务</span></div>
					) : (
						<div className="task-activity-list">{renderActivities(selected.items)}</div>
					)}
					{error && items.length > 0 ? <div className="task-activity-stale"><CircleAlertIcon />刷新失败，正在显示上次结果 <button type="button" onClick={onRetry}>重试</button></div> : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
