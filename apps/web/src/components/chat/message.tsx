"use client";

import { createContext, type ComponentProps, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, FilePenIcon, FileSearchIcon, FileTextIcon, FolderIcon, ListTreeIcon, SquareIcon, SquareTerminalIcon, UserPlusIcon, UsersIcon, WrenchIcon } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
	Message as AiMessage,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { streamdownPlugins } from "@/core/streamdown/plugins";
import { delegateWorker, isDelegateCall } from "@/lib/events";
import { useAgentLabel } from "@/lib/avatars";
import { formatTokens } from "@/lib/session-stats";
import { cancelDelegation, openRoomFile } from "@/lib/api";
import type { ChatMessage, ToolCallView, WindowType } from "@/lib/types";
import { toast } from "sonner";
import { ManagerAvatar, WorkerAvatar } from "./worker-avatar";
import { InteractionCard } from "./interaction-card";
import { useWorkerProcessDrawer } from "./worker-process-context";

const TOOL_STATUS_LABEL: Record<ToolCallView["status"], string> = {
	pending: "待运行",
	running: "运行中",
	done: "完成",
	error: "失败",
	interrupted: "已中断",
};

/** 通用工具调用行的行首图标（按工具名区分；缺省由 TaskTrigger 给放大镜）。 */
function toolCallIcon(name: string) {
	if (name === "bash") return <SquareTerminalIcon className="size-4" />;
	if (name === "read") return <FileTextIcon className="size-4" />;
	if (name === "write" || name === "edit") return <FilePenIcon className="size-4" />;
	if (name === "grep" || name === "find") return <FileSearchIcon className="size-4" />;
	if (name === "ls") return <FolderIcon className="size-4" />;
	if (name === "search_agent_tools") return <WrenchIcon className="size-4" />;
	if (name === "create_group_window") return <UsersIcon className="size-4" />;
	if (name === "invite_to_group") return <UserPlusIcon className="size-4" />;
	return undefined;
}

const RoomFileContext = createContext<string | undefined>(undefined);

function localPathFromHref(href: string): string | undefined {
	const value = href.trim();
	if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//")) return undefined;
	if (/^(?:https?|mailto|tel|data|blob):/i.test(value) || value.startsWith("/api/")) return undefined;
	if (/^file:/i.test(value)) return value;
	if (/^(?:sandbox|attachment):/i.test(value)) {
		const localValue = value.replace(/^(?:sandbox|attachment):(?:\/\/)?/i, "");
		try {
			return decodeURIComponent(localValue);
		} catch {
			return localValue;
		}
	}
	// Other URI schemes are browser links. Drive-letter paths are local files.
	if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined;
	const pathOnly = value.split(/[?#]/, 1)[0] ?? value;
	try {
		return decodeURIComponent(pathOnly);
	} catch {
		return pathOnly;
	}
}

function ChatMarkdownLink({ href = "", children, node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
	void node;
	const roomId = useContext(RoomFileContext);
	const localPath = localPathFromHref(href);
	if (localPath && roomId) {
		return (
			<button
				type="button"
				className="home-local-file-link"
				title={`打开本地文件：${localPath}`}
				onClick={async () => {
					try {
						await openRoomFile(roomId, localPath);
					} catch (error) {
						toast.error(error instanceof Error ? error.message : "无法打开本地文件");
					}
				}}
			>
				{children}
			</button>
		);
	}
	return <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer" {...props}>{children}</a>;
}

const chatStreamdownProps = {
	...streamdownPlugins,
	components: { a: ChatMarkdownLink },
};

/**
 * 执行中计时器。起算点优先用消息时间戳（工具调用发起时刻）：组件随窗口
 * 切换/重挂载会重建，用挂载时间会清零；用消息时间戳则切换后仍显示真实
 * 已耗时。缺省（无时间戳）退回挂载时刻。
 */
function Elapsed({ active, since }: { active: boolean; since?: number }) {
	const [mountedAt] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	const s = Math.max(0, Math.round((now - (since ?? mountedAt)) / 1000));
	const mm = String(Math.floor(s / 60)).padStart(2, "0");
	const ss = String(s % 60).padStart(2, "0");
	return <span className="tabular-nums text-muted-foreground">{active ? `${mm}:${ss}` : ""}</span>;
}

/** worker 回报的委托状态 → 中文徽标文案（未识别的兜底原始值）。 */
const WORKER_STATUS_LABEL: Record<string, string> = {
	running: "执行中",
	completed: "完成",
	needs_input: "等待审批",
	cancelled: "已取消",
	failed: "失败",
	// 历史卡：direct 镜像在失败时写过 vocab 外的 "error"（agent-extensions soloMeta），
	// 新数据已统一 failed，这里仅为兼容旧会话记录。
	error: "失败",
	conflict: "会话占用",
	timeout: "超时",
};

function statusBadge(call: ToolCallView, since?: number) {
	const details = call.details as { status?: string } | undefined;
	if (call.status === "running" || details?.status === "running" || details?.status === "approved")
		return (
			<Badge variant="secondary" className="gap-1">
				<span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
				执行中 <Elapsed active since={since} />
			</Badge>
		);
	if (call.status === "error") return <Badge variant="destructive">失败</Badge>;
	if (call.status === "interrupted") return <Badge variant="outline">已中断</Badge>;
	if (call.status === "pending") return <Badge variant="secondary">准备中</Badge>;
	if (details?.status === "needs_input") return <Badge variant="secondary">等待审批</Badge>;
	if (details?.status && details.status !== "completed") {
		return <Badge variant="destructive">{WORKER_STATUS_LABEL[details.status] ?? details.status}</Badge>;
	}
	if (call.status === "done" || details?.status === "completed") return <Badge variant="secondary">完成</Badge>;
	return <Badge variant="outline">状态未知</Badge>;
}

/** Badge for a worker-reported status string (custom_message details). */
function workerStatusBadge(status?: string) {
	if (status === "needs_input") return <Badge variant="secondary">等待审批</Badge>;
	if (status && status !== "completed") {
		return <Badge variant="destructive">{WORKER_STATUS_LABEL[status] ?? status}</Badge>;
	}
	return <Badge variant="secondary">完成</Badge>;
}

/**
 * 展开/折叠时把卡片钉在原地：stopScroll() 解除 StickToBottom 吸底（内容变高时
 * 它的 ResizeObserver 会吸住底部，把被点的卡片顶到视口上方），同时记录卡片
 * 顶部的视口位置，React 提交后按位移补偿 scrollTop。只 stopScroll 不够——
 * 收起内容（负向 resize）时 use-stick-to-bottom 的 ResizeObserver 在
 * isNearBottom 下会重新吸底（setEscapedFromLock(false) + setIsAtBottom(true)），
 * 随后任何新内容都会把视口拽到底部，用户找不到刚才点的卡片。补偿滚动本身
 * 会触发 scroll 事件，方向向上，库会保持 escaped 状态，不会误吸底；
 * isNearBottom 不受影响，「回到底部」浮钮也不会误现。
 */
function useAnchorPreservingToggle<T extends HTMLElement>() {
	const { stopScroll, scrollRef } = useStickToBottomContext();
	const rootRef = useRef<T | null>(null);
	const anchorTop = useRef<number | null>(null);
	const toggle = (setter: React.Dispatch<React.SetStateAction<boolean>>) => {
		anchorTop.current = rootRef.current?.getBoundingClientRect().top ?? null;
		stopScroll();
		setter((v) => !v);
	};
	useLayoutEffect(() => {
		const before = anchorTop.current;
		anchorTop.current = null;
		if (before === null) return;
		const el = rootRef.current;
		const scroller = scrollRef.current;
		if (!el || !scroller) return;
		const delta = el.getBoundingClientRect().top - before;
		if (delta !== 0) scroller.scrollTop += delta;
	});
	return { rootRef, toggle };
}

/** 委托任务的独立过程入口；任务摘要仍由相邻标题/箭头负责。 */
function ProcessViewButton({ details }: { details: unknown }) {
	const process = details as { processView?: boolean; delegationId?: string } | undefined;
	const { openWorkerProcess } = useWorkerProcessDrawer();
	if (!process?.processView || !process.delegationId) return null;
	return (
		<button
			type="button"
			className="home-process-link"
			onClick={() => openWorkerProcess(process.delegationId!)}
			title="打开执行过程"
		>
			<ListTreeIcon aria-hidden="true" />
			<span>执行过程</span>
		</button>
	);
}

/** Cancel exactly one delegated Run; the manager Session stays alive. */
function CancelDelegationButton({ delegationId, goalId }: { delegationId?: string; goalId?: string }) {
	const [cancelling, setCancelling] = useState(false);
	if (!delegationId) return null;
	return (
		<button
			type="button"
			disabled={cancelling}
			onClick={async () => {
				setCancelling(true);
				try {
					await cancelDelegation(delegationId, goalId);
					toast.success("已终止该 Worker 任务");
				} catch (error) {
					toast.error(error instanceof Error ? error.message : "无法终止任务");
					setCancelling(false);
				}
			}}
			className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive disabled:cursor-wait disabled:opacity-60"
			title="仅终止这个 Worker 任务，不影响 Goal 和其他任务"
		>
			<SquareIcon className="size-3 fill-current" />
			{cancelling ? "正在终止" : "终止任务"}
		</button>
	);
}

/**
 * A worker-authored entry in the member message flow (§7): avatar + name +
 * status badge + task + result markdown, standing on its own instead of being
 * wrapped inside the manager bubble. Shared by direct/group delegate tool blocks
 * and solo-synced pudding:task_result custom messages.
 */
/** 本任务 token 消耗（worker Run 聚合，经 details.usage 透传到结果卡/工具卡）。 */
interface TaskUsage {
	turns?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

/** 「消耗 输入 12.3K · 输出 1.2K · $0.0034」；无数据不显示。 */
function usageMetaText(usage: TaskUsage | undefined): string | undefined {
	if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
	let text = `消耗 输入 ${formatTokens(usage.inputTokens ?? 0)} · 输出 ${formatTokens(usage.outputTokens ?? 0)}`;
	if (typeof usage.cost === "number") {
		text += ` · $${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`;
	}
	return text;
}

function WorkerTaskEntry({
	worker,
	task,
	result,
	badge,
	processDetails,
	running,
	isError,
	meta,
	usage,
	timestamp,
	progress,
	actions,
	children,
}: {
	worker: string;
	task?: string;
	result?: string;
	badge: React.ReactNode;
	/** 委托过程元数据，仅供独立的「执行过程」按钮使用。 */
	processDetails?: unknown;
	running?: boolean;
	isError?: boolean;
	meta?: string;
	/** 本任务 token 消耗（worker Run 聚合）。 */
	usage?: TaskUsage;
	timestamp?: number;
	progress?: string;
	/** 额外动作区（如 pi worker 的「执行过程」入口）。 */
	actions?: React.ReactNode;
	children?: React.ReactNode;
}) {
	// worker 工作过程：运行中/完成都默认展开； chevron 折叠整卡（两种状态一致），
	// 完成态的长结果另有 clamp，运行中的长任务默认折叠成三行可展开。
	// worker prop 是内部 id（头像/详情用），展示渲染显示名。
	const workerLabel = useAgentLabel(worker);
	const finished = !running && result !== undefined && result !== "";
	const [open, setOpen] = useState(true);
	const [resultOpen, setResultOpen] = useState(true);
	const [taskOpen, setTaskOpen] = useState(false);
	const { rootRef, toggle: toggleKeepingAnchor } = useAnchorPreservingToggle<HTMLDivElement>();
	const toggleTaskSummary = () => toggleKeepingAnchor(setOpen);
	const time = timestamp
		? new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
		: "";
	const expandableResult = Boolean(result && (result.length > 1200 || result.split("\n").length > 24));
	const clampTask = Boolean(task && (task.length > 240 || task.split("\n").length > 5));
	const usageText = usageMetaText(usage);

	const header = (
		<div className="flex items-center gap-2">
			<button
				type="button"
				onClick={() => toggleKeepingAnchor(setOpen)}
				className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				aria-label={open ? "收起任务摘要" : "展开任务摘要"}
				aria-expanded={open}
			>
				{open ? (
					<ChevronDownIcon className="size-3.5 shrink-0" />
				) : (
					<ChevronRightIcon className="size-3.5 shrink-0" />
				)}
			</button>
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<button
					type="button"
					onClick={toggleTaskSummary}
					className="home-worker-task-link flex min-w-0 items-center gap-2 text-left"
					title={open ? "收起任务摘要" : "展开任务摘要"}
				>
					<span className="truncate font-mono text-sm font-medium">{workerLabel}</span>
					{/* 状态徽标由调用方按 details/status 推导（含 needs_input 等待审批），
					    不能在这里按完成/失败二分写死。 */}
					{badge}
				</button>
				<ProcessViewButton details={processDetails} />
			</div>
			{actions}
			{time ? <time className="text-muted-foreground/60 text-[10px] tabular-nums">{time}</time> : null}
		</div>
	);

	// 任务块：左侧竖线引用样式，和长结果/正文区分开；clamp 开关独占一行，
	// 不再贴在正文尾巴上被当成普通文本。
	const taskBlock = task ? (
		<div className="mt-1 border-l-2 border-border/70 pl-2">
			<p className="text-xs text-muted-foreground">
				<span className="mr-1.5 text-muted-foreground/60">任务：</span>
				<span className={`whitespace-pre-wrap ${clampTask && !taskOpen ? "line-clamp-3" : ""}`}>{task}</span>
			</p>
			{clampTask ? (
				<button
					type="button"
					className="mt-0.5 flex items-center gap-0.5 text-[11px] text-muted-foreground/80 hover:text-foreground"
					onClick={() => toggleKeepingAnchor(setTaskOpen)}
				>
					{taskOpen ? "收起任务详情" : "展开任务详情"}
					<ChevronDownIcon className={`size-3 transition-transform ${taskOpen ? "rotate-180" : ""}`} />
				</button>
			) : null}
		</div>
	) : null;

	const collapsedPreview = task ? (
		<button type="button" className="mt-1 block w-full truncate text-left text-xs text-muted-foreground hover:text-foreground" onClick={toggleTaskSummary} title="展开任务摘要">
			<span className="mr-1.5 text-muted-foreground/60">任务：</span>
			{task}
		</button>
	) : null;

	if (finished) {
		return (
			<div ref={rootRef} className="home-worker-entry is-finished">
				<WorkerAvatar name={worker} size={34} className="shrink-0" />
				<div className="home-worker-finished-body">
					{header}
					{open ? (
						<>
							{taskBlock}
							{/* 结果区与任务块用分隔线区分归属，避免长任务和长结果视觉上粘连。 */}
							<div className="mt-2 border-t border-border/60 pt-1.5">
								<div className={`home-worker-result ${!resultOpen && expandableResult ? "is-clamped" : ""} ${isError ? "text-destructive" : ""}`}>
									<MessageResponse {...chatStreamdownProps}>{result}</MessageResponse>
								</div>
								{expandableResult ? (
									<button
										type="button"
										className="home-worker-result-toggle"
										onClick={() => toggleKeepingAnchor(setResultOpen)}
									>
										{resultOpen ? "收起结果" : "展开结果"}
										<ChevronDownIcon className={resultOpen ? "rotate-180" : ""} />
									</button>
								) : null}
							</div>
							{usageText ? <p className="mt-1 text-xs text-muted-foreground/70 tabular-nums">{usageText}</p> : null}
						</>
					) : (
						collapsedPreview
					)}
				</div>
			</div>
		);
	}

	return (
		<div ref={rootRef} className="home-worker-entry flex w-full items-start gap-2.5">
			<WorkerAvatar name={worker} size={34} className="shrink-0" />
			<div className="min-w-0 flex-1">
				{header}
				{open ? (
					<>
						{taskBlock}
						{running ? (
							<p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
								<span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
								{progress ?? "等待 worker 完成…"}
							</p>
						) : null}
						{children}
						{result !== undefined && result !== "" && (
							<div className="mt-2 border-t border-border/60 pt-1.5">
								<div className={`text-sm ${isError ? "text-destructive" : ""}`}>
									<MessageResponse {...chatStreamdownProps}>{result}</MessageResponse>
								</div>
							</div>
						)}
						{meta ? <p className="mt-1 text-xs text-muted-foreground/70 tabular-nums">{meta}</p> : null}
						{usageText ? <p className="mt-1 text-xs text-muted-foreground/70 tabular-nums">{usageText}</p> : null}
					</>
				) : (
					collapsedPreview
				)}
			</div>
		</div>
	);
}

function toolCallMeta(call: ToolCallView): string | undefined {
	const details = call.details as
		| { status?: string; outcome?: string; exitCode?: number; elapsedMs?: number }
		| undefined;
	if (!details || (!details.status && details.outcome === undefined)) return undefined;
	return [
		details.status ? (WORKER_STATUS_LABEL[details.status] ?? details.status) : undefined,
		details.outcome,
		details.elapsedMs !== undefined ? `${(details.elapsedMs / 1000).toFixed(0)}s` : undefined,
		details.exitCode !== undefined ? `exit ${details.exitCode}` : undefined,
	]
		.filter((x): x is string => Boolean(x))
		.filter((x, i, arr) => arr.indexOf(x) === i)
		.join(" · ");
}

/** Specialized card for a delegate tool call — rendered as a member message
 * (worker avatar + name + result), with the raw tool call kept expandable. */
function DelegateCard({ call, onOpenWindow, timestamp }: { call: ToolCallView; onOpenWindow?: (windowId: string) => void; timestamp?: number }) {
	const args = call.args as { task?: string } | undefined;
	const worker = delegateWorker(call);
	// worker 是内部 id（头像/工具详情用），卡面展示显示名。
	const workerLabel = useAgentLabel(worker ?? "worker");
	const details = call.details as
		| {
				status?: string;
				synced?: boolean;
				windowId?: string;
				conflict?: boolean;
				interactionId?: string;
				delegationId?: string;
				goalId?: string;
				processView?: boolean;
				revision?: number;
				requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
		  }
		| undefined;
	const [open, setOpen] = useState(false);
	const resumedRunning = details?.status === "running" || details?.status === "approved";
	// 任务/结果主体：运行中展开看进度，完成后自动折叠（可手动再展开）。
	const finished = !resumedRunning && (call.status === "done" || call.status === "error" || call.status === "interrupted");
	const [bodyOpen, setBodyOpen] = useState(!finished);
	const [wasFinished, setWasFinished] = useState(finished);
	if (finished !== wasFinished) {
		// render 期间按 props 变化调整 state（React 推荐模式）：running→done 折叠一次。
		setWasFinished(finished);
		if (finished) setBodyOpen(false);
	}
	const meta = toolCallMeta(call);
	const { rootRef, toggle: toggleKeepingAnchor } = useAnchorPreservingToggle<HTMLDivElement>();
	const toggleTaskSummary = () => toggleKeepingAnchor(setBodyOpen);

	// 409 冲突 + 带 pending interactionId：冲突优先显示，并保留对账的 interactionId。
	const conflict = details?.status === "conflict" || details?.conflict;
	if (conflict && details?.interactionId) {
		return (
			<div className="flex w-full flex-col gap-2">
				<div className="w-full overflow-hidden rounded-lg border border-destructive/40 bg-muted/60 px-3 py-2">
					<p className="text-xs text-destructive">
						该 worker 的会话仍在等待上一个任务的审批，不能发起新任务（409）。
					</p>
					{args?.task ? (
						<p className="mt-1 text-xs text-muted-foreground">
							<span className="mr-1.5 text-muted-foreground/60">任务：</span>
							<span className="whitespace-pre-wrap">{args.task}</span>
						</p>
					) : null}
				</div>
				<InteractionCard
					interactionId={details.interactionId}
					worker={worker ?? "worker"}
					goalId={details.goalId}
					requests={details.requests}
					revision={details.revision}
					windowId={details.windowId}
					onOpenWindow={onOpenWindow}
				/>
			</div>
		);
	}

	// HITL：等待审批的审批卡由 invoker 写入会话的 pudding:interaction_required
	// custom message 承载（唯一事实源，可折叠/对账）；这里不再内联渲染，
	// 否则同一窗口会出现两张相同的审批卡。

	// 409 冲突（无 interactionId）：渲染带「去处理」跳转的占用卡。
	if (conflict) {
		return (
			<InteractionCard
				worker={worker ?? "worker"}
				statusHint="conflict"
				windowId={details?.windowId}
				onOpenWindow={onOpenWindow}
			/>
		);
	}

	return (
		<div ref={rootRef} className="home-delegate-card w-full overflow-hidden rounded-lg bg-muted">
			<div className="flex items-center justify-between gap-2 px-3 pt-2">
				<button
					type="button"
					onClick={() => toggleKeepingAnchor(setBodyOpen)}
					className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
					aria-label={bodyOpen ? "收起任务摘要" : "展开任务摘要"}
					aria-expanded={bodyOpen}
				>
					{bodyOpen ? (
						<ChevronDownIcon className="size-3.5 shrink-0" />
					) : (
						<ChevronRightIcon className="size-3.5 shrink-0" />
					)}
				</button>
				<button
					type="button"
					onClick={toggleTaskSummary}
					className="home-delegate-task-link flex min-w-0 flex-1 items-center gap-2 text-left"
					title={bodyOpen ? "收起任务摘要" : "展开任务摘要"}
				>
					<WorkerAvatar name={worker ?? "worker"} size={20} />
					<span className="truncate font-mono text-sm font-medium">{workerLabel}</span>
				</button>
				<div className="flex shrink-0 items-center gap-2">
					<ProcessViewButton details={call.details} />
					{call.status === "running" || resumedRunning ? <CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} /> : null}
					{details?.synced && details.windowId ? (
						<button
							type="button"
							onClick={() => onOpenWindow?.(details.windowId!)}
							className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						>
							已同步到单聊
							<ExternalLinkIcon className="size-3" />
						</button>
					) : null}
					{statusBadge(call, timestamp)}
				</div>
			</div>
			{bodyOpen ? (
				<div className="flex flex-col gap-2 p-3">
					{args?.task ? (
						<p className="text-xs text-muted-foreground">
							<span className="mr-1.5 text-muted-foreground/60">任务：</span>
							<span className="whitespace-pre-wrap">{args.task}</span>
						</p>
					) : null}
					{call.status === "running" || resumedRunning ? (
						<p className="text-xs text-muted-foreground">{call.progress ?? "等待 worker 完成…"}</p>
					) : null}
					{/* needs_input 的旧 toolResult 是“等待审批”快照；批准续跑后
					    隐藏这段过期正文，以实时 running 状态为准。 */}
					{call.result !== undefined && !resumedRunning && (
						<div className={`text-sm ${call.isError ? "text-destructive" : ""}`}>
							<MessageResponse {...chatStreamdownProps}>{call.result}</MessageResponse>
						</div>
					)}
					{meta ? <p className="text-xs text-muted-foreground/70 tabular-nums">{meta}</p> : null}
					{usageMetaText((call.details as { usage?: TaskUsage } | undefined)?.usage) ? (
						<p className="text-xs text-muted-foreground/70 tabular-nums">
							{usageMetaText((call.details as { usage?: TaskUsage } | undefined)?.usage)}
						</p>
					) : null}
					<Collapsible open={open} onOpenChange={setOpen}>
						<CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground">
							{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
							工具详情
						</CollapsibleTrigger>
						<CollapsibleContent className="mt-2">
							<pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-xs">
								{JSON.stringify(
									{
										worker,
										status: details?.status,
										task: args?.task,
									},
									null,
									2,
								)}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				</div>
			) : (
				<button type="button" className="block w-full px-3 pb-2 pt-1 text-left" onClick={toggleTaskSummary} title="展开任务摘要">
					{args?.task ? (
						<span className="block truncate text-xs text-muted-foreground transition-colors hover:text-foreground">
							<span className="mr-1.5 text-muted-foreground/60">任务：</span>
							{args.task}
						</span>
					) : null}
				</button>
			)}
		</div>
	);
}

function ToolCallItem({
	call,
	windowType,
	onOpenWindow,
	timestamp,
}: {
	call: ToolCallView;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	timestamp?: number;
}) {
	if (isDelegateCall(call)) {
		// §7 成员消息流：direct/group 下脱离 manager 气泡，渲染为 worker 独立条目。
		// 等待审批的交互卡由 pudding:interaction_required custom message 承载；
		// 批准续跑后隐藏旧 needs_input toolResult，按普通 running worker 条目渲染。
		if (windowType && windowType !== "solo") {
			const args = call.args as { task?: string } | undefined;
				const details = call.details as { status?: string; delegationId?: string; goalId?: string } | undefined;
			const resumedRunning = details?.status === "running" || details?.status === "approved";
			const running = call.status === "running" || resumedRunning;
			return (
				<WorkerTaskEntry
					worker={delegateWorker(call) ?? "worker"}
					task={args?.task}
					result={resumedRunning ? undefined : call.result}
					badge={statusBadge(call, timestamp)}
					processDetails={call.details}
					running={running}
					isError={resumedRunning ? false : call.isError}
					meta={toolCallMeta(call)}
					usage={(call.details as { usage?: TaskUsage } | undefined)?.usage}
					timestamp={timestamp}
					progress={call.progress}
					actions={running ? <CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} /> : null}
				/>
			);
		}
		return <DelegateCard call={call} onOpenWindow={onOpenWindow} timestamp={timestamp} />;
	}
	// manager 建房卡：create_group_window 成功后给「打开群聊」跳转。
	if (call.name === "create_group_window") {
		const details = call.details as { windowId?: string; members?: string[]; name?: string } | undefined;
		if (details?.windowId) {
			return (
				<div className="w-full overflow-hidden rounded-lg bg-muted">
					<div className="flex items-center justify-between gap-2 px-3 py-2">
						<div className="flex min-w-0 items-center gap-2 text-sm">
							<UsersIcon className="size-4 shrink-0 text-muted-foreground" />
							<span className="truncate">
								已创建群聊{details.name ? `「${details.name}」` : ""}
								{details.members?.length ? `（${details.members.join("、")}）` : ""}，任务已下达
							</span>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<button
								type="button"
								onClick={() => onOpenWindow?.(details.windowId!)}
								className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
							>
								打开群聊
								<ExternalLinkIcon className="size-3" />
							</button>
							{statusBadge(call, timestamp)}
						</div>
					</div>
				</div>
			);
		}
	}
	return (
		<Task defaultOpen={call.status === "running" || call.status === "error"}>
			<TaskTrigger title={`${TOOL_STATUS_LABEL[call.status]} · ${call.name}`} icon={toolCallIcon(call.name)} />
			<TaskContent>
				{call.args !== undefined && (
					<pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-xs">
						{JSON.stringify(call.args, null, 2)}
					</pre>
				)}
				{call.result !== undefined && (
					<pre
						className={`max-h-60 overflow-y-auto whitespace-pre-wrap text-xs ${
							call.isError ? "text-destructive" : ""
						}`}
					>
						{call.result}
					</pre>
				)}
				{call.status === "running" && (
					<p className="text-muted-foreground text-xs">执行中…</p>
				)}
			</TaskContent>
		</Task>
	);
}

/** role:"custom" entries written by the platform (solo task sync, §4.4). */
function CustomMessageEntry({
	message,
	resolvedTaskIds,
}: {
	message: ChatMessage;
	resolvedTaskIds?: Set<string>;
}) {
	const details = message.details as
		| {
				worker?: string;
				status?: string;
				taskId?: string;
				from?: string;
				windowId?: string;
				interactionId?: string;
				delegationId?: string;
				goalId?: string;
				sessionHandle?: string;
				processView?: boolean;
				revision?: number;
				usage?: TaskUsage;
				requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
		  }
		| undefined;

	// direct 直派（§5.2）：用户发言以普通用户气泡呈现。
	if (message.customType === "pudding:user_message") {
		return (
			<AiMessage from="user" className="home-user-message">
				<MessageContent>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
				</MessageContent>
			</AiMessage>
		);
	}

	if (message.customType === "pudding:task_assign") {
		// 结果/审批卡到达后（同 taskId），running 态落定，不再显示「执行中」。
		const running = details?.status === "running" && !resolvedTaskIds?.has(details?.taskId ?? "");
		if (details?.from === "direct") {
			// direct 窗口：用户消息就在上方，指派卡只作 worker 侧运行指示，
			// 落定后整张收起（结果卡已说明一切）。
			if (!running) return null;
			return (
					<WorkerTaskEntry
						worker={details?.worker ?? "worker"}
					badge={<Badge variant="secondary">执行中</Badge>}
					processDetails={details}
					running
					timestamp={message.timestamp}
					actions={<CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} />}
				/>
			);
		}
		if (details?.from === "solo") {
			// A manager-routed task should still feel like a normal direct worker
			// conversation: user-side task first, then one worker running row, then
			// the eventual worker result. Keep process/cancel controls on the worker
			// row instead of burying them in the task bubble.
			return (
				<>
					<AiMessage from="user" className="home-user-message">
						<MessageContent>
							<p className="text-xs text-muted-foreground">Manager 委派</p>
							<p className="text-sm whitespace-pre-wrap">{message.content}</p>
						</MessageContent>
					</AiMessage>
					{running ? (
						<WorkerTaskEntry
							worker={details?.worker ?? "worker"}
							badge={(
								<Badge variant="secondary" className="gap-1">
									<span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
									执行中 <Elapsed active since={message.timestamp} />
								</Badge>
							)}
							processDetails={details}
							running
							timestamp={message.timestamp}
							actions={<CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} />}
						/>
					) : null}
				</>
			);
		}
		return (
			<AiMessage from="user" className="home-user-message">
				<MessageContent>
					<p className="text-xs text-muted-foreground">派给 {details?.worker ?? "worker"}</p>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
					{running ? (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span>执行中…</span>
							<CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} />
						</div>
					) : null}
				</MessageContent>
			</AiMessage>
		);
	}

	if (message.customType === "pudding:task_result") {
		return (
			<WorkerTaskEntry
				worker={details?.worker ?? "worker"}
				result={message.content}
				badge={workerStatusBadge(details?.status)}
				processDetails={details}
				isError={Boolean(details?.status && details.status !== "completed" && details.status !== "needs_input")}
				timestamp={message.timestamp}
				usage={details?.usage}
			/>
		);
	}

	// HITL：审批卡（§6.5）——历史中只存安全投影（无 token），状态由服务端对账。
	if (message.customType === "pudding:interaction_required") {
		return (
			<InteractionCard
					interactionId={details?.interactionId}
					worker={details?.worker ?? "worker"}
					goalId={details?.goalId}
				requests={details?.requests}
				revision={details?.revision}
				windowId={details?.windowId}
				onOpenWindow={undefined}
			/>
		);
	}

	// 状态变化追加一条 resolved 事件；前端按 interactionId 折叠到原卡片。
	if (message.customType === "pudding:interaction_resolved") {
		const text =
			details?.status === "approved"
				? "审批已批准，任务继续执行中。"
				: details?.status === "rejected"
					? "审批已拒绝，任务已取消。"
					: details?.status === "failed"
						? "审批已批准，但任务执行失败。"
						: "审批已处理。";
		return <p className="text-xs text-muted-foreground">{text}</p>;
	}

	// Unknown custom types stay visible but unobtrusive.
	return (
		<p className="text-xs text-muted-foreground">
			[{message.customType ?? "custom"}] {message.content}
		</p>
	);
}

function MessageBody({
	message,
	windowType,
	onOpenWindow,
	resolvedTaskIds,
	assistantAs,
}: {
	message: ChatMessage;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	resolvedTaskIds?: Set<string>;
	/** assistant 消息的身份覆盖：worker 执行过程查看器里 assistant 是 worker
	 *  自己（内部 id，头像/显示名按它解析），缺省为 Manager。 */
	assistantAs?: string;
}) {
	const assistantLabel = useAgentLabel(assistantAs ?? "");
	if (message.role === "user") {
		return (
			<AiMessage from="user" className="home-user-message">
				<MessageContent>
					<p className="whitespace-pre-wrap">{message.content}</p>
				</MessageContent>
			</AiMessage>
		);
	}

	if (message.role === "custom") {
		return <CustomMessageEntry message={message} resolvedTaskIds={resolvedTaskIds} />;
	}

	if (message.role === "toolResult") {
		return (
			<Task defaultOpen={false}>
				<TaskTrigger title={`工具结果 · ${message.name ?? ""}`} />
				<TaskContent>
					<pre className="text-sm whitespace-pre-wrap">{message.content}</pre>
				</TaskContent>
			</Task>
		);
	}

	const showThinking =
		Boolean(message.thinking) || (message.streaming && !message.content && message.toolCalls.length === 0);
	const showContent = Boolean(message.content) || message.error;

	// §7: in direct/group windows delegate tool blocks leave the manager bubble
	// and render as standalone worker entries; other tools stay inside.
	const memberFlow = windowType === "direct" || windowType === "group";
	const bubbleCalls = memberFlow ? message.toolCalls.filter((c) => !isDelegateCall(c)) : message.toolCalls;
	const workerCalls = memberFlow ? message.toolCalls.filter((c) => isDelegateCall(c)) : [];
	const showBubble = showThinking || showContent || bubbleCalls.length > 0;

	const time = new Date(message.timestamp).toLocaleTimeString("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	return (
		<>
			{showBubble && (
				<div className="home-assistant-message">
					{assistantAs ? (
						<WorkerAvatar name={assistantAs} size={34} className="home-manager-avatar" />
					) : (
						<ManagerAvatar size={34} className="home-manager-avatar" />
					)}
					<div className="home-assistant-body">
						<div className="home-message-meta"><strong>{assistantAs ? assistantLabel : "Manager"}</strong><span>{time}</span></div>
						{showThinking && (
							<AssistantReasoning streaming={message.streaming} thinking={message.thinking} />
						)}
						{bubbleCalls.length > 0 && (
							<div className="flex w-full flex-col gap-2">
								{bubbleCalls.map((call) => (
									<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} timestamp={message.timestamp} />
								))}
							</div>
						)}
						{showContent && (
							<>
								<MessageResponse
									className={`home-message-response ${message.error ? "text-destructive" : ""}`}
									{...chatStreamdownProps}
								>
									{message.content}
								</MessageResponse>
								<ErrorTechnicalDetails detail={message.errorDetail} />
							</>
						)}
					</div>
				</div>
			)}
			{workerCalls.map((call) => (
				<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} timestamp={message.timestamp} />
			))}
		</>
	);
}

export function Message({ roomId, ...props }: {
	roomId: string;
	message: ChatMessage;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	resolvedTaskIds?: Set<string>;
	assistantAs?: string;
}) {
	return (
		<RoomFileContext.Provider value={roomId}>
			<MessageBody {...props} />
		</RoomFileContext.Provider>
	);
}

function AssistantReasoning({ streaming, thinking, className }: { streaming: boolean; thinking?: string; className?: string }) {
	// Freeze the mount-time streaming flag: live messages mount open and auto-close
	// when the stream ends; history messages mount already collapsed, so switching
	// sessions never plays an open→close jump (vendored Reasoning auto-closes
	// whenever defaultOpen && !isStreaming).
	const [defaultOpen] = useState(() => streaming);

	return (
		<Reasoning isStreaming={streaming} defaultOpen={defaultOpen} className={className}>
			<ReasoningTrigger hasContent={Boolean(thinking)} />
			<ReasoningContent>{thinking ?? ""}</ReasoningContent>
		</Reasoning>
	);
}

function ErrorTechnicalDetails({ detail }: { detail?: string }) {
	if (!detail) return null;
	return (
		<Collapsible className="mt-1">
			<CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
				<ChevronRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90" />
				查看技术详情
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 max-w-full rounded-md border bg-muted/40 p-3">
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">{detail}</pre>
			</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * 工具折叠摘要行：一段里连续的非 delegate 工具调用折成一行
 * 「使用了 N 个工具，运行 M 个命令」（M=bash 数，为 0 时省略后半句），
 * chevron 展开看每个工具细节；有工具在跑时显示「执行中 · 工具名」+ 脉冲点。
 */
function ToolSummaryRow({
	calls,
	windowType,
	onOpenWindow,
	timestamp,
}: {
	calls: ToolCallView[];
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	timestamp: number;
}) {
	const [open, setOpen] = useState(false);
	const { rootRef, toggle: toggleKeepingAnchor } = useAnchorPreservingToggle<HTMLDivElement>();
	const running = calls.filter((c) => c.status === "running");
	const failed = calls.filter((c) => c.status === "error" || c.isError).length;
	const bashCount = calls.filter((c) => c.name === "bash").length;
	const summary =
		running.length > 0
			? `执行中 · ${running[running.length - 1]!.name}`
			: `使用了 ${calls.length} 个工具${bashCount > 0 ? `，运行 ${bashCount} 个命令` : ""}`;
	return (
		<Collapsible
			ref={rootRef}
			open={open}
			onOpenChange={() => toggleKeepingAnchor(setOpen)}
		>
			<CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
				{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				{running.length > 0 ? <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" /> : null}
				{summary}
				{failed > 0 && running.length === 0 ? <Badge variant="destructive">{failed} 失败</Badge> : null}
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 flex w-full flex-col gap-2">
				{calls.map((call) => (
					<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} timestamp={timestamp} />
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

type AssistantNode = { merged: ChatMessage[] } | { single: ChatMessage };

/**
 * 合并气泡正文：连续 assistant 段（一个 run 的多个 turn，常只有 thinking+工具、
 * 无正文）渲染为一条气泡，段内按 thinking → 正文 → 工具摘要行 顺序排布。
 * §7 成员消息流：delegate 工具段要脱离气泡独立成 worker 条目，打断合并走旧渲染；
 * solo 窗口 delegate 卡（DelegateCard）不入折叠，按段内顺序全卡渲染。
 */
function AssistantGroupBody({
	messages,
	windowType,
	onOpenWindow,
	assistantAs,
}: {
	messages: ChatMessage[];
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	assistantAs?: string;
}) {
	const assistantLabel = useAgentLabel(assistantAs ?? "");
	const memberFlow = windowType === "direct" || windowType === "group";
	const nodes: AssistantNode[] = [];
	for (const m of messages) {
		if (memberFlow && m.toolCalls.some((c) => isDelegateCall(c))) {
			nodes.push({ single: m });
			continue;
		}
		const last = nodes[nodes.length - 1];
		if (last && "merged" in last) last.merged.push(m);
		else nodes.push({ merged: [m] });
	}

	return (
		<>
			{nodes.map((node) => {
				if ("single" in node) {
					return (
						<MessageBody
							key={node.single.id}
							message={node.single}
							windowType={windowType}
							onOpenWindow={onOpenWindow}
							assistantAs={assistantAs}
						/>
					);
				}
				const segments = node.merged
					.map((m) => ({
						m,
						showThinking:
							Boolean(m.thinking) || (m.streaming && !m.content && m.toolCalls.length === 0),
						showContent: Boolean(m.content) || m.error,
						foldCalls: m.toolCalls.filter((c) => !isDelegateCall(c)),
						cardCalls: memberFlow ? [] : m.toolCalls.filter((c) => isDelegateCall(c)),
					}))
					.filter((s) => s.showThinking || s.showContent || s.foldCalls.length > 0 || s.cardCalls.length > 0);
				if (segments.length === 0) return null;
				const lastTime = new Date(segments[segments.length - 1]!.m.timestamp).toLocaleTimeString("zh-CN", {
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				});
				return (
					<div key={node.merged[0]!.id} className="home-assistant-message">
						{assistantAs ? (
							<WorkerAvatar name={assistantAs} size={34} className="home-manager-avatar" />
						) : (
							<ManagerAvatar size={34} className="home-manager-avatar" />
						)}
						<div className="home-assistant-body">
							<div className="home-message-meta">
								<strong>{assistantAs ? assistantLabel : "Manager"}</strong>
								<span>{lastTime}</span>
							</div>
							<div className="flex w-full flex-col gap-3">
								{segments.map((s) => (
									<div key={s.m.id} className="home-assistant-segment flex w-full flex-col gap-2">
										{s.showThinking && <AssistantReasoning streaming={s.m.streaming} thinking={s.m.thinking} className="mb-0" />}
										{s.showContent && (
											<MessageResponse
												className={`home-message-response ${s.m.error ? "text-destructive" : ""}`}
												{...chatStreamdownProps}
											>
												{s.m.content}
											</MessageResponse>
										)}
										<ErrorTechnicalDetails detail={s.m.errorDetail} />
										{s.foldCalls.length > 0 && (
											<ToolSummaryRow
												calls={s.foldCalls}
												windowType={windowType}
												onOpenWindow={onOpenWindow}
												timestamp={s.m.timestamp}
											/>
										)}
										{s.cardCalls.map((call) => (
											<ToolCallItem
												key={call.id}
												call={call}
												windowType={windowType}
												onOpenWindow={onOpenWindow}
												timestamp={s.m.timestamp}
											/>
										))}
									</div>
								))}
							</div>
						</div>
					</div>
				);
			})}
		</>
	);
}

/** groupForRender 分组的 assistant 段集合，渲染入口与 Message 对齐（RoomFileContext）。 */
export function AssistantGroup({ roomId, ...props }: {
	roomId: string;
	messages: ChatMessage[];
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	assistantAs?: string;
}) {
	return (
		<RoomFileContext.Provider value={roomId}>
			<AssistantGroupBody {...props} />
		</RoomFileContext.Provider>
	);
}
