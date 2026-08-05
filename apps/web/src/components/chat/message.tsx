"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
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
import type { ChatMessage, ToolCallView } from "@/lib/types";
import { WorkerAvatar } from "./worker-avatar";

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
			<Badge className="gap-1 border-amber-500/50 text-amber-600">
				<span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
				执行中 <Elapsed active />
			</Badge>
		);
	if (call.status === "error") return <Badge className="border-destructive/50 text-destructive">失败</Badge>;
	const details = call.details as { status?: string } | undefined;
	if (details?.status === "needs_input")
		return <Badge className="border-amber-500/50 text-amber-600">等待输入</Badge>;
	return <Badge className="border-emerald-500/50 text-emerald-600">完成</Badge>;
}

/** Specialized card for team_task delegation — rendered as a member message
 * (worker avatar + name + result), with the raw tool call kept expandable. */
function TeamTaskCard({ call }: { call: ToolCallView }) {
	const args = call.args as { task?: string; model?: string } | undefined;
	const worker = teamTaskWorker(call);
	const details = call.details as
		| { status?: string; outcome?: string; exitCode?: number; elapsedMs?: number }
		| undefined;
	const [open, setOpen] = useState(false);

	const meta =
		details && (details.status || details.outcome !== undefined)
			? [
					details.status,
					details.outcome,
					details.elapsedMs !== undefined ? `${(details.elapsedMs / 1000).toFixed(0)}s` : undefined,
					details.exitCode !== undefined ? `exit ${details.exitCode}` : undefined,
				]
					.filter((x): x is string => Boolean(x))
					.join(" · ")
			: undefined;

	return (
		<div className="w-full overflow-hidden rounded-lg border bg-card">
			<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<WorkerAvatar name={worker ?? "team_task"} size={20} />
					<span className="truncate font-mono text-sm font-medium">{worker ?? "team_task"}</span>
					{args?.model ? (
						<span className="truncate text-xs text-muted-foreground">model: {args.model}</span>
					) : null}
				</div>
				{statusBadge(call)}
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
				{meta ? <p className="text-xs text-muted-foreground/70">{meta}</p> : null}
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

function ToolCallItem({ call }: { call: ToolCallView }) {
	if (call.name === "team_task") return <TeamTaskCard call={call} />;
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

export function Message({ message }: { message: ChatMessage }) {
	if (message.role === "user") {
		return (
			<AiMessage from="user">
				<MessageContent>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
				</MessageContent>
			</AiMessage>
		);
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

	return (
		<AiMessage from="assistant">
			<MessageContent>
				{showThinking && (
					<AssistantReasoning streaming={message.streaming} thinking={message.thinking} />
				)}
				{message.toolCalls.length > 0 && (
					<div className="flex w-full flex-col gap-2">
						{message.toolCalls.map((call) => (
							<ToolCallItem key={call.id} call={call} />
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
