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
	LoaderIcon,
	MessageSquareTextIcon,
	MoreHorizontalIcon,
	PlugIcon,
	RefreshCwIcon,
	SaveIcon,
	SlidersHorizontalIcon,
	UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiConflictError, listAgents, probeAgent, putAgentConfig, setAgentEnabled, updateAgent } from "@/lib/api";
import type { AgentConfig, AgentProbeResult, MutationResponse, PiManagerSettings } from "@/lib/types";
import { isConnectorProbe } from "@/lib/types";
import { WorkerAvatar } from "@/components/chat/worker-avatar";
import {
	buildConfigBody,
	buildResponsibility,
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

/**
 * Agent 独立配置页（§10.5）：所有角色统一入口。
 * - pinned manager 与 pi worker：概览 / 模型与运行 / 提示词 / 模板四个分区编辑
 *   同一份页面级草稿，一个「保存」调 PUT /api/agents/:name/config 一次提交；
 * - 其余 connector / legacy worker：概览（描述 + 责任边界，随页面「保存」走
 *   全量 upsert）+ 基础接入 / Extensions / 运行状态三个分区（各自独立保存，
 *   见 connector-sections.tsx）。
 */

type SectionKey = "overview" | "model" | "prompt" | "templates" | "connector" | "extensions" | "status";

type SectionDef = { key: SectionKey; label: string; description: string; icon: typeof InfoIcon };

const OVERVIEW_SECTION: SectionDef = {
	key: "overview",
	label: "概览",
	description: "定义用户看见的角色信息，以及 Manager 在协作中使用的责任边界。",
	icon: InfoIcon,
};

const PI_SECTIONS: SectionDef[] = [
	OVERVIEW_SECTION,
	{ key: "model", label: "模型与运行", description: "选择模型、思考强度与上下文加载方式。", icon: SlidersHorizontalIcon },
	{ key: "prompt", label: "提示词", description: "运行指令只属于 Agent；群聊协作规则仍在聊天信息中管理。", icon: MessageSquareTextIcon },
	{ key: "templates", label: "模板", description: "管理可复用提示模板，让常用协作方式保持一致。", icon: BoxIcon },
];

const CONNECTOR_SECTIONS: SectionDef[] = [
	OVERVIEW_SECTION,
	{ key: "connector", label: "基础接入", description: "选择 Connector Extension、填写接入配置与密钥。", icon: PlugIcon },
	{ key: "extensions", label: "Extensions", description: "绑定 Capability Extension，为 Worker 注册额外工具。", icon: BoxesIcon },
	{ key: "status", label: "运行状态", description: "启停 Agent、探测本机接入、查看写操作对会话的影响。", icon: ActivityIcon },
];

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

/** 导出 / 导入 JSON 的载体：草稿 + 责任边界，便于跨环境搬运（仅 pi Agent）。 */
interface ConfigTransfer {
	description?: string;
	responsibility?: AgentConfig["responsibility"] | null;
	manager?: PiManagerSettings;
	connectorConfig?: Record<string, unknown>;
	piResources?: AgentConfig["piResources"];
}

export function AgentConfigPage({ name }: { name: string }) {
	const router = useRouter();
	const [agents, setAgents] = useState<AgentConfig[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [agent, setAgent] = useState<AgentConfig | null>(null);
	const [draft, setDraft] = useState<ConfigDraft | null>(null);
	const [baseline, setBaseline] = useState("");
	const [section, setSection] = useState<SectionKey>("overview");
	const [saving, setSaving] = useState(false);
	const [probe, setProbe] = useState<AgentProbeResult | null>(null);
	const [probing, setProbing] = useState(false);
	const [toggling, setToggling] = useState(false);
	const [leaveConfirm, setLeaveConfirm] = useState(false);
	const [lastMutation, setLastMutation] = useState<MutationResponse | null>(null);
	const importInputRef = useRef<HTMLInputElement>(null);

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
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [name]);

	const dirty = useMemo(() => (draft ? serializeDraft(draft) !== baseline : false), [draft, baseline]);

	const patchDraft = useCallback((patch: Partial<ConfigDraft>) => {
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
	}, []);

	/** 分区写操作（Connector 绑定 / Capability 绑定）回写 agent 并记录影响。 */
	const handleMutation = useCallback((res: MutationResponse) => {
		setLastMutation(res);
		setAgent(res.agent);
		setAgents((prev) => prev?.map((item) => (item.name === res.agent.name ? res.agent : item)) ?? prev);
	}, []);

	/** legacy 命令接入保存后直接回写 agent。 */
	const handleAgentSaved = useCallback((updated: AgentConfig) => {
		setAgent(updated);
		setAgents((prev) => prev?.map((item) => (item.name === updated.name ? updated : item)) ?? prev);
	}, []);

	const handleBack = useCallback(() => {
		if (dirty) setLeaveConfirm(true);
		else router.push("/agents");
	}, [dirty, router]);

	const handleSave = useCallback(async () => {
		if (!agent || !draft) return;
		setSaving(true);
		try {
			if (isPiAgent(agent)) {
				const mutation = await putAgentConfig(agent.name, buildConfigBody(agent, draft));
				setAgent(mutation.agent);
				setAgents((prev) => prev?.map((item) => (item.name === mutation.agent.name ? mutation.agent : item)) ?? prev);
				const next = draftFromAgent(mutation.agent);
				setDraft(next);
				setBaseline(serializeDraft(next));
				const { affectedSessions, activeNow, reloadPending } = mutation.affectedSessions;
				toast.success(
					affectedSessions > 0
						? `「${agent.name}」配置已保存；${affectedSessions} 个会话受影响（${activeNow} 个立即生效，${reloadPending} 个回合结束后刷新）`
						: `「${agent.name}」配置已保存；新建或重开的 Session 生效`,
				);
				for (const warning of mutation.securityWarnings ?? []) toast.warning(warning);
			} else {
				// connector / legacy worker 只保存概览字段（描述 + 责任边界），全量 upsert
				// 语义与原管理抽屉一致：责任边界全空 = 不提交该键（保留现状）。
				const responsibility = buildResponsibility(draft) ?? undefined;
				const updated = await updateAgent(agent.name, {
					...agent,
					description: draft.description.trim(),
					responsibility,
				});
				handleAgentSaved(updated);
				const next = draftFromAgent(updated);
				setDraft(next);
				setBaseline(serializeDraft(next));
				toast.success(`「${agent.name}」配置已保存；新建或重开的 Session 生效`);
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [agent, draft, handleAgentSaved]);

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
		const body = buildConfigBody(agent, draft);
		const transfer: ConfigTransfer = {
			description: body.description,
			responsibility: body.responsibility,
			...(body.manager ? { manager: body.manager as PiManagerSettings } : {}),
			...(body.connector ? { connectorConfig: body.connector.config } : {}),
			piResources: body.piResources,
		};
		const blob = new Blob([JSON.stringify(transfer, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${agent.name}-config.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	}, [agent, draft]);

	const handleImportFile = useCallback(async (file: File) => {
		try {
			const parsed: unknown = JSON.parse(await file.text());
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("不是合法的 JSON 对象");
			const transfer = parsed as ConfigTransfer;
			if (transfer.description !== undefined && typeof transfer.description !== "string") throw new Error("description 必须是字符串");
			if (transfer.responsibility !== undefined && transfer.responsibility !== null && typeof transfer.responsibility !== "object")
				throw new Error("responsibility 必须是对象或 null");
			if (transfer.manager !== undefined && typeof transfer.manager !== "object") throw new Error("manager 必须是对象");
			if (transfer.connectorConfig !== undefined && typeof transfer.connectorConfig !== "object") throw new Error("connectorConfig 必须是对象");
			if (transfer.piResources !== undefined && transfer.piResources !== null && typeof transfer.piResources !== "object")
				throw new Error("piResources 必须是对象或 null");
			setDraft((prev) => {
				if (!prev) return prev;
				const next: ConfigDraft = { ...prev };
				if (typeof transfer.description === "string") next.description = transfer.description;
				if (transfer.responsibility !== undefined) {
					const profile = transfer.responsibility;
					next.identity = profile?.identity ?? "";
					next.domain = profile?.domain ?? "";
					next.owns = (profile?.owns ?? []).join("\n");
					next.excludes = (profile?.excludes ?? []).join("\n");
					next.escalateWhen = (profile?.escalateWhen ?? []).join("\n");
				}
				if (transfer.manager) next.manager = { ...transfer.manager };
				if (transfer.connectorConfig) next.connectorConfig = { ...transfer.connectorConfig };
				if (transfer.piResources !== undefined) {
					const resources = transfer.piResources ?? {};
					next.systemPrompt = resources.systemPrompt ?? "";
					next.skillPaths = (resources.skillPaths ?? []).join("\n");
					next.promptTemplatePaths = (resources.promptTemplatePaths ?? []).join("\n");
					next.enabledSkills = [...(resources.enabledSkills ?? [])];
					next.enabledPrompts = [...(resources.enabledPrompts ?? [])];
					next.loadWorkspaceSkills = resources.loadWorkspaceSkills !== false;
					next.loadWorkspacePrompts = resources.loadWorkspacePrompts !== false;
					next.loadWorkspaceContext = resources.loadWorkspaceContext !== false;
				}
				return next;
			});
			toast.success("已导入到草稿，保存后生效");
		} catch (err) {
			toast.error(`导入失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}, []);

	const handleProbe = useCallback(async () => {
		if (!agent) return;
		setProbing(true);
		try {
			setProbe(await probeAgent(agent.name));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(false);
		}
	}, [agent]);

	const handleToggleEnabled = useCallback(
		async (enabled: boolean) => {
			if (!agent) return;
			setToggling(true);
			try {
				const mutation = await setAgentEnabled(agent.name, enabled);
				setAgent(mutation.agent);
				setAgents((prev) => prev?.map((item) => (item.name === mutation.agent.name ? mutation.agent : item)) ?? prev);
				toast.success(enabled ? `「${agent.name}」已启用` : `「${agent.name}」已停用`);
			} catch (err) {
				if (err instanceof ApiConflictError) {
					toast.error(`${err.message}（请先在智能体列表处理进行中的 Run）`);
				} else {
					toast.error(err instanceof Error ? err.message : String(err));
				}
			} finally {
				setToggling(false);
			}
		},
		[agent],
	);

	// ---- 加载 / 404 两态 ----

	if (loadError) {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3">
				<p className="text-sm text-destructive">无法加载智能体列表：{loadError}</p>
				<Button size="sm" variant="outline" onClick={() => router.push("/agents")}>
					返回
				</Button>
			</div>
		);
	}
	if (agents === null) {
		return (
			<div className="flex h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
				<LoaderIcon className="size-4 animate-spin" />
				加载中…
			</div>
		);
	}
	if (!agent || !draft) {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3">
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
		<div className="agent-config-shell flex h-full min-w-0 flex-1 flex-col bg-background">
			{/* header */}
			<header className="agent-config-head">
				<Button size="icon" variant="ghost" onClick={handleBack} aria-label="返回智能体列表" title="返回智能体列表">
					<ArrowLeftIcon className="size-4" />
				</Button>
				<WorkerAvatar name={agent.name} size={40} />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate text-sm font-semibold">{agent.name}</span>
						<Badge variant="secondary">{agent.pinned ? "Manager" : (agent.connector?.connectorId ?? "worker")}</Badge>
					</div>
					<p className="truncate text-xs text-muted-foreground">{agent.description || "（无描述）"}</p>
				</div>

				{agent.pinned ? (
					<span className="agent-config-status">已启用</span>
				) : (
					<label className="agent-config-status flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={agent.enabled !== false}
							disabled={toggling}
							onChange={(e) => void handleToggleEnabled(e.target.checked)}
							className="size-4 accent-foreground"
						/>
						{agent.enabled !== false ? "已启用" : "已停用"}
					</label>
				)}

				<div className="agent-config-actions">
					{agent.pinned ? null : (
						<Button size="sm" variant="outline" disabled={probing} onClick={() => void handleProbe()}>
							{probing ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
							探测
						</Button>
					)}
					{piMode ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button size="icon" variant="ghost" aria-label="更多配置操作" title="更多配置操作"><MoreHorizontalIcon className="size-4" /></Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-52">
								<DropdownMenuSub>
									<DropdownMenuSubTrigger disabled={copySources.length === 0}><CopyIcon />从其他 Agent 复制</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										{copySources.map((item) => <DropdownMenuItem key={item.name} onSelect={() => handleCopyFrom(item.name)}>{item.name}{item.pinned ? "（Manager）" : ""}</DropdownMenuItem>)}
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={handleExport}><DownloadIcon />导出 JSON</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => importInputRef.current?.click()}><UploadIcon />导入 JSON</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					<input
						ref={importInputRef}
						type="file"
						accept="application/json,.json"
						className="hidden"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void handleImportFile(file);
							e.target.value = "";
						}}
					/>
					<Button size="sm" disabled={saving || !dirty} onClick={() => void handleSave()}>
						{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : <SaveIcon className="size-3.5" />}
						保存{dirty ? " · 有更改" : ""}
					</Button>
				</div>
				{probe ? <span className={`agent-config-probe ${isConnectorProbe(probe) ? (probe.detected && probe.compatibility !== "incompatible" ? "" : "text-destructive") : probe.ok ? "" : "text-destructive"}`}>{probeSummary(probe)}</span> : null}
			</header>

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
						>
							<item.icon className="size-4" />
							{item.label}
						</button>
					))}
				</nav>
				<main className="agent-config-content">
					<div className="agent-config-column">
						<div className="agent-config-title-row">
							<div><h1>{sections.find((item) => item.key === section)?.label}</h1><p>{sections.find((item) => item.key === section)?.description}</p></div>
							{dirty ? <span>草稿已修改</span> : null}
						</div>
						{section === "overview" ? <OverviewSection agent={agent} draft={draft} onChange={patchDraft} onAgentUpdated={handleAgentSaved} /> : null}
						{piMode && section === "model" ? <ModelSection agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{piMode && section === "prompt" ? <PromptSection agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{piMode && section === "templates" ? <ResourceLibrarySection kind="templates" agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{!piMode && section === "connector" ? (
							legacy ? (
								<LegacyInvokeSection agent={agent} onSaved={handleAgentSaved} />
							) : (
								<ConnectorSection agent={agent} onMutation={handleMutation} />
							)
						) : null}
						{!piMode && section === "extensions" ? <BindingsSection agent={agent} onMutation={handleMutation} /> : null}
						{!piMode && section === "status" ? <StatusSection agent={agent} lastMutation={lastMutation} onToggleEnabled={handleToggleEnabled} toggling={toggling} /> : null}
					</div>
				</main>
			</div>

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
		</div>
	);
}
