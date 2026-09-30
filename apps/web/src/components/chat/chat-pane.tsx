"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDownIcon, EllipsisIcon, FolderGit2Icon, FolderOpenIcon, InfoIcon, LayersIcon, ListTreeIcon, PanelLeftOpenIcon } from "lucide-react";
import { toast } from "sonner";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { useStickToBottomContext } from "use-stick-to-bottom";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { preloadChatHistory, useChat } from "@/hooks/useChat";
import { compactDay } from "@/lib/time";
import { isIMEComposing } from "@/lib/ime";
import { preferCurrentRoomSummary } from "@/lib/room-order";
import {
	createRoomSession,
	createWorkspace,
	deleteRoomSession,
	fetchRoomDelegationProcesses,
	getRoom,
	listWorkspaces,
	markRoomRead,
	renameRoomSession,
	setActiveRoomSession,
	switchRoomWorkspace,
	updateRoom,
	RoomCreationOperationConflictError,
	RoomSelectionStaleError,
	RoomSourceStaleError,
} from "@/lib/api";
import { clearGroupCreationOperation, groupWorkspaceSwitchFingerprint, reserveGroupCreationOperation } from "@/lib/group-creation-operation";
import { agentDisplayName, type ChatMessage, type ChatStatus, type RoomSession, type RoomSummary, type WorkspaceRecord } from "@/lib/types";
import { Composer } from "./composer";
import { computeSessionStats } from "@/lib/session-stats";
import { delegateWorker, groupForRender, isDelegateCall } from "@/lib/events";
import { useAgentLabels } from "@/lib/avatars";
import { AssistantGroup, Message, MessageQuickActionProvider } from "./message";
import { ManagerAvatar, MemberStack, WorkerAvatar } from "./worker-avatar";
import { DirectoryPickerDialog } from "./directory-picker-dialog";
import { WorkspaceTrustDialog, needsTrustDecision } from "./workspace-trust-dialog";
import { WorkspaceTrustBadge } from "./workspace-trust-badge";
import { ChatInfoDialog } from "./chat-info-dialog";
import { SessionMenu } from "./session-menu";
import { SessionWorkCard } from "./session-work-card";
import type { SessionExecutionTurn, SessionRuntimeSummary, SessionRuntimeView } from "./session-activity-drawer";
import { WorkerProcessDrawer } from "./worker-process-dialog";
import { WorkerProcessProvider } from "./worker-process-context";
import { InlinePiHistoryGate, InlinePiProcessProvider } from "./inline-pi-process";

const inlinePreferenceEvent = "pudding:inline-pi-process";
function subscribeInlinePreference(notify: () => void) {
	window.addEventListener("storage", notify);
	window.addEventListener(inlinePreferenceEvent, notify);
	return () => { window.removeEventListener("storage", notify); window.removeEventListener(inlinePreferenceEvent, notify); };
}

/** StickToBottom 的 isAtBottom 桥给悬浮层外的兄弟组件（统计条淡入淡出）。 */
function AtBottomReporter({ onChange }: { onChange: (atBottom: boolean) => void }) {
	const { isAtBottom } = useStickToBottomContext();
	useEffect(() => onChange(isAtBottom), [isAtBottom, onChange]);
	return null;
}

/** 同一浏览器标签内按 Room/Session 保存阅读位置；等完整历史显露后恢复。 */
function ConversationScrollMemory({ roomId, sessionId, ready }: { roomId: string; sessionId: string; ready: boolean }) {
	const { scrollRef, stopScroll } = useStickToBottomContext();
	useEffect(() => {
		if (!ready) return;
		const scroller = scrollRef.current;
		if (!scroller) return;
		const key = `puddingteams:conversation-scroll:v1:${roomId}:${sessionId}`;
		let saved: { top: number; atBottom: boolean } | null = null;
		try {
			const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
			if (parsed && typeof parsed === "object" && "top" in parsed && "atBottom" in parsed
				&& typeof parsed.top === "number" && Number.isFinite(parsed.top) && typeof parsed.atBottom === "boolean") saved = parsed as { top: number; atBottom: boolean };
		} catch { /* Storage is optional; this tab still works without restoration. */ }
		const save = () => {
			const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
			try { sessionStorage.setItem(key, JSON.stringify({ top: scroller.scrollTop, atBottom: max - scroller.scrollTop <= 24 })); }
			catch { /* Storage can be unavailable in a private browser context. */ }
		};
		let attached = false;
		let saveFrame = 0;
		const onScroll = () => {
			if (saveFrame) return;
			saveFrame = requestAnimationFrame(() => { saveFrame = 0; save(); });
		};
		const frame = requestAnimationFrame(() => {
			if (saved && !saved.atBottom) {
				stopScroll();
				scroller.scrollTop = Math.min(Math.max(0, saved.top), Math.max(0, scroller.scrollHeight - scroller.clientHeight));
			}
			scroller.addEventListener("scroll", onScroll, { passive: true });
			attached = true;
		});
		return () => {
			cancelAnimationFrame(frame);
			cancelAnimationFrame(saveFrame);
			if (attached) { scroller.removeEventListener("scroll", onScroll); save(); }
		};
	}, [ready, roomId, sessionId, scrollRef, stopScroll]);
	return null;
}

type QueryAxisItem = Pick<ChatMessage, "id" | "content">;

/**
 * Query 输入轴：把每轮用户输入映射成一枚可跳转刻度。当前刻度随聊天滚动
 * 自动更新；使用当前 Conversation 自己的 viewport，避免与执行过程抽屉串台。
 */
function QueryInputAxis({ items }: { items: QueryAxisItem[] }) {
	const axisRef = useRef<HTMLElement>(null);
	const [activeId, setActiveId] = useState(items.at(-1)?.id ?? "");
	const [preview, setPreview] = useState<{ content: string; index: number; top: number } | null>(null);

	useEffect(() => {
		if (items.length < 2) return;
		const root = axisRef.current?.closest('[role="log"]');
		if (!root) return;
		const scroller = root.querySelector<HTMLElement>(".conversation-scroll-viewport");
		if (!scroller) return;
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const viewport = scroller.getBoundingClientRect();
				const anchor = viewport.top + Math.min(190, viewport.height * 0.34);
				const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-query-axis-id]"));
				if (targets.length === 0) return;
				let current = targets[0]!;
				if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
					current = targets[targets.length - 1]!;
				} else {
					for (const target of targets) {
						if (target.getBoundingClientRect().top <= anchor) current = target;
						else break;
					}
				}
				setActiveId(current.dataset.queryAxisId ?? "");
			});
		};
		update();
		scroller.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update);
		observer.observe(scroller);
		return () => {
			cancelAnimationFrame(frame);
			scroller.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, [items]);

	useEffect(() => {
		const active = Array.from(axisRef.current?.querySelectorAll<HTMLElement>("[data-axis-target]") ?? [])
			.find((element) => element.dataset.axisTarget === activeId);
		const rail = axisRef.current?.querySelector<HTMLElement>(".home-query-axis-rail");
		if (!active || !rail) return;
		const top = active.offsetTop;
		const bottom = top + active.offsetHeight;
		if (top < rail.scrollTop) rail.scrollTop = top;
		else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight;
	}, [activeId]);

	if (items.length < 2) return null;

	const jumpTo = (id: string) => {
		const root = axisRef.current?.closest('[role="log"]');
		const target = Array.from(root?.querySelectorAll<HTMLElement>("[data-query-axis-id]") ?? [])
			.find((element) => element.dataset.queryAxisId === id);
		if (!target) return;
		target.scrollIntoView({
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			block: "start",
		});
	};
	const showPreview = (target: HTMLButtonElement, content: string, index: number) => {
		const axis = axisRef.current?.getBoundingClientRect();
		if (!axis) return;
		const tick = target.getBoundingClientRect();
		setPreview({ content, index, top: tick.top - axis.top + tick.height / 2 });
	};

	return (
		<nav ref={axisRef} className="home-query-axis" aria-label={`Query 输入轴，共 ${items.length} 条`}>
			<div className="home-query-axis-rail">
				{items.map((item, index) => {
					const active = item.id === activeId;
					const summary = item.content.replace(/\s+/g, " ").trim() || `Query ${index + 1}`;
					const previewDistance = preview ? Math.abs(preview.index - index) : null;
					const proximityClass = previewDistance === 0
						? " is-preview"
						: previewDistance === 1
							? " is-near-1"
							: previewDistance === 2
								? " is-near-2"
								: "";
					return (
						<button
							key={item.id}
							type="button"
							className={`home-query-axis-tick${active ? " is-active" : ""}${proximityClass}`}
							data-axis-target={item.id}
							onClick={() => jumpTo(item.id)}
							onMouseEnter={(event) => showPreview(event.currentTarget, summary, index)}
							onMouseLeave={() => setPreview(null)}
							onFocus={(event) => showPreview(event.currentTarget, summary, index)}
							onBlur={() => setPreview(null)}
							aria-current={active ? "step" : undefined}
							aria-label={`跳转到 Query ${index + 1}：${summary.slice(0, 48)}`}
						>
							<span className="home-query-axis-mark" />
						</button>
					);
				})}
			</div>
			{preview ? (
				<span className="home-query-axis-tooltip" role="tooltip" style={{ top: preview.top }}>
					<small>Query {String(preview.index + 1).padStart(2, "0")}</small>
					<span>{preview.content}</span>
				</span>
			) : null}
		</nav>
	);
}

function statusLabelOf(status: ChatStatus): string {
	switch (status) {
		case "connected":
			return "已连接 pi manager";
		case "connecting":
			return "连接中…";
		case "reconnecting":
			return "连接中断，重连中…";
		case "gone":
			return "会话不存在或已被删除";
		default:
			return "连接已断开，仍在后台重试";
	}
}

/** The live chat area for one pi session. Keyed by sessionId so switching
 * sessions remounts it (fresh history + WS). */
function SessionChat({
	roomId,
	sessionId,
	sessionLabel,
	sessionModifiedAt,
	emptyHint,
	windowType,
	onStatus,
	onOpenWindow,
	onRoomsMayHaveChanged,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	draftContextKey,
	onOpenWorkspace,
	blocked,
	sessionModel,
	sessionThinkingLevel,
	directWorkerModel,
	onSessionModelChange,
	onSessionThinkingChange,
	runtimeOpen,
	onRuntimeOpenChange,
	runtimeView,
	onRuntimeViewChange,
	onRuntimeSummaryChange,
	activityRevision,
	onHistoryReady,
}: {
	roomId: string;
	sessionId: string;
	sessionLabel: string;
	/** 会话最后活动时间，用于分隔条的 今天/昨天/周X 展示（与列表同源）。 */
	sessionModifiedAt?: string;
	emptyHint?: string;
	windowType: RoomSummary["type"];
	onStatus: (s: ChatStatus) => void;
	onOpenWindow?: (windowId: string) => void;
	/** manager 建房工具落定后回调：侧栏房间列表立即刷新，不等轮询。 */
	onRoomsMayHaveChanged?: () => void;
	workspaceLabel: string;
	workspacePath: string;
	workspaceAvailable: boolean;
	draftContextKey: string;
	onOpenWorkspace: () => void;
	blocked?: boolean;
	/** 会话真实模型 ref（rooms 数据），composer 选择器以此为准。 */
	sessionModel?: string;
	/** 会话真实 thinking level（rooms 数据，§10.6），composer 思考强度选择器以此为准。 */
	sessionThinkingLevel?: string;
	/** direct 消息由目标 Worker 的 Connector 执行，而不是房间 Session 模型。 */
	directWorkerModel?: { name: string; model?: string };
	onSessionModelChange?: (sessionId: string, model: string) => void;
	onSessionThinkingChange?: (sessionId: string, level: string) => void;
	runtimeOpen: boolean;
	onRuntimeOpenChange: (open: boolean) => void;
	runtimeView: SessionRuntimeView;
	onRuntimeViewChange: (view: SessionRuntimeView) => void;
	onRuntimeSummaryChange: (summary: SessionRuntimeSummary) => void;
	activityRevision: number;
	onHistoryReady?: (sessionId: string, activityRevision: number) => Promise<boolean>;
}) {
	const { messages, historyLoading, historyLoaded, status, running, unansweredUserMessage, unfinishedAssistantTurn, sending, stopping, error, unconfirmedOperation, send, stop, refreshHistory, reviewUnconfirmedHistory, startNewMessageIntent } = useChat(sessionId);
	const [newMessageIntentOpen, setNewMessageIntentOpen] = useState(false);
	const initialActivityRevision = useRef(activityRevision);
	const [presentedActivityRevision, setPresentedActivityRevision] = useState<number | null>(null);
	const acknowledgedRevision = useRef(0);
	const handleStop = useCallback(async () => {
		try {
			const result = await stop();
			toast.success(result.reconciledToolResults > 0
				? `任务已停止，已保存 ${result.reconciledToolResults} 个工具结果`
				: "任务已停止");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [stop]);
	const executionTurns = useMemo<SessionExecutionTurn[]>(() => messages
		.filter((message) => message.role === "user")
		.map((message, index) => ({
			id: message.id,
			index: index + 1,
			startedAt: message.timestamp,
			title: message.content.replace(/\s+/g, " ").trim().slice(0, 48) || "用户消息",
		})), [messages]);
	const queryAxisItems = useMemo<QueryAxisItem[]>(() => messages
		.filter((message) => message.role === "user" || (message.role === "custom" && message.customType === "pudding:user_message"))
		.map(({ id, content }) => ({ id, content })), [messages]);
	const [goalCreateOpen, setGoalCreateOpen] = useState(false);
	const [goalDraft, setGoalDraft] = useState("");
	const [hasGoal, setHasGoal] = useState(false);
	const [scrollButtonHost, setScrollButtonHost] = useState<HTMLDivElement | null>(null);
	const [atBottom, setAtBottom] = useState(true);
	const [transcriptReady, setTranscriptReady] = useState(false);
	const [transcriptReadReady, setTranscriptReadReady] = useState(false);
	const handleTranscriptReady = useCallback(() => setTranscriptReady(true), []);
	const handleTranscriptReadinessChange = useCallback((ready: boolean) => setTranscriptReadReady(ready), []);
	const [composerDraft, setComposerDraft] = useState<{ id: number; content: string }>();
	const composerDraftId = useRef(0);
	const draftFromMessage = useCallback((content: string) => {
		composerDraftId.current += 1;
		setComposerDraft({ id: composerDraftId.current, content });
	}, []);
	useEffect(() => onStatus(status), [status, onStatus]);
	const openGoalCommand = useCallback((initialGoal: string) => {
		setGoalDraft(initialGoal);
		setGoalCreateOpen(true);
	}, []);
	const layoutReady = !historyLoading;
	useEffect(() => {
		if (!historyLoaded || !layoutReady || !transcriptReady || !transcriptReadReady) return;
		setPresentedActivityRevision((previous) => previous ?? initialActivityRevision.current);
	}, [historyLoaded, layoutReady, transcriptReady, transcriptReadReady]);
	useEffect(() => {
		if (status === "gone" || presentedActivityRevision === null || !transcriptReadReady || !onHistoryReady) return;
		let cancelled = false;
		let inFlight = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const acknowledgeVisibleHistory = async () => {
			if (cancelled || inFlight || document.visibilityState !== "visible" || presentedActivityRevision <= acknowledgedRevision.current) return;
			inFlight = true;
			const confirmed = await onHistoryReady(sessionId, presentedActivityRevision);
			inFlight = false;
			// The acknowledgement callback refreshes room state and may replace this
			// effect before it resolves. Keep the confirmed watermark across cleanup.
			if (confirmed) acknowledgedRevision.current = Math.max(acknowledgedRevision.current, presentedActivityRevision);
			if (cancelled) return;
			if (!confirmed) retryTimer = setTimeout(() => void acknowledgeVisibleHistory(), 5000);
		};
		void acknowledgeVisibleHistory();
		document.addEventListener("visibilitychange", acknowledgeVisibleHistory);
		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			document.removeEventListener("visibilitychange", acknowledgeVisibleHistory);
		};
	}, [onHistoryReady, presentedActivityRevision, sessionId, status, transcriptReadReady]);
	useEffect(() => {
		if (status === "gone" || !historyLoaded || !layoutReady || !transcriptReady || !transcriptReadReady || presentedActivityRevision === null || activityRevision <= presentedActivityRevision) return;
		let cancelled = false;
		let inFlight = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const synchronizeVisibleHistory = async () => {
			if (cancelled || inFlight || document.visibilityState !== "visible") return;
			inFlight = true;
			const synchronized = await refreshHistory();
			inFlight = false;
			if (cancelled) return;
			if (synchronized) setPresentedActivityRevision((previous) => Math.max(previous ?? 0, activityRevision));
			else retryTimer = setTimeout(() => void synchronizeVisibleHistory(), 5000);
		};
		void synchronizeVisibleHistory();
		document.addEventListener("visibilitychange", synchronizeVisibleHistory);
		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			document.removeEventListener("visibilitychange", synchronizeVisibleHistory);
		};
	}, [activityRevision, historyLoaded, layoutReady, presentedActivityRevision, refreshHistory, status, transcriptReady, transcriptReadReady]);
	const sessionStats = useMemo(() => computeSessionStats(messages), [messages]);
	// running 态指派卡（pudding:task_assign）在同 taskId 的结果/审批卡到达后
	// 落定折叠。
	const resolvedTaskIds = useMemo(() => {
		const ids = new Set<string>();
		for (const m of messages) {
			if (m.role === "custom" && (m.customType === "pudding:task_result" || m.customType === "pudding:interaction_required")) {
				const taskId = (m.details as { taskId?: string } | undefined)?.taskId;
				if (taskId) ids.add(taskId);
			}
		}
		return ids;
	}, [messages]);
	const workStateSignal = useMemo(
		() => [...messages].reverse().find((message) => message.role === "custom" && message.customType === "pudding:work_plan_update")?.id,
		[messages],
	);
	const inlineHistoryIds = messages.flatMap((message) => {
		const details = message.details as { delegationId?: string; taskId?: string; status?: string; from?: string } | undefined;
		const rendered = message.customType === "pudding:task_result" || (message.customType === "pudding:task_assign"
			&& (details?.from === "direct" || details?.from === "solo") && details.status === "running" && !resolvedTaskIds.has(details.taskId ?? ""));
		return rendered && details?.delegationId ? [details.delegationId] : [];
	});
	// 拆分「等 worker」与「manager 思考」：delegate 工具阻塞在 manager 的 run 里，
	// run 活跃不等于 manager 在生成。有 running 态委托调用时，composer 提示
	// 等待哪个 worker，而不是笼统的「处理中」。
	const waitingWorkers = useMemo(() => {
		const names: string[] = [];
		for (const m of messages) {
			for (const call of m.toolCalls) {
				if (!isDelegateCall(call)) continue;
				const resumedStatus = (call.details as { status?: string } | undefined)?.status;
				if (call.status !== "running" && resumedStatus !== "running" && resumedStatus !== "approved") continue;
				const worker = delegateWorker(call);
				if (worker && !names.includes(worker)) names.push(worker);
			}
		}
		return names;
	}, [messages]);
	// manager 建房（create_group_window）落定后立即刷新侧栏房间列表——
	// 8s 轮询太慢，用户会以为群聊没建上。每个 toolCallId 只触发一次。
	const seenGroupCreations = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!onRoomsMayHaveChanged) return;
		for (const m of messages) {
			for (const call of m.toolCalls) {
				if (call.name !== "create_group_window") continue;
				if (call.status !== "done" && call.status !== "error") continue;
				if (seenGroupCreations.current.has(call.id)) continue;
				seenGroupCreations.current.add(call.id);
				if (call.status === "done") onRoomsMayHaveChanged();
			}
		}
	}, [messages, onRoomsMayHaveChanged]);
	// delegateWorker 反解出的是内部 id；等待提示渲染显示名。
	const agentLabels = useAgentLabels();
	const busyHint = running && waitingWorkers.length > 0 ? `等待 ${waitingWorkers.map((id) => agentLabels[id] ?? id).join("、")} 返回…` : undefined;
	const showUnansweredUserMessage = historyLoaded && unansweredUserMessage && !running && !sending &&
		messages.findLast((message) => message.role === "user" || message.role === "assistant")?.role === "user";
	const showUnfinishedAssistantTurn = historyLoaded && unfinishedAssistantTurn && !running && !sending &&
		messages.findLast((message) => message.role === "user" || message.role === "assistant")?.piStopReason === "toolUse";

	return (
		<div className="home-session-chat relative flex min-h-0 flex-1 flex-col" aria-busy={!layoutReady}>
			<div className={`flex min-h-0 flex-1 flex-col ${layoutReady ? "visible" : "invisible"}`}>
				<SessionWorkCard
					roomId={roomId}
					sessionId={sessionId}
					executionTurns={executionTurns}
					createOpen={goalCreateOpen}
					onCreateOpenChange={setGoalCreateOpen}
					initialGoal={goalDraft}
					onGoalStateChange={setHasGoal}
					onRuntimeSummaryChange={onRuntimeSummaryChange}
					workStateSignal={workStateSignal}
					runtimeOpen={runtimeOpen}
					onRuntimeOpenChange={onRuntimeOpenChange}
					runtimeView={runtimeView}
					onRuntimeViewChange={onRuntimeViewChange}
				/>
				<MessageQuickActionProvider onDraft={draftFromMessage}>
					<Conversation initial="instant" resize={layoutReady ? "smooth" : "instant"}>
						<AtBottomReporter onChange={setAtBottom} />
						<ConversationScrollMemory roomId={roomId} sessionId={sessionId} ready={transcriptReady} />
						<InlinePiHistoryGate ids={inlineHistoryIds} historyLoading={historyLoading} onReady={handleTranscriptReady} onReadinessChange={handleTranscriptReadinessChange}>
						<QueryInputAxis items={queryAxisItems} />
						<ConversationContent className="home-message-column">
							<div className="home-session-marker"><span />{sessionLabel}{sessionModifiedAt ? ` · ${compactDay(sessionModifiedAt)}` : ""}<span /></div>
							{messages.length === 0 ? (
								<div className="flex flex-1 items-center justify-center pt-20 text-sm text-muted-foreground">
									{emptyHint ?? "开始和 pi manager 对话"}
								</div>
							) : (
								groupForRender(messages).map((item) =>
									"kind" in item ? (
										<AssistantGroup key={item.id} roomId={roomId} messages={item.messages} windowType={windowType} onOpenWindow={onOpenWindow} />
									) : (
										<Message key={item.id} roomId={roomId} message={item} windowType={windowType} onOpenWindow={onOpenWindow} resolvedTaskIds={resolvedTaskIds} />
									),
								)
							)}
							{showUnansweredUserMessage ? (
								<p role="status" className="mx-auto mt-4 max-w-2xl rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-foreground">
									上次消息已保存，但未找到完成的回复。请核对历史；如需继续，请发送新指令。
								</p>
							) : null}
							{showUnfinishedAssistantTurn ? (
								<p role="status" className="mx-auto mt-4 max-w-2xl rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-foreground">
									本轮已有工具调用记录，但未找到最终回复。请先核对工具和审批状态，再决定是否发送新指令。
								</p>
							) : null}
						</ConversationContent>
						</InlinePiHistoryGate>
						<ConversationScrollButton
							portalTarget={scrollButtonHost}
							className="home-scroll-to-bottom"
							aria-label="回到底部"
							title="回到底部"
						/>
					</Conversation>
				</MessageQuickActionProvider>
				{blocked ? (
					<div className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-center text-xs text-destructive">
						项目路径已失效，重新绑定或切换项目后才能继续对话与派活。
					</div>
				) : null}
				<Composer
					sessionId={sessionId}
					draftScope={JSON.stringify([draftContextKey, roomId, sessionId])}
					disabled={status !== "connected" || running || sending || stopping || Boolean(blocked)}
					sending={sending}
					stopAvailable={running || stopping}
					stopping={stopping}
					busyHint={busyHint}
					hasGoal={hasGoal}
					workspaceLabel={workspaceLabel}
					workspacePath={workspacePath}
					workspaceAvailable={workspaceAvailable}
					sessionModel={sessionModel}
					sessionThinkingLevel={sessionThinkingLevel}
					directWorkerModel={directWorkerModel}
					stats={sessionStats}
					statsVisible={atBottom}
					onModelChanged={onSessionModelChange}
					onThinkingChanged={onSessionThinkingChange}
					onSend={send}
					onStop={handleStop}
					onGoalCommand={openGoalCommand}
					onOpenWorkspace={onOpenWorkspace}
					scrollButtonHostRef={setScrollButtonHost}
					draft={composerDraft}
				/>
			</div>
			{!layoutReady ? (
				<div className="absolute inset-0 flex items-center justify-center" role="status">
					<div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader size={14} />正在加载对话…</div>
				</div>
			) : null}
			{error ? (
				<div className="absolute bottom-24 left-1/2 z-20 w-[min(90%,36rem)] -translate-x-1/2 rounded-md border border-destructive/30 bg-background px-3 py-2 text-xs text-destructive shadow-md" role="alert">
					<p>{error}</p>
					{unconfirmedOperation ? (
						<div className="mt-2 flex flex-wrap items-center gap-2">
							<Button type="button" size="sm" variant="outline" onClick={() => {
								void reviewUnconfirmedHistory().then((ok) => {
									if (ok) toast.info("历史已刷新，请核对本次消息是否出现");
									else toast.error("历史刷新失败，请稍后重试");
								});
							}}>刷新并核对历史</Button>
							<Button type="button" size="sm" variant="outline" disabled={!unconfirmedOperation.historyReviewed} onClick={() => setNewMessageIntentOpen(true)}>
								核对后发起新消息
							</Button>
						</div>
					) : null}
				</div>
			) : null}
			<Dialog open={newMessageIntentOpen} onOpenChange={setNewMessageIntentOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>将草稿作为新消息发送？</DialogTitle>
						<DialogDescription>旧消息的结果仍未确认。请先核对上方历史；如果旧消息稍后出现，再发送可能产生第二条消息。确认后只会更新操作身份并保留草稿，需要你再次点击发送。</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setNewMessageIntentOpen(false)}>继续核对</Button>
						<Button type="button" onClick={() => {
							if (!startNewMessageIntent()) { toast.error("请先刷新并核对历史"); return; }
							setNewMessageIntentOpen(false);
							toast.info("草稿已保留；确认后请再次点击发送");
						}}>保留草稿，发起新消息</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function ChatPane({
	roomId,
	requestedSessionId,
	requestedSessionActivation = "self",
	workspaceSwitchRequest,
	workspaceDialogOnly = false,
	openWorkspaceOnMount = false,
	onWorkspacePickerClosed,
	onOpenWindow,
	onInvalidRequestedSession,
	onRoomUpdated,
	onSessionActivated,
	onWorkspaceSwitched,
	onOpenRoomList,
	onRoomsMayHaveChanged,
}: {
	roomId: string;
	requestedSessionId?: string | null;
	requestedSessionActivation?: "self" | "parent";
	workspaceSwitchRequest?: number;
	workspaceDialogOnly?: boolean;
	openWorkspaceOnMount?: boolean;
	onWorkspacePickerClosed?: () => void;
	onOpenWindow?: (windowId: string, sourceSessionId?: string) => void;
	onInvalidRequestedSession?: (roomId: string, sessionId: string) => void;
	onRoomUpdated?: (room: RoomSummary) => void;
	/** Local session creation or selection; parent updates its requested session and URL. */
	onSessionActivated?: (room: RoomSummary) => void;
	/** Local in-place Workspace change; parent routes away from the old Session. */
	onWorkspaceSwitched?: (room: RoomSummary) => void;
	onOpenRoomList?: () => void;
	onRoomsMayHaveChanged?: () => void;
}) {
	const [room, setRoom] = useState<RoomSummary | null>(null);
	const [roomLoadError, setRoomLoadError] = useState<string | null>(null);
	const [roomLoadNonce, setRoomLoadNonce] = useState(0);
	const inlinePreferenceKey = `pudding:inline-pi-process:${roomId}`;
	const inlinePiProcess = useSyncExternalStore(subscribeInlinePreference, () => {
		try { return localStorage.getItem(inlinePreferenceKey) === "true"; } catch { return false; }
	}, () => false);
	const toggleInlinePiProcess = () => {
		try {
			localStorage.setItem(inlinePreferenceKey, String(!inlinePiProcess));
			window.dispatchEvent(new Event(inlinePreferenceEvent));
		} catch { toast.error("无法保存显示偏好"); }
	};
	const [activeId, setActiveId] = useState<string>("");
	const [historicalPiProcess, setHistoricalPiProcess] = useState<{ roomId: string; sessionId: string; available: boolean } | null>(null);
	const sessionSwitchQueue = useRef<Promise<void>>(Promise.resolve());
	const pendingSessionSwitches = useRef(0);
	const sessionSwitchGeneration = useRef(0);
	const [status, setStatus] = useState<ChatStatus>("connecting");
	const [delayedConnectionStatus, setDelayedConnectionStatus] = useState<ChatStatus | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [promptOpen, setPromptOpen] = useState(false);
	const [promptValue, setPromptValue] = useState("");
	const [chatInfoOpen, setChatInfoOpen] = useState(false);
	const [workerProcessOpen, setWorkerProcessOpen] = useState(false);
	const [goalRuntimeOpen, setGoalRuntimeOpen] = useState(false);
	const [runtimeView, setRuntimeView] = useState<SessionRuntimeView>("activity");
	const [runtimeSummary, setRuntimeSummary] = useState<SessionRuntimeSummary | null>(null);
	const [requestedDelegationId, setRequestedDelegationId] = useState<string | null>(null);
	const [requestedFullWorkerSession, setRequestedFullWorkerSession] = useState(false);
	const [pendingDeleteSession, setPendingDeleteSession] = useState<RoomSession | null>(null);
	const [renamingSession, setRenamingSession] = useState<RoomSession | null>(null);
	const [sessionRenameValue, setSessionRenameValue] = useState("");
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceRecord[]>([]);
	const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
	const [workspaceSelectionError, setWorkspaceSelectionError] = useState<string | null>(null);
	const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
	const [workspacePath, setWorkspacePath] = useState("");
	const [switchToDefault, setSwitchToDefault] = useState(false);
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
	const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
	const workspacePreparationRef = useRef(false);
	const workspaceRequestRef = useRef(false);
	const [trustCandidate, setTrustCandidate] = useState<{ workspace: WorkspaceRecord; mode: "new_window" | "in_place" } | null>(null);
	/** 头部「待信任/已拒绝」badge 点开的信任复核（与切换项目流程分开）。 */
	const [trustReview, setTrustReview] = useState<WorkspaceRecord | null>(null);
	const openWorkerProcess = useCallback((delegationId: string, fullSession = false) => {
		setChatInfoOpen(false);
		setGoalRuntimeOpen(false);
		setRequestedDelegationId(delegationId);
		setRequestedFullWorkerSession(fullSession);
		setWorkerProcessOpen(true);
	}, []);
	const changeGoalRuntimeOpen = useCallback((open: boolean) => {
		if (open) {
			setWorkerProcessOpen(false);
			setRequestedDelegationId(null);
			if (runtimeView === "goal" && !runtimeSummary?.hasGoal) setRuntimeView("activity");
			if (runtimeView === "activity" && runtimeSummary?.sessionTotal === 0 && runtimeSummary.hasGoal) setRuntimeView("goal");
		}
		setGoalRuntimeOpen(open);
	}, [runtimeSummary, runtimeView]);

	useEffect(() => {
		let cancelled = false;
		void getRoom(roomId)
			.then(async (initial) => {
				if (cancelled) return;
				let r = initial;
				if (requestedSessionId) {
					if (!r.sessions.some((session) => session.id === requestedSessionId)) {
						if (requestedSessionActivation === "parent") { onRoomUpdated?.(r); return; }
						toast.error("目标会话不存在或不属于此对话，已打开当前会话");
						onInvalidRequestedSession?.(roomId, requestedSessionId);
					} else if (r.activeSession !== requestedSessionId) {
						if (requestedSessionActivation === "parent") { onRoomUpdated?.(r); return; }
						try {
							await setActiveRoomSession(roomId, requestedSessionId);
							r = await getRoom(roomId);
							if (r.activeSession !== requestedSessionId || !r.sessions.some((session) => session.id === requestedSessionId)) {
								throw new Error("目标会话已在其他窗口改变，请重试");
							}
						} catch (error) {
							if (!cancelled) setRoomLoadError(`无法定位目标会话：${error instanceof Error ? error.message : String(error)}`);
							return;
						}
					}
				}
				if (cancelled) return;
				setWorkerProcessOpen(false);
				setGoalRuntimeOpen(false);
				setRuntimeSummary(null);
				setRuntimeView("activity");
				setRequestedDelegationId(null);
				setRoom(r);
				setRoomLoadError(null);
				setActiveId(r.activeSession || "");
				onRoomUpdated?.(r);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setRoomLoadError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [roomId, requestedSessionId, requestedSessionActivation, onRoomUpdated, onInvalidRequestedSession, roomLoadNonce]);

	// 首条消息发出后 LLM 异步生成会话标题；轻量轮询把标题/时间刷出来。
	// 正常情况下保留当前 activeId；若另一个客户端切换了 Solo Workspace，
	// 旧 Session 会被停放并从当前 sessions 移除，此时必须跟随服务端切到
	// 新 activeSession，否则会持续请求 inactive context 并得到 409。
	useEffect(() => {
		let cancelled = false;
		const timer = setInterval(() => {
			const switchGeneration = sessionSwitchGeneration.current;
			void getRoom(roomId)
				.then((r) => {
					if (cancelled || pendingSessionSwitches.current > 0 || switchGeneration !== sessionSwitchGeneration.current || (room && preferCurrentRoomSummary(room, r) !== r)) return;
					setRoom((prev) => (prev ? preferCurrentRoomSummary(prev, r) : prev));
					setActiveId((current) =>
						r.sessions.some((session) => session.id === current)
						? current
						: r.activeSession || "",
					);
				})
				.catch(() => undefined);
		}, 8000);
		return () => { cancelled = true; clearInterval(timer); };
	}, [roomId, room]);

	// Session 切换会创建一条新 WebSocket，正常握手通常在一瞬间完成。
	// 延迟展示非 connected 状态，避免把正常切换误报成一次可见的连接故障；
	// 真正持续的首次连接/重连仍会出现，error/gone 则立即提示。
	useEffect(() => {
		if (status === "connected" || status === "error" || status === "gone") return;
		const timer = setTimeout(() => setDelayedConnectionStatus(status), 700);
		return () => clearTimeout(timer);
	}, [status]);

	const acknowledgePresentedActivity = useCallback(async (sessionId: string, revision: number): Promise<boolean> => {
		if (!room?.sessions.some((session) => session.id === sessionId) || revision === 0) return true;
		try {
			await markRoomRead(roomId, sessionId, revision);
			const updated = await getRoom(roomId);
			setRoom((prev) => preferCurrentRoomSummary(prev, updated));
			onRoomUpdated?.(updated);
			return true;
		} catch {
			return false;
		}
	}, [room?.sessions, roomId, onRoomUpdated]);

	/** composer 改模型后本地同步 rooms 数据，避免切换会话后回读旧值。 */
	const handleSessionModelChange = useCallback((sessionId: string, model: string) => {
		setRoom((prev) =>
			prev
				? { ...prev, sessions: prev.sessions.map((s) => (s.id === sessionId ? { ...s, model } : s)) }
				: prev,
		);
	}, []);

	/** composer 改思考强度后本地同步 rooms 数据（§10.6 会话级真值）。 */
	const handleSessionThinkingChange = useCallback((sessionId: string, thinkingLevel: string) => {
		setRoom((prev) =>
			prev
				? { ...prev, sessions: prev.sessions.map((s) => (s.id === sessionId ? { ...s, thinkingLevel } : s)) }
				: prev,
		);
	}, []);

	const switchSession = useCallback((sessionId: string): Promise<void> => {
		if (sessionId === activeId && pendingSessionSwitches.current === 0) return Promise.resolve();
		pendingSessionSwitches.current += 1;
		sessionSwitchGeneration.current += 1;
		const next = sessionSwitchQueue.current.then(async () => {
			setWorkerProcessOpen(false);
			setGoalRuntimeOpen(false);
			setRuntimeSummary(null);
			setRuntimeView("activity");
			setRequestedDelegationId(null);
			void preloadChatHistory(sessionId).catch(() => undefined);
			await setActiveRoomSession(roomId, sessionId);
			const updated = await getRoom(roomId);
			if (updated.activeSession !== sessionId) throw new Error("当前会话已在其他窗口改变，请从会话列表重新打开");
			setRoom(updated);
			setActiveId(sessionId);
			onSessionActivated?.(updated);
		}).catch((err: unknown) => {
			toast.error(err instanceof Error ? err.message : String(err));
		}).finally(() => {
			pendingSessionSwitches.current -= 1;
			sessionSwitchGeneration.current += 1;
		});
		sessionSwitchQueue.current = next;
		return next;
	}, [roomId, activeId, onSessionActivated]);

	const newSession = useCallback(async () => {
		setWorkerProcessOpen(false);
		setGoalRuntimeOpen(false);
		setRuntimeSummary(null);
		setRuntimeView("activity");
		setRequestedDelegationId(null);
		try {
			const created = await createRoomSession(roomId);
			const updated = await getRoom(roomId);
			if (updated.activeSession !== created.id) throw new Error("新会话已创建，但当前会话已在其他窗口改变，请从会话列表打开");
			setRoom(updated);
			setActiveId(created.id);
			onSessionActivated?.(updated);
			onRoomsMayHaveChanged?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [roomId, onSessionActivated, onRoomsMayHaveChanged]);

	const removeSession = useCallback(
		async (sessionId: string) => {
			try {
				await deleteRoomSession(roomId, sessionId);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				return;
			}
			setRoom((prev) => {
				if (!prev) return prev;
				const sessions = prev.sessions.filter((s) => s.id !== sessionId);
				// Mirror the server: a deleted active session falls back to the
				// first remaining one. setActiveId must follow, otherwise the UI
				// stays on the deleted session.
				const active = prev.activeSession === sessionId ? sessions[0]!.id : prev.activeSession;
				setActiveId(active);
				return { ...prev, sessions, activeSession: active };
			});
		},
		[roomId],
	);

	const openSessionRename = useCallback((session: RoomSession) => {
		setRenamingSession(session);
		setSessionRenameValue(session.name || session.firstMessage || "新对话");
	}, []);

	const saveSessionRename = useCallback(async () => {
		if (!renamingSession || !sessionRenameValue.trim()) return;
		try {
			const updated = await renameRoomSession(roomId, renamingSession.id, sessionRenameValue.trim());
			setRoom((prev) =>
				prev
					? { ...prev, sessions: prev.sessions.map((session) => (session.id === updated.id ? updated : session)) }
					: prev,
			);
			setRenamingSession(null);
			toast.success("会话已重命名");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [renamingSession, roomId, sessionRenameValue]);

	const openRename = useCallback(() => {
		setRenameValue(room?.name ?? "");
		setRenaming(true);
	}, [room]);

	const saveRename = useCallback(async () => {
		try {
			const updated = await updateRoom(roomId, { name: renameValue.trim() || undefined });
			setRoom(updated);
			onRoomUpdated?.(updated);
			toast.success("已重命名");
			setRenaming(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [roomId, renameValue, onRoomUpdated]);

	const openPrompt = useCallback(() => {
		setPromptValue(room?.prompt ?? "");
		setPromptOpen(true);
	}, [room]);

	const savePrompt = useCallback(async () => {
		try {
			const updated = await updateRoom(roomId, { prompt: promptValue.trim() || undefined });
			setRoom(updated);
			toast.success(updated.prompt ? "提示词已保存" : "已恢复默认提示词");
			setPromptOpen(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [roomId, promptValue]);

	const openWorkspaceSwitch = useCallback(() => {
		if (workspacePreparationRef.current || workspaceRequestRef.current) return;
		setWorkspaceOpen(true);
		setWorkspacePath("");
		setTargetWorkspaceId("");
		setSwitchToDefault(false);
		setDirectoryPickerOpen(false);
		setWorkspaceLoadError(null);
		setWorkspaceSelectionError(null);
		void listWorkspaces()
			.then((items) => {
				setWorkspaceOptions(items);
			})
			.catch((err: unknown) => setWorkspaceLoadError(err instanceof Error ? err.message : String(err)));
	}, []);
	const previousWorkspaceSwitchRequest = useRef(workspaceSwitchRequest);
	useEffect(() => {
		if (openWorkspaceOnMount) openWorkspaceSwitch();
	}, [openWorkspaceOnMount, openWorkspaceSwitch]);
	const workspacePickerWasOpen = useRef(false);
	useEffect(() => {
		if (!openWorkspaceOnMount) return;
		if (workspaceOpen) workspacePickerWasOpen.current = true;
		else if (workspacePickerWasOpen.current) {
			workspacePickerWasOpen.current = false;
			onWorkspacePickerClosed?.();
		}
	}, [openWorkspaceOnMount, workspaceOpen, onWorkspacePickerClosed]);
	useEffect(() => {
		if (workspaceSwitchRequest === undefined || workspaceSwitchRequest === previousWorkspaceSwitchRequest.current) return;
		previousWorkspaceSwitchRequest.current = workspaceSwitchRequest;
		openWorkspaceSwitch();
	}, [workspaceSwitchRequest, openWorkspaceSwitch]);

	const doWorkspaceSwitch = useCallback(
		async (workspaceId: string | null, mode: "new_window" | "in_place") => {
			if (workspaceRequestRef.current) return;
			workspaceRequestRef.current = true;
			setSwitchingWorkspace(true);
			try {
				const groupSwitch = room?.type === "group" && mode === "new_window";
				const fingerprint = groupSwitch ? groupWorkspaceSwitchFingerprint(roomId, workspaceId) : "";
				let storage: Storage | null = null;
				try { storage = window.sessionStorage; } catch { /* Same-tab memory fallback. */ }
				const operationId = groupSwitch ? reserveGroupCreationOperation(fingerprint, storage) : undefined;
				let result: Awaited<ReturnType<typeof switchRoomWorkspace>>;
				try {
					result = await switchRoomWorkspace(roomId, workspaceId, mode, operationId, room ?? undefined);
				} catch (error) {
					if (operationId && (error instanceof RoomCreationOperationConflictError || error instanceof RoomSourceStaleError)) clearGroupCreationOperation(fingerprint, operationId, storage);
					if (error instanceof RoomSourceStaleError) {
						setWorkspaceSelectionError(`${error.message}。请重新打开来源房间后发起。`);
						if (!error.unavailable) {
							try { setRoom(await getRoom(roomId)); } catch { /* The source may have been deleted meanwhile. */ }
						}
						onRoomsMayHaveChanged?.();
					}
					if (error instanceof RoomSelectionStaleError) {
						setWorkspaceSelectionError(error.selection === "workspace"
							? `${error.message}。请重新选择项目。`
							: `${error.message}。请更新房间成员或重新启用 Worker。`);
						if (error.selection === "workspace") {
							try {
								setWorkspaceOptions(await listWorkspaces());
								setWorkspaceLoadError(null);
							} catch (refreshError) {
								setWorkspaceLoadError(refreshError instanceof Error ? refreshError.message : String(refreshError));
							}
						}
					}
					throw error;
				}
				if (operationId) clearGroupCreationOperation(fingerprint, operationId, storage);
				setWorkspaceOpen(false);
				if (result.room.id === roomId) {
					setRoom(result.room);
					setActiveId(result.room.activeSession || "");
					if (onWorkspaceSwitched) onWorkspaceSwitched(result.room);
					else onRoomUpdated?.(result.room);
				} else {
					onOpenWindow?.(result.room.id, activeId);
				}
				toast.success(
					mode === "in_place"
						? result.restored ? "已切换项目并恢复历史会话" : "已切换项目并开始新会话"
						: result.existed ? "已打开已有对话" : "已创建新对话",
				);
			} finally {
				workspaceRequestRef.current = false;
				setSwitchingWorkspace(false);
			}
		},
		[roomId, room, activeId, onRoomUpdated, onWorkspaceSwitched, onOpenWindow, onRoomsMayHaveChanged],
	);

	const saveWorkspaceSwitch = useCallback(async (mode: "new_window" | "in_place") => {
		if (workspacePreparationRef.current || workspaceRequestRef.current) return;
		workspacePreparationRef.current = true;
		setSwitchingWorkspace(true);
		try {
			let workspace: WorkspaceRecord | undefined;
			if (!switchToDefault) {
				if (workspacePath.trim()) {
					workspace = await createWorkspace({ path: workspacePath.trim() });
				} else {
					workspace = workspaceOptions.find((item) => item.id === targetWorkspaceId);
					if (!workspace) throw new Error("请选择项目文件夹或最近项目");
				}
			}
			// 信任门（§7.2）：含可注入资源的外部项目先弹信任卡，再执行切换。
			if (workspace && needsTrustDecision(workspace)) {
				setTrustCandidate({ workspace, mode });
				return;
			}
			await doWorkspaceSwitch(workspace?.id ?? null, mode);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			workspacePreparationRef.current = false;
			setSwitchingWorkspace(false);
		}
	}, [targetWorkspaceId, workspacePath, switchToDefault, workspaceOptions, doWorkspaceSwitch]);

	const members = room?.members ?? [];
	const directMemberName = members[0]?.name ?? "Worker";
	const type = room?.type ?? "solo";
	const isSingle = type === "direct";
	const currentPiWorker = isSingle && members[0]?.connector?.connectorId === "pi";
	const canInlinePiProcess = isSingle && (currentPiWorker || (historicalPiProcess?.roomId === roomId && historicalPiProcess.sessionId === activeId && historicalPiProcess.available));
	useEffect(() => {
		if (!isSingle || currentPiWorker || !activeId) return;
		let current = true;
		void fetchRoomDelegationProcesses(roomId, activeId)
			.then((items) => {
				if (current) setHistoricalPiProcess({ roomId, sessionId: activeId, available: items.some((item) => item.view === "session" && item.workerStarted) });
			})
			.catch(() => {
				if (current) setHistoricalPiProcess({ roomId, sessionId: activeId, available: false });
			});
		return () => { current = false; };
	}, [roomId, activeId, isSingle, currentPiWorker]);
	const isGroup = type === "group";
	const headerTitle = room?.name ?? (roomLoadError ? "对话暂不可用" : "正在加载对话…");
	const activeSession = room?.sessions.find((s) => s.active);
	const sessionTitle =
		activeSession?.name ||
		(activeSession?.firstMessage && activeSession.firstMessage !== "新对话" && activeSession.firstMessage !== "(no messages)" ? activeSession.firstMessage : "") ||
		"";
	const subtitle =
		type === "group"
			? `${members.length} 位 Worker · Manager 在场`
			: type === "direct"
				? members[0]?.description || `与 ${members[0] ? agentDisplayName(members[0]) : ""} 单聊`
			: room ? "理解消息、组织协作并汇总结果" : "";
	const workspaceTargetReady = !workspaceLoadError && !workspaceSelectionError && (switchToDefault || Boolean(targetWorkspaceId || workspacePath.trim()));
	const workspaceLabel = room?.workspace ? `项目 · ${room.workspace.name}` : "默认目录";
	const currentWorkspacePath = room?.workspace?.rootPath ?? room?.cwdSnapshot ?? "";
	const recentWorkspaceOptions = workspaceOptions.filter((item) => item.id !== room?.workspace?.id);
	const selectedRecentWorkspace = recentWorkspaceOptions.find((item) => item.id === targetWorkspaceId);
	const newWindowLabel = type === "group" ? "新建群聊" : "新建/打开单聊";
	const directoryPickerInitialPath =
		workspacePath || workspaceOptions.find((item) => item.id === targetWorkspaceId)?.rootPath || room?.cwdSnapshot || "";
	const emptyHint = isGroup
		? `群聊：${members.map((m) => agentDisplayName(m)).join("、")} 在窗口里，pi manager 负责调度。试试对 manager 说：让 ${members[0] ? agentDisplayName(members[0]) : "worker"} 分析一个任务…`
		: isSingle
			? `和 ${members[0] ? agentDisplayName(members[0]) : "Worker"} 单聊。发送消息后由本窗口的 Worker 直接执行。`
			: "开始和 pi manager 对话";

	return (
		<div className="home-chat-pane relative flex h-full min-w-0">
			{!workspaceDialogOnly ? <>
			<div className={`home-chat-primary flex min-w-0 flex-1 flex-col${goalRuntimeOpen ? ` runtime-drawer-open runtime-view-${runtimeView}` : ""}`}>
			<header className="home-chat-header">
				<div className="home-chat-identity">
					{onOpenRoomList ? <Button type="button" size="icon" variant="ghost" className="home-open-rooms md:hidden" aria-label="打开对话列表" onClick={onOpenRoomList}><PanelLeftOpenIcon className="size-4" /></Button> : null}
					{isGroup ? (
						<MemberStack members={members} size={34} />
					) : isSingle ? (
						<WorkerAvatar name={directMemberName} size={34} />
					) : (
						<ManagerAvatar size={34} />
					)}
					<div className="min-w-0">
						<div className="home-chat-title-row">
							<div className="home-chat-title">{headerTitle}</div>
						</div>
						{subtitle ? (
							<div className="home-chat-subtitle">{subtitle}</div>
						) : null}
					</div>
				</div>
				<div className="home-chat-actions">
					{canInlinePiProcess ? <button type="button" role="switch" aria-checked={inlinePiProcess}
						aria-label="在主对话中显示执行过程" title="在主对话中显示 Pi Worker 的思考、工具调用和回复"
						className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
						onClick={toggleInlinePiProcess}>
						<span>执行过程</span><span className={`flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${inlinePiProcess ? "bg-primary" : "bg-muted-foreground/30"}`}><span className={`size-3 rounded-full bg-background transition-transform ${inlinePiProcess ? "translate-x-3" : ""}`} /></span>
					</button> : null}
					<SessionMenu
						sessions={room?.sessions ?? []}
						trigger={(
							<Button type="button" size="sm" variant="outline" className="home-context-pill">
								<LayersIcon className="size-3.5" />
								<span>{sessionTitle || "会话"}</span>
								<ChevronDownIcon className="size-3" />
							</Button>
						)}
						onSwitch={switchSession}
						onNew={newSession}
						onRename={openSessionRename}
						onDelete={setPendingDeleteSession}
					/>
					{runtimeSummary && (runtimeSummary.hasGoal || runtimeSummary.sessionTotal > 0) ? (
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className={"home-chat-more goal-header-trigger" + (goalRuntimeOpen ? " is-active" : "")}
							aria-label="任务与执行"
							title="任务与执行"
							onClick={() => changeGoalRuntimeOpen(true)}
						>
							<ListTreeIcon className="size-4" />
							{runtimeSummary.total > 0 ? <span className="goal-header-badge">已报告 {runtimeSummary.completed}/{runtimeSummary.total}</span> : runtimeSummary.pending > 0 ? <span className="goal-header-badge">{runtimeSummary.pending}</span> : runtimeSummary.running > 0 ? <span className="goal-header-live" /> : null}
						</Button>
					) : null}
					<Button type="button" size="icon" variant="ghost" className="home-chat-more" aria-label="聊天设置" title="聊天设置" onClick={() => { setWorkerProcessOpen(false); setChatInfoOpen(true); }}>
						<EllipsisIcon className="size-4" />
					</Button>
					{(status === "error" || status === "gone" || delayedConnectionStatus === status) && status !== "connected" ? (
						<span
							className={`absolute right-0 top-[calc(100%+0.375rem)] z-30 hidden items-center gap-2 whitespace-nowrap rounded-full border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur sm:flex ${
								status === "connecting" || status === "reconnecting"
									? "text-muted-foreground/70"
									: "text-destructive"
							}`}
						>
							{(status === "connecting" || status === "reconnecting") && <Loader size={12} />}
							{statusLabelOf(status)}
						</span>
					) : null}
				</div>
			</header>
			{activeId && room ? (
				<InlinePiProcessProvider key={activeId} enabled={canInlinePiProcess && inlinePiProcess} roomId={roomId} sessionId={activeId} openWorkerProcess={openWorkerProcess}>
				<SessionChat
					key={activeId}
					roomId={roomId}
					sessionId={activeId}
					sessionLabel={sessionTitle || "新会话"}
					sessionModifiedAt={room.sessions.find((s) => s.id === activeId)?.modifiedAt}
					emptyHint={emptyHint}
					windowType={type}
					onStatus={setStatus}
					onOpenWindow={(windowId) => onOpenWindow?.(windowId, activeId)}
					onRoomsMayHaveChanged={onRoomsMayHaveChanged}
					workspaceLabel={workspaceLabel}
					workspacePath={currentWorkspacePath}
					workspaceAvailable={room.contextAvailable}
					draftContextKey={JSON.stringify([room.workspace?.id ?? null, room.cwdSnapshot])}
					onOpenWorkspace={openWorkspaceSwitch}
					blocked={!room.contextAvailable || status === "gone"}
					sessionModel={activeSession?.model}
					sessionThinkingLevel={activeSession?.thinkingLevel}
					directWorkerModel={isSingle ? { name: members[0]?.name ?? "", model: typeof members[0]?.connector?.config?.model === "string" ? members[0].connector.config.model : undefined } : undefined}
					onSessionModelChange={handleSessionModelChange}
					onSessionThinkingChange={handleSessionThinkingChange}
					runtimeOpen={goalRuntimeOpen}
					onRuntimeOpenChange={changeGoalRuntimeOpen}
					runtimeView={runtimeView}
					onRuntimeViewChange={setRuntimeView}
						onRuntimeSummaryChange={setRuntimeSummary}
						activityRevision={room.activityRevision}
						onHistoryReady={acknowledgePresentedActivity}
				/>
				</InlinePiProcessProvider>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role={roomLoadError ? "alert" : "status"}>
					<p className="text-sm text-muted-foreground">{roomLoadError ? `无法加载对话：${roomLoadError}` : "正在加载对话…"}</p>
					{roomLoadError ? <Button type="button" variant="outline" onClick={() => { setRoomLoadError(null); setRoomLoadNonce((value) => value + 1); }}>重新加载</Button> : null}
				</div>
			)}
			</div>

			{room && activeId ? (
				<WorkerProcessProvider value={{ openWorkerProcess }}>
				<WorkerProcessDrawer
					key={`${activeId}:${requestedDelegationId ?? "index"}:${requestedFullWorkerSession ? "full" : "delegation"}`}
					roomId={roomId}
					managerSessionId={activeId}
					requestedDelegationId={requestedDelegationId}
					requestedFullSession={requestedFullWorkerSession}
					showWorkerFilter={isGroup}
					open={workerProcessOpen}
					onOpenChange={setWorkerProcessOpen}
				/>
				</WorkerProcessProvider>
			) : null}

			{room ? (
				<ChatInfoDialog
					room={room}
					open={chatInfoOpen}
					onOpenChange={setChatInfoOpen}
					onRename={openRename}
					onEditPrompt={openPrompt}
					onSwitchWorkspace={openWorkspaceSwitch}
					onSwitchSession={switchSession}
					onNewSession={newSession}
					onRenameSession={openSessionRename}
					onDeleteSession={setPendingDeleteSession}
				/>
			) : null}
			</> : null}

			<Dialog
				open={pendingDeleteSession !== null}
				onOpenChange={(open) => !open && setPendingDeleteSession(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除会话</DialogTitle>
						<DialogDescription>
							确定删除「{pendingDeleteSession?.firstMessage || "新对话"}」吗？该会话的历史记录将一并删除，无法恢复。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingDeleteSession(null)}>
							取消
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								if (pendingDeleteSession) void removeSession(pendingDeleteSession.id);
								setPendingDeleteSession(null);
							}}
						>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={renamingSession !== null} onOpenChange={(open) => !open && setRenamingSession(null)}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>重命名会话</DialogTitle>
					</DialogHeader>
					<Input
						value={sessionRenameValue}
						onChange={(e) => setSessionRenameValue(e.target.value)}
						placeholder="输入会话名称"
						maxLength={60}
						autoFocus
						onKeyDown={(e) => {
							if (e.key !== "Enter" || e.repeat || isIMEComposing(e)) return;
							e.preventDefault();
							void saveSessionRename();
						}}
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setRenamingSession(null)}>
							取消
						</Button>
						<Button type="button" disabled={!sessionRenameValue.trim()} onClick={() => void saveSessionRename()}>
							保存
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={promptOpen} onOpenChange={setPromptOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>协作提示词</DialogTitle>
					</DialogHeader>
					<Textarea
						value={promptValue}
						onChange={(e) => setPromptValue(e.target.value)}
						placeholder="例如：派活给 puddingclaw 前，先让它列出可用分析模型，把用户选定的 id 写进任务描述再委托。"
						rows={8}
						className="text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						定义这个群聊中 Manager 如何分工与汇总；只作用于本群聊的 Manager，不会发给 Worker。
						留空使用默认协作规则；保存后从新会话开始生效。
					</p>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPromptOpen(false)}>
							取消
						</Button>
						<Button type="button" onClick={() => void savePrompt()}>保存</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={workspaceOpen}
				onOpenChange={(open) => {
					if (!open && (workspacePreparationRef.current || workspaceRequestRef.current)) return;
					setWorkspaceOpen(open);
					if (!open) setDirectoryPickerOpen(false);
				}}
			>
				<DialogContent className="workspace-switch-dialog sm:max-w-[600px]">
					<DialogHeader className="workspace-switch-header">
						<div className="workspace-switch-heading-icon" aria-hidden="true"><FolderGit2Icon /></div>
						<div className="min-w-0">
							<DialogTitle>打开项目</DialogTitle>
							<DialogDescription>选择新的工作目录或最近项目。</DialogDescription>
						</div>
					</DialogHeader>

					<div className="workspace-switch-current">
						<div className="workspace-switch-current-icon" aria-hidden="true"><FolderGit2Icon /></div>
						<div className="min-w-0 flex-1">
							<div className="workspace-switch-current-label">
								<span>当前项目</span>
								{room?.workspace ? <WorkspaceTrustBadge trust={room.workspace.trust} /> : null}
							</div>
							<strong>{room?.workspace?.name ?? "默认目录"}</strong>
							<code title={currentWorkspacePath}>{currentWorkspacePath || "未设置目录"}</code>
						</div>
					</div>

					{switchToDefault ? (
						<div className="workspace-switch-default-card">
							<div className="workspace-switch-option-icon"><FolderGit2Icon /></div>
							<div className="min-w-0 flex-1">
								<strong>默认目录</strong>
								<small>新会话将使用平台默认运行目录</small>
							</div>
							<span className="workspace-switch-selected">已选择</span>
							<Button type="button" size="sm" variant="ghost" disabled={switchingWorkspace} onClick={() => setSwitchToDefault(false)}>更改</Button>
						</div>
					) : (
						<div className="workspace-switch-body">
							<label className="workspace-switch-field">
								<span className="workspace-switch-label">项目文件夹</span>
								<div className="workspace-switch-input-row">
									<Input
										value={workspacePath}
										disabled={switchingWorkspace}
										onChange={(e) => {
											setWorkspacePath(e.target.value);
											if (e.target.value) setTargetWorkspaceId("");
											setWorkspaceSelectionError(null);
										}}
										placeholder="选择文件夹或输入绝对目录"
										className="workspace-switch-path"
									/>
									<Button type="button" variant="outline" className="workspace-switch-browse" disabled={switchingWorkspace} onClick={() => setDirectoryPickerOpen(true)}>
										<FolderOpenIcon className="size-4" />
										浏览…
									</Button>
								</div>
							</label>
							{recentWorkspaceOptions.length > 0 || room?.workspace ? (
								<div className="workspace-switch-field">
									<div className="workspace-switch-label-row">
										<span className="workspace-switch-label">最近项目</span>
										{room?.workspace ? (
											<button
												type="button"
												disabled={switchingWorkspace}
												className="workspace-switch-default-button"
											onClick={() => {
												setSwitchToDefault(true);
												setWorkspacePath("");
												setTargetWorkspaceId("");
												setWorkspaceSelectionError(null);
												}}
											>
												<FolderGit2Icon aria-hidden="true" />
												使用默认目录
											</button>
										) : null}
									</div>
									{recentWorkspaceOptions.length > 0 ? (
										<Select
											value={targetWorkspaceId}
											disabled={switchingWorkspace}
											onValueChange={(value) => {
												setTargetWorkspaceId(value);
												setWorkspacePath("");
												setWorkspaceSelectionError(null);
											}}
										>
											<SelectTrigger className="workspace-switch-select" aria-label="最近项目">
												<SelectValue placeholder="选择最近项目">
													{selectedRecentWorkspace ? `${selectedRecentWorkspace.name} · ${selectedRecentWorkspace.rootPath}` : undefined}
												</SelectValue>
											</SelectTrigger>
											<SelectContent position="popper" align="start" className="workspace-switch-select-content">
												{recentWorkspaceOptions.map((item) => (
													<SelectItem
														key={item.id}
														value={item.id}
														disabled={!item.available}
														textValue={`${item.name} ${item.rootPath}`}
														className="workspace-switch-select-item"
													>
														<span className="workspace-switch-select-copy">
															<span className="workspace-switch-select-name">
																<strong>{item.name}</strong>
																{!item.available ? <em>失效</em> : item.trust.state !== "trusted" ? <em>{item.trust.state === "pending" ? "待信任" : "已拒绝"}</em> : null}
															</span>
															<code>{item.rootPath}</code>
														</span>
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									) : null}
								</div>
							) : null}
						</div>
					)}
					<div className="workspace-switch-note">
						<InfoIcon aria-hidden="true" />
						<p>
							{type === "solo"
								? "切换会停止当前任务并保存本项目会话；再次切回时自动恢复。"
								: `“${newWindowLabel}”会打开目标项目的已有对话或创建新对话，当前对话会保留。`}
						</p>
					</div>
					{workspaceSelectionError ? <p className="text-sm text-destructive" role="alert">{workspaceSelectionError}</p> : null}
					{workspaceLoadError ? (
						<div className="flex items-center gap-2 text-sm text-destructive" role="alert">
							<span>项目列表读取失败：{workspaceLoadError}</span>
							<Button type="button" size="sm" variant="outline" disabled={switchingWorkspace} onClick={() => {
								void listWorkspaces().then((items) => { setWorkspaceOptions(items); setWorkspaceLoadError(null); }).catch((error: unknown) => setWorkspaceLoadError(error instanceof Error ? error.message : String(error)));
							}}>重试</Button>
						</div>
					) : null}
					<DialogFooter className="workspace-switch-footer">
						<Button type="button" variant="ghost" disabled={switchingWorkspace} onClick={() => { if (!workspacePreparationRef.current && !workspaceRequestRef.current) setWorkspaceOpen(false); }}>取消</Button>
						<Button type="button" disabled={switchingWorkspace || !workspaceTargetReady} onClick={() => void saveWorkspaceSwitch(type === "solo" ? "in_place" : "new_window")}>
							{switchingWorkspace ? "处理中…" : type === "solo" ? "切换项目" : newWindowLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<DirectoryPickerDialog
				open={directoryPickerOpen}
				initialPath={directoryPickerInitialPath}
				onOpenChange={setDirectoryPickerOpen}
				onSelect={(path) => {
					if (workspacePreparationRef.current || workspaceRequestRef.current) return;
					setWorkspacePath(path);
					setTargetWorkspaceId("");
					setSwitchToDefault(false);
					setWorkspaceSelectionError(null);
				}}
			/>

			{trustCandidate ? (
				<WorkspaceTrustDialog
					workspace={trustCandidate.workspace}
					onCancel={() => setTrustCandidate(null)}
					onDecided={(workspace) => {
						const { mode } = trustCandidate;
						setTrustCandidate(null);
						void doWorkspaceSwitch(workspace.id, mode).catch((err: unknown) =>
							toast.error(err instanceof Error ? err.message : String(err)),
						);
					}}
				/>
			) : null}

			{trustReview ? (
				<WorkspaceTrustDialog
					workspace={trustReview}
					onCancel={() => setTrustReview(null)}
					onDecided={() => {
						setTrustReview(null);
						// 决定已保存（撤销会标记活跃会话 dirty）；刷新房间让 badge 即时更新。
						void getRoom(roomId)
							.then((r) => setRoom((prev) => (prev ? { ...r } : prev)))
							.catch(() => undefined);
					}}
				/>
			) : null}

			<Dialog open={renaming} onOpenChange={setRenaming}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>重命名对话</DialogTitle>
					</DialogHeader>
					<Input
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						placeholder="默认按窗口类型显示"
						onKeyDown={(e) => {
							if (e.key !== "Enter" || e.repeat || isIMEComposing(e)) return;
							e.preventDefault();
							void saveRename();
						}}
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
							取消
						</Button>
						<Button type="button" onClick={() => void saveRename()}>保存</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
