"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { KnowledgeApiError, listKnowledgeBindings, type KnowledgeBindingSummary } from "@/lib/api";
import { promoteMemos, type Memo, type PromoteMemoResult } from "@/lib/memos";

const DEFAULT_TASK = "把这些速记整理成知识库条目，合并重复的观点，保留我原来的措辞。";
/** 跨关闭/重开复用同一次提交身份：网络结果未知时按原 operationId 重放。 */
const attemptCache = new Map<string, string>();

function isComposingEscape(event: { detail?: unknown; isComposing?: boolean; keyCode?: number }): boolean {
	if (event.isComposing || event.keyCode === 229) return true;
	const original = (event.detail as { originalEvent?: { isComposing?: boolean; keyCode?: number } } | undefined)?.originalEvent;
	return Boolean(original?.isComposing || original?.keyCode === 229);
}

export function PromoteMemosDialog({
	open,
	onOpenChange,
	memos,
	onSubmitted,
	onConflict,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	memos: Memo[];
	onSubmitted: (result: PromoteMemoResult) => void;
	/** 409：状态已变化，页面需要刷新并关闭弹窗，而不是继续用新 ID 重试。 */
	onConflict?: () => void;
}) {
	const [bindings, setBindings] = useState<KnowledgeBindingSummary[] | null>(null);
	const [bindingsError, setBindingsError] = useState("");
	const [bindingId, setBindingId] = useState("");
	const [task, setTask] = useState(DEFAULT_TASK);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");
	const previousFocus = useRef<HTMLElement | null>(null);

	useEffect(() => {
		previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		return () => {
			const element = previousFocus.current;
			previousFocus.current = null;
			if (element?.isConnected) element.focus();
		};
	}, []);

	const loadBindings = useCallback(async () => {
		setBindingsError("");
		try {
			const next = await listKnowledgeBindings();
			const usable = next.filter((binding) => binding.availability === "available");
			setBindings(usable);
			setBindingId((current) => (usable.some((binding) => binding.id === current) ? current : usable[0]?.id ?? ""));
		} catch (cause) {
			setBindings([]);
			setBindingsError(cause instanceof Error ? cause.message : "读取知识库失败");
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => void loadBindings(), 0);
		return () => clearTimeout(timer);
	}, [open, loadBindings]);

	const submit = async () => {
		if (submitting || !bindingId || !task.trim() || !memos.length) return;
		const payload = JSON.stringify({ memoIds: memos.map((memo) => memo.id), bindingId, task: task.trim() });
		const cached = attemptCache.get(payload);
		const operationId = cached ?? crypto.randomUUID();
		if (!cached) attemptCache.set(payload, operationId);
		setSubmitting(true);
		setError("");
		try {
			const result = await promoteMemos({
				operationId,
				memoIds: memos.map((memo) => memo.id),
				bindingId,
				task: task.trim(),
			});
			attemptCache.delete(payload);
			onSubmitted(result);
		} catch (cause) {
			if (cause instanceof KnowledgeApiError && cause.status === 409) {
				// 状态冲突：这次载荷已不可再用；关闭并刷新，而不是循环重试。
				attemptCache.delete(payload);
				setError(cause.message);
				toast.error(cause.message);
				onConflict?.();
			} else {
				// 网络结果未知：保留同一 operationId，重试由服务端幂等对账。
				setError(cause instanceof Error ? cause.message : "提交整理失败，请重试");
			}
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[520px]"
				onEscapeKeyDown={(event) => { if (submitting || isComposingEscape(event as unknown as { detail?: unknown })) event.preventDefault(); }}
				onPointerDownOutside={(event) => { if (submitting) event.preventDefault(); }}
				onCloseAutoFocus={(event) => { event.preventDefault(); }}
			>
				<DialogHeader>
					<DialogTitle>整理进知识库</DialogTitle>
					<DialogDescription>
						已选 {memos.length} 条速记。提交后先生成候选，不会直接写入知识库。
					</DialogDescription>
				</DialogHeader>

				<div className="flex max-h-28 flex-col gap-1.5 overflow-y-auto text-xs text-muted-foreground">
					{memos.slice(0, 3).map((memo) => (
						<p key={memo.id} className="border-l-2 border-border pl-2.5 leading-6 line-clamp-2">{memo.text}</p>
					))}
					{memos.length > 3 ? <p className="pl-3">还有 {memos.length - 3} 条</p> : null}
				</div>

				<div className="flex flex-col gap-2">
					<label className="text-xs font-medium text-foreground" htmlFor="memo-promote-binding">目标知识库</label>
					{bindingsError ? (
						<p className="text-xs text-destructive" role="alert">
							{bindingsError}
							<button type="button" className="ml-2 underline" onClick={() => void loadBindings()}>重试</button>
						</p>
					) : bindings === null ? (
						<p className="text-xs text-muted-foreground">正在读取知识库…</p>
					) : bindings.length ? (
						<select
							id="memo-promote-binding"
							className="h-9 rounded-md border bg-background px-2 text-sm"
							value={bindingId}
							onChange={(event) => setBindingId(event.target.value)}
							disabled={submitting}
						>
							{bindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.name}</option>)}
						</select>
					) : (
						<p className="text-xs text-muted-foreground">
							没有可用的知识库。<a className="text-primary underline" href="/knowledge">先接入一个知识库</a>
						</p>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<label className="text-xs font-medium text-foreground" htmlFor="memo-promote-task">整理要求</label>
					<textarea
						id="memo-promote-task"
						className="min-h-20 rounded-md border bg-background px-2.5 py-2 text-sm leading-6"
						value={task}
						maxLength={20000}
						disabled={submitting}
						onChange={(event) => setTask(event.target.value)}
					/>
					<p className="text-[11px] text-muted-foreground">整理会检索查重、合并同类观点，再提交候选。</p>
				</div>

				{error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}

				<p className="rounded-md bg-muted px-3 py-2 text-[11px] leading-5 text-muted-foreground">
					提交不是发布。整理结果停在候选，需要你逐条审核后才会写入知识库。
				</p>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
					<Button type="button" onClick={() => void submit()} disabled={submitting || !bindingId || !task.trim() || !memos.length}>
						{submitting ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
						提交整理 · {memos.length} 条
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
