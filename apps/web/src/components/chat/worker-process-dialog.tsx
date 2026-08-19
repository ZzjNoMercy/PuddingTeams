"use client";

import { useEffect, useMemo, useState } from "react";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWorkerProcess } from "@/hooks/useWorkerProcess";
import { groupForRender, type RenderItem } from "@/lib/events";
import { AssistantGroup, Message } from "./message";

const statusText: Record<string, string> = {
	running: "执行中",
	waiting_input: "等待审批",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

function WorkerProcessBody({
	delegationId,
	onMeta,
}: {
	delegationId: string;
	onMeta: (meta: { live: boolean; status: string }) => void;
}) {
	// 默认只显示本次委托；切到完整会话可跨任务 trace（worker 会话是续接的）。
	const [full, setFull] = useState(false);
	const { messages, loading, live, status, agentId, createdAt, error } = useWorkerProcess(delegationId, full);
	const resolvedTaskIds = useMemo(() => new Set<string>(), []);

	useEffect(() => onMeta({ live, status }), [live, status, onMeta]);

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
		<>
			<div className="flex justify-end px-1 pb-1">
				<button
					type="button"
					className="text-xs text-muted-foreground hover:text-foreground"
					onClick={() => setFull((v) => !v)}
				>
					{full ? "只看本次委托" : "查看完整会话"}
				</button>
			</div>
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
				</ConversationContent>
				<ConversationScrollButton aria-label="回到底部" title="回到底部" />
			</Conversation>
		</>
	);
}

/** pi worker 执行过程查看器（只读）：历史回放 + live 实时事件流。 */
export function WorkerProcessDialog({
	delegationId,
	workerName,
	open,
	onOpenChange,
}: {
	delegationId: string | null;
	/** 入口卡片已知的 worker 显示名。 */
	workerName?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [meta, setMeta] = useState<{ live: boolean; status: string }>({ live: false, status: "" });
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[80vh] flex-col sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-base">
						{workerName ?? "worker"} 的执行过程
						{meta.live ? (
							<span className="inline-flex items-center gap-1 text-xs font-normal text-emerald-600">
								<span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-500" />
								实时
							</span>
						) : null}
						{meta.status ? (
							<span className="text-xs font-normal text-muted-foreground">
								{statusText[meta.status] ?? meta.status}
							</span>
						) : null}
					</DialogTitle>
					<DialogDescription>只读视图：worker 的 pi 会话历史与实时事件，不能在此输入。</DialogDescription>
				</DialogHeader>
				{open && delegationId ? (
					<WorkerProcessBody key={delegationId} delegationId={delegationId} onMeta={setMeta} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}
