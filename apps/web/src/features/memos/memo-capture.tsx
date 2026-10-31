"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getViewerIdentity } from "@/lib/api";
import { createMemo, deleteMemo, type Memo } from "@/lib/memos";
import { notifyMemosChanged } from "@/lib/memo-inbox-count";
import {
	clearMemoDraftIfMatches,
	memoDraftKey,
	newMemoOperationId,
	operationIdFor,
	readMemoDraft,
	safeSessionStorage,
	writeMemoDraft,
} from "@/lib/memo-draft";
import { shouldOpenCapture } from "@/lib/memo-shortcuts";
import { MemoComposer } from "./memo-composer";
import "./memos.css";

export const MEMO_CAPTURE_EVENT = "pudding-memo-capture";

function anyDialogOpen(): boolean {
	return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/** 任意页面可用的捕获单例：⌘/Ctrl+Shift+Space 或 MEMO_CAPTURE_EVENT。 */
export function MemoCapture() {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [operationId, setOperationId] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const storageKey = useRef<string | null>(null);
	const storage = useRef<ReturnType<typeof safeSessionStorage>>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const textRef = useRef("");
	const operationRef = useRef("");

	useEffect(() => { textRef.current = text; }, [text]);
	useEffect(() => { operationRef.current = operationId; }, [operationId]);

	useEffect(() => {
		storage.current = safeSessionStorage();
		let active = true;
		void getViewerIdentity()
			.then((identity) => {
				if (!active) return;
				storageKey.current = memoDraftKey(identity.tenant.id, identity.user.id);
				const draft = readMemoDraft(storage.current, storageKey.current);
				// 身份解析晚于用户开始输入时，不覆盖当前草稿。
				if (draft && !textRef.current) { setText(draft.text); setOperationId(draft.operationId); }
			})
			.catch(() => undefined);
		return () => { active = false; };
	}, []);

	const openCapture = useCallback(() => {
		if (anyDialogOpen()) return;
		previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (storageKey.current) {
			const draft = readMemoDraft(storage.current, storageKey.current);
			if (draft) { setText(draft.text); setOperationId(draft.operationId); }
		}
		if (!operationRef.current) setOperationId(newMemoOperationId());
		setOpen(true);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!shouldOpenCapture(event, { modalOpen: anyDialogOpen() })) return;
			// macOS 只认 ⌘；Ctrl+Shift+Space 留给系统/输入法。
			const mac = /Mac|iPhone|iPad/.test(navigator.platform);
			if (mac && event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			openCapture();
		};
		const onEvent = () => openCapture();
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener(MEMO_CAPTURE_EVENT, onEvent);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener(MEMO_CAPTURE_EVENT, onEvent);
		};
	}, [openCapture]);

	const change = (next: string) => {
		const nextOperationId = operationIdFor(next, { text: textRef.current, operationId: operationRef.current || newMemoOperationId() });
		setText(next);
		setOperationId(nextOperationId);
		if (storageKey.current) writeMemoDraft(storage.current, storageKey.current, { text: next, operationId: nextOperationId });
	};

	const undo = async (memo: Memo) => {
		try {
			await deleteMemo(memo.id, { operationId: newMemoOperationId(), expectedRevision: memo.revision });
			notifyMemosChanged();
			toast.success("已撤销");
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : "撤销失败");
		}
	};

	const submit = async (value: string) => {
		if (submitting) return;
		const submitted = value;
		const key = storageKey.current;
		const submittedOperation = operationRef.current || newMemoOperationId();
		setSubmitting(true);
		try {
			const { memo } = await createMemo({ operationId: submittedOperation, text: submitted });
			// 迟到响应不能清掉用户的后来输入；只有当前仍是这次提交的草稿才收尾。
			if (key) clearMemoDraftIfMatches(storage.current, key, { text: submitted, operationId: submittedOperation });
			const unchanged = textRef.current === submitted && operationRef.current === submittedOperation;
			if (unchanged) {
				setText("");
				setOperationId(newMemoOperationId());
				setOpen(false);
			}
			notifyMemosChanged();
			toast.success("已记下", { action: { label: "撤销", onClick: () => void undo(memo) } });
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : "保存失败，请重试");
		} finally {
			setSubmitting(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (!next && submitting) return;
		setOpen(next);
		if (!next) {
			const element = previousFocus.current;
			if (element?.isConnected) requestAnimationFrame(() => element.focus());
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="border-0 bg-transparent p-0 shadow-none sm:max-w-[620px]"
				showCloseButton={false}
				onEscapeKeyDown={(event) => {
					const composing = (event as unknown as { detail?: { originalEvent?: { isComposing?: boolean; keyCode?: number } } }).detail?.originalEvent;
					if (submitting || composing?.isComposing || composing?.keyCode === 229) event.preventDefault();
				}}
				onPointerDownOutside={(event) => { if (submitting) event.preventDefault(); }}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					const element = previousFocus.current;
					previousFocus.current = null;
					if (element?.isConnected) element.focus();
				}}
			>
				<DialogTitle className="sr-only">速记</DialogTitle>
				<DialogDescription className="sr-only">按 Enter 保存，Shift+Enter 换行，Esc 关闭。</DialogDescription>
				<div className="memo-capture">
					<div className="memo-capture-head">
						<span>速记</span>
						<kbd className="rounded border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">esc</kbd>
					</div>
					<MemoComposer
						variant="capture"
						autoFocus
						value={text}
						onChange={change}
						onSubmit={(value) => void submit(value)}
						submitting={submitting}
						disabled={submitting}
						onCancel={() => handleOpenChange(false)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
