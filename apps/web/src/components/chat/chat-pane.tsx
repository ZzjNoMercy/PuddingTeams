"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, EllipsisIcon, FolderGit2Icon, FolderOpenIcon, LayersIcon, ListTreeIcon, PanelLeftOpenIcon } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useChat } from "@/hooks/useChat";
import { compactDay } from "@/lib/time";
import {
	createRoomSession,
	createWorkspace,
	deleteRoomSession,
	getRoom,
	listWorkspaces,
	renameRoomSession,
	setActiveRoomSession,
	switchRoomWorkspace,
	updateRoom,
} from "@/lib/api";
import { agentDisplayName, type ChatStatus, type RoomSession, type RoomSummary, type WorkspaceRecord } from "@/lib/types";
import { Composer } from "./composer";
import { computeSessionStats } from "@/lib/session-stats";
import { delegateWorker, groupForRender, isDelegateCall } from "@/lib/events";
import { useAgentLabels } from "@/lib/avatars";
import { AssistantGroup, Message } from "./message";
import { ManagerAvatar, MemberStack, WorkerAvatar } from "./worker-avatar";
import { DirectoryPickerDialog } from "./directory-picker-dialog";
import { WorkspaceTrustDialog, needsTrustDecision } from "./workspace-trust-dialog";
import { WorkspaceTrustBadge, workspaceTrustSuffix } from "./workspace-trust-badge";
import { ChatInfoDialog } from "./chat-info-dialog";
import { SessionMenu } from "./session-menu";
import { SessionWorkCard } from "./session-work-card";
import { WorkerProcessDrawer } from "./worker-process-dialog";
import { WorkerProcessProvider } from "./worker-process-context";

/** StickToBottom 的 isAtBottom 桥给悬浮层外的兄弟组件（统计条淡入淡出）。 */
function AtBottomReporter({ onChange }: { onChange: (atBottom: boolean) => void }) {
	const { isAtBottom } = useStickToBottomContext();
	useEffect(() => onChange(isAtBottom), [isAtBottom, onChange]);
	return null;
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
	onOpenWorkspace,
	blocked,
	sessionModel,
	onSessionModelChange,
	runtimeOpen,
	onRuntimeOpenChange,
	onGoalSummaryChange,
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
	onOpenWorkspace: () => void;
	blocked?: boolean;
	/** 会话真实模型 ref（rooms 数据），composer 选择器以此为准。 */
	sessionModel?: string;
	onSessionModelChange?: (model: string) => void;
	runtimeOpen: boolean;
	onRuntimeOpenChange: (open: boolean) => void;
	onGoalSummaryChange: (summary: { hasGoal: boolean; pending: number; running: boolean } | null) => void;
}) {
	const { messages, historyLoading, status, running, send, stop } = useChat(sessionId);
	const [goalCreateOpen, setGoalCreateOpen] = useState(false);
	const [goalDraft, setGoalDraft] = useState("");
	const [hasGoal, setHasGoal] = useState(false);
	const [workStateReady, setWorkStateReady] = useState(false);
	const [scrollButtonHost, setScrollButtonHost] = useState<HTMLDivElement | null>(null);
	const [atBottom, setAtBottom] = useState(true);
	useEffect(() => onStatus(status), [status, onStatus]);
	const markWorkStateReady = useCallback(() => setWorkStateReady(true), []);
	const openGoalCommand = useCallback((initialGoal: string) => {
		setGoalDraft(initialGoal);
		setGoalCreateOpen(true);
	}, []);
	const layoutReady = !historyLoading && workStateReady;
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

	return (
		<div className="home-session-chat relative flex min-h-0 flex-1 flex-col" aria-busy={!layoutReady}>
			<div className={`flex min-h-0 flex-1 flex-col ${layoutReady ? "visible" : "invisible"}`}>
				<SessionWorkCard
					sessionId={sessionId}
					createOpen={goalCreateOpen}
					onCreateOpenChange={setGoalCreateOpen}
					initialGoal={goalDraft}
					onGoalStateChange={setHasGoal}
					onGoalSummaryChange={onGoalSummaryChange}
					onReady={markWorkStateReady}
					workStateSignal={workStateSignal}
					runtimeOpen={runtimeOpen}
					onRuntimeOpenChange={onRuntimeOpenChange}
				/>
				<Conversation initial="instant" resize={layoutReady ? "smooth" : "instant"}>
					<AtBottomReporter onChange={setAtBottom} />
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
					</ConversationContent>
					<ConversationScrollButton
						portalTarget={scrollButtonHost}
						className="home-scroll-to-bottom"
						aria-label="回到底部"
						title="回到底部"
					/>
				</Conversation>
				{blocked ? (
					<div className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-center text-xs text-destructive">
						项目路径已失效，重新绑定或切换项目后才能继续对话与派活。
					</div>
				) : null}
				<Composer
					sessionId={sessionId}
					disabled={running || Boolean(blocked)}
					busyHint={busyHint}
					hasGoal={hasGoal}
					workspaceLabel={workspaceLabel}
					workspacePath={workspacePath}
					workspaceAvailable={workspaceAvailable}
					sessionModel={sessionModel}
					stats={sessionStats}
					statsVisible={atBottom}
					onModelChanged={onSessionModelChange}
					onSend={send}
					onStop={stop}
					onGoalCommand={openGoalCommand}
					onOpenWorkspace={onOpenWorkspace}
					scrollButtonHostRef={setScrollButtonHost}
				/>
			</div>
			{!layoutReady ? (
				<div className="absolute inset-0 flex items-center justify-center" role="status">
					<div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader size={14} />正在加载对话…</div>
				</div>
			) : null}
		</div>
	);
}

export function ChatPane({
	roomId,
	onOpenWindow,
	onRoomUpdated,
	onOpenRoomList,
	onRoomsMayHaveChanged,
}: {
	roomId: string;
	onOpenWindow?: (windowId: string) => void;
	onRoomUpdated?: (room: RoomSummary) => void;
	onOpenRoomList?: () => void;
	onRoomsMayHaveChanged?: () => void;
}) {
	const [room, setRoom] = useState<RoomSummary | null>(null);
	const [activeId, setActiveId] = useState<string>("");
	const [status, setStatus] = useState<ChatStatus>("connecting");
	const [delayedConnectionStatus, setDelayedConnectionStatus] = useState<ChatStatus | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [promptOpen, setPromptOpen] = useState(false);
	const [promptValue, setPromptValue] = useState("");
	const [chatInfoOpen, setChatInfoOpen] = useState(false);
	const [workerProcessOpen, setWorkerProcessOpen] = useState(false);
	const [goalRuntimeOpen, setGoalRuntimeOpen] = useState(false);
	const [goalSummary, setGoalSummary] = useState<{ hasGoal: boolean; pending: number; running: boolean } | null>(null);
	const [requestedDelegationId, setRequestedDelegationId] = useState<string | null>(null);
	const [pendingDeleteSession, setPendingDeleteSession] = useState<RoomSession | null>(null);
	const [renamingSession, setRenamingSession] = useState<RoomSession | null>(null);
	const [sessionRenameValue, setSessionRenameValue] = useState("");
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceRecord[]>([]);
	const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
	const [workspacePath, setWorkspacePath] = useState("");
	const [switchToDefault, setSwitchToDefault] = useState(false);
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
	const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
	const [trustCandidate, setTrustCandidate] = useState<{ workspace: WorkspaceRecord; mode: "new_window" | "in_place" } | null>(null);
	/** 头部「待信任/已拒绝」badge 点开的信任复核（与切换项目流程分开）。 */
	const [trustReview, setTrustReview] = useState<WorkspaceRecord | null>(null);
	const openWorkerProcess = useCallback((delegationId: string) => {
		setChatInfoOpen(false);
		setRequestedDelegationId(delegationId);
		setWorkerProcessOpen(true);
	}, []);
	const changeGoalRuntimeOpen = useCallback((open: boolean) => {
		if (open) {
			setWorkerProcessOpen(false);
			setRequestedDelegationId(null);
		}
		setGoalRuntimeOpen(open);
	}, []);

	useEffect(() => {
		let cancelled = false;
		getRoom(roomId)
			.then((r) => {
				if (cancelled) return;
				setWorkerProcessOpen(false);
				setGoalRuntimeOpen(false);
				setGoalSummary(null);
				setRequestedDelegationId(null);
				setRoom(r);
				setActiveId(r.activeSession || "");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				toast.error(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [roomId]);

	// 首条消息发出后 LLM 异步生成会话标题；轻量轮询把标题/时间刷出来
	// （不覆盖 activeId，只在后台用 server 事实刷新 room 数据）。
	useEffect(() => {
		const timer = setInterval(() => {
			void getRoom(roomId)
				.then((r) => setRoom((prev) => (prev ? { ...r } : prev)))
				.catch(() => undefined);
		}, 8000);
		return () => clearInterval(timer);
	}, [roomId]);

	// Session 切换会创建一条新 WebSocket，正常握手通常在一瞬间完成。
	// 延迟展示非 connected 状态，避免把正常切换误报成一次可见的连接故障；
	// 真正持续的首次连接/重连仍会出现，error/gone 则立即提示。
	useEffect(() => {
		if (status === "connected" || status === "error" || status === "gone") return;
		const timer = setTimeout(() => setDelayedConnectionStatus(status), 700);
		return () => clearTimeout(timer);
	}, [status]);

	const patchSessions = useCallback((sessions: RoomSession[], active: string) => {
		setRoom((prev) => (prev ? { ...prev, sessions, activeSession: active } : prev));
		setActiveId(active);
	}, []);

	/** composer 改模型后本地同步 rooms 数据，避免切换会话后回读旧值。 */
	const handleSessionModelChange = useCallback((model: string) => {
		setRoom((prev) =>
			prev
				? { ...prev, sessions: prev.sessions.map((s) => (s.id === prev.activeSession ? { ...s, model } : s)) }
				: prev,
		);
	}, []);

	const switchSession = useCallback(
		async (sessionId: string) => {
			if (sessionId === activeId) return;
			setWorkerProcessOpen(false);
			setGoalRuntimeOpen(false);
			setGoalSummary(null);
			setRequestedDelegationId(null);
			try {
				await setActiveRoomSession(roomId, sessionId);
				if (room) {
					patchSessions(
						room.sessions.map((s) => ({ ...s, active: s.id === sessionId })),
						sessionId,
					);
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		},
		[roomId, activeId, room, patchSessions],
	);

	const newSession = useCallback(async () => {
		setWorkerProcessOpen(false);
		setGoalRuntimeOpen(false);
		setGoalSummary(null);
		setRequestedDelegationId(null);
		try {
			const created = await createRoomSession(roomId);
			setRoom((prev) =>
				prev
					? {
							...prev,
							sessions: [
								{ id: created.id, firstMessage: "", modifiedAt: created.modifiedAt, active: true },
								...prev.sessions.map((s) => ({ ...s, active: false })),
							],
							activeSession: created.id,
						}
					: prev,
			);
			setActiveId(created.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [roomId]);

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
		setWorkspaceOpen(true);
		setWorkspacePath("");
		setTargetWorkspaceId("");
		setSwitchToDefault(false);
		setDirectoryPickerOpen(false);
		void listWorkspaces()
			.then((items) => {
				setWorkspaceOptions(items);
			})
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
	}, []);

	const doWorkspaceSwitch = useCallback(
		async (workspaceId: string | null, mode: "new_window" | "in_place") => {
			const result = await switchRoomWorkspace(roomId, workspaceId, mode);
			setWorkspaceOpen(false);
			if (result.room.id === roomId) {
				setRoom(result.room);
				onRoomUpdated?.(result.room);
			} else {
				onOpenWindow?.(result.room.id);
			}
			toast.success(mode === "in_place" ? "已切换项目并开始新会话" : result.existed ? "已打开已有单聊" : "已创建新对话");
		},
		[roomId, onRoomUpdated, onOpenWindow],
	);

	const saveWorkspaceSwitch = useCallback(async (mode: "new_window" | "in_place") => {
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
			setSwitchingWorkspace(false);
		}
	}, [targetWorkspaceId, workspacePath, switchToDefault, workspaceOptions, doWorkspaceSwitch]);

	const members = room?.members ?? [];
	const type = room?.type ?? "solo";
	const isSingle = type === "direct";
	const isGroup = type === "group";
	const headerTitle = room?.name ?? "与 pi manager 对话";
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
				: "理解消息、组织协作并汇总结果";
	const workspaceTargetReady = switchToDefault || Boolean(targetWorkspaceId || workspacePath.trim());
	const currentContextLabel = room?.workspace ? `${room.workspace.name} · ${room.workspace.rootPath}` : `默认目录 · ${room?.cwdSnapshot ?? ""}`;
	const workspaceLabel = room?.workspace ? `项目 · ${room.workspace.name}` : "默认目录";
	const currentWorkspacePath = room?.workspace?.rootPath ?? room?.cwdSnapshot ?? "";
	const newWindowLabel = type === "group" ? "新建群聊" : "新建/打开单聊";
	const directoryPickerInitialPath =
		workspacePath || workspaceOptions.find((item) => item.id === targetWorkspaceId)?.rootPath || room?.cwdSnapshot || "";
	const emptyHint = isGroup
		? `群聊：${members.map((m) => agentDisplayName(m)).join("、")} 在窗口里，pi manager 负责调度。试试对 manager 说：让 ${members[0] ? agentDisplayName(members[0]) : "worker"} 分析一个任务…`
		: isSingle
			? `和 ${members[0] ? agentDisplayName(members[0]) : "worker"} 单聊（经 pi manager 中转）。派一个任务，manager 会交给 ${members[0] ? agentDisplayName(members[0]) : "它"} 执行`
			: "开始和 pi manager 对话";

	return (
		<div className="home-chat-pane relative flex h-full min-w-0">
			<div className="home-chat-primary flex min-w-0 flex-1 flex-col">
			<header className="home-chat-header">
				<div className="home-chat-identity">
					{onOpenRoomList ? <Button type="button" size="icon" variant="ghost" className="md:hidden" aria-label="打开对话列表" onClick={onOpenRoomList}><PanelLeftOpenIcon className="size-4" /></Button> : null}
					{isGroup ? (
						<MemberStack members={members} size={34} />
					) : isSingle ? (
						<WorkerAvatar name={members[0]!.name} size={34} />
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
					{goalSummary?.hasGoal ? (
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className={"home-chat-more goal-header-trigger" + (goalRuntimeOpen ? " is-active" : "")}
							aria-label="目标与执行"
							title="目标与执行"
							onClick={() => changeGoalRuntimeOpen(true)}
						>
							<ListTreeIcon className="size-4" />
							{goalSummary.pending > 0 ? <span className="goal-header-badge">{goalSummary.pending}</span> : goalSummary.running ? <span className="goal-header-live" /> : null}
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
				<WorkerProcessProvider value={{ openWorkerProcess }}>
				<SessionChat
					key={activeId}
					roomId={roomId}
					sessionId={activeId}
					sessionLabel={sessionTitle || "新会话"}
					sessionModifiedAt={room.sessions.find((s) => s.id === activeId)?.modifiedAt}
					emptyHint={emptyHint}
					windowType={type}
					onStatus={setStatus}
					onOpenWindow={onOpenWindow}
					onRoomsMayHaveChanged={onRoomsMayHaveChanged}
					workspaceLabel={workspaceLabel}
					workspacePath={currentWorkspacePath}
					workspaceAvailable={room.contextAvailable}
					onOpenWorkspace={openWorkspaceSwitch}
					blocked={!room.contextAvailable || status === "gone"}
					sessionModel={activeSession?.model}
					onSessionModelChange={handleSessionModelChange}
					runtimeOpen={goalRuntimeOpen}
					onRuntimeOpenChange={changeGoalRuntimeOpen}
					onGoalSummaryChange={setGoalSummary}
				/>
				</WorkerProcessProvider>
			) : null}
			</div>

			{room && activeId ? (
				<WorkerProcessProvider value={{ openWorkerProcess }}>
				<WorkerProcessDrawer
					key={`${activeId}:${requestedDelegationId ?? "index"}`}
					roomId={roomId}
					managerSessionId={activeId}
					requestedDelegationId={requestedDelegationId}
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
							if (e.key === "Enter") void saveSessionRename();
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
					setWorkspaceOpen(open);
					if (!open) setDirectoryPickerOpen(false);
				}}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>打开项目</DialogTitle>
						<DialogDescription className="flex items-center gap-2 truncate" title={currentContextLabel}>
							<span className="truncate">当前：{currentContextLabel}</span>
							{room?.workspace ? <WorkspaceTrustBadge trust={room.workspace.trust} /> : null}
						</DialogDescription>
					</DialogHeader>
					{switchToDefault ? (
						<div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2.5">
							<FolderGit2Icon className="size-4 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium">默认目录</div>
								<div className="text-xs text-muted-foreground">使用平台默认运行目录</div>
							</div>
							<Button type="button" size="sm" variant="ghost" onClick={() => setSwitchToDefault(false)}>更改</Button>
						</div>
					) : (
						<div className="flex flex-col gap-4">
							<label className="flex flex-col gap-1.5 text-sm">
								<span className="font-medium">项目文件夹</span>
								<div className="flex gap-2">
									<Input
										value={workspacePath}
										onChange={(e) => {
											setWorkspacePath(e.target.value);
											if (e.target.value) setTargetWorkspaceId("");
										}}
										placeholder="选择文件夹或输入绝对目录"
										className="min-w-0 font-mono text-xs"
									/>
									<Button type="button" variant="outline" onClick={() => setDirectoryPickerOpen(true)}>
										<FolderOpenIcon className="size-4" />
										浏览…
									</Button>
								</div>
							</label>
							{workspaceOptions.some((item) => item.id !== room?.workspace?.id) ? (
								<label className="flex flex-col gap-1.5 text-sm">
									<span className="text-muted-foreground">最近项目</span>
									<select
										value={targetWorkspaceId}
										onChange={(e) => {
											setTargetWorkspaceId(e.target.value);
											if (e.target.value) setWorkspacePath("");
										}}
										className="h-9 rounded-md border bg-background px-2"
									>
										<option value="">选择最近项目</option>
										{workspaceOptions.filter((item) => item.id !== room?.workspace?.id).map((item) => (
											<option key={item.id} value={item.id} disabled={!item.available}>{item.name} — {item.rootPath}{item.available ? "" : "（失效）"}{workspaceTrustSuffix(item.trust)}</option>
										))}
									</select>
								</label>
							) : null}
							{room?.workspace ? (
								<Button
									type="button"
									variant="link"
									className="h-auto w-fit px-0 text-muted-foreground"
									onClick={() => {
										setSwitchToDefault(true);
										setWorkspacePath("");
										setTargetWorkspaceId("");
									}}
								>
									不使用项目，切回默认目录
								</Button>
							) : null}
						</div>
					)}
					<p className="text-xs text-muted-foreground">
						{type === "solo"
							? "切换后会停止当前任务，并开始一个新会话。"
							: `“${newWindowLabel}”会保留当前对话；“替换当前”会停止当前任务，并开始一个新会话。`}
					</p>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setWorkspaceOpen(false)}>取消</Button>
						{type !== "solo" ? (
							<Button type="button" variant="outline" disabled={switchingWorkspace || !workspaceTargetReady} onClick={() => void saveWorkspaceSwitch("in_place")}>
								替换当前
							</Button>
						) : null}
						<Button type="button" disabled={switchingWorkspace || !workspaceTargetReady} onClick={() => void saveWorkspaceSwitch(type === "solo" ? "in_place" : "new_window")}>
							{switchingWorkspace ? "处理中…" : type === "solo" ? "切换并开始新会话" : newWindowLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<DirectoryPickerDialog
				open={directoryPickerOpen}
				initialPath={directoryPickerInitialPath}
				onOpenChange={setDirectoryPickerOpen}
				onSelect={(path) => {
					setWorkspacePath(path);
					setTargetWorkspaceId("");
					setSwitchToDefault(false);
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
							if (e.key === "Enter") void saveRename();
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
