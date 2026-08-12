"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
	ArrowLeftIcon,
	CopyIcon,
	DownloadIcon,
	LoaderIcon,
	RefreshCwIcon,
	SaveIcon,
	UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiConflictError, listAgents, probeAgent, putAgentConfig, setAgentEnabled } from "@/lib/api";
import type { AgentConfig, AgentProbeResult, PiManagerSettings } from "@/lib/types";
import { isConnectorProbe } from "@/lib/types";
import { WorkerAvatar } from "@/components/chat/worker-avatar";
import {
	buildConfigBody,
	draftFromAgent,
	isPiAgent,
	serializeDraft,
	type ConfigDraft,
} from "@/components/agent-config/draft";
import { OverviewSection } from "@/components/agent-config/overview-section";
import { ModelSection } from "@/components/agent-config/model-section";
import { PromptSection } from "@/components/agent-config/prompt-section";
import { ResourceLibrarySection } from "@/components/agent-config/resource-library-section";

/**
 * Pi Agent 独立配置页（§10.5）：概览 / 模型与运行 / 提示词 / 技能 / 模板
 * 五个分区编辑同一份页面级草稿，一个「保存」调 PUT /api/agents/:name/config
 * 一次提交；pinned manager 与 pi worker 同表单同接口（模型与运行分区按
 * pinned 渲染 PiManagerSettings 或 connector config）。
 */

type SectionKey = "overview" | "model" | "prompt" | "skills" | "templates";

const SECTIONS: Array<{ key: SectionKey; label: string }> = [
	{ key: "overview", label: "概览" },
	{ key: "model", label: "模型与运行" },
	{ key: "prompt", label: "提示词" },
	{ key: "skills", label: "技能" },
	{ key: "templates", label: "模板" },
];

function probeSummary(probe: AgentProbeResult): string {
	if (isConnectorProbe(probe)) {
		if (!probe.extensionInstalled) return "扩展未安装";
		if (!probe.detected) return "CLI 未检测";
		if (probe.compatibility === "incompatible") return "不兼容";
		return "探测正常";
	}
	return probe.ok ? "探测健康" : `探测异常：${probe.error ?? `exit ${probe.exitCode}`}`;
}

/** 导出 / 导入 JSON 的载体：草稿 + 责任边界，便于跨环境搬运。 */
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
	const importInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		let cancelled = false;
		listAgents()
			.then((list) => {
				if (cancelled) return;
				setAgents(list);
				const found = list.find((item) => item.name === name) ?? null;
				setAgent(found);
				if (found && isPiAgent(found)) {
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

	const handleBack = useCallback(() => {
		if (dirty) setLeaveConfirm(true);
		else router.push("/?view=agents");
	}, [dirty, router]);

	const handleSave = useCallback(async () => {
		if (!agent || !draft) return;
		setSaving(true);
		try {
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
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [agent, draft]);

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

	// ---- 加载 / 404 / 非 pi 三态 ----

	if (loadError) {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3">
				<p className="text-sm text-destructive">无法加载智能体列表：{loadError}</p>
				<Button size="sm" variant="outline" onClick={() => router.push("/?view=agents")}>
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
	if (!agent) {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3">
				<p className="text-sm text-muted-foreground">智能体「{name}」不存在（404）。</p>
				<Button size="sm" variant="outline" onClick={() => router.push("/?view=agents")}>
					返回智能体列表
				</Button>
			</div>
		);
	}
	if (!isPiAgent(agent) || !draft) {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3">
				<p className="text-sm text-muted-foreground">
					「{agent.name}」不是 pi Agent（connector: {agent.connector?.connectorId ?? "命令接入"}），此配置页只承载
					pinned manager 与 pi Connector worker。
				</p>
				<Button size="sm" variant="outline" onClick={() => router.push("/?view=agents")}>
					返回智能体列表
				</Button>
			</div>
		);
	}

	const copySources = agents.filter((item) => item.name !== agent.name && isPiAgent(item));

	return (
		<div className="flex h-dvh flex-col bg-background">
			{/* header */}
			<div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
				<Button size="sm" variant="ghost" onClick={handleBack}>
					<ArrowLeftIcon className="size-4" />
					返回
				</Button>
				<WorkerAvatar name={agent.name} size={40} />
				<div className="min-w-0">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-mono text-sm font-medium">{agent.name}</span>
						<Badge variant="outline">{agent.pinned ? "Manager" : (agent.connector?.connectorId ?? "worker")}</Badge>
					</div>
					<p className="truncate text-xs text-muted-foreground">{agent.description || "（无描述）"}</p>
				</div>

				{agent.pinned ? (
					<Badge variant="secondary">已启用（不可禁用）</Badge>
				) : (
					<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
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

				{agent.pinned ? null : (
					<div className="flex items-center gap-1.5">
						<Button size="sm" variant="outline" disabled={probing} onClick={() => void handleProbe()}>
							{probing ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
							探测
						</Button>
						{probe ? (
							<span className={`text-xs ${isConnectorProbe(probe) ? (probe.detected && probe.compatibility !== "incompatible" ? "text-muted-foreground" : "text-destructive") : probe.ok ? "text-muted-foreground" : "text-destructive"}`}>
								{probeSummary(probe)}
							</span>
						) : null}
					</div>
				)}

				<div className="ml-auto flex flex-wrap items-center gap-2">
					<Select onValueChange={handleCopyFrom}>
						<SelectTrigger size="sm" className="w-44">
							<CopyIcon className="size-3.5" />
							<SelectValue placeholder="从其他 Agent 复制配置" />
						</SelectTrigger>
						<SelectContent>
							{copySources.length === 0 ? (
								<SelectItem value="__none__" disabled>
									没有其他 pi Agent
								</SelectItem>
							) : (
								copySources.map((item) => (
									<SelectItem key={item.name} value={item.name}>
										{item.name}
										{item.pinned ? "（Manager）" : ""}
									</SelectItem>
								))
							)}
						</SelectContent>
					</Select>
					<Button size="sm" variant="outline" onClick={handleExport}>
						<DownloadIcon className="size-3.5" />
						导出 JSON
					</Button>
					<Button size="sm" variant="outline" onClick={() => importInputRef.current?.click()}>
						<UploadIcon className="size-3.5" />
						导入 JSON
					</Button>
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
						保存{dirty ? "（有未保存更改）" : ""}
					</Button>
				</div>
			</div>

			{/* 分区导航 + 内容 */}
			<div className="flex min-h-0 flex-1">
				<nav className="flex w-36 shrink-0 flex-col gap-1 border-r px-2 py-3">
					{SECTIONS.map((item) => (
						<button
							key={item.key}
							type="button"
							onClick={() => setSection(item.key)}
							className={`rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
								section === item.key ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"
							}`}
						>
							{item.label}
						</button>
					))}
				</nav>
				<main className="min-w-0 flex-1 overflow-y-auto">
					<div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
						<div className="flex items-baseline gap-2">
							<h1 className="text-sm font-semibold">{SECTIONS.find((item) => item.key === section)?.label}</h1>
							{dirty ? <span className="text-xs text-muted-foreground">草稿已修改，保存后生效</span> : null}
						</div>
						{section === "overview" ? <OverviewSection draft={draft} onChange={patchDraft} /> : null}
						{section === "model" ? <ModelSection agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{section === "prompt" ? <PromptSection agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{section === "skills" ? <ResourceLibrarySection kind="skills" agent={agent} draft={draft} onChange={patchDraft} /> : null}
						{section === "templates" ? <ResourceLibrarySection kind="templates" agent={agent} draft={draft} onChange={patchDraft} /> : null}
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
						<Button type="button" variant="destructive" onClick={() => router.push("/?view=agents")}>
							放弃并返回
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
