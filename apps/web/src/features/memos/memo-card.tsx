"use client";

import { useState } from "react";
import { ArrowUpRightIcon, CheckIcon, LoaderCircleIcon, Layers3Icon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Memo } from "@/lib/memos";
import { canEditMemo, canSelectMemo, formatMemoTime, memoStatusTone } from "@/lib/memo-presentation";
import { isIMEComposing } from "@/lib/ime";
import { MEMO_TEXT_LIMIT } from "./memo-composer";

function linkLabel(state: Memo["display"]["state"]): string {
	if (state === "published") return "查看页面";
	if (state === "returned") return "查看修订";
	if (state === "conflict" || state === "partial") return "处理异常";
	if (state === "candidate_registration_failed" || state === "needs_attention" || state === "failed") return "查看任务";
	return "查看候选";
}

export function MemoCard({
	memo,
	selected,
	onSelect,
	onSave,
	onDelete,
	onPromote,
}: {
	memo: Memo;
	selected: boolean;
	onSelect: (id: string) => void;
	onSave: (memo: Memo, text: string) => Promise<void>;
	onDelete: (memo: Memo) => void;
	onPromote: (memo: Memo) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(memo.text);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const tone = memoStatusTone(memo.display.state);
	const editable = canEditMemo(memo);
	const selectable = canSelectMemo(memo);
	const deletable = memo.lifecycle !== "promoting";
	// 已发布指向知识库结果；其它状态优先指向审核/任务入口。
	const link = memo.display.knowledgeUrl ?? memo.display.reviewUrl;
	const draftLength = Array.from(draft).length;
	const overLimit = draftLength > MEMO_TEXT_LIMIT;

	const beginEdit = () => { setDraft(memo.text); setError(""); setEditing(true); };

	const save = async () => {
		if (saving || !draft.trim() || overLimit) return;
		setSaving(true);
		setError("");
		try {
			await onSave(memo, draft);
			setEditing(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "保存失败，请重试");
		} finally {
			setSaving(false);
		}
	};

	return (
		<article
			className="memo-card"
			data-selected={selected ? "true" : undefined}
			data-organized={memo.lifecycle === "organized" ? "true" : undefined}
			aria-label={`速记：${memo.text.slice(0, 24)}`}
		>
			<button
				type="button"
				className="memo-check"
				role="checkbox"
				aria-checked={selected}
				aria-label={selected ? "取消选择这条速记" : "选择这条速记"}
				disabled={!selectable}
				onClick={() => onSelect(memo.id)}
			>
				{selected ? <CheckIcon className="size-3" aria-hidden="true" /> : null}
			</button>

			<div className="memo-main">
				<header className="memo-head">
					<span className="memo-time">
						{formatMemoTime(memo.createdAt)}
						<span className="memo-badge" data-tone={tone}>{memo.display.label}</span>
					</span>
					<div className="memo-actions">
						{selectable ? (
							<Button type="button" variant="ghost" size="icon-sm" aria-label="整理这条速记" title="整理这条" onClick={() => onPromote(memo)}>
								<Layers3Icon aria-hidden="true" />
							</Button>
						) : null}
						{editable ? (
							<Button type="button" variant="ghost" size="icon-sm" aria-label="编辑这条速记" title="编辑" onClick={beginEdit}>
								<PencilIcon aria-hidden="true" />
							</Button>
						) : null}
						{deletable ? (
							<Button type="button" variant="ghost" size="icon-sm" aria-label="删除这条速记" title="删除" onClick={() => onDelete(memo)}>
								<Trash2Icon aria-hidden="true" />
							</Button>
						) : null}
					</div>
				</header>

				{editing ? (
					<div className="memo-editor">
						<textarea
							value={draft}
							rows={3}
							autoFocus
							lang="zh"
							aria-label="编辑速记内容"
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape" && !isIMEComposing(event)) { setEditing(false); return; }
								if (event.key === "Enter" && !event.shiftKey && !isIMEComposing(event)) {
									event.preventDefault();
									void save();
								}
							}}
						/>
						{error ? <p className="memo-editor-error" role="alert">{error}</p> : null}
						{overLimit || draftLength > 9000 ? (
							<p className="memo-counter" role={overLimit ? "alert" : undefined}>
								{draftLength} / {MEMO_TEXT_LIMIT}{overLimit ? "，超出不能保存" : ""}
							</p>
						) : null}
						<div className="memo-editor-actions">
							<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>取消</Button>
							<Button type="button" size="sm" onClick={() => void save()} disabled={saving || !draft.trim() || overLimit}>
								{saving ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
								保存
							</Button>
						</div>
					</div>
				) : (
					<p className="memo-text" lang="zh">{memo.text}</p>
				)}

				{memo.tags.length ? (
					<div className="memo-links" aria-label="标签">
						{memo.tags.map((tag) => <span key={tag} className="memo-tag">#{tag}</span>)}
					</div>
				) : null}

				{(link || memo.display.detail || memo.lastError) ? (
					<div className="memo-links">
						{link ? (
							<a href={link}>
								{linkLabel(memo.display.state)}
								<ArrowUpRightIcon className="size-3" aria-hidden="true" />
							</a>
						) : null}
						{memo.display.detail ?? memo.lastError ? <span>{memo.display.detail ?? memo.lastError}</span> : null}
					</div>
				) : null}
			</div>
		</article>
	);
}
