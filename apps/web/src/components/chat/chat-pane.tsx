"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon, FileTextIcon, FolderGit2Icon, FolderOpenIcon, LayersIcon, PencilIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { writeTextToClipboard } from "@/core/clipboard";
import { useChat } from "@/hooks/useChat";
import {
	createRoomSession,
	createWorkspace,
	deleteRoomSession,
	getRoom,
	listWorkspaces,
	setActiveRoomSession,
	switchRoomWorkspace,
	updateRoom,
} from "@/lib/api";
import type { ChatStatus, RoomSession, RoomSummary, WorkspaceRecord } from "@/lib/types";
import { Composer } from "./composer";
import { Message } from "./message";
import { ManagerAvatar, MemberStack, WorkerAvatar } from "./worker-avatar";
import { DirectoryPickerDialog } from "./directory-picker-dialog";
import { SessionWorkCard } from "./session-work-card";

function statusLabelOf(status: ChatStatus): string {
	switch (status) {
		case "connected":
			return "已连接 pi manager";
		case "connecting":
			return "连接中…";
		case "reconnecting":
			return "连接中断，重连中…";
		default:
			return "连接已断开，仍在后台重试";
	}
}

/** The live chat area for one pi session. Keyed by sessionId so switching
 * sessions remounts it (fresh history + WS). */
function SessionChat({
	sessionId,
	emptyHint,
	windowType,
	onStatus,
	onOpenWindow,
	blocked,
}: {
	sessionId: string;
	emptyHint?: string;
	windowType: RoomSummary["type"];
	onStatus: (s: ChatStatus) => void;
	onOpenWindow?: (windowId: string) => void;
	blocked?: boolean;
}) {
	const { messages, status, running, send, stop } = useChat(sessionId);
	useEffect(() => onStatus(status), [status, onStatus]);

	return (
		<>
			<SessionWorkCard sessionId={sessionId} />
			<Conversation>
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6">
					{messages.length === 0 ? (
						<div className="flex flex-1 items-center justify-center pt-20 text-sm text-muted-foreground">
							{emptyHint ?? "开始和 pi manager 对话"}
						</div>
					) : (
						messages.map((m) => (
							<Message key={m.id} message={m} windowType={windowType} onOpenWindow={onOpenWindow} />
						))
					)}
				</ConversationContent>
				<ConversationScrollButton className="z-10" />
			</Conversation>
			{blocked ? (
				<div className="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-center text-xs text-destructive">
					项目路径已失效，重新绑定或切换项目后才能继续对话与派活。
				</div>
			) : null}
			<Composer sessionId={sessionId} disabled={running || Boolean(blocked)} onSend={send} onStop={stop} />
		</>
	);
}

export function ChatPane({
	roomId,
	onOpenWindow,
	onRoomUpdated,
}: {
	roomId: string;
	onOpenWindow?: (windowId: string) => void;
	onRoomUpdated?: (room: RoomSummary) => void;
}) {
	const [room, setRoom] = useState<RoomSummary | null>(null);
	const [activeId, setActiveId] = useState<string>("");
	const [status, setStatus] = useState<ChatStatus>("connecting");
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [promptOpen, setPromptOpen] = useState(false);
	const [promptValue, setPromptValue] = useState("");
	const [pendingDeleteSession, setPendingDeleteSession] = useState<RoomSession | null>(null);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceRecord[]>([]);
	const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
	const [workspacePath, setWorkspacePath] = useState("");
	const [switchToDefault, setSwitchToDefault] = useState(false);
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
	const [switchingWorkspace, setSwitchingWorkspace] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getRoom(roomId)
			.then((r) => {
				if (cancelled) return;
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

	const patchSessions = useCallback((sessions: RoomSession[], active: string) => {
		setRoom((prev) => (prev ? { ...prev, sessions, activeSession: active } : prev));
		setActiveId(active);
	}, []);

	const switchSession = useCallback(
		async (sessionId: string) => {
			if (sessionId === activeId) return;
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

	const saveWorkspaceSwitch = useCallback(async (mode: "new_window" | "in_place") => {
		setSwitchingWorkspace(true);
		try {
			let workspaceId: string | null = switchToDefault ? null : targetWorkspaceId;
			if (!switchToDefault && workspacePath.trim()) workspaceId = (await createWorkspace({ path: workspacePath.trim() })).id;
			if (!switchToDefault && !workspaceId) throw new Error("请选择项目文件夹或最近项目");
			const result = await switchRoomWorkspace(roomId, workspaceId, mode);
			setWorkspaceOpen(false);
			if (result.room.id === roomId) {
				setRoom(result.room);
				onRoomUpdated?.(result.room);
			} else {
				onOpenWindow?.(result.room.id);
			}
			toast.success(mode === "in_place" ? "已切换项目并开始新会话" : result.existed ? "已打开已有单聊" : "已创建新对话");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSwitchingWorkspace(false);
		}
	}, [targetWorkspaceId, workspacePath, switchToDefault, roomId, onRoomUpdated, onOpenWindow]);

	const members = room?.members ?? [];
	const type = room?.type ?? "solo";
	const isSingle = type === "direct";
	const isGroup = type === "group";
	const headerTitle = room?.name ?? "与 pi manager 对话";
	// 副标题：active session 的标题（会话上下文）优先，否则退回类型描述；
	// 与窗口名相同时不重复显示。
	const activeSession = room?.sessions.find((s) => s.active);
	const sessionTitle =
		activeSession?.name || (activeSession?.firstMessage !== "新对话" ? activeSession?.firstMessage : "") || "";
	const typeText =
		type === "group"
			? `${members.length} 个成员 · ${members.map((m) => m.name).join("、")}`
			: type === "direct"
				? `与 ${members[0]?.name} 单聊`
				: "与 pi manager 对话";
	const subtitle = sessionTitle || (typeText !== headerTitle ? typeText : "");
	const workspaceTargetReady = switchToDefault || Boolean(targetWorkspaceId || workspacePath.trim());
	const currentContextLabel = room?.workspace ? `${room.workspace.name} · ${room.workspace.rootPath}` : `默认目录 · ${room?.cwdSnapshot ?? ""}`;
	const newWindowLabel = type === "group" ? "新建群聊" : "新建/打开单聊";
	const directoryPickerInitialPath =
		workspacePath || workspaceOptions.find((item) => item.id === targetWorkspaceId)?.rootPath || room?.cwdSnapshot || "";
	const emptyHint = isGroup
		? `群聊：${members.map((m) => m.name).join("、")} 在窗口里，pi manager 负责调度。试试对 manager 说：让 ${members[0]?.name} 分析一个任务…`
		: isSingle
			? `和 ${members[0]?.name} 单聊（经 pi manager 中转）。派一个任务，manager 会交给 ${members[0]?.name} 执行`
			: "开始和 pi manager 对话";

	return (
		<div className="relative flex h-full flex-col">
			<header className="flex items-center justify-between gap-2 px-4 py-2">
				<div className="flex min-w-0 items-center gap-2.5">
					{isGroup ? (
						<MemberStack members={members} size={28} />
					) : isSingle ? (
						<WorkerAvatar name={members[0]!.name} size={28} />
					) : (
						<ManagerAvatar size={28} />
					)}
					<div className="min-w-0">
						<div className="flex items-center gap-1.5">
							<div className="truncate text-sm font-medium">{headerTitle}</div>
							{type === "solo" ? (
								<span className="shrink-0 text-xs text-muted-foreground">solo</span>
							) : null}
						</div>
						{subtitle ? (
							<div className="truncate text-xs text-muted-foreground">{subtitle}</div>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant={room?.contextAvailable === false ? "destructive" : "outline"}
						onClick={openWorkspaceSwitch}
						aria-label={room?.workspace ? `打开项目，当前项目 ${room.workspace.name}` : "打开项目，当前使用默认目录"}
						title={`当前运行目录：${room?.workspace?.rootPath ?? room?.cwdSnapshot ?? ""}`}
					>
						<FolderGit2Icon className="size-3.5" />
						<span className="max-w-36 truncate">{room?.workspace ? `项目 · ${room.workspace.name}` : "默认目录"}</span>
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="sm" variant="outline">
								<LayersIcon className="size-3.5" />
								会话
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
							<div className="px-2 py-1.5 text-xs text-muted-foreground">
								{room?.sessions.length ?? 1} 个会话
							</div>
							{(room?.sessions ?? []).map((s) => (
								<DropdownMenuItem key={s.id} onSelect={() => void switchSession(s.id)} className="gap-2">
									<span className="min-w-0 flex-1 truncate">
										{s.name || s.firstMessage || "新对话"}
									</span>
									{s.active ? <CheckIcon className="size-3.5 shrink-0" /> : null}
									<button
										type="button"
										aria-label="删除会话"
										onClick={(e) => {
											e.stopPropagation();
											setPendingDeleteSession(s);
										}}
										className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
									>
										<XIcon className="size-3" />
									</button>
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => void newSession()}>
								<PlusIcon className="size-3.5" />
								新建会话
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="sm" variant="outline">
								<UsersIcon className="size-3.5" />
								成员
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-80">
							<div className="px-2 py-1.5 text-xs text-muted-foreground">
								{type === "solo" ? "solo 对话：仅与 pi manager 对话" : `${members.length} 个成员`}
							</div>
							{members.length === 0 ? (
								<div className="px-2 py-2 text-xs text-muted-foreground">
									没有成员。选一个有 worker 的单聊/群聊窗口来派活。
								</div>
							) : (
								members.map((m) => {
									// invoke 变为联合类型后：命令接入显示命令行，Connector 接入显示绑定。
									const cmd =
										m.invoke?.type === "command"
											? [m.invoke.command, ...m.invoke.runArgs].join(" ")
											: m.connector
												? `connector:${m.connector.connectorId}`
												: "—";
									const workerSession = room?.workerBindings?.[m.name]?.sessionHandle;
									const enabled = m.enabled !== false;
									return (
										<div key={m.name} className="flex items-start gap-2 px-2 py-1.5">
											<WorkerAvatar name={m.name} size={22} className="mt-0.5 shrink-0" />
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-1.5">
													<div className="font-mono text-sm font-medium">{m.name}</div>
													<span
														className={`size-1.5 rounded-full ${enabled ? "bg-foreground" : "bg-muted-foreground/40"}`}
														title={enabled ? "已启用" : "已停用"}
													/>
													<span className="text-xs text-muted-foreground">{enabled ? "已启用" : "已停用"}</span>
												</div>
												<div className="mt-0.5 flex items-center gap-1">
													<div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={cmd}>
														{cmd}
													</div>
													<button
														type="button"
														aria-label="复制命令"
														onClick={() =>
															void writeTextToClipboard(cmd).then((ok) =>
																ok ? toast.success("命令已复制") : toast.error("复制失败"),
															)
														}
														className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
													>
														<CopyIcon className="size-3" />
													</button>
												</div>
												<div className="mt-0.5 text-xs text-muted-foreground/70">
													{workerSession ? (
														<>
															续接 worker 会话 <span className="font-mono">{workerSession.slice(0, 8)}…</span>
														</>
													) : (
														"新会话（下次派活启动新 worker 会话）"
													)}
												</div>
											</div>
										</div>
									);
								})
							)}
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={openRename}>
								<PencilIcon className="size-3.5" />
								重命名
							</DropdownMenuItem>
							{type !== "solo" ? (
								<DropdownMenuItem onSelect={openPrompt}>
									<FileTextIcon className="size-3.5" />
									提示词{room?.prompt ? "（已自定义）" : ""}
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
					{status !== "connected" ? (
						<span
							className={`hidden items-center gap-2 text-xs sm:flex ${
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
				<SessionChat
					key={activeId}
					sessionId={activeId}
					emptyHint={emptyHint}
					windowType={type}
					onStatus={setStatus}
					onOpenWindow={onOpenWindow}
					blocked={!room.contextAvailable}
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

			<Dialog open={promptOpen} onOpenChange={setPromptOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>窗口提示词</DialogTitle>
					</DialogHeader>
					<Textarea
						value={promptValue}
						onChange={(e) => setPromptValue(e.target.value)}
						placeholder="例如：派活给 puddingclaw 前，先让它列出可用分析模型，把用户选定的 id 写进任务描述再委托。"
						rows={8}
						className="text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						这段文字会作为该窗口 manager 的附加系统提示。留空 = 使用默认 relay 提示词（委托给 worker 并转述结果）。保存后，本窗口新开的会话按此提示词运行。
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
						<DialogDescription className="truncate" title={currentContextLabel}>当前：{currentContextLabel}</DialogDescription>
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
											<option key={item.id} value={item.id} disabled={!item.available}>{item.name} — {item.rootPath}{item.available ? "" : "（失效）"}</option>
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
