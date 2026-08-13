"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderIcon, PlusIcon, RefreshCwIcon, TrashIcon, UserCheckIcon } from "lucide-react";
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
import { WorkerAvatar } from "@/components/chat/worker-avatar";
import { ConfigSchemaForm, SecretSchemaFields } from "@/components/agents/form-parts";
import { AgentManageDialog } from "@/components/agents/agent-manage-dialog";
import { ExtensionsPane } from "@/components/agents/extensions-pane";

/**
 * 智能体管理页（Phase 5）：
 * - 列表含 pinned 内置 Pi manager（pinned 标识，无删除/禁用/探测按钮）；
 * - pinned manager 与 pi worker 卡片跳转独立配置页（/agents/<name>，§10.5），
 *   其余 worker 进入三分区管理抽屉（§10.1）；
 * - 启用/禁用走 PUT /enabled：禁用有进行中 Run 时 409，弹窗选择保留（keep）或
 *   取消（cancel），绝不静默杀死；
 * - 「扩展目录」页签管理 Connector/Capability Extension 的安装/更新/卸载。
 */

function parseArgs(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** 探测健康判断：Connector probe 看 detected + 兼容性，legacy 看 ok。 */
function probeHealthy(probe: AgentProbeResult): boolean {
	return isConnectorProbe(probe) ? probe.detected && probe.compatibility !== "incompatible" : probe.ok;
}

function probeSummary(probe: AgentProbeResult): string {
	if (isConnectorProbe(probe)) {
		if (!probe.extensionInstalled) return "扩展未安装";
		if (!probe.detected) return "CLI 未检测";
		if (probe.compatibility === "incompatible") return "不兼容";
		return "探测正常";
	}
	return probe.ok ? "探测健康" : `探测异常：${probe.error ?? `exit ${probe.exitCode}`}`;
}

/** Enabled / health status lights: green = on, grey = off, red = probe failed. */
function StatusLights({ agent, probe }: { agent: AgentConfig; probe?: AgentProbeResult }) {
	return (
		<span className="flex items-center gap-1.5">
			<span
				className={`size-2 rounded-full ${agent.enabled !== false ? "bg-foreground" : "bg-muted-foreground/40"}`}
				title={agent.enabled !== false ? "已启用" : "已停用"}
			/>
			{probe ? (
				<span
					className={`size-2 rounded-full ${probeHealthy(probe) ? "bg-foreground" : "bg-destructive"}`}
					title={probeSummary(probe)}
				/>
			) : null}
		</span>
	);
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
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>添加 Worker</DialogTitle>
					<DialogDescription>
						Worker 按 Connector 标签归入内置或第三方；没有内置标签的接入默认归入第三方。创建后到管理抽屉完成配置、探测与启用。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-1">
						{(["connector", "command"] as const).map((m) => (
							<button
								key={m}
								type="button"
								onClick={() => setMode(m)}
								className={`rounded-md px-3 py-1 text-sm transition-colors ${
									mode === m ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"
								}`}
							>
								{m === "connector" ? "Connector 接入" : "命令接入（legacy）"}
							</button>
						))}
					</div>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">名称（唯一标识，用于委托工具 agent_&lt;名称&gt;__delegate）</span>
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 puddingclaw" />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">描述</span>
						<Textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="给 manager 看的 worker 能力描述"
							rows={2}
						/>
					</label>

					{mode === "connector" ? (
						<>
							<label className="flex flex-col gap-1 text-sm">
								<span className="text-muted-foreground">Connector Extension</span>
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
								{installed.length === 0 ? (
									<span className="text-xs text-muted-foreground/70">
										没有已安装的 Connector，请先到「扩展目录」安装。
									</span>
								) : null}
							</label>
							{contribution ? (
								<>
									<ConfigSchemaForm schema={contribution.configSchema} value={config} onChange={setConfig} />
									<SecretSchemaFields
										schema={contribution.secretSchema}
										configuredKeys={[]}
										values={secrets}
										onChange={setSecrets}
									/>
								</>
							) : null}
						</>
					) : (
						<>
							<label className="flex flex-col gap-1 text-sm">
								<span className="text-muted-foreground">命令（可执行文件或绝对路径）</span>
								<Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="puddingclaw" />
							</label>
							<label className="flex flex-col gap-1 text-sm">
								<span className="text-muted-foreground">run 参数（逗号或换行分隔）</span>
								<Input value={runArgs} onChange={(e) => setRunArgs(e.target.value)} placeholder="run, --input-json, -, --json" />
							</label>
							<label className="flex flex-col gap-1 text-sm">
								<span className="text-muted-foreground">健康探测参数（可选，默认 doctor --json）</span>
								<Input value={probeArgs} onChange={(e) => setProbeArgs(e.target.value)} placeholder="doctor, --json" />
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
						启用（勾选后 manager 才可派活给它）
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
	const [tab, setTab] = useState<"agents" | "extensions">("agents");
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [connectorCatalog, setConnectorCatalog] = useState<CatalogEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [manageAgent, setManageAgent] = useState<AgentConfig | null>(null);
	const [manageOpen, setManageOpen] = useState(false);
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

	const handleAgentChanged = useCallback((updated: AgentConfig) => {
		setAgents((prev) => prev.map((a) => (a.name === updated.name ? updated : a)));
		setManageAgent((prev) => (prev && prev.name === updated.name ? updated : prev));
	}, []);

	/** pinned manager 与 pi worker 进独立配置页；其余 worker 仍开三分区管理抽屉。 */
	const openManage = (agent: AgentConfig) => {
		if (agent.pinned || agent.connector?.connectorId === "pi") {
			router.push(`/agents/config?name=${encodeURIComponent(agent.name)}`);
			return;
		}
		setManageAgent(agent);
		setManageOpen(true);
	};

	const managers = agents.filter((agent) => agent.pinned);
	const workers = agents.filter((agent) => !agent.pinned);
	const builtinWorkers = workers.filter((agent) => isBuiltinWorker(agent, connectorCatalog));
	const thirdPartyWorkers = workers.filter((agent) => !isBuiltinWorker(agent, connectorCatalog));

	const renderAgentCard = (agent: AgentConfig) => {
		const description = agent.pinned
			? agent.description.replace(/^内置\s+Pi\s+manager[：:]?\s*/i, "")
			: agent.description;
		return (
			<div
				key={agent.name}
				role="button"
				tabIndex={0}
				onClick={() => openManage(agent)}
				onKeyDown={(e) => {
					if (e.key === "Enter") openManage(agent);
				}}
				className="flex cursor-pointer flex-col gap-2.5 rounded-lg bg-muted p-4 transition-colors hover:bg-accent"
			>
				<div className="flex items-start justify-between gap-2">
					<WorkerAvatar name={agent.name} size={56} />
					<StatusLights agent={agent} probe={probes[agent.name]} />
				</div>
				<div className="min-w-0">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-mono text-sm font-medium">{agent.name}</span>
						{agent.connector ? (
							<Badge variant="outline" className="shrink-0">
								{agent.connector.connectorId}
							</Badge>
						) : null}
					</div>
					<p className="mt-0.5 truncate text-xs text-muted-foreground" title={description}>
						{description || "（无描述）"}
					</p>
				</div>
				{/* pinned manager：无删除/禁用/探测入口（§10.5） */}
				{agent.pinned ? null : (
					<div
						className="mt-auto flex items-center gap-1 pt-1"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => handleProbe(agent.name)}
							disabled={probing === agent.name}
						>
							{probing === agent.name ? (
								<LoaderIcon className="size-3.5 animate-spin" />
							) : (
								<RefreshCwIcon className="size-3.5" />
							)}
							探测
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={resolving}
							onClick={() => void applyEnabled(agent, !(agent.enabled !== false))}
						>
							<UserCheckIcon className="size-3.5" />
							{agent.enabled !== false ? "停用" : "启用"}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="ml-auto"
							onClick={() => setPendingDelete(agent)}
						>
							<TrashIcon className="size-3.5" />
						</Button>
					</div>
				)}
			</div>
		);
	};

	if (tab === "extensions") {
		return (
			<div className="flex h-full flex-col">
				<PaneTabs tab={tab} onTab={setTab} />
				<ExtensionsPane />
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between pr-4">
				<PaneTabs tab={tab} onTab={setTab} />
				<Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
					<PlusIcon className="size-4" />
					添加 Worker
				</Button>
			</div>
			<div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 pb-4">
				{loading ? (
					<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : (
					<div className="flex flex-col gap-8 py-2">
						<section className="flex flex-col gap-3">
							<div className="flex items-baseline gap-2">
								<h2 className="text-sm font-semibold">Manager</h2>
								<span className="text-xs text-muted-foreground">负责理解消息、调度 Worker</span>
							</div>
							{managers.length > 0 ? (
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
									{managers.map(renderAgentCard)}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">未找到 Manager 配置。</p>
							)}
						</section>

						<section className="flex flex-col gap-5">
							<div className="flex items-baseline gap-2">
								<h2 className="text-sm font-semibold">Worker</h2>
								<span className="text-xs text-muted-foreground">接受 Manager 委派，执行具体任务并返回结果</span>
							</div>
							<div className="flex flex-col gap-3">
								<div className="flex items-center gap-2">
									<h3 className="text-xs font-medium text-muted-foreground">内置</h3>
									<Badge variant="secondary">{builtinWorkers.length}</Badge>
								</div>
								{builtinWorkers.length > 0 ? (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
										{builtinWorkers.map(renderAgentCard)}
									</div>
								) : (
									<p className="text-sm text-muted-foreground">暂无内置 Worker。</p>
								)}
							</div>
							<div className="flex flex-col gap-3">
								<div className="flex items-center gap-2">
									<h3 className="text-xs font-medium text-muted-foreground">第三方</h3>
									<Badge variant="secondary">{thirdPartyWorkers.length}</Badge>
								</div>
								{thirdPartyWorkers.length > 0 ? (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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

			{/* 非 pi worker 的三分区管理抽屉；pi Agent 已跳独立配置页（manager-dialog.tsx 留档备用） */}
			{manageAgent && !manageAgent.pinned ? (
				<AgentManageDialog
					agent={manageAgent}
					open={manageOpen}
					onOpenChange={setManageOpen}
					onAgentChanged={handleAgentChanged}
				/>
			) : null}

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

/** 页签：智能体 / 扩展目录。 */
function PaneTabs({ tab, onTab }: { tab: "agents" | "extensions"; onTab: (tab: "agents" | "extensions") => void }) {
	return (
		<div className="flex items-center gap-1 px-4 py-2">
			{(["agents", "extensions"] as const).map((key) => (
				<button
					key={key}
					type="button"
					onClick={() => onTab(key)}
					className={`rounded-md px-3 py-1 text-sm transition-colors ${
						tab === key ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"
					}`}
				>
					{key === "agents" ? "智能体" : "扩展目录"}
				</button>
			))}
		</div>
	);
}
