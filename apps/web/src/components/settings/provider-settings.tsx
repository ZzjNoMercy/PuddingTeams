"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDownIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
	ApiConflictError,
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
	defaultKnown,
	defaultPending,
	onSetDefault,
	onChanged,
}: {
	provider: ProviderSummary;
	defaultModelRef?: string;
	defaultKnown: boolean;
	defaultPending: boolean;
	onSetDefault: (provider: string, model: string) => Promise<void>;
	onChanged: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showModels, setShowModels] = useState(false);
	const [models, setModels] = useState<ModelSummary[] | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [loadingModels, setLoadingModels] = useState(false);
	const modelsRequestId = useRef(0);
	const [apiKey, setApiKey] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);

	const loadModels = async () => {
		const requestId = ++modelsRequestId.current;
		setLoadingModels(true);
		setModelsError(null);
		try {
			const result = await listProviderModels(provider.id);
			if (requestId === modelsRequestId.current) setModels(result);
		} catch (err) {
			if (requestId === modelsRequestId.current) setModelsError(err instanceof Error ? err.message : String(err));
		} finally {
			if (requestId === modelsRequestId.current) setLoadingModels(false);
		}
	};
	const toggleModels = () => {
		setShowModels((current) => !current);
		if (!showModels && models === null) void loadModels();
	};

	const save = async () => {
		const key = apiKey.trim();
		if (!key || busyRef.current) return;
		busyRef.current = true;
		modelsRequestId.current += 1;
		setLoadingModels(false);
		setBusy(true);
		try {
			const availableCount = await setProviderKey(provider.id, key);
			toast.success(`${provider.name} 已配置，可用模型 ${availableCount} 个`);
			setApiKey("");
			setExpanded(false);
			window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
			onChanged();
			if (showModels) void loadModels();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const remove = async () => {
		if (busyRef.current) return;
		busyRef.current = true;
		modelsRequestId.current += 1;
		setLoadingModels(false);
		setBusy(true);
		try {
			await deleteProviderKey(provider.id);
			toast.success(`已删除 ${provider.name} 的 API key`);
			setConfirmingDelete(false);
			window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
			onChanged();
			if (showModels) void loadModels();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	return (
		<div className={cn("provider-row", showModels && "is-open")}>
			<button type="button" className="provider-row-summary" onClick={() => void toggleModels()}>
				<span className="provider-row-identity">
					<span className="provider-row-indicator" data-configured={provider.configured ? "true" : "false"} />
					<span className="provider-row-name">{provider.name}</span>
				</span>
				<span className="provider-row-status">
					{provider.configured ? `已配置 · ${provider.modelCount} 模型` : "未配置"}
				</span>
				<ChevronDownIcon className="provider-row-chevron" aria-hidden="true" />
			</button>
			{showModels && (
				<div className="provider-row-detail">
					<div className="provider-connection">
						{provider.baseUrl ? (
							<div className="provider-connection-item">
								<span>服务端点</span>
								<code title={provider.baseUrl}>{provider.baseUrl}</code>
							</div>
						) : null}
						<div className="provider-connection-item">
							<span>认证方式</span>
							<strong>{provider.oauth ? "OAuth" : provider.configured ? "API Key · 已配置" : "API Key · 未配置"}</strong>
						</div>
					</div>
					<div className="provider-row-actions" aria-label="凭证操作">
						{confirmingDelete ? (
							<div className="provider-key-confirm">
								<span>删除此 key？</span>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="provider-key-action provider-key-action-danger is-confirm"
									disabled={busy}
									onClick={remove}
								>
									<Trash2Icon aria-hidden="true" />
									确认删除
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="provider-key-action provider-key-cancel"
									onClick={() => setConfirmingDelete(false)}
								>
									取消
								</Button>
							</div>
						) : (
							<>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="provider-key-action provider-key-action-primary"
									onClick={() => setExpanded((v) => !v)}
								>
									{expanded ? <ChevronDownIcon className="provider-key-collapse-icon" aria-hidden="true" /> : <KeyRoundIcon aria-hidden="true" />}
									{expanded ? "收起" : provider.configured ? "替换 key" : "配置 key"}
								</Button>
								{provider.configured ? (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										className="provider-key-action provider-key-action-danger"
										onClick={() => setConfirmingDelete(true)}
									>
										<Trash2Icon aria-hidden="true" />
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
						{loadingModels ? (
							<p className="py-1 text-xs text-muted-foreground">加载中…</p>
						) : modelsError ? (
							<div role="alert" className="flex items-center gap-2 py-1 text-xs text-destructive"><span>模型列表加载失败：{modelsError}</span><Button type="button" size="sm" variant="outline" onClick={() => void loadModels()}>重试</Button></div>
						) : models === null ? null : models.length === 0 ? (
						<p className="py-1 text-xs text-muted-foreground">无模型</p>
					) : (
						<div className="provider-models">
							<div className="provider-models-label">可用模型</div>
							{models.map((m) => {
								const isDefault = m.id === defaultModelRef;
								return (
									<div key={m.id} className="provider-model-row">
										<span className="provider-model-copy">
											<strong>{m.name}</strong>
											<small>{m.id}{m.reasoning ? " · 支持思考" : ""}</small>
										</span>
										{!defaultKnown ? <span className="text-xs text-muted-foreground">{defaultPending ? "正在设置默认模型…" : "默认状态未加载"}</span> : isDefault ? (
											<span className="provider-default-badge">默认</span>
										) : (
											<Button type="button" size="sm" variant="ghost" disabled={defaultPending} onClick={() => void onSetDefault(provider.id, m.id.split("/").slice(1).join("/"))}>
												设为默认
											</Button>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export function ProviderSettings() {
	const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
	const [providersError, setProvidersError] = useState<string | null>(null);
	const [customProviders, setCustomProviders] = useState<CustomProviderRecord[]>([]);
	const [customRevision, setCustomRevision] = useState<string | null>(null);
	const [customProvidersError, setCustomProvidersError] = useState<string | null>(null);
	const [customProvidersConfirmed, setCustomProvidersConfirmed] = useState(false);
	const [defaultModelRef, setDefaultModelRef] = useState<string | undefined>();
	const [defaultKnown, setDefaultKnown] = useState(false);
	const [defaultPending, setDefaultPending] = useState(false);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingCustom, setEditingCustom] = useState<CustomProviderRecord | undefined>();
	const [deletingCustom, setDeletingCustom] = useState<string | null>(null);
	const [deleteRevision, setDeleteRevision] = useState<string | null>(null);
	const [dialogRevision, setDialogRevision] = useState<string | null>(null);
	const [busyDelete, setBusyDelete] = useState(false);
	const busyDeleteRef = useRef(false);
	const [showMore, setShowMore] = useState(false);
	const refreshRequestId = useRef(0);
	const settingsRequestId = useRef(0);
	const defaultMutationRef = useRef(false);

	const refresh = useCallback(async () => {
		const requestId = ++refreshRequestId.current;
		// The prior catalog cannot authorize key mutations while a new snapshot is unknown.
		setProviders(null);
		setProvidersError(null);
		setCustomProvidersConfirmed(false);
		const settingsId = defaultMutationRef.current ? null : ++settingsRequestId.current;
		const [providerResult, customResult, settingsResult] = await Promise.allSettled([listProviders(), listCustomProviders(), getSettings()]);
		if (requestId !== refreshRequestId.current) return;
		if (providerResult.status === "fulfilled") { setProviders(providerResult.value); setProvidersError(null); }
		else { setProviders(null); setProvidersError(providerResult.reason instanceof Error ? providerResult.reason.message : String(providerResult.reason)); }
		if (customResult.status === "fulfilled") { setCustomProviders(customResult.value.providers); setCustomRevision(customResult.value.revision); setCustomProvidersError(null); setCustomProvidersConfirmed(true); }
		else { setCustomProvidersError(customResult.reason instanceof Error ? customResult.reason.message : String(customResult.reason)); setCustomProvidersConfirmed(false); }
		if (settingsId === null || settingsId !== settingsRequestId.current || defaultMutationRef.current) return;
		if (settingsResult.status === "fulfilled") {
			setDefaultModelRef(defaultRef(settingsResult.value.defaultProvider, settingsResult.value.defaultModel));
			setDefaultKnown(true);
			setSettingsError(null);
		} else {
			setDefaultKnown(false);
			setSettingsError(settingsResult.reason instanceof Error ? settingsResult.reason.message : String(settingsResult.reason));
		}
	}, []);

	useEffect(() => {
		const timer = setTimeout(() => void refresh(), 0);
		return () => { clearTimeout(timer); refreshRequestId.current += 1; settingsRequestId.current += 1; };
	}, [refresh]);

	const setDefault = async (provider: string, model: string) => {
		if (defaultMutationRef.current) return;
		defaultMutationRef.current = true;
		const settingsId = ++settingsRequestId.current;
		setDefaultPending(true);
		setDefaultKnown(false);
		let submitted = false;
		try {
			await setDefaultModel(provider, model);
			submitted = true;
			const settings = await getSettings();
			if (settingsId !== settingsRequestId.current) return;
			setDefaultModelRef(defaultRef(settings.defaultProvider, settings.defaultModel));
			setDefaultKnown(true);
			setSettingsError(null);
			if (settings.defaultProvider !== provider || settings.defaultModel !== model) throw new Error("回读的默认模型与提交值不一致");
			toast.success("已设为默认模型");
		} catch (err) {
			if (submitted) {
				setSettingsError(err instanceof Error ? err.message : String(err));
				toast.warning("默认模型已提交，但回读未确认；请重试加载检查当前值");
			} else {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		} finally {
			defaultMutationRef.current = false;
			setDefaultPending(false);
			if (!submitted) void refresh();
		}
	};

	const removeCustom = async (id: string) => {
		if (!customProvidersConfirmed || !deleteRevision || busyDeleteRef.current) return;
		busyDeleteRef.current = true;
		setBusyDelete(true);
		try {
			const outcome = await deleteCustomProvider(id, deleteRevision);
			if (outcome.recoveryPending) toast.warning(`自定义 provider「${id}」已删除，清理将在重启时确认`);
			else toast.success(`自定义 provider「${id}」已删除（含其凭证）`);
			setDeletingCustom(null);
			window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
			refresh();
		} catch (err) {
			if (err instanceof ApiConflictError) { setDeletingCustom(null); void refresh(); }
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			busyDeleteRef.current = false;
			setBusyDelete(false);
		}
	};

	const keyword = filter.trim().toLowerCase();
	const configured = (providers ?? []).filter((provider) => provider.configured);
	const unconfigured = (providers ?? []).filter((provider) => !provider.configured);
	const available = unconfigured
		.filter((provider) => !keyword || provider.id.toLowerCase().includes(keyword) || provider.name.toLowerCase().includes(keyword));
	const editingCustomChanged = editingCustom !== undefined
		&& JSON.stringify(customProviders.find((provider) => provider.id === editingCustom.id)) !== JSON.stringify(editingCustom);
	const customDialogIssue = !customProvidersConfirmed
		? "Provider 列表尚未确认，请先重试加载。"
		: dialogRevision !== customRevision
			? "Provider 目录已变化，请关闭弹窗后重新打开。"
		: editingCustomChanged
			? "正在编辑的 Provider 已变化，请关闭后重新打开最新条目。"
			: null;

	return (
		<div className={cn("provider-settings flex min-h-0 flex-1 flex-col gap-3")}>
			{providersError || customProvidersError || settingsError ? <div role="alert" className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"><p>{providersError ? `Provider 列表加载失败：${providersError}。` : ""}{customProvidersError ? `自定义 Provider 加载失败：${customProvidersError}。` : ""}{settingsError ? `默认模型状态加载失败：${settingsError}。` : ""}</p><Button type="button" size="sm" variant="outline" className="mt-2" disabled={defaultPending} onClick={() => void refresh()}>重试加载</Button></div> : null}
			<div className="provider-group">
				<div className="provider-group-label">已配置</div>
				{providers === null ? (
					<p className="provider-empty">{providersError ? "Provider 列表暂不可用。" : "加载中…"}</p>
				) : configured.length === 0 ? (
					<p className="provider-empty">尚未配置 Provider，可从下方添加。</p>
				) : (
					configured.map((provider) => (
						<ProviderRow
							key={provider.id}
							provider={provider}
							defaultModelRef={defaultModelRef}
							defaultKnown={defaultKnown}
							defaultPending={defaultPending}
							onSetDefault={setDefault}
							onChanged={refresh}
						/>
					))
				)}
			</div>
			<button
				type="button"
				className="provider-more-toggle"
				aria-expanded={showMore}
				onClick={() => setShowMore((value) => !value)}
			>
				<span>更多 Provider</span>
				<span className="provider-more-meta">{providers === null ? providersError ? "加载失败" : "加载中" : `${unconfigured.length} 个可配置`}</span>
				<ChevronDownIcon aria-hidden="true" />
			</button>
			{showMore ? (
				<div className="provider-more-panel">
					<Input
						placeholder="搜索 Provider…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="provider-filter h-9 text-xs"
					/>
					<div className="custom-provider-card rounded-md px-3 py-2">
						<div className="flex items-center gap-2">
							<span className="flex-1 text-sm text-muted-foreground">
								自定义 Provider（OpenAI-compatible 端点，{customProvidersError ? "加载失败" : customProvidersConfirmed ? customProviders.length : "加载中"}）
							</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={!customProvidersConfirmed || busyDelete}
								onClick={() => {
									setEditingCustom(undefined);
									setDialogRevision(customRevision);
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
												<Button type="button" size="sm" variant="destructive" disabled={busyDelete || !customProvidersConfirmed} onClick={() => void removeCustom(p.id)}>
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
													disabled={!customProvidersConfirmed || busyDelete}
													onClick={() => {
													setEditingCustom(p);
													setDialogRevision(customRevision);
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
													disabled={!customProvidersConfirmed || busyDelete}
													onClick={() => { setDeleteRevision(customRevision); setDeletingCustom(p.id); }}
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
					<div className="provider-list min-h-0 flex-1">
						{available.length === 0 ? (
							<p className="py-8 text-center text-xs text-muted-foreground">
								{providers === null ? providersError ? "Provider 列表暂不可用。" : "加载中…" : keyword ? "没有匹配的 Provider" : "没有更多 Provider"}
							</p>
						) : (
							available.map((p) => (
								<ProviderRow
									key={p.id}
									provider={p}
									defaultModelRef={defaultModelRef}
									defaultKnown={defaultKnown}
									defaultPending={defaultPending}
									onSetDefault={setDefault}
									onChanged={refresh}
								/>
							))
						)}
					</div>
				</div>
			) : null}
			{dialogOpen ? <CustomProviderDialog
				open
				onOpenChange={setDialogOpen}
				editing={editingCustom}
				catalogConfirmed={customDialogIssue === null}
				expectedRevision={dialogRevision}
				catalogIssue={customDialogIssue}
				existingProviderIds={customProviders.map((provider) => provider.id)}
				onConflict={() => void refresh()}
				onSaved={refresh}
			/> : null}
		</div>
	);
}
