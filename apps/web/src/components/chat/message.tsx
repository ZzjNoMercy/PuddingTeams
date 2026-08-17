"use client";

import { createContext, type ComponentProps, useContext, useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, UsersIcon } from "lucide-react";
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
import { openRoomFile } from "@/lib/api";
import type { ChatMessage, ToolCallView, WindowType } from "@/lib/types";
import { toast } from "sonner";
import { ManagerAvatar, WorkerAvatar } from "./worker-avatar";
import { InteractionCard } from "./interaction-card";

const TOOL_STATUS_LABEL: Record<ToolCallView["status"], string> = {
	pending: "待运行",
	running: "运行中",
	done: "完成",
	error: "失败",
	interrupted: "已中断",
};

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

function Elapsed({ active }: { active: boolean }) {
	const [start] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	const s = Math.max(0, Math.round((now - start) / 1000));
	const mm = String(Math.floor(s / 60)).padStart(2, "0");
	const ss = String(s % 60).padStart(2, "0");
	return <span className="tabular-nums text-muted-foreground">{active ? `${mm}:${ss}` : ""}</span>;
}

function statusBadge(call: ToolCallView) {
	if (call.status === "running")
		return (
			<Badge variant="secondary" className="gap-1">
				<span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
				执行中 <Elapsed active />
			</Badge>
		);
	if (call.status === "error") return <Badge variant="destructive">失败</Badge>;
	if (call.status === "interrupted") return <Badge variant="outline">已中断</Badge>;
	const details = call.details as { status?: string } | undefined;
	if (details?.status === "needs_input") return <Badge variant="secondary">等待输入</Badge>;
	return <Badge variant="secondary">完成</Badge>;
}

/** Badge for a worker-reported status string (custom_message details). */
function workerStatusBadge(status?: string) {
	if (status === "needs_input") return <Badge variant="secondary">等待输入</Badge>;
	if (status && status !== "completed") return <Badge variant="destructive">{status}</Badge>;
	return <Badge variant="secondary">完成</Badge>;
}

/**
 * 展开/折叠前解除 StickToBottom 的吸底锁定：内容变高时它的 ResizeObserver
 * 会把底部吸住（scrollTop 增大），导致被点击的卡片跳到视口顶部。官方 API
 * stopScroll() 同步置 escapedFromLock + isAtBottom=false，随后的高度变化
 * 不再触发吸底，标题保持原位、内容向下展开；用户向下滚动或折叠（负向
 * resize）时库会自动恢复吸底。isNearBottom 不受影响，「回到底部」浮钮
 * 也不会误现。
 */
function useEscapeBottomLock() {
	const { stopScroll } = useStickToBottomContext();
	return stopScroll;
}

/**
 * A worker-authored entry in the member message flow (§7): avatar + name +
 * status badge + task + result markdown, standing on its own instead of being
 * wrapped inside the manager bubble. Shared by direct/group delegate tool blocks
 * and solo-synced pudding:task_result custom messages.
 */
function WorkerTaskEntry({
	worker,
	task,
	result,
	badge,
	running,
	isError,
	meta,
	timestamp,
	children,
}: {
	worker: string;
	task?: string;
	result?: string;
	badge: React.ReactNode;
	running?: boolean;
	isError?: boolean;
	meta?: string;
	timestamp?: number;
	children?: React.ReactNode;
}) {
	// worker 工作过程：运行中/无结果时展开，拿到结果后自动折叠（可手动再展开）。
	const finished = !running && result !== undefined && result !== "";
	const [open, setOpen] = useState(!finished);
	const [wasFinished, setWasFinished] = useState(finished);
	if (finished !== wasFinished) {
		// render 期间按 props 变化调整 state：running→done 折叠一次。
		setWasFinished(finished);
		if (finished) setOpen(false);
	}
	const escapeBottomLock = useEscapeBottomLock();
	const time = timestamp
		? new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
		: "";
	const expandableResult = Boolean(result && (result.length > 360 || result.split("\n").length > 8));

	if (finished) {
		return (
			<div className="home-worker-entry is-finished">
				<WorkerAvatar name={worker} size={34} className="shrink-0" />
				<div className="home-worker-finished-body">
					<div className="home-worker-message-meta">
						<strong>{worker}</strong>
						{isError ? (
							<span className="home-worker-status is-error">失败</span>
						) : (
							<span className="home-worker-status is-complete"><CheckIcon />已完成</span>
						)}
						{time ? <time>{time}</time> : null}
					</div>
					<div className={`home-worker-result ${!open && expandableResult ? "is-clamped" : ""} ${isError ? "text-destructive" : ""}`}>
						<MessageResponse {...chatStreamdownProps}>{result}</MessageResponse>
					</div>
					{expandableResult ? (
						<button
							type="button"
							className="home-worker-result-toggle"
							onClick={() => {
								escapeBottomLock();
								setOpen((value) => !value);
							}}
						>
							{open ? "收起结果" : "展开结果"}
							<ChevronDownIcon className={open ? "rotate-180" : ""} />
						</button>
					) : null}
				</div>
			</div>
		);
	}

	return (
		<div className="home-worker-entry flex w-full items-start gap-2.5">
			<WorkerAvatar name={worker} size={34} className="shrink-0" />
			<div className="min-w-0 flex-1">
				<button
					type="button"
					onClick={() => {
						escapeBottomLock();
						setOpen((v) => !v);
					}}
					className="flex items-center gap-2 text-left"
				>
					{open ? (
						<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
					) : (
						<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
					)}
					<span className="truncate font-mono text-sm font-medium">{worker}</span>
					{badge}
				</button>
				{open ? (
					<>
						{task ? (
							<p className="mt-1 text-xs text-muted-foreground">
								<span className="mr-1.5 text-muted-foreground/60">任务：</span>
								<span className="whitespace-pre-wrap">{task}</span>
							</p>
						) : null}
						{running ? <p className="mt-1 text-xs text-muted-foreground">等待 worker 完成…</p> : null}
						{children}
						{result !== undefined && result !== "" && (
							<div className={`mt-1 text-sm ${isError ? "text-destructive" : ""}`}>
								<MessageResponse {...chatStreamdownProps}>{result}</MessageResponse>
							</div>
						)}
						{meta ? <p className="mt-1 text-xs text-muted-foreground/70 tabular-nums">{meta}</p> : null}
					</>
				) : task ? (
					<p className="mt-1 truncate text-xs text-muted-foreground">
						<span className="mr-1.5 text-muted-foreground/60">任务：</span>
						{task}
					</p>
				) : null}
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
		details.status,
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
function DelegateCard({ call, onOpenWindow }: { call: ToolCallView; onOpenWindow?: (windowId: string) => void }) {
	const args = call.args as { task?: string } | undefined;
	const worker = delegateWorker(call);
	const details = call.details as
		| {
				status?: string;
				synced?: boolean;
				windowId?: string;
				conflict?: boolean;
				interactionId?: string;
				delegationId?: string;
				revision?: number;
				requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
		  }
		| undefined;
	const [open, setOpen] = useState(false);
	// 任务/结果主体：运行中展开看进度，完成后自动折叠（可手动再展开）。
	const finished = call.status === "done" || call.status === "error" || call.status === "interrupted";
	const [bodyOpen, setBodyOpen] = useState(!finished);
	const [wasFinished, setWasFinished] = useState(finished);
	if (finished !== wasFinished) {
		// render 期间按 props 变化调整 state（React 推荐模式）：running→done 折叠一次。
		setWasFinished(finished);
		if (finished) setBodyOpen(false);
	}
	const meta = toolCallMeta(call);
	const escapeBottomLock = useEscapeBottomLock();

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
					requests={details.requests}
					revision={details.revision}
					windowId={details.windowId}
					onOpenWindow={onOpenWindow}
				/>
			</div>
		);
	}

	// HITL：等待审批 → 渲染审批卡（任务文本在先，审批卡是其后续动作）。
	if (details?.interactionId) {
		return (
			<div className="flex w-full flex-col gap-2">
				{args?.task ? (
					<p className="px-1 text-xs text-muted-foreground">
						<span className="mr-1.5 text-muted-foreground/60">任务：</span>
						<span className="whitespace-pre-wrap">{args.task}</span>
					</p>
				) : null}
				<InteractionCard
					interactionId={details.interactionId}
					worker={worker ?? "worker"}
					requests={details.requests}
					revision={details.revision}
					windowId={details.windowId}
					onOpenWindow={onOpenWindow}
				/>
			</div>
		);
	}

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
		<div className="w-full overflow-hidden rounded-lg bg-muted">
			<div className="flex items-center justify-between gap-2 px-3 pt-2">
				<button
					type="button"
					onClick={() => {
						escapeBottomLock();
						setBodyOpen((v) => !v);
					}}
					className="flex min-w-0 items-center gap-2 text-left"
				>
					{bodyOpen ? (
						<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
					) : (
						<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
					)}
					<WorkerAvatar name={worker ?? "worker"} size={20} />
					<span className="truncate font-mono text-sm font-medium">{worker ?? "worker"}</span>
				</button>
				<div className="flex shrink-0 items-center gap-2">
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
					{statusBadge(call)}
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
					{call.status === "running" ? (
						<p className="text-xs text-muted-foreground">等待 worker 完成…</p>
					) : null}
					{call.result !== undefined && (
						<div className={`text-sm ${call.isError ? "text-destructive" : ""}`}>
							<MessageResponse {...chatStreamdownProps}>{call.result}</MessageResponse>
						</div>
					)}
					{meta ? <p className="text-xs text-muted-foreground/70 tabular-nums">{meta}</p> : null}
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
				<div className="px-3 pb-2 pt-1">
					{args?.task ? (
						<p className="truncate text-xs text-muted-foreground">
							<span className="mr-1.5 text-muted-foreground/60">任务：</span>
							{args.task}
						</p>
					) : null}
				</div>
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
		if (windowType && windowType !== "solo") {
			const details = call.details as
				| { interactionId?: string; revision?: number; windowId?: string; requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }> }
				| undefined;
			// HITL：审批卡优先（等待审批），不做成普通 worker 结果条目。
			if (details?.interactionId) {
				return (
					<WorkerTaskEntry
						worker={delegateWorker(call) ?? "worker"}
						task={(call.args as { task?: string } | undefined)?.task}
						badge={statusBadge(call)}
						timestamp={timestamp}
					>
						<div className="mt-1">
							<InteractionCard
								interactionId={details.interactionId}
								worker={delegateWorker(call) ?? "worker"}
								requests={details.requests}
								revision={details.revision}
								windowId={details.windowId}
								onOpenWindow={onOpenWindow}
							/>
						</div>
					</WorkerTaskEntry>
				);
			}
			const args = call.args as { task?: string } | undefined;
			return (
				<WorkerTaskEntry
					worker={delegateWorker(call) ?? "worker"}
					task={args?.task}
					result={call.result}
					badge={statusBadge(call)}
					running={call.status === "running"}
					isError={call.isError}
					meta={toolCallMeta(call)}
					timestamp={timestamp}
				/>
			);
		}
		return <DelegateCard call={call} onOpenWindow={onOpenWindow} />;
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
							{statusBadge(call)}
						</div>
					</div>
				</div>
			);
		}
	}
	return (
		<Task defaultOpen={call.status === "running" || call.status === "error"}>
			<TaskTrigger title={`${TOOL_STATUS_LABEL[call.status]} · ${call.name}`} />
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
				revision?: number;
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
			return <WorkerTaskEntry worker={details?.worker ?? "worker"} badge={<Badge variant="secondary">执行中</Badge>} running timestamp={message.timestamp} />;
		}
		return (
			<AiMessage from="user" className="home-user-message">
				<MessageContent>
					<p className="text-xs text-muted-foreground">派给 {details?.worker ?? "worker"}</p>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
					{running ? <p className="text-xs text-muted-foreground">执行中…</p> : null}
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
				isError={Boolean(details?.status && details.status !== "completed")}
				timestamp={message.timestamp}
			/>
		);
	}

	// HITL：审批卡（§6.5）——历史中只存安全投影（无 token），状态由服务端对账。
	if (message.customType === "pudding:interaction_required") {
		return (
			<InteractionCard
				interactionId={details?.interactionId}
				worker={details?.worker ?? "worker"}
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
}: {
	message: ChatMessage;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	resolvedTaskIds?: Set<string>;
}) {
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
					<ManagerAvatar size={34} className="home-manager-avatar" />
					<div className="home-assistant-body">
						<div className="home-message-meta"><strong>Manager</strong><span>{time}</span></div>
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
							<MessageResponse
								className={`home-message-response ${message.error ? "text-destructive" : ""}`}
								{...chatStreamdownProps}
							>
								{message.content}
							</MessageResponse>
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
}) {
	return (
		<RoomFileContext.Provider value={roomId}>
			<MessageBody {...props} />
		</RoomFileContext.Provider>
	);
}

function AssistantReasoning({ streaming, thinking }: { streaming: boolean; thinking?: string }) {
	// Freeze the mount-time streaming flag: live messages mount open and auto-close
	// when the stream ends; history messages mount already collapsed, so switching
	// sessions never plays an open→close jump (vendored Reasoning auto-closes
	// whenever defaultOpen && !isStreaming).
	const [defaultOpen] = useState(() => streaming);

	return (
		<Reasoning isStreaming={streaming} defaultOpen={defaultOpen}>
			<ReasoningTrigger hasContent={Boolean(thinking)} />
			<ReasoningContent>{thinking ?? ""}</ReasoningContent>
		</Reasoning>
	);
}
