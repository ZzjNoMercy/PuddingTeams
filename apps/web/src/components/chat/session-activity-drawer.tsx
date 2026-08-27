"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, ListTreeIcon, RefreshCwIcon, TargetIcon } from "lucide-react";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WorkerProcessListItem } from "@/lib/api";
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

function isActive(status: string): boolean {
	return status === "running" || status === "waiting_input";
}

function statusLabel(status: string): string {
	return {
		running: "执行中",
		waiting_input: "等待输入",
		completed: "已完成",
		failed: "失败",
		cancelled: "已取消",
	}[status] ?? status;
}

function taskSummary(item: WorkerProcessListItem): string {
	return item.task?.trim() || item.intent?.trim() || item.expectedOutcome?.trim() || "未命名任务";
}

function orderActivities(items: WorkerProcessListItem[]): WorkerProcessListItem[] {
	return [...items].sort((a, b) => {
		const activeDelta = Number(isActive(b.status)) - Number(isActive(a.status));
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
	const end = isActive(item.status) ? now : Date.parse(item.updatedAt);
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
	const running = current.items.filter((item) => item.status === "running").length;
	const pending = current.items.filter((item) => item.status === "waiting_input").length;
	const completed = current.items.filter((item) => item.status === "completed").length;
	const selectedRunning = selected.items.filter((item) => item.status === "running").length;
	const selectedPending = selected.items.filter((item) => item.status === "waiting_input").length;
	const selectedCompleted = selected.items.filter((item) => item.status === "completed").length;

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
			<button key={item.delegationId} type="button" title="查看执行过程" className={`task-activity-card is-${item.status}`} onClick={() => onOpenProcess(item.delegationId)}>
				<WorkerAvatar name={item.agentId} size={34} />
				<span className="task-activity-copy">
					<span className="task-activity-worker">{labels[item.agentId] ?? item.agentId}</span>
					<strong>{summary}</strong>
				</span>
				<span className="task-activity-status"><i />{statusLabel(item.status)}{duration ? ` · ${duration}` : ""}</span>
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
						<label className="task-turn-select">
							<span className="sr-only">选择执行轮次</span>
							<select aria-label="选择执行轮次" value={selected.id} onChange={(event) => setSelectedTurnId(event.target.value === current.id ? null : event.target.value)}>
								{groups.map((group) => <option key={group.id} value={group.id}>{group.isCurrent ? "本轮" : group.index ? `第 ${group.index} 轮` : "会话早期"} · {group.items.length} 个任务</option>)}
							</select>
						</label>
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
