"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BrainIcon, CheckCircle2Icon, CircleDotIcon, FilePenIcon, ListChecksIcon, MessageSquareIcon, SearchIcon, ShieldAlertIcon, SlidersHorizontalIcon, TerminalIcon, WrenchIcon, XCircleIcon, XIcon } from "lucide-react";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkerProcess } from "@/hooks/useWorkerProcess";
import { useDelegationTimeline } from "@/hooks/useDelegationTimeline";
import { fetchRoomDelegationProcesses, isObservationLost, reconcileDelegation, takeoverDelegation, type WorkerProcessInfo, type WorkerProcessListItem } from "@/lib/api";
import { toast } from "sonner";
import type { DelegationTimelineEvent } from "@/lib/types";
import { timelineForDisplay, type TimelineDisplayEvent } from "@/lib/delegation-timeline-display";
import { groupForRender, type RenderItem } from "@/lib/events";
import { useAgentLabels } from "@/lib/avatars";
import { workerProcessPresentation } from "@/lib/worker-process-presentation";
import { AssistantGroup, Message } from "./message";
import { WorkerAvatar } from "./worker-avatar";
import { CollaborationTrustAxes } from "./session-activity-drawer";

function WorkerProcessBody({
	delegationId,
	full,
}: {
	delegationId: string;
	full: boolean;
}) {
	const { messages, loading, live, agentId, status, createdAt, error } = useWorkerProcess(delegationId, full);
	const resolvedTaskIds = useMemo(() => new Set<string>(), []);

	// 完整会话模式下，本次委托的起点（此前都是历史任务的过程）。
	// 分组在分界两侧分别进行，保证分隔线落在精确的消息边界上。
	const since = Date.parse(createdAt);
	const boundaryIdx = full && !Number.isNaN(since) ? messages.findIndex((m) => m.timestamp >= since) : -1;
	const items = useMemo<(RenderItem | "divider")[]>(() => {
		if (boundaryIdx > 0) {
			return [
				...groupForRender(messages.slice(0, boundaryIdx)),
				"divider" as const,
				...groupForRender(messages.slice(boundaryIdx)),
			];
		}
		return groupForRender(messages);
	}, [messages, boundaryIdx]);
	const currentTaskMessages = Number.isNaN(since) ? messages : messages.filter((message) => message.timestamp >= since);
	const waitingForFirstModelEvent = status === "running"
		&& !currentTaskMessages.some((message) => message.role === "assistant" || message.role === "toolResult");

	if (loading) {
		return (
			<div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" role="status">
				<span className="flex items-center gap-2"><Loader size={14} />正在加载执行过程…</span>
			</div>
		);
	}
	if (error) {
		return (
			<div className="flex flex-1 items-center justify-center text-xs text-destructive">
				加载失败：{error}
			</div>
		);
	}

	return (
		<Conversation initial="instant" className="min-h-0 flex-1">
				<ConversationContent className="home-message-column">
					{messages.length === 0 ? (
						<div className="flex flex-1 items-center justify-center pt-16 text-sm text-muted-foreground">
							worker 会话还没有消息
						</div>
					) : (
						items.map((item) => {
							if (item === "divider") {
								return (
									<div key="divider" className="my-2 flex items-center gap-3 text-[11px] text-muted-foreground">
										<span className="h-px flex-1 bg-border" />
										本次委托从这里开始
										<span className="h-px flex-1 bg-border" />
									</div>
								);
							}
							if ("kind" in item) {
								return (
									<AssistantGroup
										key={item.id}
										roomId=""
										messages={item.messages}
										windowType="direct"
										assistantAs={agentId || undefined}
									/>
								);
							}
							return (
								<Message key={item.id} roomId="" message={item} windowType="direct" resolvedTaskIds={resolvedTaskIds} assistantAs={agentId || undefined} />
							);
						})
					)}
					{waitingForFirstModelEvent ? (
						<div className="mx-auto my-3 flex w-full max-w-xl items-center gap-3 rounded-xl border border-dashed bg-muted/25 px-4 py-3 text-xs text-muted-foreground" role="status">
							<Loader size={14} />
							<span>{live ? "模型响应中… 已连接 Pi worker，正在等待 Provider 返回首个模型事件。" : "Pi worker 正在启动，等待模型会话就绪…"}</span>
						</div>
					) : null}
				</ConversationContent>
				<ConversationScrollButton aria-label="回到底部" title="回到底部" />
		</Conversation>
	);
}

const activityIcons: Record<DelegationTimelineEvent["kind"], typeof CircleDotIcon> = {
	lifecycle: CircleDotIcon,
	assistant: MessageSquareIcon,
	reasoning: BrainIcon,
	tool: WrenchIcon,
	file: FilePenIcon,
	search: SearchIcon,
	plan: ListChecksIcon,
	approval: ShieldAlertIcon,
	error: XCircleIcon,
};

function TimelineEvent({ event }: { event: TimelineDisplayEvent }) {
	const Icon = event.kind === "tool" && event.metadata?.tool === "command_execution" ? TerminalIcon : activityIcons[event.kind];
	const failed = event.status === "failed";
	const completed = event.status === "completed" || event.status === "resolved";
	const time = new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const seqLabel = event.displaySeqEnd && event.displaySeqEnd !== event.seq ? `${event.seq}–${event.displaySeqEnd}` : String(event.seq);
	const storedEventCount = typeof event.metadata?.tokenEventCount === "number" ? event.metadata.tokenEventCount : undefined;
	const eventCount = event.displayEventCount ?? storedEventCount;
	const sourceLabel = eventCount && eventCount > 1 ? `${event.sourceEvent} ×${eventCount}` : event.sourceEvent;
	return (
		<div className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 pb-3 last:pb-0">
			<div className="absolute bottom-0 left-[11px] top-6 w-px bg-border last:hidden" />
			<div className={`relative z-10 mt-0.5 flex size-5 items-center justify-center rounded-full border bg-background ${failed ? "border-destructive/50 text-destructive" : completed ? "border-emerald-500/40 text-emerald-600" : "text-muted-foreground"}`}>
				{completed ? <CheckCircle2Icon className="size-3" /> : <Icon className="size-3" />}
			</div>
			<div className="min-w-0 border-b border-border/60 pb-3 last:border-0">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<p className="text-xs font-medium leading-5">{event.title}</p>
						<p className="truncate text-[10px] text-muted-foreground">#{seqLabel} · {sourceLabel}</p>
					</div>
					<time className="shrink-0 text-[10px] text-muted-foreground">{time}</time>
				</div>
				{event.content ? (
					<details className="mt-2">
						<summary className="cursor-pointer text-xs text-muted-foreground">
							{event.kind === "assistant" ? "查看回复" : "查看详情"}
						</summary>
						<pre className={`mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 leading-relaxed ${event.kind === "assistant" ? "bg-muted/45 px-3 py-2.5 font-sans text-xs text-foreground/90" : "bg-muted/60 font-mono text-[11px]"}`}>{event.content}</pre>
					</details>
				) : null}
			</div>
		</div>
	);
}

function WorkerTimelineBody({
	delegationId,
}: {
	delegationId: string;
}) {
	const { events, loading, error } = useDelegationTimeline(delegationId);
	const displayEvents = useMemo(() => timelineForDisplay(events), [events]);

	if (loading) return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader size={14} />正在加载时间线…</div>;
	if (error) return <div className="flex flex-1 items-center justify-center text-xs text-destructive">加载失败：{error}</div>;
	return (
		<Conversation initial="instant" className="min-h-0 flex-1">
			<ConversationContent className="mx-auto w-full max-w-2xl px-4 py-4">
				{displayEvents.length ? displayEvents.map((event) => <TimelineEvent key={event.id} event={event} />) : (
					<div className="flex flex-1 items-center justify-center pt-16 text-sm text-muted-foreground">等待 worker 上报事件…</div>
				)}
			</ConversationContent>
			<ConversationScrollButton aria-label="回到底部" title="回到底部" />
		</Conversation>
	);
}

function WorkerProcessRouter({
	info,
	full,
}: {
	info: WorkerProcessInfo;
	full: boolean;
}) {
	const presentation = workerProcessPresentation(info);
	if (presentation === "waiting_admission") {
		return <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">当前正在等待 Teams 准入决定。</div>;
	}
	if (presentation === "starting") {
		return <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">Teams 已接纳任务，正在等待 Worker 上报首个执行事件。</div>;
	}
	if (presentation === "terminal_without_start_evidence") {
		return <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">Teams 未观测到 Worker 启动；任务已经结束。具体原因请查看上方执行状态。</div>;
	}
	return info.view === "session"
		? <WorkerProcessBody delegationId={info.delegationId} full={full} />
		: <WorkerTimelineBody delegationId={info.delegationId} />;
}

function processSummary(item: WorkerProcessListItem, maxLength = 36): string {
	const source = item.task?.trim() || item.intent?.trim() || item.expectedOutcome?.trim() || "未命名委托";
	const firstLine = source
		.replace(/^[\s#>*\-–—]+/, "")
		.replace(/\s+/g, " ")
		.split(/[。！？!?]/, 1)[0]
		.trim();
	if (firstLine.length <= maxLength) return firstLine;
	return `${firstLine.slice(0, maxLength).trimEnd()}…`;
}

function shortTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Room/session-scoped worker process inspector: pi, Codex and PuddingClaw. */
export function WorkerProcessDrawer({
	roomId,
	managerSessionId,
	requestedDelegationId,
	showWorkerFilter,
	open,
	onOpenChange,
}: {
	roomId: string;
	managerSessionId: string;
	requestedDelegationId: string | null;
	showWorkerFilter: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [items, setItems] = useState<WorkerProcessListItem[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [fullSessionDelegationId, setFullSessionDelegationId] = useState<string | null>(null);
	const [takeoverRationale, setTakeoverRationale] = useState("");
	const [reconciling, setReconciling] = useState(false);
	const labels = useAgentLabels();
	const orderedItems = useMemo(() => [...items].sort((a, b) => {
		const activeA = a.executionState === "running" || a.executionState === "waiting_input" || a.executionState === "cancel_requested" || a.executionState === "reconciling" ? 1 : 0;
		const activeB = b.executionState === "running" || b.executionState === "waiting_input" || b.executionState === "cancel_requested" || b.executionState === "reconciling" ? 1 : 0;
		return activeB - activeA || b.updatedAt.localeCompare(a.updatedAt);
	}), [items]);
	const selected = orderedItems.find((item) => item.delegationId === selectedId) ?? null;
	const workerOptions = useMemo(() => {
		const byAgent = new Map<string, { agentId: string; count: number; active: boolean; latest: WorkerProcessListItem }>();
		for (const item of orderedItems) {
			const current = byAgent.get(item.agentId);
			const active = item.executionState === "running" || item.executionState === "waiting_input" || item.executionState === "cancel_requested" || item.executionState === "reconciling";
			if (current) {
				current.count += 1;
				current.active ||= active;
			} else {
				byAgent.set(item.agentId, { agentId: item.agentId, count: 1, active, latest: item });
			}
		}
		return [...byAgent.values()];
	}, [orderedItems]);
	const selectedWorkerItems = useMemo(
		() => selected ? orderedItems.filter((item) => item.agentId === selected.agentId) : [],
		[orderedItems, selected],
	);

	const refresh = useCallback(async () => {
		try {
			const next = await fetchRoomDelegationProcesses(roomId, managerSessionId);
			setItems(next);
			setError(null);
			setSelectedId((current) => {
				if (current && next.some((item) => item.delegationId === current)) return current;
				if (requestedDelegationId && next.some((item) => item.delegationId === requestedDelegationId)) return requestedDelegationId;
				return next[0]?.delegationId ?? null;
			});
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, [managerSessionId, requestedDelegationId, roomId]);

	useEffect(() => {
		if (!open) return;
		const initial = setTimeout(() => void refresh(), 0);
		const timer = setInterval(() => void refresh(), 2500);
		return () => {
			clearTimeout(initial);
			clearInterval(timer);
		};
	}, [open, refresh]);

	useEffect(() => {
		if (!open) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onOpenChange(false);
		};
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [onOpenChange, open]);

	const activeCount = orderedItems.filter((item) => item.executionState === "running" || item.executionState === "waiting_input" || item.executionState === "cancel_requested" || item.executionState === "reconciling").length;
	const showFullSession = selected !== null && fullSessionDelegationId === selected.delegationId;
	const selectItem = (item: WorkerProcessListItem) => {
		setSelectedId(item.delegationId);
		setTakeoverRationale("");
	};
	const resolveUnknown = async (takeover = false) => {
		if (!selected) return;
		setReconciling(true);
		try {
			const result = takeover
				? await takeoverDelegation(selected.delegationId, takeoverRationale.trim(), selected.goalId)
				: await reconcileDelegation(selected.delegationId, selected.goalId);
			if (takeover) setTakeoverRationale("");
			await refresh();
			toast.success(takeover ? "已确认终止并完成人工接管" : `对账结果：${result.executionState}`);
		} catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)) } finally { setReconciling(false) }
	};

	return (
		<aside className={`worker-process-inspector ${open ? "open" : ""}`} aria-hidden={!open} inert={!open} aria-label="执行过程抽屉">
			<div className="worker-process-panel flex h-full min-w-0 flex-col overflow-hidden">
				<header className="worker-process-head flex shrink-0 items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="text-sm font-semibold">执行过程</h2>
							{activeCount > 0 ? <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />{activeCount} 个运行中</span> : null}
						</div>
						<p className="mt-1 text-[11px] text-muted-foreground">{showWorkerFilter ? "先选择 Worker，再查看一次委托的完整任务流。" : "查看每次委托的完整任务流与原始事件。"}</p>
					</div>
					<button type="button" aria-label="关闭执行过程" onClick={() => onOpenChange(false)} className="chat-info-close"><XIcon className="size-4" /></button>
				</header>

				{showWorkerFilter ? <div className="worker-process-filter shrink-0">
					<div className="worker-process-filter-label"><SlidersHorizontalIcon />Worker</div>
					{loading && items.length === 0 ? <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground"><Loader size={13} />加载中…</div> : null}
					{error && items.length === 0 ? <div className="py-2 text-xs text-destructive">{error}</div> : null}
					{!loading && !error && orderedItems.length === 0 ? <div className="py-2 text-xs text-muted-foreground">当前会话还没有 Worker 任务</div> : null}
					{workerOptions.length ? (
						<div className="worker-process-filter-options" role="list">
							{workerOptions.map((option) => {
								const active = selected?.agentId === option.agentId;
								const label = labels[option.agentId] ?? option.agentId;
								return (
									<button key={option.agentId} type="button" onClick={() => selectItem(option.latest)} className="worker-process-filter-chip" data-active={active ? "true" : "false"} role="listitem">
										<WorkerAvatar name={option.agentId} size={24} />
										<span className="truncate">{label}</span>
										{option.active ? <span className="worker-process-live-dot" aria-label="运行中" /> : null}
										{option.count > 1 ? <span className="worker-process-count">{option.count}</span> : null}
									</button>
								);
							})}
						</div>
					) : null}
				</div> : null}

				<section className="worker-process-detail flex min-h-0 min-w-0 flex-1 flex-col">
						{selected ? (
							<>
								{selected.view === "session" || selectedWorkerItems.length > 1 ? (
									<div className="worker-process-detail-toolbar shrink-0">
										{selected.view === "session" ? (
											<button type="button" className="worker-process-session-scope" onClick={() => setFullSessionDelegationId(showFullSession ? null : selected.delegationId)}>
												{showFullSession ? "只看本次委托" : "查看完整会话"}
											</button>
										) : null}
										{selectedWorkerItems.length > 1 ? (
											<label className="worker-process-task-select-wrap">
												<span className="sr-only">选择单次任务</span>
												<select
													aria-label="选择单次任务"
													value={selected.delegationId}
													onChange={(event) => {
														const next = selectedWorkerItems.find((item) => item.delegationId === event.target.value);
														if (next) selectItem(next);
													}}
												>
													{selectedWorkerItems.map((item) => <option key={item.delegationId} value={item.delegationId}>{processSummary(item, 24)} · {shortTime(item.updatedAt)}</option>)}
												</select>
											</label>
										) : null}
									</div>
								) : null}
								<div className={`worker-process-trust ${isObservationLost(selected) ? "is-observation-lost" : ""}`}>
									<CollaborationTrustAxes source={selected} />
								</div>
								{isObservationLost(selected) ? <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 p-2 text-[11px]"><div className="flex gap-2"><Button size="sm" variant="outline" disabled={reconciling} onClick={() => void resolveUnknown()}>重新对账原 Run</Button><Input value={takeoverRationale} onChange={(event) => setTakeoverRationale(event.target.value)} placeholder="上游已终止的确认依据（至少 8 字）" /><Button size="sm" variant="destructive" disabled={reconciling || takeoverRationale.trim().length < 8} onClick={() => void resolveUnknown(true)}>确认并接管</Button></div></div> : null}
								<WorkerProcessRouter key={`${selected.delegationId}:${selected.view}`} info={selected} full={showFullSession} />
							</>
						) : (
							<div className={`flex flex-1 items-center justify-center gap-2 px-5 text-center text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
								{loading ? <Loader size={13} /> : null}
								{loading ? "正在加载执行过程…" : error ?? "当前会话还没有执行任务"}
							</div>
						)}
				</section>
			</div>
		</aside>
	);
}
