"use client";

import { useState } from "react";
import { LoaderIcon, PlusIcon, RefreshCwIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	discoverProviderModels,
	MODELS_CHANGED_EVENT,
	setProviderKey,
	testProviderConnection,
	upsertCustomProvider,
} from "@/lib/api";
import type { CustomModelInput, CustomProviderRecord } from "@/lib/types";

/**
 * 自定义 OpenAI-compatible Provider 编辑弹窗（借鉴 PuddingClaw 的 provider
 * 详情页：API 地址 + 模型清单 + 连通性测试 + 模型发现是显式动作）。
 * 保存写 pi models.json；API key 单独走 pi 凭证存储（不进 models.json）。
 */

const API_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "openai-completions", label: "openai-completions（Chat Completions，最常见）" },
	{ value: "openai-responses", label: "openai-responses（Responses API）" },
	{ value: "anthropic-messages", label: "anthropic-messages（Claude 兼容）" },
];

interface ModelRow extends CustomModelInput {
	_key: number;
}

let rowKey = 0;
function toRows(models: CustomModelInput[]): ModelRow[] {
	return models.map((m) => ({ ...m, _key: ++rowKey }));
}

export function CustomProviderDialog({
	open,
	onOpenChange,
	editing,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 编辑已有 provider 时传入；新增为 undefined。 */
	editing?: CustomProviderRecord;
	onSaved: () => void;
}) {
	const [id, setId] = useState(editing?.id ?? "");
	const [name, setName] = useState(editing?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
	const [api, setApi] = useState(editing?.api ?? "openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<ModelRow[]>(toRows(editing?.models ?? []));
	const [busy, setBusy] = useState<"test" | "discover" | "save" | null>(null);

	const canTest = baseUrl.trim().length > 0 && busy === null;

	const test = async () => {
		setBusy("test");
		try {
			const result = await testProviderConnection({
				baseUrl: baseUrl.trim(),
				...(apiKey.trim() ? { apiKey: apiKey.trim() } : editing ? { providerId: editing.id } : {}),
			});
			if (result.ok) toast.success(`连接成功（${result.latencyMs}ms）`);
			else toast.error(`连接失败：${result.error ?? "未知错误"}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const discover = async () => {
		setBusy("discover");
		try {
			const result = await discoverProviderModels({
				baseUrl: baseUrl.trim(),
				...(apiKey.trim() ? { apiKey: apiKey.trim() } : editing ? { providerId: editing.id } : {}),
			});
			if (!result.ok) {
				toast.error(`发现失败：${result.error ?? "未知错误"}`);
				return;
			}
			const existing = new Set(models.map((m) => m.id));
			const added = result.models.filter((m) => !existing.has(m.id));
			if (added.length === 0) {
				toast.info(`拉到 ${result.models.length} 个模型，没有新增（都已在清单里）`);
				return;
			}
			setModels([...models, ...toRows(added.map((m) => ({ id: m.id, name: m.name ?? m.id })))]);
			toast.success(`新增 ${added.length} 个模型（共拉取 ${result.models.length} 个）`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const save = async () => {
		const providerId = (editing?.id ?? id).trim();
		const cleanModels: CustomModelInput[] = models
			.filter((m) => m.id.trim())
			.map((m) => ({
				id: m.id.trim(),
				...(m.name?.trim() ? { name: m.name.trim() } : {}),
				reasoning: m.reasoning === true,
				...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
				...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
			}));
		setBusy("save");
		try {
			await upsertCustomProvider(providerId, {
				name: name.trim(),
				baseUrl: baseUrl.trim(),
				api,
				models: cleanModels,
			});
			if (apiKey.trim()) {
				await setProviderKey(providerId, apiKey.trim());
			}
			toast.success(`自定义 provider「${name.trim() || providerId}」已保存`);
			window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
			onOpenChange(false);
			onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const updateRow = (key: number, patch: Partial<ModelRow>) => {
		setModels((rows) => rows.map((r) => (r._key === key ? { ...r, ...patch } : r)));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{editing ? `编辑自定义 Provider「${editing.id}」` : "添加自定义 Provider"}</DialogTitle>
					<DialogDescription>
						接入任意 OpenAI-compatible 端点（如 vLLM / Ollama / 网关）。保存后该 provider
						及其模型进入全局模型目录，manager 与 worker 都可选。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="grid grid-cols-2 gap-2">
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">ID（小写字母/数字/连字符）</span>
							<Input
								value={id}
								disabled={Boolean(editing)}
								placeholder="如 my-vllm"
								className="h-8 font-mono text-xs"
								onChange={(e) => setId(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">显示名</span>
							<Input value={name} placeholder="如 公司内网 vLLM" className="h-8 text-xs" onChange={(e) => setName(e.target.value)} />
						</label>
					</div>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">Base URL</span>
						<Input
							value={baseUrl}
							placeholder="https://host/v1"
							className="h-8 font-mono text-xs"
							onChange={(e) => setBaseUrl(e.target.value)}
						/>
					</label>
					<div className="grid grid-cols-2 gap-2">
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">调用协议（api）</span>
							<Select value={api} onValueChange={setApi}>
								<SelectTrigger className="h-8 w-full text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{API_OPTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</label>
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">API Key（可选，保存时写入凭证）</span>
							<Input
								type="password"
								value={apiKey}
								placeholder={editing ? "留空则不改动已存 key" : "sk-..."}
								autoComplete="off"
								className="h-8 font-mono text-xs"
								onChange={(e) => setApiKey(e.target.value)}
							/>
						</label>
					</div>

					<div className="flex items-center gap-2">
						<span className="flex-1 text-sm text-muted-foreground">模型清单（{models.length}）</span>
						<Button type="button" size="sm" variant="outline" disabled={!canTest} onClick={() => void test()}>
							{busy === "test" ? <LoaderIcon className="size-3.5 animate-spin" /> : <ZapIcon className="size-3.5" />}
							测试连接
						</Button>
						<Button type="button" size="sm" variant="outline" disabled={!canTest} onClick={() => void discover()}>
							{busy === "discover" ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
							发现模型
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setModels([...models, { id: "", _key: ++rowKey }])}
						>
							<PlusIcon className="size-3.5" />
							手填模型
						</Button>
					</div>

					{models.length === 0 ? (
						<p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
							还没有模型。点「发现模型」从接口拉取，或「手填模型」直接登记模型 ID。
						</p>
					) : (
						<div className="flex flex-col gap-1.5">
							{models.map((m) => (
								<div key={m._key} className="flex items-center gap-1.5">
									<Input
										value={m.id}
										placeholder="模型 ID *"
										className="h-8 flex-1 font-mono text-xs"
										onChange={(e) => updateRow(m._key, { id: e.target.value })}
									/>
									<Input
										value={m.name ?? ""}
										placeholder="显示名"
										className="h-8 w-28 text-xs"
										onChange={(e) => updateRow(m._key, { name: e.target.value })}
									/>
									<Input
										type="number"
										value={m.contextWindow ?? ""}
										placeholder="上下文"
										title="上下文窗口（tokens）"
										className="h-8 w-24 text-xs"
										onChange={(e) => updateRow(m._key, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
									/>
									<label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title="推理（thinking）模型">
										<input
											type="checkbox"
											checked={m.reasoning === true}
											onChange={(e) => updateRow(m._key, { reasoning: e.target.checked })}
											className="size-3.5 accent-foreground"
										/>
										思考
									</label>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() => setModels((rows) => rows.filter((r) => r._key !== m._key))}
									>
										<Trash2Icon className="size-3.5" />
									</Button>
								</div>
							))}
						</div>
					)}
				</div>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button
						type="button"
						disabled={busy !== null || (!editing && !id.trim()) || !name.trim() || !baseUrl.trim() || models.every((m) => !m.id.trim())}
						onClick={() => void save()}
					>
						{busy === "save" ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
						保存
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
