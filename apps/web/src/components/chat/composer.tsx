"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { getViewerIdentity, listSessionCommands, setSessionModel, setSessionThinkingLevel, type MessageAttachmentInput, type SessionSlashCommand } from "@/lib/api";
import { useModelCatalog } from "@/lib/model-catalog";
import { setPreferredModel } from "@/lib/model-pref";
import { clearSubmittedChatDraft, loadChatAttachmentDraft, loadChatDraft, removeSubmittedChatAttachments, saveChatAttachmentDraft, saveChatDraft } from "@/lib/chat-draft";
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
import { BrainCircuitIcon, CheckIcon, ChevronDownIcon, FolderGit2Icon, PaperclipIcon, SparklesIcon, TargetIcon } from "lucide-react";
import type { PromptInputFilePart } from "@/core/uploads";
import { SessionKnowledgePicker } from "./session-knowledge-picker";
import { WorkerModelPicker } from "./worker-model-picker";

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
	onChanged?: (sessionId: string, model: string) => void;
}) {
	const { models, modelsError, reload } = useModelCatalog();
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const [value, setValue] = useState<string>(sessionModel ?? "");
	// 显示值只采用会话真实模型；本地偏好只供创建新会话使用。
	const [prevSessionModel, setPrevSessionModel] = useState(sessionModel);
	if (sessionModel !== prevSessionModel) {
		setPrevSessionModel(sessionModel);
		setValue(sessionModel ?? "");
	}

	const handleChange = async (ref: string) => {
		if (pendingRef.current || ref === value) return;
		pendingRef.current = true;
		setPending(true);
		try {
			const confirmed = await setSessionModel(sessionId, ref);
			setValue(confirmed);
			setPreferredModel(confirmed);
			onChanged?.(sessionId, confirmed);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	};

	if (modelsError) return <Button type="button" variant="ghost" className="model-picker-trigger h-8 px-2 text-xs text-destructive" onClick={reload} title={modelsError}>模型列表不可用 · 重试</Button>;
	if (models === null) return <Button type="button" variant="ghost" className="model-picker-trigger h-8 px-2 text-xs" disabled>正在读取模型…</Button>;
	if (models.length === 0) return <Button type="button" variant="ghost" className="model-picker-trigger h-8 px-2 text-xs" disabled>{value ? `当前模型：${value}（目录无可选项）` : "暂无模型"}</Button>;

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
				<Button type="button" variant="ghost" className="model-picker-trigger h-8 w-auto gap-1 px-2 text-xs" disabled={pending} aria-busy={pending}>
					<span className="max-w-44 truncate">{pending ? "正在切换模型…" : selectedModel?.name ?? (value ? `当前模型：${value}` : "选择模型")}</span>
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

/**
 * 会话级思考强度选择器（§10.6）：只作用于当前 Session，优先级高于
 * manager 默认档位。档位只用 pi SDK 归一化枚举原名（off/minimal/low/…
 * max）——它们是上游线上参数值，翻译成中文反而制造一层需要维护的对应关系，
 * 且各 provider 的强度语义不同，中文「轻量/适中/深入」无法准确表达。
 * 非推理模型不渲染。
 */
function ThinkingLevelPicker({
	sessionId,
	sessionModel,
	sessionThinkingLevel,
	onChanged,
}: {
	sessionId: string;
	sessionModel?: string;
	/** 会话真实 thinking level（服务端为准）。 */
	sessionThinkingLevel?: string;
	onChanged?: (sessionId: string, level: string) => void;
}) {
	const { find, levelsFor, gradedFor } = useModelCatalog();
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const [value, setValue] = useState<string>(sessionThinkingLevel ?? "");
	const [prevSessionThinkingLevel, setPrevSessionThinkingLevel] = useState(sessionThinkingLevel);
	if (sessionThinkingLevel !== prevSessionThinkingLevel) {
		setPrevSessionThinkingLevel(sessionThinkingLevel);
		setValue(sessionThinkingLevel ?? "");
	}

	const currentModel = find(sessionModel);
	// 档位取自共享目录（与 Agent 配置页同源）；未命中时回退归一化全集。
	const levels = levelsFor(sessionModel);
	const reasoning = currentModel ? currentModel.reasoning !== false : true;
	const graded = gradedFor(sessionModel);
	if (!reasoning) return null;

	const handleChange = async (level: string) => {
		if (pendingRef.current || level === value) return;
		pendingRef.current = true;
		setPending(true);
		try {
			const confirmed = await setSessionThinkingLevel(sessionId, level);
			setValue(confirmed);
			onChanged?.(sessionId, confirmed);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					className="model-picker-trigger thinking-picker-trigger h-8 w-auto gap-1 px-2 text-xs"
					disabled={pending}
					aria-busy={pending}
					aria-label={`思考强度：${value || "未设置"}`}
					title={`思考强度（仅当前会话）：${value || "未设置"}。档位为 pi 原生枚举，各 provider 的实际强度语义以服务商文档为准。${graded ? "" : "该模型只支持思考开/关，档位不改变实际推理量。"}`}
				>
					<BrainCircuitIcon className="size-3.5 opacity-55" />
					<span className="max-w-20 truncate">{pending ? "切换中…" : value || "思考强度"}</span>
					<ChevronDownIcon className="size-3.5 opacity-55" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="model-picker-menu thinking-picker-menu" align="start" sideOffset={8}>
				{levels.map((level) => (
					<DropdownMenuItem key={level} className="model-picker-item" onSelect={() => handleChange(level)}>
						<span className="min-w-0 flex-1 truncate">{level}</span>
						{level === value ? <CheckIcon className="model-picker-check size-4" /> : null}
					</DropdownMenuItem>
				))}
				{graded ? null : (
					<div className="thinking-picker-note">该模型只支持思考开/关，各档在链路上无差别。</div>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ComposerInner({
	sessionId,
	draftScope,
	disabled,
	sending,
	stopAvailable,
	stopping,
	busyHint,
	hasGoal,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	sessionModel,
	sessionThinkingLevel,
	directWorkerModel,
	onModelChanged,
	onThinkingChanged,
	onSend,
	onStop,
	onGoalCommand,
	onOpenWorkspace,
	draft,
}: {
	sessionId: string;
	draftScope: string;
	disabled: boolean;
	sending: boolean;
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
	/** 会话真实 thinking level（服务端 rooms 数据，§10.6）。 */
	sessionThinkingLevel?: string;
	directWorkerModel?: { name: string; model?: string };
	onModelChanged?: (sessionId: string, model: string) => void;
	onThinkingChanged?: (sessionId: string, level: string) => void;
	onSend: (text: string, attachments?: MessageAttachmentInput[]) => void | Promise<void>;
	onStop: () => void | Promise<void>;
	onGoalCommand: (initialGoal: string) => void;
	onOpenWorkspace: () => void;
	draft?: { id: number; content: string };
}) {
	const { textInput, attachments } = usePromptInputController();
	const [knowledgeSaving, setKnowledgeSaving] = useState(false);
	const [workerModelSaving, setWorkerModelSaving] = useState(false);
	const currentTextRef = useRef(textInput.value);
	useLayoutEffect(() => { currentTextRef.current = textInput.value; }, [textInput.value]);
	const currentAttachmentsRef = useRef(attachments.files);
	useLayoutEffect(() => { currentAttachmentsRef.current = attachments.files; }, [attachments.files]);
	const [draftKey, setDraftKey] = useState<string | null>(null);
	const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
	const sentBeforeDraftReadyRef = useRef(false);
	const [draftIdentityError, setDraftIdentityError] = useState<string | null>(null);
	const [draftIdentityRetry, setDraftIdentityRetry] = useState(0);
	const setInput = textInput.setInput;
	useEffect(() => {
		let cancelled = false;
		void getViewerIdentity().then((identity) => {
			if (!cancelled) {
				setDraftIdentityError(null);
				setDraftKey(`puddingteams:draft:v1:${JSON.stringify([identity.tenant.id, identity.user.id, draftScope])}`);
			}
		}).catch((error: unknown) => { if (!cancelled) setDraftIdentityError(error instanceof Error ? error.message : String(error)); });
		return () => { cancelled = true; };
	}, [draftScope, draftIdentityRetry]);
	useEffect(() => {
		if (!draftKey || hydratedDraftKey === draftKey) return;
		const timer = setTimeout(() => {
			if (sentBeforeDraftReadyRef.current) {
				saveChatDraft(draftKey, "", () => localStorage);
				saveChatAttachmentDraft(draftKey, []);
				sentBeforeDraftReadyRef.current = false;
			}
			if (!textInput.value) {
				setInput(loadChatDraft(draftKey, () => localStorage));
			}
			if (attachments.files.length === 0) {
				const savedFiles = loadChatAttachmentDraft(draftKey);
				if (savedFiles.length > 0) attachments.add(savedFiles);
			}
			setHydratedDraftKey(draftKey);
		}, 0);
		return () => clearTimeout(timer);
	}, [attachments, draftKey, hydratedDraftKey, setInput, textInput.value]);
	useEffect(() => {
		if (!draftKey || hydratedDraftKey !== draftKey) return;
		saveChatDraft(draftKey, textInput.value, () => localStorage);
		saveChatAttachmentDraft(draftKey, attachments.files);
	}, [attachments.files, draftKey, hydratedDraftKey, textInput.value]);
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
	const status: ChatStatus = stopAvailable ? "streaming" : sending ? "submitted" : "idle";
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
			{draftIdentityError ? <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-destructive"><span>草稿身份加载失败；当前输入尚未保存：{draftIdentityError}</span><Button type="button" size="sm" variant="outline" onClick={() => setDraftIdentityRetry((current) => current + 1)}>重试加载草稿</Button></div> : null}
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
				if (disabled || knowledgeSaving || workerModelSaving || stopping) return;
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
				if (draftKey && hydratedDraftKey === draftKey) {
					clearSubmittedChatDraft(draftKey, message.text, currentTextRef.current, () => localStorage);
					removeSubmittedChatAttachments(draftKey, message.files.flatMap(({ file }) => file ? [file] : []), currentAttachmentsRef.current);
				} else {
					sentBeforeDraftReadyRef.current = true;
				}
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
					<SessionKnowledgePicker sessionId={sessionId} disabled={disabled || stopAvailable || stopping} onSavingChange={setKnowledgeSaving} />
				</PromptInputTools>
				<span className="home-composer-status">{stopping ? "正在停止并保存结果…" : stopAvailable ? (busyHint ?? "处理中…") : sending ? "正在提交消息…" : ""}</span>
				<div className="home-composer-send">
					{directWorkerModel ? (
						<WorkerModelPicker key={`${sessionId}:${directWorkerModel.name}`} sessionId={sessionId} workerName={directWorkerModel.name} disabled={disabled || sending || stopping} onSavingChange={setWorkerModelSaving} />
					) : (
						<>
							<ModelPicker sessionId={sessionId} sessionModel={sessionModel} onChanged={onModelChanged} />
							<ThinkingLevelPicker sessionId={sessionId} sessionModel={sessionModel} sessionThinkingLevel={sessionThinkingLevel} onChanged={onThinkingChanged} />
						</>
					)}
					<PromptInputSubmit
						status={status}
						disabled={stopping || (!stopAvailable && (disabled || knowledgeSaving || workerModelSaving || !canSend))}
						aria-label={stopping ? "正在停止" : stopAvailable ? "停止" : "发送"}
						onClick={(e) => {
							if (stopAvailable && !stopping) {
								e.preventDefault();
								void onStop();
							}
						}}
					/>
				</div>
			</PromptInputFooter>
			</PromptInput>
		</>
	);
}

export function Composer({
	sessionId,
	draftScope,
	disabled,
	sending = false,
	stopAvailable = false,
	stopping = false,
	busyHint,
	hasGoal,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	sessionModel,
	sessionThinkingLevel,
	directWorkerModel,
	stats,
	statsVisible = true,
	onModelChanged,
	onThinkingChanged,
	onSend,
	onStop,
	onGoalCommand,
	onOpenWorkspace,
	scrollButtonHostRef,
	draft,
}: {
	sessionId: string;
	draftScope: string;
	disabled: boolean;
	sending?: boolean;
	stopAvailable?: boolean;
	stopping?: boolean;
	busyHint?: string;
	hasGoal: boolean;
	workspaceLabel: string;
	workspacePath: string;
	workspaceAvailable: boolean;
	sessionModel?: string;
	sessionThinkingLevel?: string;
	directWorkerModel?: { name: string; model?: string };
	/** 会话用量统计（composer 悬浮层内、输入框上方）。 */
	stats?: SessionStats | null;
	/** 吸底时才显示统计条，上滑浏览历史时淡出。 */
	statsVisible?: boolean;
	onModelChanged?: (sessionId: string, model: string) => void;
	onThinkingChanged?: (sessionId: string, level: string) => void;
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
				<PromptInputProvider key={draftScope}>
					<ComposerInner
							sessionId={sessionId}
							draftScope={draftScope}
							disabled={disabled}
							sending={sending}
							stopAvailable={stopAvailable}
							stopping={stopping}
						busyHint={busyHint}
						hasGoal={hasGoal}
						workspaceLabel={workspaceLabel}
						workspacePath={workspacePath}
						workspaceAvailable={workspaceAvailable}
						sessionModel={sessionModel}
						sessionThinkingLevel={sessionThinkingLevel}
						directWorkerModel={directWorkerModel}
						onModelChanged={onModelChanged}
						onThinkingChanged={onThinkingChanged}
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
