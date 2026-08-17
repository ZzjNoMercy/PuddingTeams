"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderIcon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon, Settings2Icon, TrashIcon, UserCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	ApiConflictError,
	createAgent,
	deleteAgent,
	listAgents,
	listExtensionCatalog,
	probeAgent,
	putAgentConnector,
	setAgentEnabled,
} from "@/lib/api";
import { agentRemoved } from "@/lib/avatars";
import type { AgentConfig, AgentProbeResult, CatalogEntry, ConflictRun } from "@/lib/types";
import { isConnectorProbe } from "@/lib/types";
import { ManagerAvatar, WorkerAvatar } from "@/components/chat/worker-avatar";
import { ConfigSchemaForm, SecretSchemaFields } from "@/components/agents/form-parts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 智能体管理页（Phase 5）：
 * - 列表含 pinned 内置 Pi manager（pinned 标识，无删除/禁用/探测按钮）；
 * - 所有 Agent 卡片统一跳转独立配置页（/agents/config?name=，§10.5）：
 *   pi Agent 用四分区草稿表单，其余 worker 用概览 + 基础接入/Extensions/运行状态；
 * - 启用/禁用走 PUT /enabled：禁用有进行中 Run 时 409，弹窗选择保留（keep）或
 *   取消（cancel），绝不静默杀死；
 * - 扩展统一从 /extensions 管理 Connector/Capability Extension 的安装/更新/卸载。
 */

function parseArgs(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** 探测健康判断：Connector probe 看 detected + 兼容性 + 认证，legacy 看 ok。 */
function probeHealthy(probe: AgentProbeResult): boolean {
	return isConnectorProbe(probe)
		? probe.detected && probe.compatibility !== "incompatible" && probe.authenticated !== false
		: probe.ok;
}

function probeSummary(probe: AgentProbeResult): string {
	if (isConnectorProbe(probe)) {
		if (!probe.extensionInstalled) return "扩展未安装";
		if (!probe.detected) return "CLI 未检测";
		if (probe.compatibility === "incompatible") return "不兼容";
		if (probe.authenticated === false) return "凭证无效";
		return "探测正常";
	}
	return probe.ok ? "探测健康" : `探测异常：${probe.error ?? `exit ${probe.exitCode}`}`;
}

/** Worker 分组跟随 Connector 目录来源标签；legacy / 未知 Connector 默认第三方。 */
function isBuiltinWorker(agent: AgentConfig, connectorCatalog: CatalogEntry[]): boolean {
	if (agent.pinned || !agent.connector) return false;
	const entry = connectorCatalog.find(
		(item) => item.manifest.kind === "connector" && item.manifest.id === agent.connector!.extensionId,
	);
	return entry?.origin === "builtin";
}

// ---- 创建智能体：Connector 接入（新模型）或命令接入（legacy） ----

function CreateAgentDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: () => void;
}) {
	const [mode, setMode] = useState<"connector" | "command">("connector");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
	const [extensionId, setExtensionId] = useState("");
	const [config, setConfig] = useState<Record<string, unknown>>({});
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [command, setCommand] = useState("");
	const [runArgs, setRunArgs] = useState("");
	const [probeArgs, setProbeArgs] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 打开时清空上次错误（渲染期间重置）；目录拉取留在 effect。
	const [prevOpen, setPrevOpen] = useState(open);
	if (open !== prevOpen) {
		setPrevOpen(open);
		if (open) setError(null);
	}
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		listExtensionCatalog("connector")
			.then((entries) => {
				if (!cancelled) setCatalog(entries);
			})
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
		return () => {
			cancelled = true;
		};
	}, [open]);

	const installed = (catalog ?? []).filter((e) => e.installed && e.loaded);
	const selected = installed.find((e) => e.manifest.id === extensionId);
	const contribution = selected?.manifest.kind === "connector" ? selected.manifest.connector : undefined;

	const reset = () => {
		setName("");
		setDescription("");
		setExtensionId("");
		setConfig({});
		setSecrets({});
		setCommand("");
		setRunArgs("");
		setProbeArgs("");
		setEnabled(true);
		setError(null);
	};

	const handleSubmit = async () => {
		setError(null);
		if (!name.trim()) return setError("名称必填");
		if (mode === "connector" && !contribution) return setError("请选择 Connector");
		if (mode === "command" && !command.trim()) return setError("命令必填");
		setSaving(true);
		try {
			const agent: AgentConfig =
				mode === "connector"
					? {
							name: name.trim(),
							description: description.trim(),
							connector: {
								extensionId,
								connectorId: contribution!.id,
								config,
							},
							enabled,
						}
					: {
							name: name.trim(),
							description: description.trim(),
							invoke: {
								type: "command",
								command: command.trim(),
								runArgs: parseArgs(runArgs),
								...(probeArgs.trim() ? { probeArgs: parseArgs(probeArgs) } : {}),
							},
							enabled,
						};
			await createAgent(agent);
			// 创建时填写的 secret：再走一次 PUT connector（明文提交，服务端只存 refs）。
			if (mode === "connector" && Object.keys(secrets).length > 0) {
				await putAgentConnector(name.trim(), {
					extensionId,
					connectorId: contribution!.id,
					config,
					secrets,
				});
			}
			toast.success(`「${name.trim()}」已创建${enabled ? "" : "（未启用）"}`);
			onOpenChange(false);
			reset();
			onCreated();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="worker-create max-h-[85vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>添加 Worker</DialogTitle>
					<DialogDescription>
						选接入方式、填名称和描述即可创建；Connector 的细项配置与探测、启用都在创建后的配置页完成。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-5">
					<div className="worker-create-segment" role="tablist" aria-label="接入方式">
						{(["connector", "command"] as const).map((m) => (
							<button
								key={m}
								type="button"
								role="tab"
								aria-selected={mode === m}
								onClick={() => setMode(m)}
								className={mode === m ? "is-active" : ""}
							>
								{m === "connector" ? "Connector 接入" : "命令接入（legacy）"}
							</button>
						))}
					</div>

					<label className="worker-create-field">
						<span className="worker-create-label">名称<span className="worker-create-required">*</span></span>
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 puddingclaw" />
						<span className="worker-create-hint">唯一标识，创建后不可改；委托工具名为 agent_&lt;名称&gt;__delegate。</span>
					</label>
					<label className="worker-create-field">
						<span className="worker-create-label">描述</span>
						<Textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="给 manager 看的 worker 能力描述，如「代码实现、调试与工程协作」"
							rows={2}
						/>
						<span className="worker-create-hint">manager 按描述和责任边界决定把活派给谁，写清擅长的事。</span>
					</label>

					{mode === "connector" ? (
						<>
							<label className="worker-create-field">
								<span className="worker-create-label">Connector Extension<span className="worker-create-required">*</span></span>
								<Select
									value={extensionId}
									onValueChange={(v) => {
										setExtensionId(v);
										setConfig({});
										setSecrets({});
									}}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="选择已安装的 Connector" />
									</SelectTrigger>
									<SelectContent>
										{installed.map((entry) => (
											<SelectItem key={entry.manifest.id} value={entry.manifest.id}>
												{entry.manifest.displayName}（{entry.manifest.id} v{entry.version}）
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<span className="worker-create-hint">
									{installed.length === 0
										? "没有已安装的 Connector，请先到「扩展」页安装。"
										: "决定 worker 的运行方式；选中后下方出现该 Connector 的配置项。"}
								</span>
							</label>
							{contribution ? (
								<section className="worker-create-section">
									<span className="worker-create-label">接入配置</span>
									<ConfigSchemaForm schema={contribution.configSchema} value={config} onChange={setConfig} />
									<SecretSchemaFields
										schema={contribution.secretSchema}
										configuredKeys={[]}
										values={secrets}
										onChange={setSecrets}
									/>
								</section>
							) : null}
						</>
					) : (
						<>
							<label className="worker-create-field">
								<span className="worker-create-label">命令<span className="worker-create-required">*</span></span>
								<Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="puddingclaw" />
								<span className="worker-create-hint">可执行文件名或绝对路径。</span>
							</label>
							<label className="worker-create-field">
								<span className="worker-create-label">run 参数</span>
								<Input value={runArgs} onChange={(e) => setRunArgs(e.target.value)} placeholder="run, --input-json, -, --json" />
								<span className="worker-create-hint">逗号或换行分隔。</span>
							</label>
							<label className="worker-create-field">
								<span className="worker-create-label">健康探测参数</span>
								<Input value={probeArgs} onChange={(e) => setProbeArgs(e.target.value)} placeholder="doctor, --json" />
								<span className="worker-create-hint">可选，默认 doctor --json。</span>
							</label>
						</>
					)}

					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={enabled}
							onChange={(e) => setEnabled(e.target.checked)}
							className="size-4 accent-foreground"
						/>
						创建后立即启用
						<span className="worker-create-hint">（勾选后 manager 才可派活给它）</span>
					</label>
					{error ? <p className="text-xs text-destructive">{error}</p> : null}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button type="button" onClick={() => void handleSubmit()} disabled={saving}>
							{saving ? "保存中…" : "创建"}
						</Button>
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ---- 主面板 ----

export function AgentsPane() {
	const router = useRouter();
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [connectorCatalog, setConnectorCatalog] = useState<CatalogEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [createOpen, setCreateOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<AgentConfig | null>(null);
	const [probing, setProbing] = useState<string | null>(null);
	const [probes, setProbes] = useState<Record<string, AgentProbeResult>>({});
	const [enableConflict, setEnableConflict] = useState<{ agent: AgentConfig; message: string; runs: ConflictRun[] } | null>(null);
	const [resolving, setResolving] = useState(false);

	const refresh = useCallback(() => {
		Promise.allSettled([listAgents(), listExtensionCatalog("connector")]).then(([agentResult, catalogResult]) => {
			if (agentResult.status === "fulfilled") setAgents(agentResult.value);
			else toast.error(agentResult.reason instanceof Error ? agentResult.reason.message : String(agentResult.reason));
			if (catalogResult.status === "fulfilled") setConnectorCatalog(catalogResult.value);
			else {
				// 目录不可用时安全回退：无法确认 builtin 标签的 Worker 都进入第三方组。
				setConnectorCatalog([]);
				const err: unknown = catalogResult.reason;
				toast.error(err instanceof Error ? err.message : String(err));
			}
				setLoading(false);
		});
	}, []);

	useEffect(() => refresh(), [refresh]);

	const handleProbe = useCallback(async (name: string) => {
		setProbing(name);
		try {
			const result = await probeAgent(name);
			setProbes((p) => ({ ...p, [name]: result }));
			if (!probeHealthy(result)) toast.error(`「${name}」${probeSummary(result)}`);
			else toast.success(`「${name}」${probeSummary(result)}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(null);
		}
	}, []);

	/** 启用/禁用（§9.3.6）：409 时弹窗列出受影响 Run，由用户选择 keep/cancel。 */
	const applyEnabled = useCallback(async (agent: AgentConfig, enabled: boolean, resolve?: "keep" | "cancel") => {
		setResolving(true);
		try {
			const res = await setAgentEnabled(agent.name, enabled, resolve);
			setAgents((prev) => prev.map((a) => (a.name === res.agent.name ? res.agent : a)));
			setEnableConflict(null);
			const { affectedSessions, reloadPending } = res.affectedSessions;
			toast.success(
				enabled
					? `「${agent.name}」已启用`
					: `「${agent.name}」已停用${
							affectedSessions > 0 ? `；已撤权 ${affectedSessions} 个会话，${reloadPending} 个将在当前回合结束后刷新` : ""
						}`,
			);
		} catch (err) {
			if (err instanceof ApiConflictError) {
				setEnableConflict({ agent, message: err.message, runs: err.payload.runs ?? [] });
			} else {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		} finally {
			setResolving(false);
		}
	}, []);

	const handleDelete = useCallback(async () => {
		if (!pendingDelete) return;
		try {
			await deleteAgent(pendingDelete.name);
			agentRemoved(pendingDelete.name);
			toast.success(`「${pendingDelete.name}」已删除`);
			refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
		setPendingDelete(null);
	}, [pendingDelete, refresh]);

	/** 所有 Agent 统一进独立配置页（§10.5）。 */
	const openManage = (agent: AgentConfig) => {
		router.push(`/agents/config?name=${encodeURIComponent(agent.name)}`);
	};

	const managers = agents.filter((agent) => agent.pinned);
	const workers = agents.filter((agent) => !agent.pinned);
	const builtinWorkers = workers.filter((agent) => isBuiltinWorker(agent, connectorCatalog));
	const thirdPartyWorkers = workers.filter((agent) => !isBuiltinWorker(agent, connectorCatalog));

	const renderAgentCard = (agent: AgentConfig) => {
		const description = agent.description;
		return (
			<div
				key={agent.name}
				className="ops-agent-card group relative flex min-h-40 flex-col rounded-2xl p-4 transition-all"
			>
				<button type="button" className="flex flex-1 flex-col text-left" onClick={() => openManage(agent)}>
					<span className="ops-agent-avatar"><WorkerAvatar name={agent.name} size={42} /></span>
					<div className="mt-3 min-w-0">
						<div className="flex items-baseline gap-2">
							<span className="truncate text-sm font-semibold tracking-tight">{agent.name}</span>
							<span className="truncate font-mono text-[11px] text-muted-foreground">{agent.connector?.connectorId ?? "command"}</span>
						</div>
						<p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground" title={description}>
							{description || "尚未填写角色描述"}
						</p>
					</div>
					<div className="mt-auto flex items-center gap-2 pt-4 text-[11px] text-muted-foreground">
						<span className="rounded-full bg-foreground/[0.035] px-2 py-0.5">{agent.enabled !== false ? "已启用" : "已停用"}</span>
						{probes[agent.name] ? <span>{probeSummary(probes[agent.name])}</span> : null}
					</div>
				</button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button type="button" size="icon" variant="ghost" aria-label={`管理 ${agent.name}`} className="absolute right-3 top-3 size-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
							<MoreHorizontalIcon className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-40">
						<DropdownMenuItem onSelect={() => openManage(agent)}><Settings2Icon />配置</DropdownMenuItem>
						<DropdownMenuItem disabled={probing === agent.name} onSelect={() => void handleProbe(agent.name)}><RefreshCwIcon />{probing === agent.name ? "探测中…" : "运行探测"}</DropdownMenuItem>
						<DropdownMenuItem disabled={resolving} onSelect={() => void applyEnabled(agent, !(agent.enabled !== false))}><UserCheckIcon />{agent.enabled !== false ? "停用" : "启用"}</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete(agent)}><TrashIcon />删除</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	};

	const renderManagerStrip = (agent: AgentConfig) => {
		const description = agent.description.replace(/^内置\s+Pi\s+manager[：:]?\s*/i, "");
		return <button key={agent.name} type="button" className="ops-manager-strip" onClick={() => openManage(agent)}>
			<ManagerAvatar size={48} className="ops-manager-avatar" />
			<div className="min-w-0 text-left">
				<div className="flex items-center gap-2"><span className="text-sm font-semibold">Manager</span><span className="ops-origin-pill">内置</span></div>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">{description || "理解目标、组织协作并汇总结果"}</p>
				<div className="mt-2 flex gap-2 text-[11px] text-muted-foreground"><span className="rounded-full bg-foreground/[0.035] px-2 py-0.5">固定角色</span><span className="rounded-full bg-foreground/[0.035] px-2 py-0.5">Pi Runtime</span></div>
			</div>
			<div className="ops-manager-meta"><span className="size-2 rounded-full bg-primary" /><span>可用</span></div>
		</button>;
	};

	return (
		<div className="ops-page flex h-full flex-col">
			<header className="ops-page-header">
				<div>
					<h1 className="ops-page-title">智能体</h1>
					<p className="ops-page-subtitle">管理协作角色、连接方式与运行状态</p>
				</div>
				<Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
					<PlusIcon className="size-4" />
					添加 Worker
				</Button>
			</header>
			<div className="ops-page-scroll flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[1180px] px-7 pb-10">
				{loading ? (
					<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : (
					<div className="flex flex-col gap-10 py-8">
						<section className="flex flex-col gap-3">
							<div className="flex items-baseline gap-2">
								<h2 className="text-sm font-semibold">Manager</h2>
								<span className="text-xs text-muted-foreground">理解消息、组织协作并汇总结果</span>
							</div>
							{managers.length > 0 ? (
								<div className="grid grid-cols-1 gap-3">
									{managers.map(renderManagerStrip)}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">未找到 Manager 配置。</p>
							)}
						</section>

						<section className="flex flex-col gap-9">
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-between gap-4">
									<div className="flex items-center gap-2"><h3 className="text-sm font-semibold">Worker（内置）</h3>
									<Badge variant="secondary">{builtinWorkers.length}</Badge>
									</div><span className="text-xs text-muted-foreground">随平台提供或由 Pi 衍生</span>
								</div>
								{builtinWorkers.length > 0 ? (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
										{builtinWorkers.map(renderAgentCard)}
									</div>
								) : (
									<p className="text-sm text-muted-foreground">暂无内置 Worker。</p>
								)}
							</div>
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-between gap-4">
									<div className="flex items-center gap-2"><h3 className="text-sm font-semibold">Worker（第三方）</h3>
									<Badge variant="secondary">{thirdPartyWorkers.length}</Badge>
									</div><span className="text-xs text-muted-foreground">通过 Connector 添加，默认归入此处</span>
								</div>
								{thirdPartyWorkers.length > 0 ? (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
										{thirdPartyWorkers.map(renderAgentCard)}
									</div>
								) : (
									<p className="text-sm text-muted-foreground">暂无第三方 Worker，点击右上角添加。</p>
								)}
							</div>
						</section>
					</div>
				)}
				</div>
			</div>

			<CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} />

			{/* 删除确认 */}
			<Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除智能体</DialogTitle>
						<DialogDescription>
							确定删除「{pendingDelete?.name}」吗？该 worker 将从 teams.json 移除，无法恢复。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingDelete(null)}>
							取消
						</Button>
						<Button type="button" variant="destructive" onClick={() => void handleDelete()}>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 禁用 409：进行中 Run 的保留/取消选择 */}
			<Dialog open={enableConflict !== null} onOpenChange={(open) => !open && setEnableConflict(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>停用「{enableConflict?.agent.name}」</DialogTitle>
						<DialogDescription>{enableConflict?.message}</DialogDescription>
					</DialogHeader>
					{enableConflict && enableConflict.runs.length > 0 ? (
						<div className="flex flex-col gap-1">
							<span className="text-sm text-muted-foreground">进行中 / 等待审批的 Run：</span>
							{enableConflict.runs.map((run) => (
								<div key={run.delegationId} className="font-mono text-xs text-muted-foreground">
									{run.delegationId} · {run.status} · 窗口 {run.windowId}
								</div>
							))}
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={resolving} onClick={() => setEnableConflict(null)}>
							取消
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={resolving || !enableConflict}
							onClick={() => enableConflict && void applyEnabled(enableConflict.agent, false, "keep")}
						>
							保留 Run 并停用
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={resolving || !enableConflict}
							onClick={() => enableConflict && void applyEnabled(enableConflict.agent, false, "cancel")}
						>
							取消 Run 并停用
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
