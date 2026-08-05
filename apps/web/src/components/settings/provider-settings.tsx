"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	deleteProviderKey,
	listProviders,
	MODELS_CHANGED_EVENT,
	setProviderKey,
} from "@/lib/api";
import type { ProviderSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function ProviderRow({ provider, onChanged }: { provider: ProviderSummary; onChanged: () => void }) {
	const [expanded, setExpanded] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [busy, setBusy] = useState(false);

	const save = async () => {
		const key = apiKey.trim();
		if (!key || busy) return;
		setBusy(true);
		try {
			const availableCount = await setProviderKey(provider.id, key);
			toast.success(`${provider.name} 已配置，可用模型 ${availableCount} 个`);
			setApiKey("");
			setExpanded(false);
			window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await deleteProviderKey(provider.id);
			toast.success(`已删除 ${provider.name} 的 API key`);
			setConfirmingDelete(false);
			window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rounded-md px-3 py-2 hover:bg-muted/60">
			<div className="flex items-center gap-3">
				<span
					className={`size-1.5 shrink-0 rounded-full ${provider.configured ? "bg-green-500" : "bg-muted-foreground/30"}`}
				/>
				<span className="min-w-0 flex-1 truncate text-sm">{provider.name}</span>
				<span className="text-xs text-muted-foreground">{provider.modelCount} 模型</span>
				{provider.configured ? (
					confirmingDelete ? (
						<span className="flex items-center gap-1">
							<Button type="button" size="sm" variant="destructive" disabled={busy} onClick={remove}>
								确认删除
							</Button>
							<Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
								取消
							</Button>
						</span>
					) : (
						<span className="flex items-center gap-2">
							<span className="text-xs text-muted-foreground">已配置</span>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="text-muted-foreground hover:text-destructive"
								onClick={() => setConfirmingDelete(true)}
							>
								删除 key
							</Button>
						</span>
					)
				) : (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? "收起" : "配置 key"}
					</Button>
				)}
			</div>
			{expanded && !provider.configured && (
				<form
					className="mt-2 flex items-center gap-2 pl-4"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<Input
						type="password"
						placeholder={`${provider.name} API key`}
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						autoComplete="off"
						className="h-8 flex-1 text-xs"
					/>
					<Button type="submit" size="sm" disabled={busy || !apiKey.trim()}>
						保存
					</Button>
				</form>
			)}
		</div>
	);
}

export function ProviderSettings() {
	const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
	const [filter, setFilter] = useState("");

	const refresh = () => {
		listProviders()
			.then(setProviders)
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
	};

	useEffect(() => {
		refresh();
	}, []);

	const keyword = filter.trim().toLowerCase();
	const visible = (providers ?? []).filter(
		(p) => !keyword || p.id.toLowerCase().includes(keyword) || p.name.toLowerCase().includes(keyword),
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<Input
				placeholder="过滤 provider…"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				className="h-8 text-xs"
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{visible.length === 0 ? (
					<p className="py-8 text-center text-xs text-muted-foreground">
						{providers === null ? "加载中…" : "没有匹配的 provider"}
					</p>
				) : (
					visible.map((p) => <ProviderRow key={p.id} provider={p} onChanged={refresh} />)
				)}
			</div>
		</div>
	);
}
