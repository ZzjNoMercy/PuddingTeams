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

function ModelPicker({ sessionId }: { sessionId: string }) {
	const [models, setModels] = useState<ModelSummary[]>([]);
	const [value, setValue] = useState<string>(() => getPreferredModel() ?? "");

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			listModels()
				.then((models) => {
					if (cancelled) return;
					setModels(models);
					// Adopt the first model when nothing was picked yet (or the stored
					// pick no longer exists), so the select never shows a dead value.
					setValue((prev) => {
						if (prev && models.some((m) => m.id === prev)) return prev;
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
		setSessionModel(sessionId, ref).catch((err: unknown) => {
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
						<SelectLabel>{provider}</SelectLabel>
						{providerModels.map((m) => (
							<PromptInputSelectItem key={m.id} value={m.id}>
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
	hasGoal,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	onSend,
	onStop,
	onGoalCommand,
	onOpenWorkspace,
}: {
	sessionId: string;
	disabled: boolean;
	hasGoal: boolean;
	workspaceLabel: string;
	workspacePath: string;
	workspaceAvailable: boolean;
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
				placeholder={disabled ? "agent 正在处理…" : "发消息（Enter 发送，Shift+Enter 换行）"}
			/>
			<PromptInputFooter>
				<PromptInputTools>
					<Button type="button" size="icon" variant="ghost" className="size-8" onClick={() => attachments.openFileDialog()} aria-label="添加附件" title="添加附件（最多 5 个，每个 8MB）">
						<PaperclipIcon className="size-4" />
					</Button>
					<ModelPicker sessionId={sessionId} />
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
					<span className="text-muted-foreground px-1 text-xs">{disabled ? "处理中…" : ""}</span>
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
	hasGoal,
	workspaceLabel,
	workspacePath,
	workspaceAvailable,
	onSend,
	onStop,
	onGoalCommand,
	onOpenWorkspace,
}: {
	sessionId: string;
	disabled: boolean;
	hasGoal: boolean;
	workspaceLabel: string;
	workspacePath: string;
	workspaceAvailable: boolean;
	onSend: (text: string, attachments?: MessageAttachmentInput[]) => void | Promise<void>;
	onStop: () => void;
	onGoalCommand: (initialGoal: string) => void;
	onOpenWorkspace: () => void;
}) {
	return (
		<div className="relative bg-background p-3">
			<div className="mx-auto max-w-3xl">
				<PromptInputProvider>
					<ComposerInner
						sessionId={sessionId}
						disabled={disabled}
						hasGoal={hasGoal}
						workspaceLabel={workspaceLabel}
						workspacePath={workspacePath}
						workspaceAvailable={workspaceAvailable}
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
