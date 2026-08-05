"use client";

import { useState } from "react";
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
import { streamdownPlugins } from "@/core/streamdown/plugins";
import type { ChatMessage, ToolCallView } from "@/lib/types";

const TOOL_STATUS_LABEL: Record<ToolCallView["status"], string> = {
	pending: "待运行",
	running: "运行中",
	done: "完成",
	error: "失败",
};

function ToolCallItem({ call }: { call: ToolCallView }) {
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
