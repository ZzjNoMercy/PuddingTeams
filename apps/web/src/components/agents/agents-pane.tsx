"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, CopyIcon, LoaderIcon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon, SearchIcon, Settings2Icon, TrashIcon, UserCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	ApiConflictError,
	AgentCreationUncertainError,
	createAgent,
	deleteAgent,
	duplicateAgent,
	getViewerIdentity,
	listAgents,
	listExtensionCatalog,
	probeAgent,
	putAgentConnector,
	setAgentEnabled,
} from "@/lib/api";
import { agentRegistered, agentRemoved, agentRenamed } from "@/lib/avatars";
import type { AgentConfig, AgentConnectorBinding, AgentProbeResult, CatalogEntry, ConflictRun } from "@/lib/types";
import { agentDisplayName, isConnectorProbe } from "@/lib/types";
import { ManagerAvatar, WorkerAvatar } from "@/components/chat/worker-avatar";
import { ConfigSchemaForm, SecretSchemaFields } from "@/components/agents/form-parts";
import { AgentSetupUnconfirmedError, createAgentWithInitialSecrets } from "@/components/agents/create-agent-flow";
import { acquireAgentCreateAttempt, agentCreateDigest, clearAgentCreateAttempt, type AgentCreateAttempt } from "@/components/agents/agent-create-attempt";
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

function transportLabel(transport: string): string {
	if (transport === "spawn") return "CLI spawn";
	if (transport === "http") return "HTTP 流式";
	if (transport === "sdk") return "进程内 SDK";
	return transport.toUpperCase();
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

/** 内置 Worker 为平台本地 Pi 角色；随平台提供的外部连接插件不代表内置角色。 */
function isBuiltinWorker(agent: AgentConfig, connectorCatalog: CatalogEntry[]): boolean {
	if (agent.pinned || agent.connector?.connectorId !== "pi") return false;
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
	const router = useRouter();
	const [mode, setMode] = useState<"connector" | "command">("connector");
	const [name, setName] = useState("");
	const [identifier, setIdentifier] = useState("");
	const [description, setDescription] = useState("");
	const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [catalogAttempt, setCatalogAttempt] = useState(0);
	const [extensionId, setExtensionId] = useState("");
	const [transport, setTransport] = useState<AgentConnectorBinding["transport"] | "">("");
	const [config, setConfig] = useState<Record<string, unknown>>({});
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [command, setCommand] = useState("");
	const [runArgs, setRunArgs] = useState("");
	const [probeArgs, setProbeArgs] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [saving, setSaving] = useState(false);
	const creatingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const creationAttempt = useRef<AgentCreateAttempt | null>(null);
	const attemptStorage = () => { try { return sessionStorage; } catch { return null; } };
	const finishCreationAttempt = () => {
		clearAgentCreateAttempt(creationAttempt.current, attemptStorage());
		creationAttempt.current = null;
	};

	// 打开时清空上次错误（渲染期间重置）；目录拉取留在 effect。
	const [prevOpen, setPrevOpen] = useState(open);
	if (open !== prevOpen) {
		setPrevOpen(open);
		if (open) {
			setError(null);
			setCatalog(null);
			setCatalogError(null);
		}
	}
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		listExtensionCatalog("connector")
			.then((entries) => {
				if (!cancelled) {
					setCatalog(entries);
					setCatalogError(null);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) setCatalogError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [open, catalogAttempt]);

	const installed = (catalog ?? []).filter((e) => e.installed && e.loaded);
	const selected = installed.find((e) => e.manifest.id === extensionId);
	const contribution = selected?.manifest.kind === "connector" ? selected.manifest.connector : undefined;
	const selectedTransport = transport || contribution?.defaultTransport || "";
	const retryCatalog = () => {
		setCatalog(null);
		setCatalogError(null);
		setCatalogAttempt((value) => value + 1);
	};

	const reset = () => {
		setName("");
		setIdentifier("");
		setDescription("");
		setExtensionId("");
		setTransport("");
		setConfig({});
		setSecrets({});
		setCommand("");
		setRunArgs("");
		setProbeArgs("");
		setEnabled(true);
		setError(null);
	};
	const closeDialog = () => {
		reset();
		onOpenChange(false);
	};

	const handleSubmit = async () => {
		if (creatingRef.current) return;
		setError(null);
		if (!name.trim()) return setError("名称必填");
		if (identifier.trim() && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(identifier.trim())) {
			return setError("标识只能包含字母、数字、连字符或下划线，且以字母或数字开头");
		}
		if (mode === "connector" && !contribution) return setError("请选择连接插件");
		if (mode === "connector" && !selectedTransport) return setError("请选择传输方式");
		if (mode === "connector" && enabled) {
			const missing = (contribution?.secretSchema ?? []).filter((item) => item.required && !secrets[item.key]);
			if (missing.length > 0) return setError(`创建后立即启用需要填写密钥：${missing.map((item) => item.label).join("、")}`);
		}
		if (mode === "command" && !command.trim()) return setError("命令必填");
		creatingRef.current = true;
		setSaving(true);
		try {
			const hasSecrets = mode === "connector" && Object.keys(secrets).length > 0;
			const agent: AgentConfig =
				mode === "connector"
					? {
							// name 空串 = server 从显示名自动派生内部 id（唯一性由服务端保证）。
							name: identifier.trim(),
							displayName: name.trim(),
							description: description.trim(),
							connector: {
								extensionId,
								connectorId: contribution!.id,
								transport: selectedTransport as AgentConnectorBinding["transport"],
								config,
							},
							enabled,
						}
					: {
							name: identifier.trim(),
							displayName: name.trim(),
							description: description.trim(),
							invoke: {
								type: "command",
								command: command.trim(),
								runArgs: parseArgs(runArgs),
								...(probeArgs.trim() ? { probeArgs: parseArgs(probeArgs) } : {}),
							},
							enabled,
						};
			const created = await createAgentWithInitialSecrets(agent, hasSecrets ? {
				extensionId,
				connectorId: contribution!.id,
				transport: selectedTransport as AgentConnectorBinding["transport"],
				config,
				secrets,
			} : null, { create: async (input) => {
				const identity = await getViewerIdentity();
				const scope = JSON.stringify([identity.tenant.id, identity.user.id]);
				const body = JSON.stringify(input);
				const digest = await agentCreateDigest(body);
				creationAttempt.current = acquireAgentCreateAttempt(scope, digest, creationAttempt.current, attemptStorage(), () => crypto.randomUUID());
				return createAgent(input, creationAttempt.current.key);
			}, configure: (agentName, input, expectedRevision) => putAgentConnector(agentName, { ...input, expectedRevision }), enable: (agentName, expectedRevision) => setAgentEnabled(agentName, true, expectedRevision) });
			finishCreationAttempt();
			agentRenamed(created.name, created.displayName);
			toast.success(`「${name.trim()}」已创建${enabled ? "" : "（未启用）"}`);
			closeDialog();
			onCreated();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (err instanceof AgentSetupUnconfirmedError) {
				const created = err.agent;
				finishCreationAttempt();
				agentRenamed(created.name, created.displayName);
				toast.error(err.stage === "configure"
					? `Worker 已创建并保持停用，凭证配置未确认：${message}。请在配置页核对后启用。`
					: `Worker 与凭证已配置，启用结果未确认：${message}。请在配置页核对当前状态。`);
				closeDialog();
				onCreated();
				router.push(`/agents/config?name=${encodeURIComponent(created.name)}`);
			} else if (err instanceof AgentCreationUncertainError) {
				finishCreationAttempt();
				toast.error(`Worker 创建结果未确认：${message}。请核对已有配置。`);
				closeDialog();
				onCreated();
				router.push(`/agents/config?name=${encodeURIComponent(err.agentName)}`);
			} else setError(message);
		} finally {
			creatingRef.current = false;
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => { if (creatingRef.current) return; if (next) onOpenChange(true); else closeDialog(); }}>
			<DialogContent className="worker-create flex max-h-[85vh] flex-col overflow-hidden sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>添加智能体</DialogTitle>
					<DialogDescription>
						选接入方式、填名称和描述即可创建；Connector 的细项配置与探测、启用都在创建后的配置页完成。
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
				<fieldset disabled={saving} className="flex min-w-0 flex-col gap-5">
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
								{m === "connector" ? "连接插件接入" : "命令接入（旧版）"}
							</button>
						))}
					</div>

					<label className="worker-create-field">
						<span className="worker-create-label">名称<span className="worker-create-required">*</span></span>
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 数据分析员" maxLength={40} />
						<span className="worker-create-hint">显示名，聊天与成员列表里看到的就是它；创建后随时可改。</span>
					</label>
					<label className="worker-create-field">
						<span className="worker-create-label">标识（可选）</span>
						<Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="留空按名称自动生成" className="font-mono" />
						<span className="worker-create-hint">内部 id（字母/数字/连字符），创建后不可改；委托工具名为 agent_&lt;标识&gt;__delegate。</span>
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
								<span className="worker-create-label">连接插件<span className="worker-create-required">*</span></span>
								<Select
									disabled={catalog === null || Boolean(catalogError)}
									value={extensionId}
									onValueChange={(v) => {
										setExtensionId(v);
										const next = installed.find((entry) => entry.manifest.id === v);
										setTransport(next?.manifest.kind === "connector" ? next.manifest.connector.defaultTransport : "");
										setConfig({});
										setSecrets({});
									}}
								>
									<SelectTrigger className="w-full">
									<SelectValue placeholder="选择已安装的连接插件" />
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
									{catalogError ? "请重新加载后选择连接插件。"
									: catalog === null
									? "正在读取连接插件目录…"
									: installed.length === 0
									? "没有已安装的连接插件，请先到「扩展」页安装。"
									: "决定 Worker 的运行方式；选中后下方显示该插件的配置项。"}
								</span>
								{catalogError ? <span role="alert" className="text-xs text-destructive">连接插件目录加载失败：{catalogError} <Button type="button" variant="outline" size="sm" onClick={retryCatalog}>重新加载</Button></span> : null}
							</label>
							{contribution ? (
								<section className="worker-create-section">
									<span className="worker-create-label">接入配置</span>
									<label className="worker-create-field">
										<span className="worker-create-label">传输方式<span className="worker-create-required">*</span></span>
										<Select
											value={selectedTransport}
											onValueChange={(value) => setTransport(value as AgentConnectorBinding["transport"])}
										>
											<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
											<SelectContent>
												{contribution.supportedTransports.map((item) => (
													<SelectItem key={item} value={item}>{transportLabel(item)}</SelectItem>
												))}
											</SelectContent>
										</Select>
									<span className="worker-create-hint">连接插件声明支持的运行边界；保存后该 Worker 固定使用此方式。</span>
									</label>
									<ConfigSchemaForm schema={contribution.configSchema} value={config} onChange={setConfig} transport={selectedTransport} />
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
						<Button type="button" variant="ghost" onClick={closeDialog}>
							取消
						</Button>
						<Button type="button" onClick={() => void handleSubmit()} disabled={saving}>
							{saving ? "保存中…" : "创建"}
						</Button>
					</DialogFooter>
				</fieldset>
				</DialogBody>
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
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<AgentConfig | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleteRuns, setDeleteRuns] = useState<ConflictRun[]>([]);
	const [deleting, setDeleting] = useState(false);
	const [duplicating, setDuplicating] = useState<string | null>(null);
	const [probing, setProbing] = useState<string | null>(null);
	const [probes, setProbes] = useState<Record<string, AgentProbeResult>>({});
	const [enableConflict, setEnableConflict] = useState<{ agent: AgentConfig; message: string; runs: ConflictRun[] } | null>(null);
	const [resolving, setResolving] = useState(false);

	const refresh = useCallback(() => {
		Promise.allSettled([listAgents(), listExtensionCatalog("connector")]).then(([agentResult, catalogResult]) => {
			if (agentResult.status === "fulfilled") {
				setAgents(agentResult.value);
				setLoadError(null);
			}
			else setLoadError(agentResult.reason instanceof Error ? agentResult.reason.message : String(agentResult.reason));
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
			const res = await setAgentEnabled(agent.name, enabled, agent.extensionRevision ?? 0, resolve);
			setAgents((prev) => prev.map((a) => (a.name === res.agent.name ? res.agent : a)));
			setEnableConflict(null);
			const { affectedSessions, reloadPending } = res.affectedSessions;
			toast.success(
				enabled
					? `「${agentDisplayName(agent)}」已启用`
					: `「${agentDisplayName(agent)}」已停用${
							affectedSessions > 0 ? `；已撤权 ${affectedSessions} 个会话，${reloadPending} 个将在当前回合结束后刷新` : ""
						}`,
			);
		} catch (err) {
			if (err instanceof ApiConflictError && err.payload.runs?.length) {
				setEnableConflict({ agent, message: err.message, runs: err.payload.runs });
			} else if (err instanceof ApiConflictError) {
				setEnableConflict(null);
				refresh();
				toast.error("Agent 配置已变化，请核对最新状态后重试");
			} else {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		} finally {
			setResolving(false);
		}
	}, [refresh]);

	const handleDelete = useCallback(async () => {
		if (!pendingDelete) return;
		setDeleting(true);
		setDeleteError(null);
		setDeleteRuns([]);
		try {
			const result = await deleteAgent(pendingDelete.name);
			agentRemoved(pendingDelete.name);
			if (result.credentialsCleanup === "pending") toast.warning(`「${agentDisplayName(pendingDelete)}」已删除；凭证清理待下次启动重试`);
			else toast.success(`「${agentDisplayName(pendingDelete)}」已删除`);
			setPendingDelete(null);
			refresh();
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : String(err));
			if (err instanceof ApiConflictError) setDeleteRuns(err.payload.runs ?? []);
		} finally {
			setDeleting(false);
		}
	}, [pendingDelete, refresh]);

	const handleDuplicate = useCallback(async (agent: AgentConfig) => {
		setDuplicating(agent.name);
		try {
			const created = await duplicateAgent(agent.name);
			agentRegistered(created);
			toast.success(`已复制为「${agentDisplayName(created)}」（已停用）；请确认凭证后再启用`);
			router.push(`/agents/config?name=${encodeURIComponent(created.name)}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setDuplicating(null);
		}
	}, [router]);

	/** 所有 Agent 统一进独立配置页（§10.5）。 */
	const openManage = (agent: AgentConfig) => {
		router.push(`/agents/config?name=${encodeURIComponent(agent.name)}`);
	};

	const managers = agents.filter((agent) => agent.pinned);
	const workers = agents.filter((agent) => !agent.pinned);
	const builtinWorkers = workers.filter((agent) => isBuiltinWorker(agent, connectorCatalog));
	const thirdPartyWorkers = workers.filter((agent) => !isBuiltinWorker(agent, connectorCatalog));
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matchesQuery = (agent: AgentConfig) => !normalizedQuery || [
		agent.name,
		agentDisplayName(agent),
		agent.description,
		agent.connector?.connectorId ?? "",
	].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
	const visibleManagers = managers.filter(matchesQuery);
	const visibleBuiltinWorkers = builtinWorkers.filter(matchesQuery);
	const visibleThirdPartyWorkers = thirdPartyWorkers.filter(matchesQuery);
	const visibleCount = visibleManagers.length + visibleBuiltinWorkers.length + visibleThirdPartyWorkers.length;

	const renderAgentCard = (agent: AgentConfig) => {
		const description = agent.description;
		return (
			<div
				key={agent.name}
				className="ops-agent-card group relative flex min-h-[132px] rounded-xl p-5 pr-12 transition-all"
			>
				<button type="button" className="ops-agent-main flex min-w-0 flex-1 items-start gap-4 text-left" onClick={() => openManage(agent)}>
					<span className="ops-agent-avatar shrink-0"><WorkerAvatar name={agent.name} size={42} /></span>
					<div className="flex min-w-0 flex-1 self-stretch flex-col">
						<div className="flex items-baseline gap-2">
							<span className="truncate text-sm font-medium tracking-tight">{agentDisplayName(agent)}</span>
							<span className={`ops-agent-status-dot ${agent.enabled === false ? "is-disabled" : ""}`} role="img" aria-label={agent.enabled !== false ? "已启用" : "已停用"} />
						</div>
						<p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground" title={description}>
							{description || "尚未填写角色描述"}
						</p>
						<div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-[11px] text-muted-foreground">
							<span className="ops-agent-kind-pill">{agent.connector?.connectorId === "pi" ? "Pi" : agent.connector?.connectorId ?? "命令"}</span>
							<span>{agent.enabled !== false ? "可用" : "已停用"}</span>
							{probes[agent.name] ? <span>{probeSummary(probes[agent.name])}</span> : null}
						</div>
					</div>
					</button>
				<ChevronRightIcon className="ops-agent-chevron pointer-events-none absolute right-5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button type="button" size="icon" variant="ghost" aria-label={`管理 ${agentDisplayName(agent)}`} className="ops-agent-menu-trigger absolute right-3 top-3 size-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
							<MoreHorizontalIcon className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						sideOffset={8}
						className="ops-agent-menu w-44"
					>
						<DropdownMenuItem onSelect={() => openManage(agent)}><Settings2Icon />配置</DropdownMenuItem>
						{agent.connector && agent.invoke?.type !== "command" ? (
							<DropdownMenuItem disabled={duplicating !== null} onSelect={() => void handleDuplicate(agent)}><CopyIcon />{duplicating === agent.name ? "复制中…" : "复制 Worker"}</DropdownMenuItem>
						) : null}
						<DropdownMenuItem disabled={probing === agent.name} onSelect={() => void handleProbe(agent.name)}><RefreshCwIcon />{probing === agent.name ? "探测中…" : "运行探测"}</DropdownMenuItem>
						<DropdownMenuItem disabled={resolving} onSelect={() => void applyEnabled(agent, !(agent.enabled !== false))}><UserCheckIcon />{agent.enabled !== false ? "停用" : "启用"}</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" onSelect={() => { setDeleteError(null); setDeleteRuns([]); setPendingDelete(agent); }}><TrashIcon />删除</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	};

	const renderManagerStrip = (agent: AgentConfig) => {
		const description = agent.description.replace(/^内置\s+Pi\s+manager[：:]?\s*/i, "");
		return <button key={agent.name} type="button" className="ops-manager-strip" onClick={() => openManage(agent)}>
			<ManagerAvatar size={48} className="ops-manager-avatar" />
			<div className="ops-manager-content min-w-0 text-left">
				<div className="flex items-center gap-2"><span className="text-sm font-medium">{agent.displayName?.trim() || "Manager"}</span><span className={`ops-agent-status-dot ${agent.enabled === false ? "is-disabled" : ""}`} role="img" aria-label={agent.enabled !== false ? "可用" : "已停用"} /></div>
				<p className="mt-1 text-xs leading-5 text-muted-foreground">{description || "理解目标、组织协作并汇总结果"}</p>
				<div className="ops-manager-meta"><span className="ops-origin-pill">Pi</span><span>个人助理 · 房间协调</span></div>
			</div>
			<ChevronRightIcon className="ops-manager-chevron" size={15} aria-hidden="true" />
		</button>;
	};

	return (
		<div className="ops-page flex h-full flex-col">
			<header className="ops-page-header ops-agents-header">
				<div>
					<h1 className="ops-page-title">智能体</h1>
					<p className="ops-page-subtitle">管理协作角色、连接方式与运行状态</p>
				</div>
				<Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
					<PlusIcon className="size-4" />
					添加智能体
				</Button>
			</header>
			<div className="ops-page-scroll flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[1180px] px-7 pb-10">
					<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 py-4">
						<p className="text-xs text-muted-foreground">{loading ? "正在读取智能体…" : loadError ? "智能体列表加载失败" : `${agents.length} 个智能体 · ${agents.filter((agent) => agent.enabled !== false).length} 个已启用`}</p>
						<div className="relative w-full sm:w-64">
							<SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input aria-label="搜索智能体" placeholder="搜索智能体" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" />
						</div>
					</div>
				{loading ? (
					<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : loadError ? (
					<div role="alert" className="flex flex-col items-start gap-3 py-10 text-sm">
						<p>智能体列表加载失败：{loadError}</p>
						<Button type="button" variant="outline" size="sm" onClick={() => { setLoading(true); refresh(); }}><RefreshCwIcon className="size-4" />重新加载</Button>
					</div>
				) : (
					<div className="flex flex-col gap-10 py-8">
						{normalizedQuery && visibleCount === 0 ? <p className="text-sm text-muted-foreground">没有找到匹配「{query.trim()}」的智能体。</p> : null}
						<section className="flex flex-col gap-3">
							<div className="flex items-baseline gap-2">
								<h2 className="text-sm font-medium">Manager</h2>
								<span className="text-xs text-muted-foreground">理解消息、组织协作并汇总结果</span>
							</div>
							{visibleManagers.length > 0 ? (
								<div className="grid grid-cols-1 gap-3">
									{visibleManagers.map(renderManagerStrip)}
								</div>
							) : !normalizedQuery ? (
								<p className="text-sm text-muted-foreground">未找到 Manager 配置。</p>
							) : null}
						</section>

						<section className="flex flex-col gap-9">
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-between gap-4">
									<div className="flex items-center gap-2"><h3 className="text-sm font-medium">Worker（内置）</h3>
									<Badge variant="secondary">{builtinWorkers.length}</Badge>
									</div><span className="text-xs text-muted-foreground">随平台提供或由 Pi 衍生</span>
								</div>
								{visibleBuiltinWorkers.length > 0 ? (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-[1500px]:grid-cols-3">
										{visibleBuiltinWorkers.map(renderAgentCard)}
									</div>
								) : !normalizedQuery ? (
									<p className="text-sm text-muted-foreground">暂无内置 Worker。</p>
								) : null}
							</div>
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-between gap-4">
									<div className="flex items-center gap-2"><h3 className="text-sm font-medium">Worker（第三方）</h3>
									<Badge variant="secondary">{thirdPartyWorkers.length}</Badge>
									</div><span className="text-xs text-muted-foreground">通过连接插件添加，默认归入此处</span>
								</div>
								{visibleThirdPartyWorkers.length > 0 ? (
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-[1500px]:grid-cols-3">
										{visibleThirdPartyWorkers.map(renderAgentCard)}
									</div>
								) : !normalizedQuery ? (
									<p className="text-sm text-muted-foreground">暂无第三方 Worker，点击右上角添加。</p>
								) : null}
							</div>
						</section>
					</div>
				)}
				</div>
			</div>

			<CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} />

			{/* 删除确认 */}
			<Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除智能体</DialogTitle>
						<DialogDescription>
							删除「{pendingDelete ? agentDisplayName(pendingDelete) : ""}」的配置？现有会话保留历史信息，删除后无法恢复此 Agent。
						</DialogDescription>
					</DialogHeader>
					{pendingDelete?.enabled !== false ? <p className="text-sm text-muted-foreground">请先停用此 Agent，处理进行中的 Run，再删除。</p> : null}
					{deleteError ? <p role="alert" className="text-sm text-destructive">{deleteError}</p> : null}
					{deleteRuns.length > 0 ? (
						<div className="flex flex-col gap-1 text-xs text-muted-foreground">
							{deleteRuns.map((run) => <div key={run.delegationId} className="font-mono">{run.delegationId} · {run.executionState} · 窗口 {run.windowId}</div>)}
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={deleting} onClick={() => setPendingDelete(null)}>
							取消
						</Button>
						<Button type="button" variant="destructive" disabled={deleting || pendingDelete?.enabled !== false} onClick={() => void handleDelete()}>
							{deleting ? <LoaderIcon className="size-4 animate-spin" /> : null}{deleteRuns.length > 0 ? "重新检查并删除" : "删除"}
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
									{run.delegationId} · {run.executionState} · 窗口 {run.windowId}
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
