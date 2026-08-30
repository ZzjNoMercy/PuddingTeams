"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	PromptInput,
	PromptInputAttachment,
	PromptInputAttachments,
	PromptInputFooter,
	PromptInputProvider,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputController,
	type ChatStatus,
} from "@/components/ai-elements/prompt-input";
import { listModels, listSessionCommands, MODELS_CHANGED_EVENT, setSessionModel, type MessageAttachmentInput, type SessionSlashCommand } from "@/lib/api";
import { getPreferredModel, setPreferredModel } from "@/lib/model-pref";
import type { ModelSummary } from "@/lib/types";
import type { SessionStats } from "@/lib/session-stats";
import { ChatStatsBar } from "./chat-stats-bar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckIcon, ChevronDownIcon, FolderGit2Icon, PaperclipIcon, SparklesIcon, TargetIcon } from "lucide-react";
import type { PromptInputFilePart } from "@/core/uploads";

async function encodeAttachment(item: PromptInputFilePart): Promise<MessageAttachmentInput> {
	let url = item.url;
	if (item.file) {
		url = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(reader.error ?? new Error("读取附件失败"));
			reader.onload = () => resolve(String(reader.result));
			reader.readAsDataURL(item.file!);
		});
	}
	const comma = url?.indexOf(",") ?? -1;
	if (!url || comma < 0 || !url.startsWith("data:")) throw new Error(`无法读取附件「${item.filename ?? "attachment"}」`);
	return {
		filename: item.filename ?? item.file?.name ?? "attachment",
		mediaType: item.mediaType ?? item.file?.type ?? "application/octet-stream",
		data: url.slice(comma + 1),
	};
}

function ModelPicker({
	sessionId,
	sessionModel,
	onChanged,
}: {
	sessionId: string;
	/** 会话真实模型 ref（服务端为准）；空表示尚未知晓，用本地偏好兜底。 */
	sessionModel?: string;
	onChanged?: (model: string) => void;
}) {
	const [models, setModels] = useState<ModelSummary[]>([]);
	const [value, setValue] = useState<string>(() => sessionModel ?? getPreferredModel() ?? "");
	// 服务端模型后到达或切换会话（SessionChat 按 sessionId remount 后 rooms
	// 数据刷新）时跟随真值；本地偏好只决定首次渲染。
	const [prevSessionModel, setPrevSessionModel] = useState(sessionModel);
	if (sessionModel !== prevSessionModel) {
		setPrevSessionModel(sessionModel);
		if (sessionModel) setValue(sessionModel);
	}

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			listModels()
				.then((models) => {
					if (cancelled) return;
					setModels(models);
					// 没有任何已知的模型时才收养目录第一个；已有值（会话真值或
					// 本地偏好）即使已不在目录里也不覆盖——显示失效的真值好过错指。
					setValue((prev) => {
						if (prev) return prev;
						const next = models[0]?.id ?? "";
						if (next) setPreferredModel(next);
						return next;
					});
				})
				.catch(() => undefined);
		};
		load();
		// Provider keys can change in the settings dialog; refetch then.
		window.addEventListener(MODELS_CHANGED_EVENT, load);
		return () => {
			cancelled = true;
			window.removeEventListener(MODELS_CHANGED_EVENT, load);
		};
	}, []);

	const handleChange = (ref: string) => {
		setValue(ref);
		setPreferredModel(ref);
		setSessionModel(sessionId, ref)
			.then(() => onChanged?.(ref))
			.catch((err: unknown) => {
				toast.error(err instanceof Error ? err.message : String(err));
			});
	};

	if (models.length === 0) return null;

	const byProvider = new Map<string, ModelSummary[]>();
	for (const m of models) {
		const group = byProvider.get(m.provider) ?? [];
		group.push(m);
		byProvider.set(m.provider, group);
	}
	const selectedModel = models.find((model) => model.id === value);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="ghost" className="model-picker-trigger h-8 w-auto gap-1 px-2 text-xs">
					<span className="max-w-44 truncate">{selectedModel?.name ?? "选择模型"}</span>
					<ChevronDownIcon className="size-3.5 opacity-55" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="model-picker-menu" align="start" sideOffset={8}>
				{[...byProvider.entries()].map(([provider, providerModels]) => (
					<DropdownMenuSub key={provider}>
						<DropdownMenuSubTrigger className="model-picker-provider-item">
							<span className="min-w-0 flex-1 truncate">{provider}</span>
							{providerModels.some((model) => model.id === value) ? <span className="model-picker-provider-active" aria-label="当前 Provider" /> : null}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="model-picker-submenu" sideOffset={8}>
							{providerModels.map((model) => (
								<DropdownMenuItem key={model.id} className="model-picker-item" onSelect={() => handleChange(model.id)}>
									<span className="min-w-0 flex-1 truncate">{model.name}</span>
									{model.id === value ? <CheckIcon className="model-picker-check size-4" /> : null}
								</DropdownMenuItem>
							))}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ComposerInner({
	sessionId,
	disabled,
	stopAvailable,
	stopping,
	busyHint,
	hasGoal,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	sessionModel,
	onModelChanged,
	onSend,
	onStop,
	onGoalCommand,
	onOpenWorkspace,
	draft,
}: {
	sessionId: string;
	disabled: boolean;
	stopAvailable: boolean;
	stopping: boolean;
	/** run 活跃但 manager 在等 worker（delegate 阻塞中）时的等待文案。 */
	busyHint?: string;
	hasGoal: boolean;
	workspaceLabel: string;
	workspacePath: string;
	workspaceAvailable: boolean;
	/** 会话真实模型 ref（服务端 rooms 数据）。 */
	sessionModel?: string;
	onModelChanged?: (model: string) => void;
	onSend: (text: string, attachments?: MessageAttachmentInput[]) => void | Promise<void>;
	onStop: () => void | Promise<void>;
	onGoalCommand: (initialGoal: string) => void;
	onOpenWorkspace: () => void;
	draft?: { id: number; content: string };
}) {
	const { textInput, attachments } = usePromptInputController();
	const handledDraftId = useRef<number | null>(null);
	useEffect(() => {
		if (!draft || handledDraftId.current === draft.id) return;
		handledDraftId.current = draft.id;
		const current = textInput.value.trimEnd();
		const next = current ? `${current}\n${draft.content}` : draft.content;
		textInput.setInput(next);
		requestAnimationFrame(() => {
			const textarea = document.querySelector<HTMLTextAreaElement>(".home-composer-textarea");
			textarea?.focus();
			textarea?.setSelectionRange(next.length, next.length);
		});
	}, [draft, textInput]);
	const [skillCommands, setSkillCommands] = useState<SessionSlashCommand[]>([]);
	useEffect(() => {
		let cancelled = false;
		listSessionCommands(sessionId)
			.then((commands) => { if (!cancelled) setSkillCommands(commands); })
			.catch(() => { if (!cancelled) setSkillCommands([]); });
		return () => { cancelled = true; };
	}, [sessionId]);
	const canSend = textInput.value.trim().length > 0 || attachments.files.length > 0;
	const status: ChatStatus = stopAvailable ? "streaming" : "idle";
	const commandQuery = !disabled && attachments.files.length === 0 && /^\/[^\s]*$/.test(textInput.value)
		? textInput.value.slice(1).toLowerCase()
		: null;
	const visibleCommands = commandQuery === null ? [] : [
		...(!hasGoal ? [{ name: "goal", description: "创建一个由 manager 持续推进的目标", source: "goal" as const }] : []),
		...skillCommands,
	].filter((command) => command.name.toLowerCase().includes(commandQuery)).slice(0, 8);
	const chooseSkillCommand = (command: SessionSlashCommand) => {
		const nextValue = `/${command.name} `;
		textInput.setInput(nextValue);
		requestAnimationFrame(() => {
			const textarea = document.querySelector<HTMLTextAreaElement>(".home-composer-textarea");
			textarea?.focus();
			textarea?.setSelectionRange(nextValue.length, nextValue.length);
		});
	};

	return (
		<>
			{visibleCommands.length > 0 ? (
				<div className="home-command-menu mb-2 rounded-xl border bg-popover p-1 shadow-lg" role="menu" aria-label="可用命令">
					{visibleCommands.map((command) => (
						<button
							type="button"
							role="menuitem"
							key={`${command.source}:${command.name}`}
							className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted"
							onClick={() => {
								if (command.source === "goal") {
									textInput.clear();
									onGoalCommand("");
								} else {
									chooseSkillCommand(command);
								}
							}}
						>
							<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{command.source === "goal" ? <TargetIcon className="size-4" /> : <SparklesIcon className="size-4" />}</div>
							<div className="min-w-0 flex-1">
								<div className="truncate font-mono text-sm font-medium">/{command.name}</div>
								<div className="truncate text-xs text-muted-foreground">{command.description || "显式调用这个 Skill"}</div>
							</div>
							<span className="shrink-0 text-[11px] text-muted-foreground">{command.source === "goal" ? "打开" : "填写任务"}</span>
						</button>
					))}
				</div>
			) : null}
			<PromptInput
			className="home-composer"
			multiple
			maxFiles={5}
			maxFileSize={8 * 1024 * 1024}
			onError={(error) => toast.error(error.message)}
			onSubmit={async (message) => {
				if (message.files.length === 0) {
					const command = message.text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
					if (command) {
						if (hasGoal) {
							toast.info("当前会话已经是 Goal");
							return;
						}
						onGoalCommand(command[1]?.trim() ?? "");
						return;
					}
				}
				const encoded = await Promise.all(message.files.map(encodeAttachment));
				await onSend(message.text.trim(), encoded);
			}}
		>
			<PromptInputAttachments>
				{(attachment) => <PromptInputAttachment data={attachment} />}
			</PromptInputAttachments>
			<PromptInputTextarea
				placeholder="发消息，或输入 / 调用命令"
				className="home-composer-textarea"
			/>
			<PromptInputFooter>
				<PromptInputTools>
					<Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => attachments.openFileDialog()} aria-label="添加附件" title="添加附件（最多 5 个，每个 8MB）">
						<PaperclipIcon className="size-4" />
					</Button>
					<ModelPicker sessionId={sessionId} sessionModel={sessionModel} onChanged={onModelChanged} />
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={onOpenWorkspace}
						aria-label={`切换运行目录，当前${workspaceLabel}`}
						title={`当前运行目录：${workspacePath}`}
						className={`h-8 max-w-44 gap-1.5 px-2 text-xs ${workspaceAvailable ? "text-muted-foreground" : "text-destructive hover:text-destructive"}`}
					>
						<FolderGit2Icon className="size-3.5" />
						<span className="truncate">{workspaceLabel}</span>
					</Button>
					<span className="text-muted-foreground px-1 text-xs">{stopping ? "正在停止并保存结果…" : stopAvailable ? (busyHint ?? "处理中…") : ""}</span>
				</PromptInputTools>
				<PromptInputSubmit
					status={status}
					disabled={stopping || (!stopAvailable && (disabled || !canSend))}
					aria-label={stopping ? "正在停止" : stopAvailable ? "停止" : "发送"}
					onClick={(e) => {
						if (stopAvailable && !stopping) {
							e.preventDefault();
							void onStop();
						}
					}}
				/>
			</PromptInputFooter>
			</PromptInput>
		</>
	);
}

export function Composer({
	sessionId,
	disabled,
	stopAvailable = false,
	stopping = false,
	busyHint,
	hasGoal,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	sessionModel,
	stats,
	statsVisible = true,
	onModelChanged,
	onSend,
	onStop,
	onGoalCommand,
	onOpenWorkspace,
	scrollButtonHostRef,
	draft,
}: {
	sessionId: string;
	disabled: boolean;
	stopAvailable?: boolean;
	stopping?: boolean;
	busyHint?: string;
	hasGoal: boolean;
	workspaceLabel: string;
	workspacePath: string;
	workspaceAvailable: boolean;
	sessionModel?: string;
	/** 会话用量统计（composer 悬浮层内、输入框上方）。 */
	stats?: SessionStats | null;
	/** 吸底时才显示统计条，上滑浏览历史时淡出。 */
	statsVisible?: boolean;
	onModelChanged?: (model: string) => void;
	onSend: (text: string, attachments?: MessageAttachmentInput[]) => void | Promise<void>;
	onStop: () => void | Promise<void>;
	onGoalCommand: (initialGoal: string) => void;
	onOpenWorkspace: () => void;
	scrollButtonHostRef?: (node: HTMLDivElement | null) => void;
	draft?: { id: number; content: string };
}) {
	return (
		<div className="home-composer-wrap">
			{/* composer 是绝对定位的悬浮层，统计条放层内才不会被它盖住。 */}
			<ChatStatsBar stats={stats ?? null} visible={statsVisible} />
			<div className="home-composer-inner">
				<div ref={scrollButtonHostRef} className="home-scroll-to-bottom-host" />
				<PromptInputProvider>
					<ComposerInner
							sessionId={sessionId}
							disabled={disabled}
							stopAvailable={stopAvailable}
							stopping={stopping}
						busyHint={busyHint}
						hasGoal={hasGoal}
						workspaceLabel={workspaceLabel}
						workspacePath={workspacePath}
						workspaceAvailable={workspaceAvailable}
						sessionModel={sessionModel}
						onModelChanged={onModelChanged}
						onSend={onSend}
						onStop={onStop}
						onGoalCommand={onGoalCommand}
						onOpenWorkspace={onOpenWorkspace}
						draft={draft}
					/>
				</PromptInputProvider>
			</div>
		</div>
	);
}
