"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDownIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
	deleteCustomProvider,
	deleteProviderKey,
	getSettings,
	listCustomProviders,
	listProviderModels,
	listProviders,
	MODELS_CHANGED_EVENT,
	setDefaultModel,
	setProviderKey,
} from "@/lib/api";
import type { CustomProviderRecord, ModelSummary, ProviderSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CustomProviderDialog } from "./custom-provider-dialog";

function defaultRef(provider?: string, model?: string): string | undefined {
	return provider && model ? `${provider}/${model}` : undefined;
}

function ProviderRow({
	provider,
	defaultModelRef,
	onSetDefault,
	onChanged,
}: {
	provider: ProviderSummary;
	defaultModelRef?: string;
	onSetDefault: (provider: string, model: string) => Promise<void>;
	onChanged: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showModels, setShowModels] = useState(false);
	const [models, setModels] = useState<ModelSummary[] | null>(null);
	const [loadingModels, setLoadingModels] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [busy, setBusy] = useState(false);

	const toggleModels = async () => {
		const next = !showModels;
		setShowModels(next);
		if (next && models === null) {
			setLoadingModels(true);
			try {
				setModels(await listProviderModels(provider.id));
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				setModels([]);
			} finally {
				setLoadingModels(false);
			}
		}
	};

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
		<div className={cn("provider-row", showModels && "is-open")}>
			<button type="button" className="provider-row-summary" onClick={() => void toggleModels()}>
				<span className="provider-row-name">{provider.name}</span>
				<span className="provider-row-status">
					{provider.configured ? `已配置 · ${provider.modelCount} 模型` : "未配置"}
				</span>
				<ChevronDownIcon className="provider-row-chevron" aria-hidden="true" />
			</button>
			{showModels && (
				<div className="provider-row-detail">
					<div className="provider-row-actions">
						{confirmingDelete ? (
							<>
								<Button type="button" size="sm" variant="destructive" disabled={busy} onClick={remove}>确认删除</Button>
								<Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>取消</Button>
							</>
						) : (
							<>
								<Button type="button" size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
									{expanded ? "收起" : provider.configured ? "替换 key" : "配置 key"}
								</Button>
								{provider.configured ? (
									<Button type="button" size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmingDelete(true)}>
										删除 key
									</Button>
								) : null}
							</>
						)}
					</div>
					{expanded && (
						<form
							className="provider-key-form"
							onSubmit={(e) => {
								e.preventDefault();
								void save();
							}}
						>
							<Input type="password" placeholder={`${provider.name} API key`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" className="h-8 flex-1 text-xs" />
							<Button type="submit" size="sm" disabled={busy || !apiKey.trim()}>保存</Button>
						</form>
					)}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						{provider.baseUrl ? (
							<span title="API endpoint">
								端点：<span className="font-mono">{provider.baseUrl}</span>
							</span>
						) : null}
						<span>认证：{provider.oauth ? "OAuth" : provider.configured ? "API Key" : "未配置"}</span>
					</div>
					{loadingModels ? (
						<p className="py-1 text-xs text-muted-foreground">加载中…</p>
					) : models === null ? null : models.length === 0 ? (
						<p className="py-1 text-xs text-muted-foreground">无模型</p>
					) : (
						models.map((m) => {
							const isDefault = m.id === defaultModelRef;
							return (
								<div key={m.id} className="flex items-center gap-2 py-0.5">
									<span className="min-w-0 flex-1 truncate text-xs">
										<span className="font-medium">{m.name}</span>
										<span className="text-muted-foreground">
											{" · "}
											{m.id}
											{m.reasoning ? " · 思考" : ""}
										</span>
									</span>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={isDefault}
										onClick={() => void onSetDefault(provider.id, m.id.split("/").slice(1).join("/"))}
									>
										{isDefault ? "默认" : "设为默认"}
									</Button>
								</div>
							);
						})
					)}
				</div>
			)}
		</div>
	);
}

export function ProviderSettings() {
	const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
	const [customProviders, setCustomProviders] = useState<CustomProviderRecord[]>([]);
	const [defaultModelRef, setDefaultModelRef] = useState<string | undefined>();
	const [filter, setFilter] = useState("");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingCustom, setEditingCustom] = useState<CustomProviderRecord | undefined>();
	const [deletingCustom, setDeletingCustom] = useState<string | null>(null);
	const [busyDelete, setBusyDelete] = useState(false);

	const refresh = () => {
		listProviders()
			.then(setProviders)
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
		listCustomProviders()
			.then(setCustomProviders)
			.catch(() => undefined);
		getSettings()
			.then((s) => setDefaultModelRef(defaultRef(s.defaultProvider, s.defaultModel)))
			.catch(() => undefined);
	};

	useEffect(() => {
		refresh();
	}, []);

	const setDefault = async (provider: string, model: string) => {
		try {
			await setDefaultModel(provider, model);
			setDefaultModelRef(`${provider}/${model}`);
			toast.success("已设为默认模型");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	};

	const removeCustom = async (id: string) => {
		setBusyDelete(true);
		try {
			await deleteCustomProvider(id);
			toast.success(`自定义 provider「${id}」已删除（含其凭证）`);
			setDeletingCustom(null);
			window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
			refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyDelete(false);
		}
	};

	const keyword = filter.trim().toLowerCase();
	const visible = (providers ?? [])
		.filter((p) => !keyword || p.id.toLowerCase().includes(keyword) || p.name.toLowerCase().includes(keyword))
		.sort((a, b) => Number(b.configured) - Number(a.configured));

	return (
		<div className={cn("provider-settings flex min-h-0 flex-1 flex-col gap-3")}>
			<Input
				placeholder="过滤 provider…"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				className="provider-filter h-9 text-xs"
			/>
			<div className="custom-provider-card rounded-md border border-border px-3 py-2">
				<div className="flex items-center gap-2">
					<span className="flex-1 text-sm text-muted-foreground">
						自定义 Provider（OpenAI-compatible 端点，{customProviders.length}）
					</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => {
							setEditingCustom(undefined);
							setDialogOpen(true);
						}}
					>
						<PlusIcon className="size-3.5" />
						添加
					</Button>
				</div>
				{customProviders.length > 0 ? (
					<div className="mt-1 flex flex-col">
						{customProviders.map((p) => (
							<div key={p.id} className="flex items-center gap-2 py-1">
								<span className="min-w-0 flex-1 truncate text-xs">
									<span className="font-medium">{p.name}</span>
									<span className="text-muted-foreground">
										{" · "}
										{p.id} · {p.models.length} 模型
									</span>
								</span>
								{deletingCustom === p.id ? (
									<span className="flex items-center gap-1">
										<Button
											type="button"
											size="sm"
											variant="destructive"
											disabled={busyDelete}
											onClick={() => void removeCustom(p.id)}
										>
											确认删除
										</Button>
										<Button type="button" size="sm" variant="ghost" onClick={() => setDeletingCustom(null)}>
											取消
										</Button>
									</span>
								) : (
									<span className="flex items-center gap-1">
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onClick={() => {
												setEditingCustom(p);
												setDialogOpen(true);
											}}
										>
											<PencilIcon className="size-3.5" />
											编辑
										</Button>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											className="text-muted-foreground hover:text-destructive"
											onClick={() => setDeletingCustom(p.id)}
										>
											<Trash2Icon className="size-3.5" />
										</Button>
									</span>
								)}
							</div>
						))}
					</div>
				) : null}
			</div>
			<div className="provider-list min-h-0 flex-1 overflow-y-auto">
				{visible.length === 0 ? (
					<p className="py-8 text-center text-xs text-muted-foreground">
						{providers === null ? "加载中…" : "没有匹配的 provider"}
					</p>
				) : (
					visible.map((p) => (
						<ProviderRow
							key={p.id}
							provider={p}
							defaultModelRef={defaultModelRef}
							onSetDefault={setDefault}
							onChanged={refresh}
						/>
					))
				)}
			</div>
			<CustomProviderDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				editing={editingCustom}
				onSaved={refresh}
			/>
		</div>
	);
}
