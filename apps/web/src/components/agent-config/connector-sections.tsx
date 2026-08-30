"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircleIcon, CheckCircle2Icon, CheckIcon, LoaderIcon, PauseCircleIcon, PlayIcon, PlusIcon, PuzzleIcon, RefreshCwIcon, TrashIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	addAgentBinding,
	deleteAgentBinding,
	getAgentConnector,
	getAgentExecutionCapabilities,
	listAgentBindings,
	listExtensionCatalog,
	listExtensionConnections,
	patchAgentBinding,
	probeAgent,
	probeAgentBinding,
	putAgentConnector,
	runExtensionConnectionAction,
	updateAgent,
	type AgentExecutionCapabilities,
} from "@/lib/api";
import type {
	AgentCapabilityBinding,
	AgentConfig,
	AgentConnectorBinding,
	AgentProbeResult,
	BindingProbeResult,
	CatalogEntry,
	ConnectorProbeResult,
	ExtensionPermission,
	ExtensionConnectionStatus,
	MutationResponse,
	ToolActivation,
	WorkerProbeResult,
} from "@/lib/types";
import { isConnectorProbe } from "@/lib/types";
import { AffectedNote, ConfigSchemaForm, SecretSchemaFields, SecretsEditor } from "@/components/agents/form-parts";

/**
 * Connector / legacy worker 的配置分区（§10.1），嵌在独立配置页
 * （/agents/config?name=）里按分区导航渲染：
 * 1. 基础接入：Connector 选择/更换、config schema 表单、secret 单独输入、
 *    probe 状态与四操作能力；legacy command invoke 的 Agent 在这里编辑命令；
 * 2. Extensions：Capability 绑定列表（版本/来源/工具/激活方式/配置/启停/删除）
 *    + “添加 Extension”（只列 kind=capability 且与当前 connectorId 兼容的项）；
 * 3. 运行状态：总开关、extensionRevision、最近写操作的 activeNow/reloadPending。
 */
/** 安装来源三态（文档 §8）。 */
const ORIGIN_LABELS: Record<CatalogEntry["origin"], string> = {
	builtin: "平台内置",
	bundled: "随产品预置",
	user: "用户安装",
	"local-link": "开发者本地链接",
};

const SOURCE_LABELS: Record<string, string> = {
	builtin: "内置来源",
	trusted: "可信来源",
	external: "外部来源",
};

const PERMISSION_LABELS: Record<ExtensionPermission, string> = {
	spawn: "启动本地进程",
	network: "访问网络",
	workspace: "访问工作区",
	secrets: "读取已授权密钥",
};

type ExtensionConnectionAction = NonNullable<ExtensionConnectionStatus["actions"]>[number];

function connectorTransportLabel(transport?: string): string {
	// The catalog and agent payload arrive independently. During a hot reload or
	// while an older in-memory server response is still on screen, the binding can
	// temporarily lack the newly required transport field. Rendering must remain
	// total; the form below resolves the manifest default and persists it on save.
	if (!transport) return "未声明（保存时使用默认值）";
	if (transport === "spawn") return "CLI spawn";
	if (transport === "http") return "HTTP 流式";
	if (transport === "sdk") return "进程内 SDK";
	return transport.toUpperCase();
}

// ---- probe 展示 ----

/** 探测完成的即时反馈：结果卡渲染在按钮下方、可能在视区外，用 toast 兜底。 */
function probeToast(probe: AgentProbeResult): void {
	if (isConnectorProbe(probe)) {
		const summary = connectorProbeSummary(probe);
		if (summary.tone === "success") toast.success("接入探测通过");
		else if (summary.tone === "warning") toast.warning("接入可用，但兼容性待确认");
		else toast.error("接入探测未通过，详见下方结果卡");
		return;
	}
	if (probe.ok) toast.success("探测通过");
	else toast.error("探测未通过，详见下方结果卡");
}

type ConnectorProbeTone = "success" | "warning" | "error";

interface ConnectorProbeSummary {
	title: string;
	description: string;
	tone: ConnectorProbeTone;
}

/** Probe 回答“接入是否可用”；Worker 是否接活是另一个维度，不能混成同一个结论。 */
function connectorProbeSummary(probe: ConnectorProbeResult): ConnectorProbeSummary {
	const transport = probe.transport ?? probe.capabilities.transport;
	const target = transport === "http" ? "API" : transport === "spawn" ? "CLI" : "接入端";
	if (!probe.extensionInstalled) return { title: "连接插件未安装", description: "先安装对应插件，再重新探测接入状态。", tone: "error" };
	if (!probe.configured) return { title: "接入配置不完整", description: `补全 ${target} 配置后再重新探测。`, tone: "error" };
	if (!probe.detected) return {
		title: transport === "http" ? "API 暂时不可达" : transport === "spawn" ? "未检测到 CLI" : "接入端不可用",
		description: transport === "http" ? "请检查服务地址、端口和上游服务状态。" : "请检查安装路径和运行环境。",
		tone: "error",
	};
	if (probe.authenticated === false) return { title: "认证未通过", description: `${target} 可访问，但当前凭证无法完成认证。`, tone: "error" };
	if (probe.compatibility === "incompatible") return { title: "协议不兼容", description: "接入端可访问，但协议版本不在当前连接插件的支持范围内。", tone: "error" };
	if (probe.compatibility === "untested" || probe.compatibility === "unknown") return {
		title: "连接可用，兼容性待确认",
		description: "已连接到接入端，但当前版本尚未经过兼容性验证。",
		tone: "warning",
	};
	return {
		title: transport === "http" ? "HTTP 接入正常" : transport === "spawn" ? "CLI 接入正常" : "接入正常",
		description: `${target} 可访问，协议与能力声明已验证。`,
		tone: "success",
	};
}

const COMPATIBILITY_LABELS: Record<ConnectorProbeResult["compatibility"], string> = {
	supported: "已验证",
	untested: "未经验证",
	incompatible: "不兼容",
	unknown: "未知",
};

const OPERATION_LABELS: Record<ConnectorProbeResult["capabilities"]["operations"][number], string> = {
	run: "发起任务",
	continue: "继续会话",
	respond: "回复交互请求",
	cancel: "取消任务",
};

const INTERACTION_LABELS: Record<ConnectorProbeResult["capabilities"]["interactionKinds"][number], string> = {
	permission: "权限审批",
	question: "问题确认",
	confirmation: "操作确认",
};

const PROGRESS_LABELS: Record<ConnectorProbeResult["capabilities"]["progress"], string> = {
	none: "无进度回传",
	coarse: "阶段性进度",
	stream: "实时流式进度",
};

function ConnectorProbeView({ probe }: { probe: ConnectorProbeResult }) {
	const summary = connectorProbeSummary(probe);
	const transport = probe.transport ?? probe.capabilities.transport;
	const capabilityLabels = [
		...probe.capabilities.operations.map((operation) => OPERATION_LABELS[operation]),
		...probe.capabilities.interactionKinds.map((kind) => INTERACTION_LABELS[kind]),
		...(probe.capabilities.progress === "none" ? [] : [PROGRESS_LABELS[probe.capabilities.progress]]),
		...(probe.capabilities.reconciliation === "query_run" ? ["远端 Run 查询对账"] : probe.capabilities.reconciliation === "reattach_stream" ? ["远端 Run 流重挂"] : []),
		...(probe.capabilities.cancelConfirmation === "acknowledged" ? ["取消明确确认"] : probe.capabilities.cancelConfirmation === "observable" ? ["取消终态观测"] : []),
		...(probe.capabilities.workspace?.honorsInvocationCwd ? ["执行目录强绑定"] : []),
		...(probe.capabilities.workspace?.readOnlyEnforcement !== undefined && probe.capabilities.workspace.readOnlyEnforcement !== "none" ? ["只读边界强制"] : []),
		...(probe.capabilities.verification?.freshSession ? ["Verifier fresh Session"] : []),
		...(probe.capabilities.verification?.commandExecution ? ["CLI 命令复验"] : []),
		...(probe.capabilities.verification?.workspaceIsolation.includes("isolated_copy") ? ["隔离副本复验"] : []),
		...(probe.capabilities.verification?.workspaceIsolation.includes("mutation_guard") ? ["原目标修改守卫"] : []),
	];
	const detailItems = [
		{ label: "接入方式", value: connectorTransportLabel(transport) },
		{ label: "兼容性", value: COMPATIBILITY_LABELS[probe.compatibility] },
		...(probe.version ? [{ label: "协议版本", value: `v${probe.version}` }] : []),
		...(probe.upstreamVersion ? [{ label: transport === "http" ? "服务版本" : "CLI 版本", value: `v${probe.upstreamVersion}` }] : []),
		...(probe.extensionVersion ? [{ label: "连接插件版本", value: `v${probe.extensionVersion}` }] : []),
	];
	return (
		<div className="agent-config-inset overflow-hidden p-0">
			<div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
				<div className="flex min-w-0 items-start gap-2.5">
					{summary.tone === "success" ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
					{summary.tone === "warning" ? <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" /> : null}
					{summary.tone === "error" ? <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" /> : null}
					<div className="min-w-0">
						<p className="text-sm font-semibold leading-5">{summary.title}</p>
						<p className="mt-0.5 text-xs leading-5 text-muted-foreground">{summary.description}</p>
					</div>
				</div>
				<Badge variant={probe.enabled ? "secondary" : "outline"} className="shrink-0">
					{probe.enabled ? "Worker 已启用" : "Worker 已停用"}
				</Badge>
			</div>
			<div className="border-t border-border/60 px-4 py-3.5">
				<p className="mb-2 text-[11px] font-medium text-muted-foreground">可用能力</p>
				<div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
					{capabilityLabels.map((label) => (
						<div key={label} className="flex items-center gap-2 text-xs text-foreground/85">
							<CheckIcon className="size-3.5 shrink-0 text-primary" />
							<span>{label}</span>
						</div>
					))}
					{capabilityLabels.length === 0 ? <p className="text-xs text-muted-foreground">未声明可用能力</p> : null}
				</div>
			</div>
			<dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-border/60 px-4 py-3.5 sm:grid-cols-5">
				{detailItems.map((item) => (
					<div key={item.label} className="min-w-0">
						<dt className="text-[10px] text-muted-foreground">{item.label}</dt>
						<dd className="mt-0.5 truncate text-xs font-medium" title={item.value}>{item.value}</dd>
					</div>
				))}
			</dl>
			{probe.issues.length > 0 ? (
				<div className="border-t border-border/60 px-4 py-3.5">
					<p className="mb-1.5 text-[11px] font-medium text-destructive">需要处理</p>
					<div className="flex flex-col gap-1.5">
						{probe.issues.map((issue, i) => (
							<div key={`${issue.code}-${i}`} className="text-xs leading-5">
								<span className="text-destructive">{issue.message}</span>
								{issue.fixAction ? <span className="ml-1 text-muted-foreground">建议：{issue.fixAction}</span> : null}
								<code className="ml-1 font-mono text-[10px] text-muted-foreground/60">{issue.code}</code>
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

function LegacyProbeView({ probe }: { probe: WorkerProbeResult }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="agent-config-inset flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<Badge variant={probe.ok ? "secondary" : "destructive"}>{probe.ok ? "健康" : "异常"}</Badge>
				<span className="text-xs text-muted-foreground">exit {probe.exitCode}</span>
				<button type="button" className="text-xs text-muted-foreground underline" onClick={() => setOpen((o) => !o)}>
					{open ? "收起" : "详情"}
				</button>
			</div>
			{probe.error ? <p className="text-xs text-destructive">{probe.error}</p> : null}
			{open ? (
				<pre className="overflow-x-auto rounded-md bg-background/60 p-2 text-xs">{JSON.stringify(probe.raw, null, 2)}</pre>
			) : null}
		</div>
	);
}

function BindingProbeView({ probe }: { probe: BindingProbeResult }) {
	const detailItems = probe.details
		? Object.entries(probe.details).filter(([, value]) => value !== undefined && value !== null && value !== "")
		: [];
	const loginCommand = typeof probe.details?.loginCommand === "string" ? probe.details.loginCommand : undefined;
	return (
		<div className="agent-config-inset flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge variant={probe.extensionInstalled ? "secondary" : "destructive"}>
					{probe.extensionInstalled ? "扩展已安装" : "扩展未安装"}
				</Badge>
				<Badge variant={probe.loaded ? "secondary" : "destructive"}>{probe.loaded ? "已加载" : "加载失败"}</Badge>
				<Badge variant={probe.enabled ? "secondary" : "outline"}>{probe.enabled ? "已启用" : "已停用"}</Badge>
				{probe.authenticated !== undefined ? (
					<Badge variant={probe.authenticated === true ? "secondary" : probe.authenticated === false ? "destructive" : "outline"}>
						{probe.authenticated === true ? "已登录" : probe.authenticated === false ? "未登录" : "登录状态未知"}
					</Badge>
				) : null}
				{probe.extensionVersion ? <Badge variant="outline">v{probe.extensionVersion}</Badge> : null}
				{probe.activation ? <Badge variant="outline">激活：{probe.activation}</Badge> : null}
			</div>
			{probe.tools.length > 0 ? (
				<div className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">将注册的工具</span>
					{probe.tools.map((tool) => (
						<code key={tool} className="truncate font-mono text-xs text-muted-foreground">
							{tool}
						</code>
					))}
				</div>
			) : null}
			{detailItems.length > 0 ? (
				<dl className="grid gap-x-4 gap-y-1.5 border-t border-border/60 pt-2 sm:grid-cols-2">
					{detailItems.filter(([key]) => key !== "loginCommand").map(([key, value]) => (
						<div key={key} className="min-w-0">
							<dt className="text-[10px] text-muted-foreground">{key}</dt>
							<dd className="truncate text-xs" title={String(value)}>{String(value)}</dd>
						</div>
					))}
				</dl>
			) : null}
			{loginCommand ? (
				<div className="border-t border-border/60 pt-2">
					<span className="text-xs text-muted-foreground">登录命令</span>
					<pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 text-xs">{loginCommand}</pre>
				</div>
			) : null}
			{probe.issues.length > 0 ? (
				<div className="flex flex-col gap-0.5">
					{probe.issues.map((issue, i) => (
						<p key={`${issue.code}-${i}`} className="text-xs text-destructive">
							{issue.message}
							{issue.fixAction ? <span className="ml-1 text-muted-foreground">建议：{issue.fixAction}</span> : null}
							<code className="ml-1 font-mono text-muted-foreground/70">({issue.code})</code>
						</p>
					))}
				</div>
			) : null}
		</div>
	);
}

// ---- 分区 1：基础接入（Connector） ----

export function ConnectorSection({
	agent,
	onMutation,
}: {
	agent: AgentConfig;
	onMutation: (res: MutationResponse) => void;
}) {
	const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
	const [extensionId, setExtensionId] = useState(agent.connector?.extensionId ?? "");
	const [transport, setTransport] = useState<AgentConnectorBinding["transport"] | "">(agent.connector?.transport ?? "");
	const [config, setConfig] = useState<Record<string, unknown>>(agent.connector?.config ?? {});
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [versionPin, setVersionPin] = useState(agent.connector?.versionPin ?? "");
	const [saving, setSaving] = useState(false);
	const [probe, setProbe] = useState<AgentProbeResult | null>(null);
	const [probing, setProbing] = useState(false);
	const [executionCapabilities, setExecutionCapabilities] = useState<AgentExecutionCapabilities | null>(null);

	// Agent 切换/外部更新时重置表单（渲染期间随 prop 变化重置，避免 effect 级联渲染）。
	const [prevAgent, setPrevAgent] = useState(agent);
	if (prevAgent !== agent) {
		setPrevAgent(agent);
		setExtensionId(agent.connector?.extensionId ?? "");
		setTransport(agent.connector?.transport ?? "");
		setConfig(agent.connector?.config ?? {});
		setSecrets({});
		setVersionPin(agent.connector?.versionPin ?? "");
		setProbe(null);
		setExecutionCapabilities(null);
	}

	useEffect(() => {
		let cancelled = false;
		listExtensionCatalog("connector")
			.then((entries) => {
				if (!cancelled) setCatalog(entries);
			})
			.catch((err: unknown) => {
				if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
			});
		// GET connector 拿贡献 manifest（catalog 已含，这里保底刷新绑定态）。
		getAgentConnector(agent.name).catch(() => undefined);
		getAgentExecutionCapabilities(agent.name)
			.then((value) => { if (!cancelled) setExecutionCapabilities(value); })
			.catch(() => { if (!cancelled) setExecutionCapabilities(null); });
		return () => {
			cancelled = true;
		};
	}, [agent.name, agent.extensionRevision]);

	const selected = catalog?.find((e) => e.manifest.id === extensionId);
	const contribution = selected?.manifest.kind === "connector" ? selected.manifest.connector : undefined;
	const selectedTransport = transport || contribution?.defaultTransport || "";
	const securityWarnings = (() => {
		if (contribution?.id === "claude-code") {
			const mode = typeof config.permissionMode === "string" ? config.permissionMode : "bypassPermissions";
			return mode === "bypassPermissions"
				? ["高风险：bypassPermissions 会绕过 Claude Code 自身的权限确认。项目目录只是 cwd，不会阻止它访问目录外文件。"]
				: [];
		}
		if (contribution?.id === "codex") {
			const sandbox = typeof config.sandbox === "string" ? config.sandbox : "workspace-write";
			return sandbox === "danger-full-access"
				? ["高风险：danger-full-access 会关闭 Codex 自身沙箱。项目目录只是 cwd，不再是强制访问边界。"]
				: [];
		}
		return [];
	})();

	const handleSelect = (id: string) => {
		setExtensionId(id);
		const next = catalog?.find((entry) => entry.manifest.id === id);
		setTransport(next?.manifest.kind === "connector" ? next.manifest.connector.defaultTransport : "");
		// 更换 Connector 时配置不继承（schema 不同）。
		if (id !== agent.connector?.extensionId) setConfig({});
		setSecrets({});
	};

	const handleSave = async () => {
		if (!selected || !contribution) return;
		setSaving(true);
		try {
			const res = await putAgentConnector(agent.name, {
				extensionId,
				connectorId: contribution.id,
				transport: selectedTransport as AgentConnectorBinding["transport"],
				config,
				...(Object.keys(secrets).length > 0 ? { secrets } : {}),
				...(versionPin.trim() ? { versionPin: versionPin.trim() } : {}),
			});
			setSecrets({});
			onMutation(res);
			toast.success(`「${agent.name}」Connector 绑定已保存`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const handleProbe = async () => {
		setProbing(true);
		try {
			const result = await probeAgent(agent.name);
			setProbe(result);
			probeToast(result);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(false);
		}
	};

	if (catalog === null) {
		return (
			<div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
				<LoaderIcon className="size-4 animate-spin" />
				加载 Connector 目录…
			</div>
		);
	}

	const installed = catalog.filter((e) => e.installed);

	return (
		<div className="flex flex-col gap-3">
			<section className="agent-config-card flex flex-col gap-3">
				<div className="agent-config-card-head"><h2>连接插件</h2><p>选择已安装的连接插件；安装与更新在「扩展」页完成。</p></div>
			{/* 当前绑定 */}
			{agent.connector ? (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span className="flex items-center gap-1.5 font-medium text-foreground/85">
						<CheckCircle2Icon className="size-3.5 text-primary" />
						当前已绑定
					</span>
					<code className="font-mono text-muted-foreground">{agent.connector.extensionId} / {agent.connector.connectorId}</code>
					<Badge variant="secondary">{connectorTransportLabel(agent.connector.transport)}</Badge>
					{agent.connector.versionPin ? <Badge variant="outline">固定 v{agent.connector.versionPin}</Badge> : null}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">尚未绑定连接插件。选择下方已安装的插件完成接入。</p>
			)}

			{/* Connector 选择/更换（安装扩展是独立动作，在「扩展目录」页完成） */}
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">连接插件</span>
				<Select value={extensionId} onValueChange={handleSelect}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder="选择已安装的连接插件" />
					</SelectTrigger>
					<SelectContent>
						{installed.map((entry) => (
							<SelectItem key={entry.manifest.id} value={entry.manifest.id} disabled={!entry.loaded}>
								{entry.manifest.displayName}（{entry.manifest.id} v{entry.version}）
								{entry.loaded ? "" : " · 加载失败"}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{installed.length === 0 ? (
					<span className="text-xs text-muted-foreground/70">没有已安装的连接插件，请先到「扩展」安装。</span>
				) : null}
			</label>
			{selected && !selected.loaded ? (
				<p className="text-xs text-destructive">该扩展加载失败：{selected.loadError ?? "—"}</p>
			) : null}

			{/* 安装前/保存前展示：来源、权限、版本范围、将注册的能力（§10.1） */}
			{selected ? (
				<div className="agent-config-inset overflow-hidden p-0 text-xs">
					<dl className="grid grid-cols-2 gap-x-5 gap-y-3 px-4 py-3.5 sm:grid-cols-4">
						<div className="min-w-0">
							<dt className="text-[10px] text-muted-foreground">安装来源</dt>
							<dd className="mt-0.5 font-medium">{ORIGIN_LABELS[selected.origin]}</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-[10px] text-muted-foreground">发布者</dt>
							<dd className="mt-0.5 truncate font-medium" title={selected.manifest.publisher}>{selected.manifest.publisher}</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-[10px] text-muted-foreground">适用 PuddingTeams</dt>
							<dd className="mt-0.5 font-medium">{selected.manifest.engines.puddingteams}</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-[10px] text-muted-foreground">支持的上游版本</dt>
							<dd className="mt-0.5 font-medium">{contribution?.supportedUpstreamVersions ?? "未限制"}</dd>
						</div>
					</dl>
					<div className="grid gap-3 border-t border-border/60 px-4 py-3.5 sm:grid-cols-2">
						<div>
							<p className="mb-2 text-[10px] text-muted-foreground">支持的接入方式</p>
							<div className="flex flex-wrap gap-1.5">
								{contribution?.supportedTransports.map((item) => (
									<Badge key={item} variant={item === contribution.defaultTransport ? "secondary" : "outline"}>
										{connectorTransportLabel(item)}{item === contribution.defaultTransport ? " · 默认" : ""}
									</Badge>
								))}
							</div>
						</div>
						<div>
							<p className="mb-2 text-[10px] text-muted-foreground">扩展需要的权限</p>
							<div className="flex flex-wrap gap-1.5">
								{selected.manifest.permissions?.length ? selected.manifest.permissions.map((permission) => (
									<Badge key={permission} variant="outline">{PERMISSION_LABELS[permission]}</Badge>
								)) : <span className="text-muted-foreground">无需额外权限</span>}
							</div>
						</div>
					</div>
				</div>
			) : null}

			{/* config schema 表单 + secret + 固定版本 */}
			</section>
			{contribution ? (
				<section className="agent-config-card flex flex-col gap-3">
					<div className="agent-config-card-head"><h2>接入配置</h2><p>按连接插件声明的配置项填写；密钥加密存储，只保存引用。</p></div>
					{executionCapabilities ? (
						<div className="agent-config-inset p-3 text-xs">
							<p className="font-medium">当前执行能力（Connector 声明）</p>
							<div className="mt-2 flex flex-wrap gap-1.5">
								<Badge variant={executionCapabilities.workspace.readOnlyEnforcement === "none" ? "destructive" : "secondary"}>
									只读：{executionCapabilities.workspace.readOnlyEnforcement === "sandbox" ? "Worker 沙箱保证" : executionCapabilities.workspace.readOnlyEnforcement === "remote_policy" ? "远端策略保证" : "无法验证"}
								</Badge>
								<Badge variant="outline">cwd：{executionCapabilities.workspace.honorsInvocationCwd ? "遵循" : "未保证"}</Badge>
								<Badge variant="outline">隔离目录：{executionCapabilities.workspace.isolatedWorkspace ? "支持" : "未声明"}</Badge>
								<Badge variant="outline">写前拦截：{executionCapabilities.workspace.mutationInterception === "pre_mutation" ? "支持" : "不支持"}</Badge>
							</div>
							{executionCapabilities.workspace.readOnlyEnforcement === "none" ? (
								<p className="mt-2 text-destructive">只读任务不会自动修改 Worker 权限；执行前由 Teams 请求用户决定是否仍使用该 Worker。</p>
							) : null}
						</div>
					) : null}
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">传输方式</span>
						<Select value={selectedTransport} onValueChange={(value) => setTransport(value as AgentConnectorBinding["transport"])}>
							<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
							<SelectContent>
								{contribution.supportedTransports.map((item) => (
									<SelectItem key={item} value={item}>{connectorTransportLabel(item)}</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span className="text-xs text-muted-foreground/70">此 Worker 实例固定使用所选 transport；切换会影响后续委托。</span>
					</label>
					<ConfigSchemaForm schema={contribution.configSchema} value={config} onChange={setConfig} agentName={agent.name} transport={selectedTransport} />
			{securityWarnings.map((warning) => (
				<div key={warning} role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
					{warning}
				</div>
			))}

			{/* secret 单独输入（只存 refs） */}
			{contribution ? (
				<SecretSchemaFields
					schema={contribution.secretSchema}
					configuredKeys={Object.keys(agent.connector?.secretRefs ?? {})}
					values={secrets}
					onChange={setSecrets}
				/>
			) : null}

				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">固定版本（可选）</span>
					<Input value={versionPin} onChange={(e) => setVersionPin(e.target.value)} placeholder="如 0.9.1" className="font-mono text-xs" />
				</label>
				</section>
			) : null}

			<div className="flex items-center gap-2">
				<Button type="button" size="sm" disabled={!selected || !selected.loaded || saving} onClick={() => void handleSave()}>
					{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
					保存绑定
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={!agent.connector || probing} onClick={() => void handleProbe()}>
					{probing ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
					探测
				</Button>
			</div>

			{probe ? (
			<div ref={(el) => el?.scrollIntoView({ block: "nearest" })}>
				{isConnectorProbe(probe) ? <ConnectorProbeView probe={probe} /> : <LegacyProbeView probe={probe} />}
			</div>
		) : null}
		</div>
	);
}

// ---- 分区 1（legacy）：command invoke 编辑 ----

export function LegacyInvokeSection({ agent, onSaved }: { agent: AgentConfig; onSaved: (agent: AgentConfig) => void }) {
	const invoke = agent.invoke?.type === "command" ? agent.invoke : undefined;
	const [command, setCommand] = useState(invoke?.command ?? "");
	const [runArgs, setRunArgs] = useState((invoke?.runArgs ?? []).join(", "));
	const [probeArgs, setProbeArgs] = useState((invoke?.probeArgs ?? []).join(", "));
	const [envText, setEnvText] = useState(agent.env ? JSON.stringify(agent.env, null, 2) : "");
	const [saving, setSaving] = useState(false);
	const [probe, setProbe] = useState<AgentProbeResult | null>(null);
	const [probing, setProbing] = useState(false);

	// Agent 切换时重置表单（渲染期间重置）。
	const [prevAgent, setPrevAgent] = useState(agent);
	if (prevAgent !== agent) {
		setPrevAgent(agent);
		const inv = agent.invoke?.type === "command" ? agent.invoke : undefined;
		setCommand(inv?.command ?? "");
		setRunArgs((inv?.runArgs ?? []).join(", "));
		setProbeArgs((inv?.probeArgs ?? []).join(", "));
		setEnvText(agent.env ? JSON.stringify(agent.env, null, 2) : "");
		setProbe(null);
	}

	const parseArgs = (text: string): string[] =>
		text
			.split(/[\n,]/)
			.map((s) => s.trim())
			.filter(Boolean);

	const handleSave = async () => {
		let env: Record<string, string> | undefined;
		if (envText.trim()) {
			try {
				const parsed: unknown = JSON.parse(envText);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
				env = parsed as Record<string, string>;
			} catch {
				toast.error("env 不是合法的 JSON 对象");
				return;
			}
		}
		setSaving(true);
		try {
			const updated = await updateAgent(agent.name, {
				...agent,
				invoke: {
					type: "command",
					command: command.trim(),
					runArgs: parseArgs(runArgs),
					...(probeArgs.trim() ? { probeArgs: parseArgs(probeArgs) } : {}),
				},
				...(env ? { env } : {}),
			});
			onSaved(updated);
			toast.success(`「${agent.name}」接入命令已保存`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const handleProbe = async () => {
		setProbing(true);
		try {
			const result = await probeAgent(agent.name);
			setProbe(result);
			probeToast(result);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<section className="agent-config-card flex flex-col gap-3">
				<div className="agent-config-card-head"><h2>接入命令</h2><p>该智能体使用旧版命令接入。推荐改用连接插件：先创建新智能体，或在「扩展」页面安装插件。</p></div>
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
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">环境变量（JSON 对象，可选）</span>
				<Textarea
					value={envText}
					onChange={(e) => setEnvText(e.target.value)}
					placeholder='{"PUDDINGCLAW_URL": "http://127.0.0.1:8888"}'
					rows={2}
					className="font-mono text-xs"
				/>
			</label>
			<SecretsEditor agent={agent} />
			</section>
			<div className="flex items-center gap-2">
				<Button type="button" size="sm" disabled={saving || !command.trim()} onClick={() => void handleSave()}>
					{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
					保存接入
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={probing} onClick={() => void handleProbe()}>
					{probing ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
					探测
				</Button>
			</div>
			{probe ? (
			<div ref={(el) => el?.scrollIntoView({ block: "nearest" })}>
				{isConnectorProbe(probe) ? <ConnectorProbeView probe={probe} /> : <LegacyProbeView probe={probe} />}
			</div>
		) : null}
		</div>
	);
}

// ---- 分区 2：Extensions（Capability 绑定） ----

function BindingCard({
	agent,
	binding,
	entry,
	onMutation,
}: {
	agent: AgentConfig;
	binding: AgentCapabilityBinding;
	entry: CatalogEntry | undefined;
	onMutation: (res: MutationResponse) => void;
}) {
	const manifest = entry?.manifest.kind === "capability" ? entry.manifest : undefined;
	const [config, setConfig] = useState<Record<string, unknown>>(binding.config);
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [editOpen, setEditOpen] = useState(false);
	const [probe, setProbe] = useState<BindingProbeResult | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [installPrompt, setInstallPrompt] = useState<{
		connection: ExtensionConnectionStatus;
		action: ExtensionConnectionAction;
	} | null>(null);

	// 绑定更新后同步草稿（渲染期间重置）。
	const [prevBinding, setPrevBinding] = useState(binding);
	if (prevBinding !== binding) {
		setPrevBinding(binding);
		setConfig(binding.config);
		setSecrets({});
		setProbe(null);
	}

	const run = async (action: string, fn: () => Promise<MutationResponse>): Promise<boolean> => {
		setBusy(action);
		try {
			const res = await fn();
			onMutation(res);
			setProbe(null);
			return true;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setBusy(null);
		}
	};

	const handleProbe = async () => {
		setEditOpen(false);
		setProbe(null);
		setBusy("probe");
		try {
			const nextProbe = await probeAgentBinding(agent.name, binding.id);
			setProbe(nextProbe);
			if (nextProbe.issues.some((issue) => issue.code === "cli_not_installed")) {
				const connection = (await listExtensionConnections()).find((item) => item.extensionId === binding.extensionId);
				const action = connection?.actions?.find((item) => item.id === "install-cli");
				if (connection && action) setInstallPrompt({ connection, action });
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const installConnectionDependency = async () => {
		if (!installPrompt) return;
		setBusy("install-cli");
		try {
			await runExtensionConnectionAction(installPrompt.connection, installPrompt.action.id);
			toast.success("飞书 CLI 已安装");
			setInstallPrompt(null);
			setProbe(await probeAgentBinding(agent.name, binding.id));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const handleSaveConfig = async () => {
		const saved = await run("config", () =>
			patchAgentBinding(agent.name, binding.id, {
				config,
				...(Object.keys(secrets).length > 0 ? { secrets } : {}),
			}),
		);
		if (!saved) return;
		setSecrets({});
		setEditOpen(false);
		toast.success("插件配置已保存");
	};

	return (
		<div className="agent-config-card agent-plugin-binding-card flex flex-col gap-3">
			<div className="agent-plugin-binding-head">
				<div className="agent-plugin-binding-icon"><PuzzleIcon className="size-4" /></div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-semibold">{manifest?.displayName ?? binding.extensionId}</span>
						<span className={`agent-plugin-state ${binding.enabled ? "enabled" : "disabled"}`}>{binding.enabled ? "已启用" : "已停用"}</span>
						{!entry ? <Badge variant="destructive">插件未安装</Badge> : !entry.loaded ? <Badge variant="destructive">加载失败</Badge> : null}
					</div>
					<div className="agent-plugin-binding-id">
						<span>插件标识</span>
						<code>{binding.extensionId}</code>
						<span aria-hidden="true">·</span>
						<span>能力标识</span>
						<code>{binding.capabilityId}</code>
					</div>
				</div>
				<div className="agent-plugin-binding-badges">
					{entry ? <Badge variant="outline">插件版本 v{entry.version}{entry.versionPin ? `（固定 ${entry.versionPin}）` : ""}</Badge> : null}
					{entry ? <Badge variant="outline">{ORIGIN_LABELS[entry.origin]}</Badge> : null}
					{binding.versionPin ? <Badge variant="outline">绑定版本 v{binding.versionPin}</Badge> : null}
				</div>
			</div>
			{/* 工具清单（模块 manifest 声明，命名空间前缀由平台加） */}
			{manifest && manifest.capability.tools.length > 0 ? (
				<div className="agent-plugin-tools flex flex-col gap-1.5">
					<span className="text-[10px] font-medium text-muted-foreground">提供的工具</span>
					<div className="flex flex-wrap gap-1">
						{manifest.capability.tools.map((tool) => (
							<Badge key={tool.name} variant="outline" title={tool.description}>
								{tool.name}
								<span className="ml-1 text-muted-foreground/70">{tool.activation}</span>
							</Badge>
						))}
					</div>
				</div>
			) : null}
			{entry?.loadError ? <p className="text-xs text-destructive">{entry.loadError}</p> : null}

			<div className="agent-plugin-actions flex flex-wrap items-center gap-2">
				{/* 激活方式：API 不支持清除回“默认”，已设置时只提供 always/searchable */}
				{manifest && manifest.capability.tools.length > 0 ? <Select
					value={binding.activation ?? "default"}
					onValueChange={(v) => {
						if (v === "default") return;
						void run("activation", () => patchAgentBinding(agent.name, binding.id, { activation: v as ToolActivation }));
					}}
					disabled={busy !== null}
				>
					<SelectTrigger size="sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{binding.activation === undefined ? <SelectItem value="default">激活方式：插件默认</SelectItem> : null}
						<SelectItem value="always">激活方式：始终启用</SelectItem>
						<SelectItem value="searchable">激活方式：按需启用</SelectItem>
					</SelectContent>
				</Select> : null}
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy !== null}
					onClick={() => void run("toggle", () => patchAgentBinding(agent.name, binding.id, { enabled: !binding.enabled }))}
				>
					{busy === "toggle" ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
					{binding.enabled ? "停用" : "启用"}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy !== null}
					onClick={() => {
						const nextOpen = !editOpen;
						setEditOpen(nextOpen);
						if (nextOpen) setProbe(null);
					}}
				>
					配置{editOpen ? "（收起）" : ""}
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void handleProbe()}>
					{busy === "probe" ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
					探测
				</Button>
				<Button type="button" size="sm" variant="ghost" className="ml-auto" aria-label={`删除「${manifest?.displayName ?? binding.extensionId}」绑定`} disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
					<TrashIcon className="size-3.5" />
				</Button>
			</div>

			{editOpen ? (
				<div className="flex flex-col gap-2 border-t pt-2">
					<span className="text-xs text-muted-foreground">绑定配置</span>
					<ConfigSchemaForm
						schema={manifest?.capability.configSchema}
						value={config}
						onChange={(next) => {
							setConfig(next);
							setProbe(null);
						}}
					/>
					<SecretSchemaFields
						schema={manifest?.capability.secretSchema}
						configuredKeys={Object.keys(binding.secretRefs ?? {})}
						values={secrets}
						onChange={setSecrets}
					/>
					<div>
						<Button
							type="button"
							size="sm"
							disabled={busy !== null}
							onClick={() => void handleSaveConfig()}
						>
							{busy === "config" ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							保存配置
						</Button>
					</div>
				</div>
			) : null}

			{probe ? <BindingProbeView probe={probe} /> : null}

			<Dialog open={installPrompt !== null} onOpenChange={(open) => { if (!open && busy !== "install-cli") setInstallPrompt(null); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{installPrompt?.action.confirmation?.title ?? "安装飞书 CLI？"}</DialogTitle>
						<DialogDescription>{installPrompt?.action.confirmation?.description ?? installPrompt?.action.description}</DialogDescription>
					</DialogHeader>
					{busy === "install-cli" ? (
						<div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
							<LoaderIcon className="size-4 shrink-0 animate-spin text-primary" />
							<div><div className="font-medium">正在安装飞书官方 CLI…</div><p className="mt-0.5 text-xs text-muted-foreground">正在通过 npm 下载并校验，请保持网络连接。</p></div>
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={busy === "install-cli"} onClick={() => setInstallPrompt(null)}>暂不安装</Button>
						<Button type="button" disabled={busy === "install-cli"} onClick={() => void installConnectionDependency()}>
							{busy === "install-cli" ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							{busy === "install-cli" ? "正在安装" : installPrompt?.action.confirmation?.confirmLabel ?? "开始安装"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除绑定</DialogTitle>
						<DialogDescription>
							确定删除「{agent.name}」对「{manifest?.displayName ?? binding.extensionId}」的绑定吗？安装包本身保留，该绑定提供的工具将立即撤权。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
							取消
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={busy !== null}
							onClick={() =>
								void run("delete", () => deleteAgentBinding(agent.name, binding.id)).then(() => setConfirmDelete(false))
							}
						>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function BindingsSection({
	agent,
	onMutation,
}: {
	agent: AgentConfig;
	onMutation: (res: MutationResponse) => void;
}) {
	const [bindings, setBindings] = useState<AgentCapabilityBinding[] | null>(null);
	const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [addExtensionId, setAddExtensionId] = useState("");
	const [addConfig, setAddConfig] = useState<Record<string, unknown>>({});
	const [addSecrets, setAddSecrets] = useState<Record<string, string>>({});
	const [addActivation, setAddActivation] = useState<"default" | ToolActivation>("default");
	const [adding, setAdding] = useState(false);

	const refresh = useCallback(() => {
		listAgentBindings(agent.name)
			.then((data) => setBindings(data.bindings))
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
	}, [agent.name]);

	useEffect(() => {
		refresh();
		listExtensionCatalog("capability")
			.then(setCatalog)
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
	}, [refresh, agent.extensionRevision]);

	const entryOf = (extensionId: string) => catalog?.find((e) => e.manifest.id === extensionId);

	// “添加 Extension”只列 kind=capability 且与当前 connectorId 兼容的项（§10.1）。
	// pinned Manager 的宿主也是 pi；compatibleConnectors 缺省视为兼容全部。
	const addable = (catalog ?? []).filter((entry) => {
		if (!entry.installed || !entry.loaded || entry.manifest.kind !== "capability") return false;
		if ((bindings ?? []).some((b) => b.extensionId === entry.manifest.id)) return false;
		const compatible = entry.manifest.capability.compatibleConnectors;
		if (!compatible) return true;
		const connectorId = agent.pinned ? "pi" : agent.connector?.connectorId;
		return connectorId ? compatible.includes(connectorId) : false;
	});

	const addEntry = addable.find((e) => e.manifest.id === addExtensionId);
	const addManifest = addEntry?.manifest.kind === "capability" ? addEntry.manifest : undefined;

	const resetAdd = () => {
		setAddExtensionId("");
		setAddConfig({});
		setAddSecrets({});
		setAddActivation("default");
	};

	const handleAdd = async () => {
		if (!addEntry || !addManifest) return;
		setAdding(true);
		try {
			const res = await addAgentBinding(agent.name, {
				extensionId: addEntry.manifest.id,
				capabilityId: addManifest.capability.id,
				config: addConfig,
				...(addActivation !== "default" ? { activation: addActivation } : {}),
				...(Object.keys(addSecrets).length > 0 ? { secrets: addSecrets } : {}),
			});
			onMutation(res);
			refresh();
			resetAdd();
			setAddOpen(false);
			toast.success(`已绑定「${addManifest.displayName}」`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setAdding(false);
		}
	};

	return (
		<div className="agent-plugin-section flex flex-col gap-3">
			<section className="agent-plugin-overview">
				<div className="agent-plugin-overview-icon"><PuzzleIcon className="size-5" /></div>
				<div className="min-w-0">
					<div className="agent-plugin-overview-label">
						<span>能力插件</span>
						{bindings !== null ? <span className="agent-plugin-count">已绑定 {bindings.length} 个</span> : null}
					</div>
					<h2>{bindings === null ? "正在读取插件绑定" : bindings.length === 0 ? "尚未绑定能力插件" : "插件能力已接入"}</h2>
					<p>{agent.pinned
						? "绑定后，Manager 可在 Pi 会话中使用插件提供的工具、CLI 与技能。"
						: "这里只展示与当前 Worker 连接方式兼容的插件，绑定后由该 Worker 独立使用。"}</p>
				</div>
				{addOpen ? <span className="agent-plugin-mode">正在添加插件</span> : (
					<Button type="button" size="sm" disabled={bindings === null || catalog === null} onClick={() => setAddOpen(true)}>
						<PlusIcon className="size-3.5" />
						添加插件
					</Button>
				)}
			</section>

			{bindings === null ? (
				<div className="agent-plugin-loading flex items-center gap-2 text-sm text-muted-foreground">
					<LoaderIcon className="size-4 animate-spin" />
					正在读取插件绑定…
				</div>
			) : bindings.length > 0 ? (
				bindings.map((binding) => (
					<BindingCard
						key={binding.id}
						agent={agent}
						binding={binding}
						entry={entryOf(binding.extensionId)}
						onMutation={(res) => {
							onMutation(res);
							refresh();
						}}
					/>
				))
			) : null}

			{addOpen ? (
				<div className="agent-config-card agent-plugin-add-card flex flex-col gap-3">
					<div className="agent-plugin-add-head">
						<div className="agent-plugin-add-icon"><PlusIcon className="size-4" /></div>
						<div><h2>添加能力插件</h2><p>选择兼容插件并确认权限，添加后可继续配置和探测。</p></div>
					</div>
					{addable.length === 0 ? (
						<div className="agent-plugin-unavailable">
							<strong>暂无可添加的能力插件</strong>
							<p>{agent.pinned ? "这里只显示与 Pi 兼容且尚未绑定的插件。" : agent.connector ? `这里只显示与当前连接插件「${agent.connector.connectorId}」兼容且尚未绑定的插件。` : "请先完成 Worker 的基础接入配置。"} 可前往「扩展」页面管理插件。</p>
						</div>
					) : (
						<Select
							value={addExtensionId}
							onValueChange={(v) => {
								setAddExtensionId(v);
								setAddConfig({});
								setAddSecrets({});
								setAddActivation("default");
							}}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="选择能力插件" />
							</SelectTrigger>
							<SelectContent>
								{addable.map((entry) => (
									<SelectItem key={entry.manifest.id} value={entry.manifest.id}>
										{entry.manifest.displayName}（{entry.manifest.id} v{entry.version}）
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}

					{/* 保存前展示来源、权限、版本范围和将注册的工具（§10.1） */}
					{addEntry && addManifest ? (
						<>
							<div className="agent-config-inset flex flex-col gap-1.5 text-xs text-muted-foreground">
								<div className="flex flex-wrap items-center gap-1.5">
									<Badge variant="outline">来源：{SOURCE_LABELS[addManifest.source] ?? addManifest.source}</Badge>
									<Badge variant="outline">{ORIGIN_LABELS[addEntry.origin]}</Badge>
									<Badge variant="outline">发布者：{addManifest.publisher}</Badge>
									<Badge variant="outline">插件版本：v{addEntry.version}</Badge>
									<Badge variant="outline">引擎：{addManifest.engines.puddingteams}</Badge>
								</div>
								{addManifest.permissions && addManifest.permissions.length > 0 ? (
									<div className="flex flex-wrap items-center gap-1.5">
									<span>权限：</span>
									{addManifest.permissions.map((p) => (
										<Badge key={p} variant="secondary">
											{PERMISSION_LABELS[p]}
										</Badge>
									))}
									</div>
								) : null}
								{addManifest.capability.tools.length > 0 ? (
									<div className="flex flex-col gap-0.5">
										<span>将提供的工具</span>
										{addManifest.capability.tools.map((tool) => (
											<code key={tool.name} className="truncate font-mono" title={tool.description}>
												agent_{agent.name}__{addManifest.id}__{tool.name}
											</code>
										))}
									</div>
								) : null}
							</div>
							<ConfigSchemaForm schema={addManifest.capability.configSchema} value={addConfig} onChange={setAddConfig} />
							<SecretSchemaFields schema={addManifest.capability.secretSchema} configuredKeys={[]} values={addSecrets} onChange={setAddSecrets} />
							{addManifest.capability.tools.length > 0 ? <Select value={addActivation} onValueChange={(v) => setAddActivation(v as "default" | ToolActivation)}>
								<SelectTrigger size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">激活方式：插件默认</SelectItem>
									<SelectItem value="always">激活方式：始终启用</SelectItem>
									<SelectItem value="searchable">激活方式：按需启用</SelectItem>
								</SelectContent>
							</Select> : null}
						</>
					) : null}

					<div className="flex items-center gap-2">
						<Button type="button" size="sm" disabled={!addEntry || adding} onClick={() => void handleAdd()}>
							{adding ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							添加
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								setAddOpen(false);
								resetAdd();
							}}
						>
							取消
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}

// ---- 分区 3：运行状态（启用开关 + 接入探测 + 写操作影响） ----

export function StatusSection({
	agent,
	lastMutation,
	onToggleEnabled,
	toggling,
}: {
	agent: AgentConfig;
	lastMutation: MutationResponse | null;
	onToggleEnabled: (enabled: boolean) => Promise<void> | void;
	toggling: boolean;
}) {
	const [probe, setProbe] = useState<AgentProbeResult | null>(null);
	const [probing, setProbing] = useState(false);

	// Agent 切换时清空上次探测结果（渲染期间重置）。
	const [prevAgent, setPrevAgent] = useState(agent);
	if (prevAgent !== agent) {
		setPrevAgent(agent);
		setProbe(null);
	}

	const handleProbe = async () => {
		setProbing(true);
		try {
			const result = await probeAgent(agent.name);
			setProbe(result);
			probeToast(result);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>启用状态</h2><p>停用后 Manager 不再派发任务，已绑定的插件能力也将不可用；配置与绑定会保留，重新启用后恢复。</p></div>
				<div className="agent-config-inset flex flex-wrap items-center justify-between gap-3">
					<div className="flex min-w-0 items-start gap-2.5">
						<span className={`mt-1.5 size-2 shrink-0 rounded-full ${agent.enabled !== false ? "bg-primary" : "bg-muted-foreground/40"}`} />
						<div>
							<p className="text-sm font-medium">{agent.enabled !== false ? "Worker 当前已启用" : "Worker 当前已停用"}</p>
							<p className="mt-0.5 text-xs leading-5 text-muted-foreground">
								{agent.enabled !== false ? "Manager 可以向它派发新任务。" : "Manager 不会向它派发新任务，配置与绑定仍会保留。"}
							</p>
						</div>
					</div>
					<Button
						type="button"
						size="sm"
						variant={agent.enabled !== false ? "outline" : "default"}
						disabled={toggling}
						onClick={() => void onToggleEnabled(agent.enabled === false)}
					>
						{toggling ? <LoaderIcon className="size-3.5 animate-spin" /> : agent.enabled !== false ? <PauseCircleIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
						{toggling ? (agent.enabled !== false ? "停用中…" : "启用中…") : agent.enabled !== false ? "停用 Worker" : "启用 Worker"}
					</Button>
				</div>
				<p className="mt-2 text-[10px] text-muted-foreground/70">如有进行中的 Run，系统会阻止停用，避免任务被静默中断。</p>
			</section>
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>接入探测</h2><p>检查当前接入端是否可用，并验证协议版本与能力声明。</p></div>
				<div>
					<Button type="button" size="sm" variant="outline" disabled={probing} onClick={() => void handleProbe()}>
						{probing ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
						探测
					</Button>
				</div>
				<div className="agent-config-probe-result">
					{probe ? (
						isConnectorProbe(probe) ? <ConnectorProbeView probe={probe} /> : <LegacyProbeView probe={probe} />
					) : (
						<p className="text-xs text-muted-foreground/70">尚未探测。列表页的状态灯来自最近一次探测。</p>
					)}
				</div>
			</section>
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>最近写操作影响</h2><p>在本页保存配置、绑定或启停后，这里列出有多少会话受影响。</p></div>
				{lastMutation ? (
					<AffectedNote affected={lastMutation.affectedSessions} />
				) : (
					<p className="text-xs text-muted-foreground/70">本次打开尚无写操作。</p>
				)}
			</section>
		</div>
	);
}
