"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
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
import { teamTaskWorker } from "@/lib/events";
import type { ChatMessage, ToolCallView, WindowType } from "@/lib/types";
import { WorkerAvatar } from "./worker-avatar";
import { InteractionCard } from "./interaction-card";

const TOOL_STATUS_LABEL: Record<ToolCallView["status"], string> = {
	pending: "待运行",
	running: "运行中",
	done: "完成",
	error: "失败",
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
 * A worker-authored entry in the member message flow (§7): avatar + name +
 * status badge + task + result markdown, standing on its own instead of being
 * wrapped inside the manager bubble. Shared by direct/group team_task blocks
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
	children,
}: {
	worker: string;
	task?: string;
	result?: string;
	badge: React.ReactNode;
	running?: boolean;
	isError?: boolean;
	meta?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex w-full items-start gap-2.5">
			<WorkerAvatar name={worker} size={28} className="mt-0.5 shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate font-mono text-sm font-medium">{worker}</span>
					{badge}
				</div>
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
						<MessageResponse {...streamdownPlugins}>{result}</MessageResponse>
					</div>
				)}
				{meta ? <p className="mt-1 text-xs text-muted-foreground/70 tabular-nums">{meta}</p> : null}
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
		.join(" · ");
}

/** Specialized card for team_task delegation — rendered as a member message
 * (worker avatar + name + result), with the raw tool call kept expandable. */
function TeamTaskCard({ call, onOpenWindow }: { call: ToolCallView; onOpenWindow?: (windowId: string) => void }) {
	const args = call.args as { task?: string; model?: string } | undefined;
	const worker = teamTaskWorker(call);
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
	const meta = toolCallMeta(call);

	// HITL：等待审批 → 渲染审批卡。
	if (details?.interactionId) {
		return (
			<div className="flex w-full flex-col gap-2">
				<InteractionCard
					interactionId={details.interactionId}
					worker={worker ?? "worker"}
					requests={details.requests}
					revision={details.revision}
					windowId={details.windowId}
					onOpenWindow={onOpenWindow}
				/>
				{args?.task ? (
					<p className="px-1 text-xs text-muted-foreground">
						<span className="mr-1.5 text-muted-foreground/60">任务：</span>
						<span className="whitespace-pre-wrap">{args.task}</span>
					</p>
				) : null}
			</div>
		);
	}

	// 409 冲突：渲染带「去处理」跳转的占用卡。
	if (details?.status === "conflict" || details?.conflict) {
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
				<div className="flex min-w-0 items-center gap-2">
					<WorkerAvatar name={worker ?? "team_task"} size={20} />
					<span className="truncate font-mono text-sm font-medium">{worker ?? "team_task"}</span>
					{args?.model ? (
						<span className="truncate text-xs text-muted-foreground">model: {args.model}</span>
					) : null}
				</div>
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
						<MessageResponse {...streamdownPlugins}>{call.result}</MessageResponse>
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
									model: args?.model,
								},
								null,
								2,
							)}
						</pre>
					</CollapsibleContent>
				</Collapsible>
			</div>
		</div>
	);
}

function ToolCallItem({
	call,
	windowType,
	onOpenWindow,
}: {
	call: ToolCallView;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
}) {
	if (call.name === "team_task") {
		// §7 成员消息流：direct/group 下脱离 manager 气泡，渲染为 worker 独立条目。
		if (windowType && windowType !== "solo") {
			const details = call.details as
				| { interactionId?: string; revision?: number; windowId?: string; requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }> }
				| undefined;
			// HITL：审批卡优先（等待审批），不做成普通 worker 结果条目。
			if (details?.interactionId) {
				return (
					<WorkerTaskEntry
						worker={teamTaskWorker(call) ?? "worker"}
						task={(call.args as { task?: string } | undefined)?.task}
						badge={statusBadge(call)}
					>
						<div className="mt-1">
							<InteractionCard
								interactionId={details.interactionId}
								worker={teamTaskWorker(call) ?? "worker"}
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
					worker={teamTaskWorker(call) ?? "team_task"}
					task={args?.task}
					result={call.result}
					badge={statusBadge(call)}
					running={call.status === "running"}
					isError={call.isError}
					meta={toolCallMeta(call)}
				/>
			);
		}
		return <TeamTaskCard call={call} onOpenWindow={onOpenWindow} />;
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
function CustomMessageEntry({ message }: { message: ChatMessage }) {
	const details = message.details as
		| {
				worker?: string;
				status?: string;
				windowId?: string;
				interactionId?: string;
				delegationId?: string;
				revision?: number;
				requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
		  }
		| undefined;

	if (message.customType === "pudding:task_assign") {
		return (
			<AiMessage from="user">
				<MessageContent>
					<p className="text-xs text-muted-foreground">派给 {details?.worker ?? "worker"}</p>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
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
		return (
			<p className="text-xs text-muted-foreground">
				审批已{details?.status === "approved" ? "批准" : details?.status === "rejected" ? "拒绝" : "处理"}，任务继续执行中。
			</p>
		);
	}

	// Unknown custom types stay visible but unobtrusive.
	return (
		<p className="text-xs text-muted-foreground">
			[{message.customType ?? "custom"}] {message.content}
		</p>
	);
}

export function Message({
	message,
	windowType,
	onOpenWindow,
}: {
	message: ChatMessage;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
}) {
	if (message.role === "user") {
		return (
			<AiMessage from="user">
				<MessageContent>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
				</MessageContent>
			</AiMessage>
		);
	}

	if (message.role === "custom") {
		return <CustomMessageEntry message={message} />;
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

	// §7: in direct/group windows team_task blocks leave the manager bubble and
	// render as standalone worker entries; other tools stay inside.
	const memberFlow = windowType === "direct" || windowType === "group";
	const bubbleCalls = memberFlow ? message.toolCalls.filter((c) => c.name !== "team_task") : message.toolCalls;
	const workerCalls = memberFlow ? message.toolCalls.filter((c) => c.name === "team_task") : [];
	const showBubble = showThinking || showContent || bubbleCalls.length > 0;

	return (
		<>
			{showBubble && (
				<AiMessage from="assistant">
					<MessageContent>
						{showThinking && (
							<AssistantReasoning streaming={message.streaming} thinking={message.thinking} />
						)}
						{bubbleCalls.length > 0 && (
							<div className="flex w-full flex-col gap-2">
								{bubbleCalls.map((call) => (
									<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} />
								))}
							</div>
						)}
						{showContent && (
							<MessageResponse
								className={message.error ? "text-destructive" : undefined}
								{...streamdownPlugins}
							>
								{message.content}
							</MessageResponse>
						)}
					</MessageContent>
				</AiMessage>
			)}
			{workerCalls.map((call) => (
				<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} />
			))}
		</>
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
