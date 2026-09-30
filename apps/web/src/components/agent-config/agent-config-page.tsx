"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
	ActivityIcon,
	ArrowLeftIcon,
	BoxIcon,
	BoxesIcon,
	CopyIcon,
	DownloadIcon,
	InfoIcon,
	GlobeIcon,
	LoaderIcon,
	MessageSquareTextIcon,
	PlugIcon,
	RefreshCwIcon,
	SaveIcon,
	ServerIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiConflictError, deleteAgent, listAgents, probeAgent, putAgentConfig, setAgentEnabled } from "@/lib/api";
import type { AgentConfig, AgentProbeResult, ConflictRun, MutationResponse, PiManagerSettings } from "@/lib/types";
import { agentDisplayName, isConnectorProbe } from "@/lib/types";
import { agentRemoved, agentRenamed } from "@/lib/avatars";
import { ManagerAvatar, WorkerAvatar } from "@/components/chat/worker-avatar";
import {
	buildConfigBody,
	buildResponsibility,
	draftAfterSave,
	draftFromAgent,
	isPiAgent,
	serializeDraft,
	type ConfigDraft,
} from "@/components/agent-config/draft";
import { OverviewSection } from "@/components/agent-config/overview-section";
import { ModelSection } from "@/components/agent-config/model-section";
import { PromptSection } from "@/components/agent-config/prompt-section";
import { ResourceLibrarySection } from "@/components/agent-config/resource-library-section";
import {
	BindingsSection,
	ConnectorSection,
	LegacyInvokeSection,
	StatusSection,
} from "@/components/agent-config/connector-sections";
import { WebResearchSection } from "@/components/agent-config/web-research-section";
import { McpSelectionSection } from "@/components/agent-config/mcp-selection-section";
import { configTransferFromDraft, draftWithConfigTransfer, parseConfigTransfer, type ConfigTransfer } from "@/components/agent-config/config-transfer";

/**
 * Agent 独立配置页（§10.5）：所有角色统一入口。
 * - pinned manager 与 pi worker：概览 / 模型与运行 / 提示词 / 技能 / 模板 / MCP /
 *   插件分区；普通配置使用同一份页面级草稿，一个「保存」调
 *   PUT /api/agents/:name/config 一次提交，MCP 与插件绑定独立保存；
 * - 其余 connector / legacy worker：概览（描述 + 责任边界，随页面「保存」走
 *   全量 upsert）+ 基础接入 / Extensions / 运行状态三个分区（各自独立保存，
 *   见 connector-sections.tsx）。
 */

type SectionKey = "overview" | "model" | "prompt" | "skills" | "templates" | "connector" | "mcp" | "network" | "extensions" | "status";

type SectionDef = { key: SectionKey; label: string; description: string; icon: typeof InfoIcon };

const OVERVIEW_SECTION: SectionDef = {
	key: "overview",
	label: "概览",
	description: "定义用户看见的角色信息，以及 Manager 在协作中使用的责任边界。",
	icon: InfoIcon,
};

const NETWORK_SECTION: SectionDef = { key: "network", label: "联网", description: "分别授权此智能体使用联网搜索与网页阅读。", icon: GlobeIcon };

const PI_SECTIONS: SectionDef[] = [
	OVERVIEW_SECTION,
	{ key: "model", label: "模型与运行", description: "选择模型、思考强度与上下文加载方式。", icon: SlidersHorizontalIcon },
	{ key: "prompt", label: "提示词", description: "运行指令、项目上下文与提示词预览。", icon: MessageSquareTextIcon },
	{ key: "skills", label: "技能", description: "选择当前智能体可用的技能；资源内容在扩展中管理。", icon: SparklesIcon },
	{ key: "templates", label: "模板", description: "选择当前智能体可用的提示词模板；资源内容在扩展中管理。", icon: BoxIcon },
	NETWORK_SECTION,
	{ key: "mcp", label: "MCP", description: "选择当前 Pi Agent 可以使用的 MCP Server。", icon: ServerIcon },
	{ key: "extensions", label: "插件", description: "为当前 Pi 会话绑定能力插件，扩充可使用的业务能力。", icon: BoxesIcon },
];

const CONNECTOR_SECTIONS: SectionDef[] = [
	OVERVIEW_SECTION,
	NETWORK_SECTION,
	{ key: "connector", label: "基础接入", description: "选择连接插件，填写接入配置与密钥。", icon: PlugIcon },
	{ key: "extensions", label: "插件", description: "为当前 Worker 绑定兼容的能力插件。", icon: BoxesIcon },
	{ key: "status", label: "运行状态", description: "启停 Agent、检查接入可用性、查看写操作对会话的影响。", icon: ActivityIcon },
];

const TRANSFER_FIELD_LABELS: Record<keyof ConfigTransfer, string> = {
	description: "描述",
	responsibility: "职责边界",
	manager: "Manager 运行配置",
	codeSearch: "Worker 代码搜索",
	connectorConfig: "Worker 运行配置",
	piResources: "提示词与资源",
};

function probeSummary(probe: AgentProbeResult): string {
	if (isConnectorProbe(probe)) {
		if (!probe.extensionInstalled) return "扩展未安装";
		if (!probe.detected) return (probe.transport ?? probe.capabilities.transport) === "http" ? "API 不可达" : "CLI 未检测";
		if (probe.compatibility === "incompatible") return "不兼容";
		if (probe.authenticated === false) return "凭证无效";
		return "探测正常";
	}
	return probe.ok ? "探测健康" : `探测异常：${probe.error ?? `exit ${probe.exitCode}`}`;
}

export function AgentConfigPage({ name }: { name: string }) {
	const router = useRouter();
	const [agents, setAgents] = useState<AgentConfig[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [agent, setAgent] = useState<AgentConfig | null>(null);
	const [draft, setDraft] = useState<ConfigDraft | null>(null);
	const [baseline, setBaseline] = useState("");
	const [draftRevision, setDraftRevision] = useState(0);
	const [configConflict, setConfigConflict] = useState(false);
	const [section, setSection] = useState<SectionKey>("overview");
	const [saving, setSaving] = useState(false);
	const [probing, setProbing] = useState(false);
	const [toggling, setToggling] = useState(false);
	const [leaveConfirm, setLeaveConfirm] = useState(false);
	const [lastMutation, setLastMutation] = useState<MutationResponse | null>(null);
	const [enableConflict, setEnableConflict] = useState<{ message: string; runs: ConflictRun[] } | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleteRuns, setDeleteRuns] = useState<ConflictRun[]>([]);
	const [transferOpen, setTransferOpen] = useState(false);
	const [transferText, setTransferText] = useState("");
	const [transferPreview, setTransferPreview] = useState<ConfigTransfer | null>(null);
	const [transferError, setTransferError] = useState<string | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);
	const transferFileReadRef = useRef(0);
	const pageMutationRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		listAgents()
			.then((list) => {
				if (cancelled) return;
				setAgents(list);
				const found = list.find((item) => item.name === name) ?? null;
				setAgent(found);
				if (found) {
					const initial = draftFromAgent(found);
					setDraft(initial);
					setBaseline(serializeDraft(initial));
					setDraftRevision(found.extensionRevision ?? 0);
					setConfigConflict(false);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [name, loadAttempt]);

	const retryLoad = () => {
		setLoadError(null);
		setAgents(null);
		setLoadAttempt((attempt) => attempt + 1);
	};

	const dirty = useMemo(() => (draft ? serializeDraft(draft) !== baseline : false), [draft, baseline]);

	/** 切换分区回到顶部：否则从长分区切到另一长分区会落在页面中段，标题被上边缘切一半。 */
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: 0 });
	}, [section, name]);

	const patchDraft = useCallback((patch: Partial<ConfigDraft>) => {
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
	}, []);

	/** 分区写操作（Connector 绑定 / Capability 绑定）回写 agent 并记录影响。 */
	const handleMutation = useCallback((res: MutationResponse) => {
		setLastMutation(res);
		setAgent(res.agent);
		setAgents((prev) => prev?.map((item) => (item.name === res.agent.name ? res.agent : item)) ?? prev);
		setDraftRevision((current) => Math.max(current, res.revision));
	}, []);

	/** legacy 命令接入保存后直接回写 agent。 */
	const handleAgentSaved = useCallback((updated: AgentConfig) => {
		setAgent(updated);
		setAgents((prev) => prev?.map((item) => (item.name === updated.name ? updated : item)) ?? prev);
	}, []);
	const handleLocalAgentSaved = useCallback((updated: AgentConfig) => {
		handleAgentSaved(updated);
		setDraftRevision((current) => Math.max(current, updated.extensionRevision ?? current));
	}, [handleAgentSaved]);

	const handleBack = useCallback(() => {
		if (dirty) setLeaveConfirm(true);
		else router.push("/agents");
	}, [dirty, router]);

	const handleSave = useCallback(async () => {
		if (!agent || !draft || pageMutationRef.current || configConflict) return;
		pageMutationRef.current = true;
		setSaving(true);
		try {
			if (isPiAgent(agent)) {
				const mutation = await putAgentConfig(agent.name, { ...buildConfigBody(agent, draft), expectedRevision: draftRevision });
				setAgent(mutation.agent);
				setAgents((prev) => prev?.map((item) => (item.name === mutation.agent.name ? mutation.agent : item)) ?? prev);
				agentRenamed(mutation.agent.name, mutation.agent.displayName);
				const next = draftFromAgent(mutation.agent);
				setDraft((current) => draftAfterSave(current, draft, next));
				setBaseline(serializeDraft(next));
				setDraftRevision(mutation.revision);
				setConfigConflict(false);
				// activeNow 恒等于 affectedSessions（session-store.agentSessionStats），
				// 说"N 个立即生效"是把"本轮结束后切换"说反了；这里只报进行中的会话数。
				const { affectedSessions } = mutation.affectedSessions;
				toast.success(
					`「${agentDisplayName(mutation.agent)}」配置已保存；新建会话立即生效${
						affectedSessions > 0 ? `；${affectedSessions} 个进行中的会话本轮结束后切换` : ""
					}`,
				);
				for (const warning of mutation.securityWarnings ?? []) toast.warning(warning);
			} else {
				// connector / legacy worker 只保存概览字段（显示名 + 描述 + 责任边界）；
				// 同样使用带草稿版本的合并更新，避免全量 upsert 覆盖其他分区。
				const responsibility = buildResponsibility(draft) ?? null;
				const mutation = await putAgentConfig(agent.name, {
					expectedRevision: draftRevision,
					displayName: draft.displayName.trim(),
					description: draft.description.trim(),
					responsibility,
				});
				const updated = mutation.agent;
				handleAgentSaved(updated);
				agentRenamed(updated.name, updated.displayName);
				const next = draftFromAgent(updated);
				setDraft((current) => draftAfterSave(current, draft, next));
				setBaseline(serializeDraft(next));
				setDraftRevision(mutation.revision);
				setConfigConflict(false);
				toast.success(`「${agentDisplayName(updated)}」配置已保存；新建或重开的 Session 生效`);
			}
		} catch (err) {
			if (err instanceof ApiConflictError) setConfigConflict(true);
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			pageMutationRef.current = false;
			setSaving(false);
		}
	}, [agent, draft, draftRevision, configConflict, handleAgentSaved]);

	const reloadConfigAfterConflict = useCallback(async () => {
		try {
			const list = await listAgents();
			const latest = list.find((item) => item.name === name);
			if (!latest) throw new Error("Agent 已不存在");
			const next = draftFromAgent(latest);
			setAgents(list);
			setAgent(latest);
			setDraft(next);
			setBaseline(serializeDraft(next));
			setDraftRevision(latest.extensionRevision ?? 0);
			setConfigConflict(false);
			toast.success("已读取最新配置，可以重新编辑");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, [name]);

	/** 从其他 pi Agent 复制：model/thinkingLevel/systemPrompt/资源开关/enabled 名单灌入草稿。 */
	const handleCopyFrom = useCallback(
		(sourceName: string) => {
			const source = agents?.find((item) => item.name === sourceName);
			if (!source) return;
			const sourceModel = source.pinned
				? source.manager?.model
				: typeof source.connector?.config.model === "string"
					? source.connector.config.model
					: undefined;
			const sourceThinking = source.pinned
				? source.manager?.thinkingLevel
				: typeof source.connector?.config.thinkingLevel === "string"
					? (source.connector.config.thinkingLevel as PiManagerSettings["thinkingLevel"])
					: undefined;
			const sourceResources = source.piResources ?? {};
			setDraft((prev) => {
				if (!prev) return prev;
				const manager = { ...prev.manager };
				if (sourceModel) manager.model = sourceModel;
				else delete manager.model;
				if (sourceThinking) manager.thinkingLevel = sourceThinking;
				else delete manager.thinkingLevel;
				const connectorConfig = { ...prev.connectorConfig };
				if (sourceModel) connectorConfig.model = sourceModel;
				else delete connectorConfig.model;
				if (sourceThinking) connectorConfig.thinkingLevel = sourceThinking;
				else delete connectorConfig.thinkingLevel;
				return {
					...prev,
					manager,
					connectorConfig,
					systemPrompt: sourceResources.systemPrompt ?? "",
					skillPaths: (sourceResources.skillPaths ?? []).join("\n"),
					promptTemplatePaths: (sourceResources.promptTemplatePaths ?? []).join("\n"),
					enabledSkills: [...(sourceResources.enabledSkills ?? [])],
					enabledPrompts: [...(sourceResources.enabledPrompts ?? [])],
					loadWorkspaceSkills: sourceResources.loadWorkspaceSkills !== false,
					loadWorkspacePrompts: sourceResources.loadWorkspacePrompts !== false,
					loadWorkspaceContext: sourceResources.loadWorkspaceContext !== false,
				};
			});
			toast.success(`已把「${sourceName}」的配置灌入草稿（不含名称/头像/责任边界），保存后生效`);
		},
		[agents],
	);

	const handleExport = useCallback(() => {
		if (!agent || !draft) return;
		try {
			const transfer = configTransferFromDraft(agent, draft);
			const blob = new Blob([JSON.stringify(transfer, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${agent.name}-config.json`;
			anchor.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			toast.error(`导出失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}, [agent, draft]);

	const handleImportFile = useCallback(async (file: File) => {
		const readId = ++transferFileReadRef.current;
		setTransferPreview(null);
		setTransferError(null);
		try {
			if (file.size > 5 * 1024 * 1024) throw new Error("配置文件不能超过 5 MB");
			const content = await file.text();
			if (readId !== transferFileReadRef.current) return;
			setTransferText(content);
		} catch (err) {
			if (readId === transferFileReadRef.current) setTransferError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	const handleProbe = useCallback(async () => {
		if (!agent) return;
		setProbing(true);
		try {
			const result = await probeAgent(agent.name);
			const healthy = isConnectorProbe(result)
				? result.detected && result.compatibility !== "incompatible" && result.authenticated !== false
				: result.ok;
			const summary = `「${agentDisplayName(agent)}」${probeSummary(result)}`;
			if (healthy) toast.success(summary);
			else toast.error(summary);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(false);
		}
	}, [agent]);

	const handleToggleEnabled = useCallback(
		async (enabled: boolean, resolve?: "keep" | "cancel") => {
			if (!agent || pageMutationRef.current) return;
			pageMutationRef.current = true;
			setToggling(true);
			try {
				const mutation = await setAgentEnabled(agent.name, enabled, agent.extensionRevision ?? 0, resolve);
				setAgent(mutation.agent);
				setAgents((prev) => prev?.map((item) => (item.name === mutation.agent.name ? mutation.agent : item)) ?? prev);
				setDraftRevision((current) => Math.max(current, mutation.revision));
				setEnableConflict(null);
				const { affectedSessions, reloadPending } = mutation.affectedSessions;
				toast.success(enabled
					? `「${agentDisplayName(agent)}」已启用`
					: `「${agentDisplayName(agent)}」已停用${affectedSessions > 0 ? `；已撤权 ${affectedSessions} 个会话，${reloadPending} 个将在当前回合结束后刷新` : ""}`);
			} catch (err) {
				if (!enabled && err instanceof ApiConflictError && err.payload.runs?.length) {
					setEnableConflict({ message: err.message, runs: err.payload.runs });
				} else if (err instanceof ApiConflictError) {
					setEnableConflict(null);
					try {
						const latest = await listAgents();
						setAgents(latest);
						setAgent(latest.find((item) => item.name === agent.name) ?? null);
						toast.error("Agent 配置已变化，请核对最新状态后重试");
					} catch {
						toast.error("Agent 状态已变化，但最新状态读取失败，请刷新后核对");
					}
				} else {
					toast.error(err instanceof Error ? err.message : String(err));
				}
			} finally {
				pageMutationRef.current = false;
				setToggling(false);
			}
		},
		[agent],
	);

	const handleDelete = useCallback(async () => {
		if (!agent || pageMutationRef.current) return;
		pageMutationRef.current = true;
		setDeleting(true);
		setDeleteError(null);
		setDeleteRuns([]);
		try {
			const result = await deleteAgent(agent.name);
			agentRemoved(agent.name);
			if (result.credentialsCleanup === "pending") toast.warning(`「${agentDisplayName(agent)}」已删除；凭证清理待下次启动重试`);
			else toast.success(`「${agentDisplayName(agent)}」已删除`);
			setDeleteConfirm(false);
			router.push("/agents");
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : String(err));
			if (err instanceof ApiConflictError) setDeleteRuns(err.payload.runs ?? []);
		} finally {
			pageMutationRef.current = false;
			setDeleting(false);
		}
	}, [agent, router]);

	// ---- 加载 / 404 两态 ----

	if (loadError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3">
				<p className="text-sm text-destructive">无法加载智能体列表：{loadError}</p>
				<div className="flex items-center gap-2">
					<Button size="sm" onClick={retryLoad}>重试读取</Button>
					<Button size="sm" variant="outline" onClick={() => router.push("/agents")}>返回智能体列表</Button>
				</div>
			</div>
		);
	}
	if (agents === null) {
		return (
			<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
				<LoaderIcon className="size-4 animate-spin" />
				加载中…
			</div>
		);
	}
	if (!agent || !draft) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3">
				<p className="text-sm text-muted-foreground">智能体「{name}」不存在（404）。</p>
				<Button size="sm" variant="outline" onClick={() => router.push("/agents")}>
					返回智能体列表
				</Button>
			</div>
		);
	}

	const piMode = isPiAgent(agent);
	const legacy = !agent.connector && agent.invoke?.type === "command";
	const sections = piMode ? PI_SECTIONS : CONNECTOR_SECTIONS;
	const copySources = agents.filter((item) => item.name !== agent.name && isPiAgent(item));

	return (
		<div className="agent-config-shell flex min-h-0 min-w-0 flex-1 flex-col bg-background">
			{/* 页面头：返回箭头贴在标题左侧，右侧统一放配置与删除操作。 */}
			<header className="agent-config-pagehead">
				<div className="agent-config-heading">
					<Button
						type="button"
						size="icon"
						variant="ghost"
						aria-label="返回智能体列表"
						title="返回智能体列表"
						onClick={handleBack}
					>
						<ArrowLeftIcon className="size-4" />
					</Button>
					<div className="min-w-0">
						<h1>{agentDisplayName(agent)}</h1>
						<p>{piMode ? "配置模型、提示词与可用能力" : "接入、能力与运行状态"}</p>
					</div>
				</div>
				<div className="agent-config-actions">
					{piMode ? (
						<Button size="icon" variant="ghost" aria-label="导入与导出配置" title="导入与导出配置" onClick={() => setTransferOpen(true)}>
							<DownloadIcon className="size-4" />
						</Button>
					) : (
						<Button size="icon" variant="ghost" aria-label="探测接入可用性" title="探测接入可用性" disabled={probing} onClick={() => void handleProbe()}>
							{probing ? <LoaderIcon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
						</Button>
					)}
					<Button size="sm" disabled={saving || toggling || !dirty || configConflict} onClick={() => void handleSave()}>
						{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : <SaveIcon className="size-3.5" />}
						保存配置{dirty ? " ·" : ""}
					</Button>
					{!agent.pinned ? (
						<button type="button" className="agent-config-delete-link" disabled={saving || toggling || deleting} onClick={() => {
							setDeleteError(null);
							setDeleteRuns([]);
							setDeleteConfirm(true);
						}}>删除智能体</button>
					) : null}
				</div>
			</header>

			<div className="agent-config-scroll" ref={scrollRef}>
				{/* 身份 banner：头像 / 名称 / 描述 / 来源 / 启停，与页面标题分工。 */}
				<div className="agent-config-banner">
					{agent.pinned ? <ManagerAvatar size={40} /> : <WorkerAvatar name={agent.name} size={40} />}
					<div className="min-w-0 flex-1">
						<strong>{agentDisplayName(agent)}</strong>
						<p>{agent.description || "（无描述）"}</p>
					</div>
					<Badge variant="secondary">{agent.pinned ? "Manager" : (agent.connector?.connectorId ?? "worker")}</Badge>
					{agent.pinned ? (
						<span className="agent-config-enable">始终启用</span>
					) : (
						<label className="agent-config-enable">
							<input
								type="checkbox"
								checked={agent.enabled !== false}
								disabled={toggling || saving}
								onChange={() => void handleToggleEnabled(agent.enabled === false)}
							/>
							{toggling ? (agent.enabled !== false ? "停用中…" : "启用中…") : agent.enabled !== false ? "已启用" : "已停用"}
						</label>
					)}
				</div>

				{configConflict ? <div role="alert" className="agent-config-callout is-warning">配置已在其他位置更新。当前草稿仍在此页；请先核对并复制需要保留的内容，再读取最新配置。<Button type="button" size="sm" variant="outline" className="ml-3" onClick={() => void reloadConfigAfterConflict()}>读取最新配置（丢弃当前草稿）</Button></div> : null}

				{/* 分区导航 + 内容 */}
				<div className="agent-config-body">
					<nav className="agent-config-nav" aria-label="Agent 配置分区">
						{sections.map((item) => (
							<button
								key={item.key}
								type="button"
								onClick={() => setSection(item.key)}
								aria-current={section === item.key ? "page" : undefined}
								className={`agent-config-nav-button ${section === item.key ? "active" : ""}`}
								title={item.description}
							>
								{item.label}
							</button>
						))}
					</nav>
					<main className="agent-config-content">
						<div className="agent-config-column">
						{section === "overview" ? <OverviewSection agent={agent} draft={draft} onChange={patchDraft} onAgentUpdated={handleLocalAgentSaved} /> : null}
						{piMode && section === "model" ? <ModelSection agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{piMode && section === "prompt" ? <PromptSection agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{piMode && section === "skills" ? <ResourceLibrarySection kind="skills" agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{piMode && section === "templates" ? <ResourceLibrarySection kind="templates" agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{!piMode && section === "connector" ? (
							legacy ? (
								<LegacyInvokeSection agent={agent} onSaved={handleLocalAgentSaved} onConflict={() => setConfigConflict(true)} conflicted={configConflict} />
							) : (
								<ConnectorSection agent={agent} onMutation={handleMutation} onAgentReloaded={handleAgentSaved} />
							)
						) : null}
						{section === "network" ? <WebResearchSection agent={agent} /> : null}
						{piMode && section === "mcp" ? <McpSelectionSection agent={agent} onMutation={handleMutation} /> : null}
						{section === "extensions" ? <BindingsSection agent={agent} onMutation={handleMutation} /> : null}
					{!piMode && section === "status" ? <StatusSection agent={agent} lastMutation={lastMutation} onToggleEnabled={handleToggleEnabled} toggling={toggling} mutationBusy={saving} /> : null}
						</div>
					</main>
				</div>
			</div>

			<Dialog open={transferOpen} onOpenChange={(open) => {
				setTransferOpen(open);
				if (!open) { transferFileReadRef.current++; setTransferText(""); setTransferPreview(null); setTransferError(null); }
			}}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>导入与导出配置</DialogTitle>
						<DialogDescription>选择 JSON 文件或粘贴配置，预览后再导入草稿；保存配置后才会生效。独立存储的凭据不进入导出文件。</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						<div className="flex flex-wrap gap-2">
							<Button type="button" size="sm" variant="outline" onClick={() => importInputRef.current?.click()}><UploadIcon className="size-3.5" />选择 JSON 文件</Button>
							<DropdownMenu>
								<DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" disabled={copySources.length === 0}><CopyIcon className="size-3.5" />从其他 Agent 复制</Button></DropdownMenuTrigger>
								<DropdownMenuContent align="start">
									{copySources.map((item) => <DropdownMenuItem key={item.name} onSelect={() => {
										handleCopyFrom(item.name);
										setTransferOpen(false);
										transferFileReadRef.current++;
										setTransferText("");
										setTransferPreview(null);
										setTransferError(null);
									}}>{agentDisplayName(item)}{item.pinned ? "（Manager）" : ""}</DropdownMenuItem>)}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						<input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) void handleImportFile(file);
							event.target.value = "";
						}} />
						<label htmlFor="agent-config-transfer-json" className="text-sm font-medium">导入配置 JSON</label>
						<Textarea id="agent-config-transfer-json" rows={8} className="font-mono text-xs" value={transferText} onChange={(event) => {
							transferFileReadRef.current++;
							setTransferText(event.target.value);
							setTransferPreview(null);
							setTransferError(null);
						}} placeholder={'{ "description": "研究助手", "piResources": { "systemPrompt": "..." } }'} />
						{transferError ? <p role="alert" className="text-xs text-destructive">{transferError}</p> : null}
						{transferPreview ? <p role="status" className="text-xs text-muted-foreground">配置已通过校验，将更新：{(Object.keys(transferPreview) as Array<keyof ConfigTransfer>).map((field) => TRANSFER_FIELD_LABELS[field]).join("、")}。名称、头像、凭据和绑定不会导入。</p> : null}
					</div>
					<DialogFooter className="gap-2 sm:justify-between">
						<Button type="button" variant="outline" onClick={handleExport}><DownloadIcon className="size-3.5" />下载当前配置</Button>
						{transferPreview ? (
							<Button type="button" onClick={() => {
								setDraft((prev) => prev ? draftWithConfigTransfer(prev, transferPreview) : prev);
								setTransferOpen(false);
								transferFileReadRef.current++;
								setTransferText("");
								setTransferPreview(null);
								toast.success("已导入到草稿，保存后生效");
							}}>确认导入草稿</Button>
						) : (
							<Button type="button" disabled={!transferText.trim()} onClick={() => {
								try {
									if (!agent) throw new Error("Agent 未加载");
									setTransferPreview(parseConfigTransfer(JSON.parse(transferText) as unknown, agent.pinned ? "manager" : "worker"));
									setTransferError(null);
								} catch (err) {
									setTransferError(err instanceof Error ? err.message : String(err));
								}
							}}>预览导入</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 未保存离开确认 */}
			<Dialog open={leaveConfirm} onOpenChange={setLeaveConfirm}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>放弃未保存的更改？</DialogTitle>
						<DialogDescription>草稿有未保存的修改，返回列表将丢失这些更改。</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setLeaveConfirm(false)}>
							继续编辑
						</Button>
						<Button type="button" variant="destructive" onClick={() => router.push("/agents")}>
							放弃并返回
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={enableConflict !== null} onOpenChange={(open) => { if (!open && !toggling) setEnableConflict(null); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>停用「{agentDisplayName(agent)}」</DialogTitle>
						<DialogDescription>{enableConflict?.message}</DialogDescription>
					</DialogHeader>
					{enableConflict && enableConflict.runs.length > 0 ? (
						<div className="flex flex-col gap-1">
							<span className="text-sm text-muted-foreground">进行中 / 等待审批的 Run：</span>
							{enableConflict.runs.map((run) => <div key={run.delegationId} className="font-mono text-xs text-muted-foreground">{run.delegationId} · {run.executionState} · 窗口 {run.windowId}</div>)}
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={toggling} onClick={() => setEnableConflict(null)}>继续保留</Button>
						<Button type="button" variant="outline" disabled={toggling} onClick={() => void handleToggleEnabled(false, "keep")}>保留 Run 并停用</Button>
						<Button type="button" variant="destructive" disabled={toggling} onClick={() => void handleToggleEnabled(false, "cancel")}>取消 Run 并停用</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={deleteConfirm} onOpenChange={(open) => { if (!open && !deleting) setDeleteConfirm(false); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除智能体</DialogTitle>
						<DialogDescription>删除「{agentDisplayName(agent)}」的配置？现有会话保留历史信息，删除后无法恢复此 Agent。</DialogDescription>
					</DialogHeader>
					{agent.enabled !== false ? <p className="text-sm text-muted-foreground">请先停用此 Agent，处理进行中的 Run，再删除。</p> : null}
					{dirty ? <p className="text-sm text-muted-foreground">当前草稿有未保存的修改；删除后这些修改会丢失。</p> : null}
					{deleteError ? <p role="alert" className="text-sm text-destructive">{deleteError}</p> : null}
					{deleteRuns.length > 0 ? <div className="flex flex-col gap-1 text-xs text-muted-foreground">{deleteRuns.map((run) => <div key={run.delegationId} className="font-mono">{run.delegationId} · {run.executionState} · 窗口 {run.windowId}</div>)}</div> : null}
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={deleting} onClick={() => setDeleteConfirm(false)}>取消</Button>
						<Button type="button" variant="destructive" disabled={deleting || agent.enabled !== false} onClick={() => void handleDelete()}>{deleting ? <LoaderIcon className="size-4 animate-spin" /> : null}{deleteRuns.length > 0 ? "重新检查并删除" : "删除"}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
