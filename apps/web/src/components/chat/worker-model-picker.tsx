"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BrainCircuitIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getWorkerRuntimeModel, getWorkerRuntimeModelOptions, setWorkerRuntimeModel, type WorkerRuntimeModelState } from "@/lib/api";
import type { DriverConfigOption } from "@/lib/types";
import { useModelCatalog } from "@/lib/model-catalog";

/** Mounted per Session: late responses cannot overwrite another conversation. */
export function WorkerModelPicker({ sessionId, workerName, disabled, onSavingChange }: {
	sessionId: string;
	workerName: string;
	disabled?: boolean;
	onSavingChange: (saving: boolean) => void;
}) {
	const catalog = useModelCatalog();
	const [state, setState] = useState<WorkerRuntimeModelState | null>(null);
	const [options, setOptions] = useState<DriverConfigOption[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [optionsError, setOptionsError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	const [pending, setPending] = useState(false);
	const active = useRef(false);
	const saving = useRef(false);
	useEffect(() => {
		active.current = true;
		let cancelled = false;
		void getWorkerRuntimeModel(sessionId).then((result) => {
			if (!cancelled) { setState(result); setError(null); }
		}).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
		void getWorkerRuntimeModelOptions(sessionId).then((items) => {
			if (!cancelled) { setOptions(items); setOptionsError(null); }
		}).catch((err: unknown) => { if (!cancelled) setOptionsError(err instanceof Error ? err.message : String(err)); });
		return () => { cancelled = true; active.current = false; onSavingChange(false); };
	}, [sessionId, retry, onSavingChange]);

	const change = async (patch: { model?: string | null; effort?: string | null }) => {
		if (!state || saving.current || disabled) return;
		saving.current = true;
		setPending(true);
		onSavingChange(true);
		try {
			const settings = await setWorkerRuntimeModel(sessionId, patch);
			if (active.current) {
				setState((current) => current ? { ...current, settings } : current);
				toast.success("已更新当前会话，下一条消息生效");
			}
		} catch (err) { if (active.current) toast.error(err instanceof Error ? err.message : String(err)); }
		finally {
			saving.current = false;
			if (active.current) { setPending(false); onSavingChange(false); }
		}
	};

	if (error) return <Button type="button" variant="ghost" className="model-picker-trigger h-8 px-2 text-xs text-destructive" title={error} onClick={() => setRetry((n) => n + 1)}>会话设置 · 重试</Button>;
	if (!state) return <Button type="button" variant="ghost" className="model-picker-trigger h-8 px-2 text-xs" disabled>读取会话设置…</Button>;
	if (!state.supported) return <a className="model-picker-trigger flex h-8 items-center px-2 text-xs text-muted-foreground" href={`/agents/config?name=${encodeURIComponent(workerName)}`} title="当前 Connector 尚未支持会话模型切换">Worker 配置</a>;
	const model = state.settings.model ?? state.defaults.model;
	const effort = state.settings.effort ?? state.defaults.effort;
	// Pi uses the same map/hook as Manager and Agent config. Native CLI
	// catalogs supply their own per-model map; capability enums only filter the
	// existing shared fallback, never define a separate model-to-effort table.
	const modelOptions = state.modelCatalog === "pi"
		? catalog.models?.map((item) => ({ value: item.id, label: item.name })) ?? null
		: options;
	const selected = modelOptions?.find((item) => item.value === model);
	const nativeSelected = options?.find((item) => model ? item.value === model : item.isDefault);
	const levelsFor = (ref?: string) => state.modelCatalog === "pi"
		? catalog.levelsFor(ref)
		: options?.find((item) => item.value === ref)?.effortLevels ?? catalog.levelsFor(ref).filter((level) => state.effortLevels.includes(level));
	const levels = state.modelCatalog === "pi" ? catalog.levelsFor(model) : nativeSelected?.effortLevels ?? levelsFor(model);
	const graded = state.modelCatalog !== "pi" || catalog.gradedFor(model);
	const modelError = state.modelCatalog === "pi" ? catalog.modelsError : optionsError;
	const locked = pending || disabled;
	const note = "仅当前会话；下一条消息生效，正在执行的回复保持原参数";
	return <>
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="ghost" className="model-picker-trigger h-8 w-auto gap-1 px-2 text-xs" disabled={locked} aria-busy={pending} aria-label={`Worker 模型：${model ?? "默认"}`} title={note}>
					<span className="max-w-44 truncate">{pending ? "切换中…" : selected?.label ?? model ?? "默认模型"}</span><ChevronDownIcon className="size-3.5 opacity-55" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="model-picker-menu max-h-80 overflow-y-auto" align="start" sideOffset={8}>
				<DropdownMenuItem className="model-picker-item" onSelect={() => void change({ model: null, effort: null })}>恢复 Worker 默认{!state.settings.model && !state.settings.effort ? <CheckIcon className="ml-auto size-4" /> : null}</DropdownMenuItem>
				{modelOptions?.map((item) => <DropdownMenuItem key={item.value} className="model-picker-item" onSelect={() => void change({ model: item.value, ...(state.settings.effort && !levelsFor(item.value).includes(state.settings.effort) ? { effort: null } : {}) })}>
					<span className="min-w-0 flex-1 truncate">{item.label}</span>{item.value === model ? <CheckIcon className="model-picker-check size-4" /> : null}
				</DropdownMenuItem>)}
				{modelError ? <DropdownMenuItem title={modelError} onSelect={() => { catalog.reload(); setRetry((n) => n + 1); }}>模型列表读取失败 · 重试</DropdownMenuItem> : modelOptions === null ? <DropdownMenuItem disabled>正在读取模型…</DropdownMenuItem> : modelOptions.length === 0 ? <DropdownMenuItem disabled>暂无可选模型</DropdownMenuItem> : null}
				<div className="thinking-picker-note">下一条消息生效 · 仅当前会话</div>
			</DropdownMenuContent>
		</DropdownMenu>
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button type="button" variant="ghost" className="model-picker-trigger thinking-picker-trigger h-8 w-auto gap-1 px-2 text-xs" disabled={locked} aria-busy={pending} aria-label={`Worker effort：${effort ?? "默认"}`} title={note}>
					<BrainCircuitIcon className="size-3.5 opacity-55" /><span>{effort ?? "默认 effort"}</span><ChevronDownIcon className="size-3.5 opacity-55" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="model-picker-menu thinking-picker-menu" align="start" sideOffset={8}>
				<DropdownMenuItem className="model-picker-item" onSelect={() => void change({ effort: null })}>跟随 Worker 默认{!state.settings.effort ? <CheckIcon className="ml-auto size-4" /> : null}</DropdownMenuItem>
				{levels.map((level) => <DropdownMenuItem key={level} className="model-picker-item" onSelect={() => void change({ effort: level })}><span className="flex-1">{level}</span>{level === effort ? <CheckIcon className="model-picker-check size-4" /> : null}</DropdownMenuItem>)}
				<div className="thinking-picker-note">下一条消息生效 · 仅当前会话</div>
				{graded ? null : <div className="thinking-picker-note">该模型只支持思考开/关，各档在链路上无差别。</div>}
			</DropdownMenuContent>
		</DropdownMenu>
	</>;
}
