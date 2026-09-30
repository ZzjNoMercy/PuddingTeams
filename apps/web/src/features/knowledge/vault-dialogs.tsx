"use client";

import { useState } from "react";
import { LoaderIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { revokeKnowledgeBinding, updateKnowledgeDescription, type KnowledgeBindingSummary } from "@/lib/api";

/**
 * 知识库轻量弹窗：编辑描述 / 移除绑定确认。沿用 CreateVaultDialog 的 vault-create 视觉
 * （同色板、同字段与页脚样式），避免退化成浏览器原生 prompt/confirm。
 */

const DESCRIPTION_LIMIT = 500;

export function VaultDescriptionDialog({ binding, open, onOpenChange, onSaved, onError }: {
	binding: KnowledgeBindingSummary | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 保存成功后回调（父级刷新列表并清空行内错误）。 */
	onSaved?: () => void;
	/** 保存失败时把错误抛回父级的行内错误位（null = 清空）。 */
	onError?: (message: string | null) => void;
}) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [wasOpen, setWasOpen] = useState(open);

	// 打开沿 render-adjust 模式重置编辑态，避免在 effect 里同步 setState。
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setValue(binding?.description ?? "");
			setError(null);
			setBusy(false);
		}
	}

	const submit = async () => {
		if (!binding || busy) return;
		setBusy(true);
		setError(null);
		try {
			await updateKnowledgeDescription(binding, value.trim());
			onOpenChange(false);
			onError?.(null);
			onSaved?.();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onError?.(message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
			<DialogContent className="vault-create vault-create-compact sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle>编辑描述</DialogTitle>
					<DialogDescription>{binding?.name ?? ""}</DialogDescription>
				</DialogHeader>
				<form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
					<label className="vault-create-field">
						<span className="sr-only">知识库描述</span>
						<textarea
							value={value}
							onChange={(event) => setValue(event.target.value)}
							placeholder="记录这里存什么、什么时候用，例如：与 LLM、Agent、Harness 等 AI 应用相关的知识合集。"
							maxLength={DESCRIPTION_LIMIT}
							disabled={busy}
							autoFocus
						/>
						<span className="vault-create-muted self-end">{value.length}/{DESCRIPTION_LIMIT}</span>
					</label>
					{error ? <div role="alert" className="vault-create-error">{error}</div> : null}
					<div className="vault-create-footer">
						<Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
						<Button type="submit" disabled={busy || value.trim() === (binding?.description ?? "")}>
							{busy ? <><LoaderIcon size={15} className="animate-spin" />正在保存…</> : "保存"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function VaultUnbindDialog({ binding, open, onOpenChange, onUnbound }: {
	binding: KnowledgeBindingSummary | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 移除成功后回调（父级跳回知识库首页）。 */
	onUnbound: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [wasOpen, setWasOpen] = useState(open);

	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setError(null);
			setBusy(false);
		}
	}

	const submit = async () => {
		if (!binding || busy) return;
		setBusy(true);
		setError(null);
		try {
			await revokeKnowledgeBinding(binding);
			onOpenChange(false);
			onUnbound();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
			<DialogContent className="vault-create vault-create-compact sm:max-w-[460px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<TriangleAlertIcon size={18} className="text-destructive" />移除绑定
					</DialogTitle>
					<DialogDescription>
						从 Teams 移除“{binding?.name ?? ""}”后，本地将不再同步这个 Wiki。磁盘上的 Markdown 文件不会被删除，之后可以重新接入。
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
					{error ? <div role="alert" className="vault-create-error">{error}</div> : null}
					<div className="vault-create-footer vault-create-footer-tight">
						<Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
						<Button type="submit" variant="destructive" disabled={busy}>
							{busy ? <><LoaderIcon size={15} className="animate-spin" />正在移除…</> : "移除绑定"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
