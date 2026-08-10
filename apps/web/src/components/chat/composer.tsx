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
import { PaperclipIcon } from "lucide-react";
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
	onSend,
	onStop,
}: {
	sessionId: string;
	disabled: boolean;
	onSend: (text: string, attachments?: MessageAttachmentInput[]) => void | Promise<void>;
	onStop: () => void;
}) {
	const { textInput, attachments } = usePromptInputController();
	const canSend = textInput.value.trim().length > 0 || attachments.files.length > 0;
	const status: ChatStatus = disabled ? "streaming" : "idle";

	return (
		<PromptInput
			multiple
			maxFiles={5}
			maxFileSize={8 * 1024 * 1024}
			onError={(error) => toast.error(error.message)}
			onSubmit={async (message) => {
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
	);
}

export function Composer({
	sessionId,
	disabled,
	onSend,
	onStop,
}: {
	sessionId: string;
	disabled: boolean;
	onSend: (text: string, attachments?: MessageAttachmentInput[]) => void | Promise<void>;
	onStop: () => void;
}) {
	return (
		<div className="relative bg-background p-3">
			<div className="mx-auto max-w-3xl">
				<PromptInputProvider>
					<ComposerInner sessionId={sessionId} disabled={disabled} onSend={onSend} onStop={onStop} />
				</PromptInputProvider>
			</div>
		</div>
	);
}
