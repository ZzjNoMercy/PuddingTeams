"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	PromptInput,
	PromptInputAttachment,
	PromptInputAttachments,
	PromptInputFooter,
	PromptInputProvider,
	PromptInputSelect,
	PromptInputSelectContent,
	PromptInputSelectItem,
	PromptInputSelectTrigger,
	PromptInputSelectValue,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputController,
	type ChatStatus,
} from "@/components/ai-elements/prompt-input";
import { listModels, MODELS_CHANGED_EVENT, setSessionModel, type MessageAttachmentInput } from "@/lib/api";
import { getPreferredModel, setPreferredModel } from "@/lib/model-pref";
import type { ModelSummary } from "@/lib/types";
import type { SessionStats } from "@/lib/session-stats";
import { ChatStatsBar } from "./chat-stats-bar";
import { SelectGroup, SelectLabel } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { FolderGit2Icon, PaperclipIcon, TargetIcon } from "lucide-react";
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

	return (
		<PromptInputSelect value={value || undefined} onValueChange={handleChange}>
			<PromptInputSelectTrigger className="h-8 w-auto gap-1 px-2 text-xs">
				<PromptInputSelectValue placeholder="选择模型" />
			</PromptInputSelectTrigger>
			<PromptInputSelectContent>
				{[...byProvider.entries()].map(([provider, providerModels]) => (
					<SelectGroup key={provider}>
						<SelectLabel className="text-sm font-medium text-foreground">{provider}</SelectLabel>
						{providerModels.map((m) => (
							<PromptInputSelectItem key={m.id} value={m.id} className="text-xs text-muted-foreground">
								{m.name}
							</PromptInputSelectItem>
						))}
					</SelectGroup>
				))}
			</PromptInputSelectContent>
		</PromptInputSelect>
	);
}

function ComposerInner({
	sessionId,
	disabled,
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
}: {
	sessionId: string;
	disabled: boolean;
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
	onStop: () => void;
	onGoalCommand: (initialGoal: string) => void;
	onOpenWorkspace: () => void;
}) {
	const { textInput, attachments } = usePromptInputController();
	const canSend = textInput.value.trim().length > 0 || attachments.files.length > 0;
	const status: ChatStatus = disabled ? "streaming" : "idle";
	const trimmed = textInput.value.trim();
	const showGoalCommand = !disabled && !hasGoal && attachments.files.length === 0 && /^\/(?:g(?:o(?:a(?:l)?)?)?)?$/i.test(trimmed);

	return (
		<>
			{showGoalCommand ? (
				<div className="mb-2 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg">
					<button
						type="button"
						className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted"
						onClick={() => {
							textInput.clear();
							onGoalCommand("");
						}}
					>
						<div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><TargetIcon className="size-4" /></div>
						<div className="min-w-0 flex-1">
							<div className="font-mono text-sm font-medium">/goal</div>
							<div className="text-xs text-muted-foreground">创建一个由 manager 持续推进的目标</div>
						</div>
						<span className="text-[11px] text-muted-foreground">Enter</span>
					</button>
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
				placeholder={disabled ? (busyHint ?? "agent 正在处理…") : "发消息，或输入 / 调用命令"}
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
					<span className="text-muted-foreground px-1 text-xs">{disabled ? (busyHint ?? "处理中…") : ""}</span>
				</PromptInputTools>
				<PromptInputSubmit
					status={status}
					disabled={!disabled && !canSend}
					aria-label={disabled ? "停止" : "发送"}
					onClick={(e) => {
						if (disabled) {
							e.preventDefault();
							onStop();
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
	busyHint,
	hasGoal,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	sessionModel,
	stats,
	onModelChanged,
	onSend,
	onStop,
	onGoalCommand,
	onOpenWorkspace,
	scrollButtonHostRef,
}: {
	sessionId: string;
	disabled: boolean;
	busyHint?: string;
	hasGoal: boolean;
	workspaceLabel: string;
	workspacePath: string;
	workspaceAvailable: boolean;
	sessionModel?: string;
	/** 会话用量统计（composer 悬浮层内、输入框上方）。 */
	stats?: SessionStats | null;
	onModelChanged?: (model: string) => void;
	onSend: (text: string, attachments?: MessageAttachmentInput[]) => void | Promise<void>;
	onStop: () => void;
	onGoalCommand: (initialGoal: string) => void;
	onOpenWorkspace: () => void;
	scrollButtonHostRef?: (node: HTMLDivElement | null) => void;
}) {
	return (
		<div className="home-composer-wrap">
			{/* composer 是绝对定位的悬浮层，统计条放层内才不会被它盖住。 */}
			<ChatStatsBar stats={stats ?? null} />
			<div className="home-composer-inner">
				<div ref={scrollButtonHostRef} className="home-scroll-to-bottom-host" />
				<PromptInputProvider>
					<ComposerInner
						sessionId={sessionId}
						disabled={disabled}
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
					/>
				</PromptInputProvider>
			</div>
		</div>
	);
}
