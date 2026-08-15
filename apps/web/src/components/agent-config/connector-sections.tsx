"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
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
	listAgentBindings,
	listExtensionCatalog,
	patchAgentBinding,
	probeAgent,
	probeAgentBinding,
	putAgentConnector,
	updateAgent,
} from "@/lib/api";
import type {
	AgentCapabilityBinding,
	AgentConfig,
	AgentProbeResult,
	BindingProbeResult,
	CatalogEntry,
	ConnectorProbeResult,
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

// ---- probe 展示 ----

/** 探测完成的即时反馈：结果卡渲染在按钮下方、可能在视区外，用 toast 兜底。 */
function probeToast(probe: AgentProbeResult): void {
	const healthy = isConnectorProbe(probe) ? probe.detected && probe.compatibility !== "incompatible" : probe.ok;
	if (healthy) toast.success("探测通过");
	else toast.error("探测未通过，详见下方结果卡");
}

/** §10：按 probe 结果计算接入状态文案（不合并成含糊按钮，只展示状态）。 */
function connectorStatus(p: ConnectorProbeResult): string {
	if (!p.extensionInstalled) return "扩展未安装";
	if (!p.detected) return "CLI 未检测";
	if (p.authenticated === false) return "待认证";
	if (p.compatibility === "incompatible") return "不兼容";
	if (p.compatibility === "untested") return "版本未经验证";
	if (p.configured && !p.enabled) return "已配置但未启用";
	if (p.enabled) return "已启用";
	return "已配置";
}

function statusVariant(status: string): "secondary" | "destructive" | "outline" {
	if (status === "已启用") return "secondary";
	if (["扩展未安装", "CLI 未检测", "待认证", "不兼容"].includes(status)) return "destructive";
	return "outline";
}

const COMPATIBILITY_LABELS: Record<ConnectorProbeResult["compatibility"], string> = {
	supported: "已验证",
	untested: "未经验证",
	incompatible: "不兼容",
	unknown: "未知",
};

function ConnectorProbeView({ probe }: { probe: ConnectorProbeResult }) {
	const status = connectorStatus(probe);
	return (
		<div className="agent-config-inset flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge variant={statusVariant(status)}>{status}</Badge>
				<Badge variant="outline">兼容性：{COMPATIBILITY_LABELS[probe.compatibility]}</Badge>
				{probe.transport ? <Badge variant="outline">transport: {probe.transport}</Badge> : null}
				{probe.extensionVersion ? <Badge variant="outline">扩展 v{probe.extensionVersion}</Badge> : null}
				{probe.upstreamVersion ? <Badge variant="outline">上游 v{probe.upstreamVersion}</Badge> : null}
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">支持的操作</span>
				<div className="flex flex-wrap gap-1">
					{(["run", "continue", "respond", "cancel"] as const).map((op) => {
						const supported = probe.capabilities.operations.includes(op);
						return (
							<Badge key={op} variant={supported ? "secondary" : "outline"} className={supported ? "" : "opacity-40"}>
								{op}
							</Badge>
						);
					})}
				</div>
				<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					<span>交互类型：{probe.capabilities.interactionKinds.length > 0 ? probe.capabilities.interactionKinds.join(" / ") : "—"}</span>
					<span>·</span>
					<span>进度：{probe.capabilities.progress}</span>
				</div>
			</div>
			{probe.issues.length > 0 ? (
				<div className="flex flex-col gap-1">
					<span className="text-xs text-muted-foreground">问题</span>
					{probe.issues.map((issue, i) => (
						<div key={`${issue.code}-${i}`} className="text-xs">
							<span className="text-destructive">{issue.message}</span>
							<code className="ml-1 font-mono text-muted-foreground/70">({issue.code})</code>
							{issue.fixAction ? <span className="ml-1 text-muted-foreground">→ {issue.fixAction}</span> : null}
						</div>
					))}
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
	return (
		<div className="agent-config-inset flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge variant={probe.extensionInstalled ? "secondary" : "destructive"}>
					{probe.extensionInstalled ? "扩展已安装" : "扩展未安装"}
				</Badge>
				<Badge variant={probe.loaded ? "secondary" : "destructive"}>{probe.loaded ? "已加载" : "加载失败"}</Badge>
				<Badge variant={probe.enabled ? "secondary" : "outline"}>{probe.enabled ? "已启用" : "已停用"}</Badge>
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
			{probe.issues.length > 0 ? (
				<div className="flex flex-col gap-0.5">
					{probe.issues.map((issue, i) => (
						<p key={`${issue.code}-${i}`} className="text-xs text-destructive">
							{issue.message}
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
	const [config, setConfig] = useState<Record<string, unknown>>(agent.connector?.config ?? {});
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [versionPin, setVersionPin] = useState(agent.connector?.versionPin ?? "");
	const [saving, setSaving] = useState(false);
	const [probe, setProbe] = useState<AgentProbeResult | null>(null);
	const [probing, setProbing] = useState(false);

	// Agent 切换/外部更新时重置表单（渲染期间随 prop 变化重置，避免 effect 级联渲染）。
	const [prevAgent, setPrevAgent] = useState(agent);
	if (prevAgent !== agent) {
		setPrevAgent(agent);
		setExtensionId(agent.connector?.extensionId ?? "");
		setConfig(agent.connector?.config ?? {});
		setSecrets({});
		setVersionPin(agent.connector?.versionPin ?? "");
		setProbe(null);
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
		return () => {
			cancelled = true;
		};
	}, [agent.name]);

	const selected = catalog?.find((e) => e.manifest.id === extensionId);
	const contribution = selected?.manifest.kind === "connector" ? selected.manifest.connector : undefined;
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
				<div className="agent-config-card-head"><h2>Connector</h2><p>选择已安装的 Connector Extension；安装与更新在「扩展」页完成。</p></div>
			{/* 当前绑定 */}
			{agent.connector ? (
				<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					<span>当前绑定：</span>
					<code className="font-mono">{agent.connector.extensionId}</code>
					<span>→</span>
					<code className="font-mono">{agent.connector.connectorId}</code>
					{agent.connector.versionPin ? <Badge variant="outline">固定 v{agent.connector.versionPin}</Badge> : null}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">尚未绑定 Connector。选择下方已安装的 Connector 完成接入。</p>
			)}

			{/* Connector 选择/更换（安装扩展是独立动作，在「扩展目录」页完成） */}
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">Connector Extension</span>
				<Select value={extensionId} onValueChange={handleSelect}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder="选择已安装的 Connector" />
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
					<span className="text-xs text-muted-foreground/70">没有已安装的 Connector，请先到「扩展」安装。</span>
				) : null}
			</label>
			{selected && !selected.loaded ? (
				<p className="text-xs text-destructive">该扩展加载失败：{selected.loadError ?? "—"}</p>
			) : null}

			{/* 安装前/保存前展示：来源、权限、版本范围、将注册的能力（§10.1） */}
			{selected ? (
				<div className="agent-config-inset flex flex-col gap-1.5 text-xs text-muted-foreground">
					<div className="flex flex-wrap items-center gap-1.5">
						<Badge variant="outline">来源：{selected.manifest.source}</Badge>
						<Badge variant="outline">{ORIGIN_LABELS[selected.origin]}</Badge>
						<Badge variant="outline">发布者：{selected.manifest.publisher}</Badge>
						<Badge variant="outline">引擎：{selected.manifest.engines.puddingteams}</Badge>
					</div>
					{selected.manifest.permissions && selected.manifest.permissions.length > 0 ? (
						<div className="flex flex-wrap items-center gap-1.5">
							<span>权限：</span>
							{selected.manifest.permissions.map((p) => (
								<Badge key={p} variant="secondary">
									{p}
								</Badge>
							))}
						</div>
					) : null}
					{contribution ? (
						<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
							<span>transport：{contribution.supportedTransports.join(" / ")}（默认 {contribution.defaultTransport}）</span>
							{contribution.supportedUpstreamVersions ? <span>· 上游版本：{contribution.supportedUpstreamVersions}</span> : null}
						</div>
					) : null}
				</div>
			) : null}

			{/* config schema 表单 + secret + 固定版本 */}
			</section>
			{contribution ? (
				<section className="agent-config-card flex flex-col gap-3">
					<div className="agent-config-card-head"><h2>接入配置</h2><p>按 Connector 声明的 schema 填写；密钥加密存储，只存引用。</p></div>
					<ConfigSchemaForm schema={contribution.configSchema} value={config} onChange={setConfig} />
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
				<div className="agent-config-card-head"><h2>接入命令</h2><p>该 Agent 使用 legacy 命令接入。推荐改用 Connector Extension（先创建新 Agent 或在「扩展」安装 Connector）。</p></div>
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

	// 绑定更新后同步草稿（渲染期间重置）。
	const [prevBinding, setPrevBinding] = useState(binding);
	if (prevBinding !== binding) {
		setPrevBinding(binding);
		setConfig(binding.config);
		setSecrets({});
	}

	const run = async (action: string, fn: () => Promise<MutationResponse>) => {
		setBusy(action);
		try {
			const res = await fn();
			onMutation(res);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const handleProbe = async () => {
		setBusy("probe");
		try {
			setProbe(await probeAgentBinding(agent.name, binding.id));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="agent-config-card flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="text-sm font-medium">{manifest?.displayName ?? binding.extensionId}</span>
				{entry ? <Badge variant="outline">v{entry.version}{entry.versionPin ? `（固定 ${entry.versionPin}）` : ""}</Badge> : null}
				{entry ? <Badge variant="outline">{ORIGIN_LABELS[entry.origin]}</Badge> : null}
				{!entry ? <Badge variant="destructive">扩展未安装</Badge> : !entry.loaded ? <Badge variant="destructive">加载失败</Badge> : null}
				<Badge variant={binding.enabled ? "secondary" : "outline"}>{binding.enabled ? "已启用" : "已停用"}</Badge>
			</div>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
				<code className="font-mono">{binding.extensionId}</code>
				<span>→</span>
				<code className="font-mono">{binding.capabilityId}</code>
				{binding.versionPin ? <Badge variant="outline">绑定固定 v{binding.versionPin}</Badge> : null}
			</div>
			{/* 工具清单（模块 manifest 声明，命名空间前缀由平台加） */}
			{manifest && manifest.capability.tools.length > 0 ? (
				<div className="flex flex-col gap-0.5">
					<span className="text-xs text-muted-foreground">工具</span>
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

			<div className="flex flex-wrap items-center gap-2">
				{/* 激活方式：API 不支持清除回“默认”，已设置时只提供 always/searchable */}
				<Select
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
						{binding.activation === undefined ? <SelectItem value="default">激活：默认（扩展声明）</SelectItem> : null}
						<SelectItem value="always">激活：always</SelectItem>
						<SelectItem value="searchable">激活：searchable</SelectItem>
					</SelectContent>
				</Select>
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
				<Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => setEditOpen((o) => !o)}>
					配置{editOpen ? "（收起）" : ""}
				</Button>
				<Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void handleProbe()}>
					{busy === "probe" ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
					探测
				</Button>
				<Button type="button" size="sm" variant="ghost" className="ml-auto" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
					<TrashIcon className="size-3.5" />
				</Button>
			</div>

			{editOpen ? (
				<div className="flex flex-col gap-2 border-t pt-2">
					<span className="text-xs text-muted-foreground">绑定配置</span>
					<ConfigSchemaForm schema={manifest?.capability.configSchema} value={config} onChange={setConfig} />
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
							onClick={() =>
								void run("config", () =>
									patchAgentBinding(agent.name, binding.id, {
										config,
										...(Object.keys(secrets).length > 0 ? { secrets } : {}),
									}),
								).then(() => setSecrets({}))
							}
						>
							{busy === "config" ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							保存配置
						</Button>
					</div>
				</div>
			) : null}

			{probe ? <BindingProbeView probe={probe} /> : null}

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
	// compatibleConnectors 缺省视为兼容全部；未绑定 Connector 的 Agent 不做过滤。
	const addable = (catalog ?? []).filter((entry) => {
		if (!entry.installed || !entry.loaded || entry.manifest.kind !== "capability") return false;
		if ((bindings ?? []).some((b) => b.extensionId === entry.manifest.id)) return false;
		const compatible = entry.manifest.capability.compatibleConnectors;
		if (!compatible || !agent.connector) return true;
		return compatible.includes(agent.connector.connectorId);
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
		<div className="flex flex-col gap-3">
			{bindings === null ? (
				<div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
					<LoaderIcon className="size-4 animate-spin" />
					加载绑定…
				</div>
			) : bindings.length === 0 ? (
				<p className="text-xs text-muted-foreground">还没有绑定 Capability Extension。基础委托能力由平台自动生成，不占绑定位。</p>
			) : (
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
			)}

			{addOpen ? (
				<div className="agent-config-card flex flex-col gap-2">
					<div className="agent-config-card-head"><h2>添加 Extension</h2></div>
					{addable.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							没有可添加的 Capability Extension{agent.connector ? `（需与 connector「${agent.connector.connectorId}」兼容）` : ""}
							。可先到「扩展」安装。
						</p>
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
								<SelectValue placeholder="选择 Capability Extension" />
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
									<Badge variant="outline">来源：{addManifest.source}</Badge>
									<Badge variant="outline">{ORIGIN_LABELS[addEntry.origin]}</Badge>
									<Badge variant="outline">发布者：{addManifest.publisher}</Badge>
									<Badge variant="outline">版本：v{addEntry.version}</Badge>
									<Badge variant="outline">引擎：{addManifest.engines.puddingteams}</Badge>
								</div>
								{addManifest.permissions && addManifest.permissions.length > 0 ? (
									<div className="flex flex-wrap items-center gap-1.5">
										<span>权限：</span>
										{addManifest.permissions.map((p) => (
											<Badge key={p} variant="secondary">
												{p}
											</Badge>
										))}
									</div>
								) : null}
								{addManifest.capability.tools.length > 0 ? (
									<div className="flex flex-col gap-0.5">
										<span>将注册的工具</span>
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
							<Select value={addActivation} onValueChange={(v) => setAddActivation(v as "default" | ToolActivation)}>
								<SelectTrigger size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">激活：默认（扩展声明）</SelectItem>
									<SelectItem value="always">激活：always</SelectItem>
									<SelectItem value="searchable">激活：searchable</SelectItem>
								</SelectContent>
							</Select>
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
			) : (
				<div>
					<Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
						添加 Extension
					</Button>
				</div>
			)}
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
				<div className="agent-config-card-head"><h2>启用状态</h2><p>停用后 Manager 不再派活给它，已绑定的 Capability 工具也一并不可用；配置与绑定保留，再启用时恢复。</p></div>
				<label className="flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						checked={agent.enabled !== false}
						disabled={toggling}
						onChange={(e) => void onToggleEnabled(e.target.checked)}
						className="mt-0.5 size-4 accent-foreground"
					/>
					<span>
						启用当前 Agent
						<small className="mt-0.5 block text-xs text-muted-foreground">有进行中的 Run 时会先弹出确认，不会静默中断。</small>
					</span>
				</label>
			</section>
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>接入探测</h2><p>检查本机 CLI 是否安装、登录态与版本兼容性。</p></div>
				<div>
					<Button type="button" size="sm" variant="outline" disabled={probing} onClick={() => void handleProbe()}>
						{probing ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
						探测
					</Button>
				</div>
				{probe ? (
					isConnectorProbe(probe) ? <ConnectorProbeView probe={probe} /> : <LegacyProbeView probe={probe} />
				) : (
					<p className="text-xs text-muted-foreground/70">尚未探测。列表页的状态灯来自最近一次探测。</p>
				)}
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
