"use client";

import { useId, useMemo } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isIMEComposing } from "@/lib/ime";
import { parseMemoTags } from "@/lib/memo-presentation";

export const MEMO_TEXT_LIMIT = 10_000;
const PAGE_PLACEHOLDER = "随手记一句……用 #标签 归个类";

export function MemoComposer({
	value,
	onChange,
	onSubmit,
	submitting = false,
	disabled = false,
	autoFocus = false,
	variant = "page",
	submitLabel = "记下",
	onCancel,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: (value: string) => void;
	submitting?: boolean;
	/** 提交中锁定输入，避免用户在请求期间继续改写被提交的正文。 */
	disabled?: boolean;
	autoFocus?: boolean;
	variant?: "page" | "capture";
	submitLabel?: string;
	onCancel?: () => void;
}) {
	const id = useId();
	const tags = useMemo(() => parseMemoTags(value), [value]);
	const length = Array.from(value).length;
	const canSubmit = value.trim().length > 0 && length <= MEMO_TEXT_LIMIT && !submitting;
	const overLimit = length > MEMO_TEXT_LIMIT;
	const capture = variant === "capture";

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || isIMEComposing(event)) return;
		event.preventDefault();
		if (canSubmit) onSubmit(value);
	};

	const textarea = (
		<textarea
			id={id}
			value={value}
			rows={capture ? 5 : 3}
			autoFocus={autoFocus}
			disabled={disabled}
			lang="zh"
			aria-label="速记内容"
			aria-describedby={`${id}-hint`}
			placeholder={PAGE_PLACEHOLDER}
			readOnly={disabled}
			onChange={(event) => onChange(event.target.value)}
			onKeyDown={onKeyDown}
		/>
	);

	const foot = (
		<div className={capture ? "memo-capture-foot" : "memo-composer-foot"}>
			<div className="memo-composer-meta">
				{tags.length ? tags.map((tag) => <span key={tag} className="memo-tag">#{tag}</span>) : (
					<span id={`${id}-hint`} className="memo-composer-hint">
						Enter 保存 · Shift+Enter 换行 · 不用选知识库、不用选类型
					</span>
				)}
				{length > 9000 ? <span className="memo-counter" role={overLimit ? "alert" : undefined}>{length} / {MEMO_TEXT_LIMIT}</span> : null}
			</div>
			<div className="memo-capture-actions">
				{onCancel ? <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>取消</Button> : null}
				<Button type="button" size="sm" disabled={!canSubmit} onClick={() => onSubmit(value)}>
					{submitting ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
					{submitLabel}
				</Button>
			</div>
		</div>
	);

	if (capture) return <>{textarea}{foot}</>;
	return <section className="memo-composer" aria-label="写一条速记">{textarea}{foot}</section>;
}
