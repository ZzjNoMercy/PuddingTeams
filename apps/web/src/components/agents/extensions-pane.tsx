"use client";

import { type ComponentProps, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRightIcon, CableIcon, CheckCircle2Icon, LoaderIcon, PackageIcon, RefreshCwIcon, SearchIcon, ShieldAlertIcon, SparklesIcon, TrashIcon, UploadIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	ApiConflictError,
	getSkillResource,
	getDeveloperMode,
	installExtension,
	importSkillResource,
	importSkillsZip,
	listAgents,
	listExtensionCatalog,
	listExtensionConnections,
	listMcpServers,
	listSkillLibrary,
	listTemplateLibrary,
	pickWorkspaceDirectory,
	runExtensionConnectionAction,
	setDeveloperMode,
	uninstallExtension,
	updateExtension,
} from "@/lib/api";
import { agentDisplayName, type AgentConfig, type CatalogEntry, type ConflictRun, type ExtensionConnectionStatus, type SkillDocument, type SkillEntry } from "@/lib/types";
import { ClipboardSafeStreamdown } from "@/components/ai-elements/streamdown";
import { ManagerAvatar, WorkerAvatar } from "@/components/chat/worker-avatar";
import { SkillImportDialog } from "@/components/skills/skill-import-dialog";
import { McpServersView } from "@/components/agents/mcp-servers-view";
import { TemplateLibraryView } from "@/components/agents/template-library-view";
import { ConnectionAuthorizationDialog } from "@/components/agents/connection-authorization-dialog";

/**
 * Extension 接入目录（§10.1）：kind=connector 与 kind=capability 分开的目录
 * 视图，不混在同一选择器。安装 / 更新 / 卸载是彼此独立的动作；卸载 409 时
 * 如实展示引用它的 agents / 进行中 runs。
 */

type ExtensionView = "skills" | "templates" | "mcp" | "plugins" | "connections";
type PluginKindFilter = "all" | "connector" | "capability";

type ExtensionTabCounts = Record<ExtensionView, number | null>;

const TAB_COUNT_STORAGE_KEY = "puddingteams:extension-tab-counts";
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function ManagedMcpPluginRow({ version }: { version: string | null }) {
	return (
		<div className="ops-extension-row">
			<div className="ops-extension-icon capability"><PackageIcon className="size-5" /></div>
			<div className="min-w-0">
				<div className="flex min-w-0 items-baseline gap-2">
					<div className="truncate text-sm font-medium">MCP</div>
					<code className="truncate font-mono text-[11px] text-muted-foreground">pi-mcp-adapter</code>
				</div>
				<p className="mt-1 truncate text-xs text-muted-foreground">为 Pi Agent 提供 MCP Server 支持</p>
			</div>
			<div className="ops-extension-meta">
				<span className="text-foreground">已加载</span>
				<span>{version ? `插件 v${version}` : "系统插件"} · MCP</span>
			</div>
			<Badge variant="secondary">内置</Badge>
		</div>
	);
}

function cachedTabCounts(): Partial<Record<ExtensionView, number>> {
	if (typeof window === "undefined") return {};
	try {
		const parsed = JSON.parse(window.localStorage.getItem(TAB_COUNT_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isInteger(value) && value >= 0),
		) as Partial<Record<ExtensionView, number>>;
	} catch {
		return {};
	}
}

function persistTabCount(key: ExtensionView, value: number) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(TAB_COUNT_STORAGE_KEY, JSON.stringify({ ...cachedTabCounts(), [key]: value }));
		window.document.documentElement.style.setProperty(`--extension-${key}-count`, JSON.stringify(String(value)));
	} catch {
		// 隐私模式或存储被禁用时，当前页面内的状态仍然正常更新。
	}
}

const SOURCE_LABELS: Record<string, string> = {
	builtin: "内置来源",
	trusted: "可信来源",
	external: "外部来源",
};

function SkillPreviewLink({ href = "", children, node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
	void node;
	if (!/^https?:\/\//i.test(href)) return <span className="skill-preview-local-link">{children}</span>;
	return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
}

function skillPreviewUrlTransform(url: string): string {
	return /^(?:https?:\/\/|mailto:|#)/i.test(url) ? url : "#";
}

const skillPreviewMarkdownComponents = { a: SkillPreviewLink };

function normalizeSkillPreviewMarkdown(markdown: string): string {
	return markdown.replace(/(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/g, (match, imageMarker: string, label: string, rawHref: string) => {
		const href = rawHref.trim().split(/\s+["']/)[0] ?? "";
		if (/^(?:https?:\/\/|mailto:|#)/i.test(href)) return match;
		const safeLabel = label.replace(/`/g, "");
		return imageMarker ? `**${safeLabel}**` : `\`${safeLabel}\``;
	});
}

/** 安装来源三态（文档 §8）：builtin 代码内嵌 / bundled 随发行物 / user 复制安装 / local-link 开发者链接。 */
const ORIGIN_LABELS: Record<CatalogEntry["origin"], string> = {
	builtin: "平台内置",
	bundled: "随产品预置",
	user: "用户安装",
	"local-link": "开发者本地链接",
};

type ExtensionConnectionAction = NonNullable<ExtensionConnectionStatus["actions"]>[number];

function EntryCard({
	entry,
	connection,
	catalogUnconfirmed,
	connectionChecking,
	connectionError,
	onChanged,
	onConnectionAction,
}: {
	entry: CatalogEntry;
	connection?: ExtensionConnectionStatus;
	catalogUnconfirmed: boolean;
	connectionChecking: boolean;
	connectionError: string | null;
	onChanged: () => void;
	onConnectionAction: (connection: ExtensionConnectionStatus, action: ExtensionConnectionAction) => void;
}) {
	const { manifest } = entry;
	const router = useRouter();
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const [updatePath, setUpdatePath] = useState("");
	const [updatePin, setUpdatePin] = useState(entry.versionPin ?? "");
	const [confirmUninstall, setConfirmUninstall] = useState(false);
	const [conflict, setConflict] = useState<{ message: string; agents: string[]; runs: ConflictRun[] } | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const isLarkCli = manifest.kind === "capability" && manifest.capability.id === "lark-cli";
	const description = manifest.kind === "connector"
		? `连接 ${manifest.connector.displayName}，通过 ${manifest.connector.defaultTransport} 运行`
		: isLarkCli
			? "为 Manager 或 Pi Worker 注入飞书 CLI 与配套 Skills"
		: manifest.capability.tools.length > 0
			? `提供 ${manifest.capability.tools.length} 个工具：${manifest.capability.tools.slice(0, 3).map((tool) => tool.name).join("、")}`
			: `为兼容的 Worker 提供 ${manifest.capability.displayName} 能力`;
	const usage = manifest.kind === "connector"
		? `${manifest.connector.supportedTransports.length} 种传输方式`
		: isLarkCli
			? "CLI + Skills"
			: manifest.capability.tools.length > 0 ? `${manifest.capability.tools.length} 个工具` : "运行时能力";
	const compatibleTargets = manifest.kind === "capability"
		? manifest.capability.compatibleConnectors?.includes("pi")
			? "Manager 或 Pi Worker"
			: "兼容的 Worker"
		: "Worker";
	const cliInstallAction = isLarkCli ? connection?.actions?.find((action) => action.id === "install-cli") : undefined;
	const openAgentList = () => {
		setDetailsOpen(false);
		router.push("/agents");
	};

	const handleUpdate = async () => {
		if (catalogUnconfirmed || busyRef.current || (entry.origin === "user" && !updatePath.trim())) return;
		busyRef.current = true;
		setBusy(true);
		try {
			await updateExtension(manifest.id, {
				...(updatePath.trim() ? { path: updatePath.trim() } : {}),
				versionPin: updatePin.trim(),
			});
			toast.success(`「${manifest.id}」已更新`);
			setUpdateOpen(false);
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const handleUninstall = async () => {
		if (catalogUnconfirmed || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			await uninstallExtension(manifest.id);
			toast.success(`「${manifest.id}」已卸载；历史绑定保留，调用时将提示 Connector 不可用`);
			setConfirmUninstall(false);
			onChanged();
		} catch (err) {
			if (err instanceof ApiConflictError) {
				setConfirmUninstall(false);
				setConflict({ message: err.message, agents: err.payload.agents ?? [], runs: err.payload.runs ?? [] });
			} else {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	return (
		<>
			<div className="ops-extension-row">
				<div className={`ops-extension-icon ${manifest.kind}`}>
					{manifest.kind === "connector" ? <CableIcon className="size-5" /> : <WrenchIcon className="size-5" />}
				</div>
				<div className="min-w-0">
					<div className="flex min-w-0 items-baseline gap-2">
						<div className="truncate text-sm font-medium">{manifest.displayName}</div>
						<code className="truncate font-mono text-[11px] text-muted-foreground">{manifest.id}</code>
					</div>
					<p className="mt-1 truncate text-xs text-muted-foreground" title={description}>{description}</p>
				</div>
				<div className="ops-extension-meta">
					<span className={entry.loaded ? "text-foreground" : "text-destructive"}>{entry.loaded ? "已加载" : "加载失败"}</span>
					<span>插件 v{entry.version} · {usage}</span>
				</div>
				<div className="flex items-center gap-2">
					{connection && cliInstallAction ? (
						<Button type="button" size="sm" disabled={connectionChecking || Boolean(connectionError)} onClick={() => onConnectionAction(connection, cliInstallAction)}>
							安装 CLI
						</Button>
					) : null}
					<Button type="button" size="sm" variant="secondary" onClick={() => setDetailsOpen(true)}>查看</Button>
				</div>
			</div>

			<Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
				<DialogContent
					overlayClassName="extension-detail-overlay"
					className="extension-detail-dialog max-h-[min(88vh,780px)] gap-0 overflow-hidden p-0 sm:max-w-[700px]"
				>
					<DialogHeader className="extension-detail-header">
						<div className={`extension-detail-hero-icon ${manifest.kind}`}>
							{manifest.kind === "connector" ? <CableIcon className="size-5" /> : <WrenchIcon className="size-5" />}
						</div>
						<div className="min-w-0">
							<div className="extension-detail-eyebrow">{manifest.kind === "connector" ? "连接插件" : "能力插件"}</div>
							<DialogTitle className="mt-1 text-xl">{manifest.displayName}</DialogTitle>
							<DialogDescription className="mt-1.5 leading-6">{description}</DialogDescription>
						</div>
					</DialogHeader>

					<div className="extension-detail-scroll">
						<div className={`extension-detail-status ${entry.loaded ? "is-ready" : "is-error"}`}>
							{entry.loaded ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" /> : <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />}
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<strong>{entry.loaded ? "插件已就绪" : "插件加载失败"}</strong>
									<span className="extension-detail-version">插件版本 v{entry.version}{entry.versionPin ? ` · 固定 ${entry.versionPin}` : ""}</span>
								</div>
								<p>{entry.loaded
									? manifest.kind === "capability"
										? isLarkCli
											? "飞书能力插件已内置。CLI 是独立运行依赖，可在下方检查并按需安装。"
											: `已完成插件安装。绑定到 ${compatibleTargets} 后方可生效。`
										: "已完成插件安装。创建或编辑 Worker 时选择该连接插件并完成配置后即可使用。"
									: "请先处理下方加载错误，再进行绑定。"}</p>
							</div>
						</div>

						{isLarkCli ? (
							<section className="extension-detail-section" aria-labelledby="lark-cli-runtime">
								<div className="extension-detail-section-heading"><h3 id="lark-cli-runtime">运行依赖</h3><span>飞书官方 CLI</span></div>
								<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/35 px-4 py-3">
									<div className="min-w-0">
										<div className="text-sm font-medium">{connection ? (connection.state === "unavailable" ? "尚未安装飞书 CLI" : `飞书 CLI ${connection.version ? `v${connection.version}` : "已安装"}`) : "正在检查飞书 CLI…"}</div>
										<p className="mt-1 text-xs text-muted-foreground">{connectionError ? `连接检查失败：${connectionError}。请在「连接状态」重新检查。` : connectionChecking ? "正在重新检查连接状态…" : connection?.message ?? "探测只读取状态，不会自动安装或更新。"}</p>
									</div>
									{connection && cliInstallAction ? <Button type="button" size="sm" disabled={connectionChecking || Boolean(connectionError)} onClick={() => { setDetailsOpen(false); onConnectionAction(connection, cliInstallAction); }}>安装飞书 CLI</Button> : null}
								</div>
							</section>
						) : null}

						<section className="extension-detail-section" aria-labelledby={`usage-${manifest.id}`}>
							<div className="extension-detail-section-heading">
								<h3 id={`usage-${manifest.id}`}>怎么使用</h3>
								<span>{manifest.kind === "capability" ? `绑定到 ${compatibleTargets}` : "配置一个 Worker"}</span>
							</div>
							<ol className="extension-detail-steps">
								<li>
									<span className="extension-detail-step-number">1</span>
									<div><strong>选择运行它的 Agent</strong><p>{manifest.kind === "capability" ? `前往「智能体」，打开 ${compatibleTargets} 的配置页。` : "前往「智能体」，打开一个 Worker 的配置页。"}</p></div>
								</li>
								<li>
									<span className="extension-detail-step-number">2</span>
									<div><strong>{manifest.kind === "capability" ? `绑定「${manifest.displayName}」` : `选择「${manifest.displayName}」`}</strong><p>{isLarkCli ? "先在本页确认 CLI 已安装，再前往 Agent 配置页完成绑定。绑定后的「探测」只检查版本和登录状态，不会触发安装。" : manifest.kind === "capability" ? "在扩展配置中添加它，保存后执行一次环境探测；若未登录，按提示完成认证。" : "填写命令、凭据等必需配置，保存并通过连接探测。"}</p></div>
								</li>
								<li>
									<span className="extension-detail-step-number">3</span>
									<div><strong>回到房间直接提任务</strong><p>{manifest.kind === "capability" ? isLarkCli ? "例如：读取这个飞书文档并总结。Agent 会按需调用飞书 CLI。" : "直接描述目标；Agent 会按需调用插件提供的能力。" : "把任务交给该 Worker；房间会负责调度、审批和结果交接。"}</p></div>
								</li>
							</ol>
						</section>

						<section className="extension-detail-section" aria-labelledby={`technical-${manifest.id}`}>
							<div className="extension-detail-section-heading"><h3 id={`technical-${manifest.id}`}>技术信息</h3></div>
							<dl className="extension-detail-facts">
								<div><dt>发布者</dt><dd>{manifest.publisher}</dd></div>
								<div><dt>安装来源</dt><dd>{ORIGIN_LABELS[entry.origin]} · {SOURCE_LABELS[manifest.source] ?? manifest.source}</dd></div>
								<div><dt>引擎范围</dt><dd>{manifest.engines.puddingteams}</dd></div>
								<div><dt>{manifest.kind === "connector" ? "连接标识" : "能力标识"}</dt><dd><code>{manifest.kind === "connector" ? manifest.connector.id : manifest.capability.id}</code></dd></div>
								<div className="wide"><dt>{manifest.kind === "connector" ? "传输方式" : "兼容范围"}</dt><dd>{manifest.kind === "connector" ? `${manifest.connector.supportedTransports.join(" / ")}（默认 ${manifest.connector.defaultTransport}）` : manifest.capability.compatibleConnectors?.join(" / ") || "全部连接插件"}</dd></div>
								<div className="wide"><dt>权限</dt><dd className="extension-detail-permissions">{manifest.permissions?.length ? manifest.permissions.map((permission) => <span key={permission}>{permission}</span>) : "无额外权限"}</dd></div>
							</dl>
						</section>

						{manifest.kind === "capability" && manifest.capability.tools.length > 0 ? <section className="extension-detail-section"><div className="extension-detail-section-heading"><h3>提供的工具</h3><span>{manifest.capability.tools.length} 个</span></div><div className="flex flex-wrap gap-1.5">{manifest.capability.tools.map((tool) => <Badge key={tool.name} variant="outline" title={tool.description}>{tool.name}</Badge>)}</div></section> : null}
						{entry.drifted ? <p className="extension-detail-warning">本地源已经发生变化，建议更新后再使用。</p> : null}
						{entry.loadError ? <p className="extension-detail-error">{entry.loadError}</p> : null}
					</div>

					<DialogFooter className="extension-detail-footer">
						<div>
							{entry.origin === "local-link" || entry.origin === "user" ? <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={catalogUnconfirmed} onClick={() => { setDetailsOpen(false); setConfirmUninstall(true); }}><TrashIcon className="size-3.5" />卸载</Button> : null}
						</div>
						<div className="extension-detail-actions">
							{entry.origin === "local-link" || entry.origin === "user" ? <Button type="button" variant="outline" disabled={catalogUnconfirmed} onClick={() => { setDetailsOpen(false); setUpdatePath(""); setUpdatePin(entry.versionPin ?? ""); setUpdateOpen(true); }}>更新</Button> : null}
							<Button type="button" variant="ghost" onClick={() => setDetailsOpen(false)}>关闭</Button>
							<Button type="button" disabled={!entry.loaded || catalogUnconfirmed} onClick={openAgentList}>去智能体绑定<ArrowRightIcon className="size-3.5" /></Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 更新对话框 */}
			<Dialog open={updateOpen} onOpenChange={(open) => { if (!open && busyRef.current) return; setUpdateOpen(open); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>更新「{manifest.id}」</DialogTitle>
						<DialogDescription>
							本地链接可从原路径重读；用户包必须指定新来源目录重新复制。固定版本时新版本必须与 pin 一致，清空固定版本可解除限制。
						</DialogDescription>
					</DialogHeader>
					<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">扩展目录路径（{entry.origin === "user" ? "用户包更新必填" : "留空 = 原安装路径"}）</span>
						<Input value={updatePath} onChange={(e) => setUpdatePath(e.target.value)} className="font-mono text-xs" />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">固定版本（留空 = 不固定）</span>
						<Input value={updatePin} onChange={(e) => setUpdatePin(e.target.value)} placeholder="如 0.9.1" className="font-mono text-xs" />
					</label>
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={busy} onClick={() => setUpdateOpen(false)}>
							取消
						</Button>
						<Button type="button" disabled={busy || catalogUnconfirmed || (entry.origin === "user" && !updatePath.trim())} onClick={() => void handleUpdate()}>
							{busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							更新
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 卸载确认 */}
			<Dialog open={confirmUninstall} onOpenChange={(open) => { if (!open && busyRef.current) return; setConfirmUninstall(open); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>卸载「{manifest.id}」</DialogTitle>
						<DialogDescription>
							卸载后模块注册与安装记录被移除；引用它的历史 Agent 绑定保留，调用时将提示不可用（不静默回退）。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmUninstall(false)}>
							取消
						</Button>
						<Button type="button" variant="destructive" disabled={busy || catalogUnconfirmed} onClick={() => void handleUninstall()}>
							卸载
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 卸载 409：引用它的 agents / 进行中 runs */}
			<Dialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>无法卸载</DialogTitle>
						<DialogDescription>{conflict?.message}</DialogDescription>
					</DialogHeader>
					{conflict && conflict.agents.length > 0 ? (
						<div className="flex flex-col gap-1">
							<span className="text-sm text-muted-foreground">引用它的启用 Agent（先停用）：</span>
							{conflict.agents.map((name) => (
								<code key={name} className="font-mono text-xs">
									{name}
								</code>
							))}
						</div>
					) : null}
					{conflict && conflict.runs.length > 0 ? (
						<div className="flex flex-col gap-1">
							<span className="text-sm text-muted-foreground">进行中的 Run：</span>
							{conflict.runs.map((run) => (
								<div key={run.delegationId} className="font-mono text-xs text-muted-foreground">
									{run.delegationId} · {run.agentId ?? "—"} · {run.executionState} · 窗口 {run.windowId}
								</div>
							))}
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" onClick={() => setConflict(null)}>
							知道了
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function SkillsLibraryView({ onCountChange, onLoadError, importOpen, setImportOpen }: { onCountChange: (count: number) => void; onLoadError: (message: string) => void; importOpen: boolean; setImportOpen: (open: boolean) => void }) {
	const router = useRouter();
	const [skills, setSkills] = useState<SkillEntry[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [importPath, setImportPath] = useState("");
	const [importing, setImporting] = useState(false);
	const [previewSkill, setPreviewSkill] = useState<SkillEntry | null>(null);
	const [previewDocument, setPreviewDocument] = useState<SkillDocument | null>(null);
	const [previewAgents, setPreviewAgents] = useState<AgentConfig[] | null>(null);
	const [previewAgentsError, setPreviewAgentsError] = useState<string | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const skillsRequest = useRef(0);
	const previewRequest = useRef(0);
	const filteredSkills = useMemo(() => {
		if (!skills) return null;
		const needle = query.trim().toLowerCase();
		if (!needle) return skills;
		return skills.filter((skill) => [skill.name, skill.description]
			.some((value) => value?.toLowerCase().includes(needle)));
	}, [query, skills]);

	const refresh = useCallback(async () => {
		const requestId = ++skillsRequest.current;
		setLoading(true);
		setLoadError(null);
		try {
			const { skills: nextSkills } = await listSkillLibrary();
			if (requestId !== skillsRequest.current) return;
			setSkills(nextSkills);
			onCountChange(nextSkills.length);
		} catch (err) {
			if (requestId !== skillsRequest.current) return;
			const message = err instanceof Error ? err.message : String(err);
			setLoadError(message);
			onLoadError(message);
		} finally {
			if (requestId === skillsRequest.current) setLoading(false);
		}
	}, [onCountChange, onLoadError]);

	useEffect(() => {
		const timer = window.setTimeout(() => void refresh(), 0);
		return () => {
			window.clearTimeout(timer);
			skillsRequest.current += 1;
			previewRequest.current += 1;
		};
	}, [refresh]);

	const importSkill = async () => {
		if (!importPath.trim()) return;
		setImporting(true);
		try {
			await importSkillResource(importPath.trim());
			toast.success("Skill 已导入资源库");
			setImportPath("");
			setImportOpen(false);
			await refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setImporting(false);
		}
	};

	const importZip = async (file: File) => {
		setImporting(true);
		try {
			const result = await importSkillsZip(file);
			toast.success(`已导入 ${result.imported.length} 个 Skill${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ""}`);
			setImportOpen(false);
			await refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setImporting(false);
		}
	};

	const pickSkillDirectory = async () => {
		try {
			const picked = await pickWorkspaceDirectory(importPath.trim() || "/");
			if (picked) setImportPath(picked);
		} catch {
			// 用户取消或目录选择不可用，保持当前输入
		}
	};

	const openPreview = async (skill: SkillEntry) => {
		const requestId = ++previewRequest.current;
		setPreviewSkill(skill);
		setPreviewDocument(null);
		setPreviewAgents(null);
		setPreviewAgentsError(null);
		setPreviewError(null);
		const [documentResult, agentsResult] = await Promise.allSettled([
			getSkillResource(skill.name),
			listAgents(),
		]);
		if (requestId !== previewRequest.current) return;
		if (documentResult.status === "fulfilled") setPreviewDocument(documentResult.value);
		else setPreviewError(documentResult.reason instanceof Error ? documentResult.reason.message : String(documentResult.reason));
		if (agentsResult.status === "fulfilled") setPreviewAgents(agentsResult.value.filter((agent) => agent.piResources?.enabledSkills?.includes(skill.name)));
		else setPreviewAgentsError(agentsResult.reason instanceof Error ? agentsResult.reason.message : String(agentsResult.reason));
	};

	const closePreview = () => {
		previewRequest.current += 1;
		setPreviewSkill(null);
		setPreviewDocument(null);
		setPreviewAgents(null);
		setPreviewAgentsError(null);
		setPreviewError(null);
	};

	return (
		<div className="flex flex-col gap-4 py-6">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<div className="flex items-center gap-2 text-sm font-medium"><SparklesIcon className="size-4 text-primary" />Skills 资源库</div>
					<p className="mt-1 text-xs text-muted-foreground">与 pi CLI 共享；这里只管理资源本体，启用范围在各 Agent 配置页「技能」分区。</p>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-2">
					<label className="ops-extension-search">
						<SearchIcon className="size-4" />
						<Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skills" aria-label="搜索 Skills" />
					</label>
					<Button type="button" size="sm" className="ops-library-import" onClick={() => setImportOpen(true)}><UploadIcon className="size-3.5" />导入 Skill</Button>
				</div>
			</div>
			{loadError ? (
				<div role="alert" className="flex items-center justify-between gap-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
					<span>Skills 资源库读取失败：{loadError}{skills ? "；下方显示上次读取的结果。" : ""}</span>
					<Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}><RefreshCwIcon className="size-4" />重试</Button>
				</div>
			) : null}
			{loading && skills === null ? (
				<div className="flex items-center justify-center gap-2 pt-12 text-sm text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />加载中…</div>
			) : skills === null ? null : skills.length === 0 ? (
				<div className="ops-empty-state"><div className="text-sm font-medium">资源库还没有 Skill</div><p className="mt-2 text-sm text-muted-foreground">导入包含 SKILL.md 的目录或 zip 文件后，会在这里统一查看。</p></div>
			) : filteredSkills && filteredSkills.length === 0 ? (
				<div className="ops-empty-state"><div className="text-sm font-medium">没有匹配的 Skill</div><p className="mt-2 text-sm text-muted-foreground">试试 Skill 名称或描述中的关键词。</p></div>
			) : (
				<div className="skills-library-list">
					{filteredSkills?.map((skill) => {
						return <button type="button" key={skill.name} className="skills-library-row flex items-center gap-3 px-4 py-3" onClick={() => void openPreview(skill)}>
							<div className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><SparklesIcon className="size-4" /></div>
							<div className="min-w-0 flex-1"><div className="truncate font-mono text-sm">{skill.name}</div><div className="truncate text-xs text-muted-foreground">{skill.description || "无描述"}</div></div>
							<ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
						</button>;
					})}
				</div>
			)}
			<Dialog open={previewSkill !== null} onOpenChange={(open) => { if (!open) closePreview(); }}>
				<DialogContent
					overlayClassName="skill-preview-overlay"
					className="skill-preview-dialog max-h-[min(88vh,820px)] gap-0 overflow-hidden p-0 sm:max-w-[820px]"
				>
					<DialogHeader className="skill-preview-header">
						<div className="skill-preview-icon"><SparklesIcon className="size-5" /></div>
						<div className="min-w-0">
							<div className="skill-preview-eyebrow">Skill 预览</div>
							<DialogTitle className="mt-1 truncate font-mono text-xl">{previewSkill?.name}</DialogTitle>
							<DialogDescription className="mt-1.5 line-clamp-2 leading-6">{previewSkill?.description || "这个 Skill 暂无描述。"}</DialogDescription>
						</div>
					</DialogHeader>

					<div className="skill-preview-body">
						<main className="skill-preview-reading">
							<div className="skill-preview-section-title"><span>使用说明</span><span>SKILL.md</span></div>
							{previewError ? (
								<div className="skill-preview-load-error"><ShieldAlertIcon className="size-4" /><span>{previewError}</span></div>
							) : previewDocument === null ? (
								<div className="skill-preview-loading"><LoaderIcon className="size-4 animate-spin" />正在读取 Skill…</div>
							) : previewDocument.content.trim() ? (
								<ClipboardSafeStreamdown
									mode="static"
									controls={false}
									skipHtml
									components={skillPreviewMarkdownComponents}
									urlTransform={skillPreviewUrlTransform}
									className="skill-preview-markdown"
								>{normalizeSkillPreviewMarkdown(previewDocument.content)}</ClipboardSafeStreamdown>
							) : (
								<div className="skill-preview-empty">SKILL.md 暂无正文。</div>
							)}
						</main>

						<aside className="skill-preview-aside">
							{previewSkill?.disableModelInvocation ? (
								<section className="skill-preview-aside-section">
									<div className="skill-preview-aside-label">调用限制</div>
									<div className="skill-preview-invocation">
										<ShieldAlertIcon className="skill-preview-invocation-icon" />
										<div><strong>仅支持手动调用</strong><p>通过 <code>/skill:{previewSkill.name}</code> 显式调用</p></div>
									</div>
								</section>
							) : null}

							<section className="skill-preview-aside-section">
								<div className="skill-preview-aside-heading"><span className="skill-preview-aside-label">启用范围</span>{previewAgents !== null ? <span>{previewAgents.length} 个 Agent</span> : null}</div>
								{previewAgentsError ? (
									<p role="alert" className="skill-preview-aside-empty text-destructive">启用范围读取失败：{previewAgentsError}</p>
								) : previewAgents === null ? (
									<div className="skill-preview-agent-loading"><LoaderIcon className="size-3.5 animate-spin" />正在检查…</div>
								) : previewAgents.length > 0 ? (
									<div className="skill-preview-agent-list">{previewAgents.map((agent) => <div key={agent.name} className="skill-preview-agent"><span>{agent.pinned ? <ManagerAvatar size={24} /> : <WorkerAvatar name={agent.name} size={24} />}</span><span className="truncate">{agentDisplayName(agent)}</span></div>)}</div>
								) : (
									<p className="skill-preview-aside-empty">尚未被任何 Agent 启用</p>
								)}
							</section>

							<section className="skill-preview-aside-section">
								<div className="skill-preview-aside-label">资源位置</div>
								<div className="skill-preview-source">pi 全局 Skills</div>
								<code title={previewSkill?.path}>{previewSkill?.path}</code>
							</section>
						</aside>
					</div>

					<DialogFooter className="skill-preview-footer">
						<p>启用范围在各 Agent 配置页的「技能」中管理。</p>
						<div className="skill-preview-actions">
							<Button type="button" variant="ghost" onClick={closePreview}>关闭</Button>
							<Button type="button" onClick={() => { closePreview(); router.push("/agents"); }}>管理启用范围<ArrowRightIcon className="size-3.5" /></Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<SkillImportDialog
				open={importOpen}
				onOpenChange={setImportOpen}
				path={importPath}
				onPathChange={setImportPath}
				onPickDirectory={pickSkillDirectory}
				onImportPath={importSkill}
				onImportZip={importZip}
				importing={importing}
			/>
		</div>
	);
}

const CONNECTION_STATE_META: Record<ExtensionConnectionStatus["state"], { label: string; className: string; dot: string }> = {
	connected: {
		label: "已连接",
		className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		dot: "bg-emerald-500",
	},
	disconnected: {
		label: "未登录",
		className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		dot: "bg-amber-500",
	},
	unavailable: {
		label: "不可用",
		className: "border-border bg-muted text-muted-foreground",
		dot: "bg-muted-foreground/60",
	},
	error: {
		label: "检查失败",
		className: "border-destructive/25 bg-destructive/10 text-destructive",
		dot: "bg-destructive",
	},
};

function ConnectionsView({
	connections,
	loading,
	error,
	onRefresh,
	onAction,
}: {
	connections: ExtensionConnectionStatus[] | null;
	loading: boolean;
	error: string | null;
	onRefresh: () => void;
	onAction: (connection: ExtensionConnectionStatus, action: ExtensionConnectionAction) => void;
}) {
	return (
		<div className="py-8">
			<div className="mb-5 flex items-end justify-between gap-5">
				<div>
					<h2 className="text-base font-medium tracking-tight">连接状态</h2>
					<p className="mt-1 text-xs text-muted-foreground">查看插件连接的外部系统与当前账号状态</p>
				</div>
				<Button type="button" size="sm" variant="outline" disabled={loading} onClick={onRefresh}>
					<RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
					重新检查
				</Button>
			</div>

			{error ? (
				<div role="alert" className="ops-empty-state mx-auto mt-16 max-w-xl">
					<div className="text-sm font-medium">连接状态检查失败</div>
					<p className="mt-2 text-sm text-muted-foreground">{error}{connections ? "。下方保留上次检查结果；请重新检查后再操作。" : ""}</p>
					<Button type="button" size="sm" variant="outline" className="mt-4" disabled={loading} onClick={onRefresh}>重新检查</Button>
				</div>
			) : null}
			{connections === null && !error ? (
				<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
					<LoaderIcon className="size-4 animate-spin" />
					正在检查连接…
				</div>
			) : connections?.length === 0 && !error ? (
				<div className="ops-empty-state mx-auto mt-16 max-w-xl">
					<div className="text-sm font-medium">还没有可检查的连接</div>
					<p className="mt-2 text-sm text-muted-foreground">安装支持连接状态的插件后，会统一显示在这里。</p>
				</div>
			) : connections?.length ? (
				<div className="grid gap-3 md:grid-cols-2">
					{connections.map((connection) => {
						const meta = CONNECTION_STATE_META[connection.state];
						const statusLabel = meta.label;
						const checkedAt = new Date(connection.checkedAt);
						const checkedLabel = Number.isNaN(checkedAt.getTime())
							? "刚刚检查"
							: checkedAt.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
						return (
							<article key={connection.id} className="rounded-2xl border border-border/80 bg-card px-5 py-4 shadow-sm">
								<div className="flex flex-wrap items-start gap-3">
									<div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
										<CableIcon className="size-5" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<h3 className="text-sm font-medium">{connection.name}</h3>
											<span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
												<span className={`size-1.5 rounded-full ${meta.dot}`} />
												{statusLabel}
											</span>
										</div>
										<p className="mt-1 text-xs text-muted-foreground">{connection.description ?? connection.extensionName}</p>
									</div>
									<span className="text-[11px] text-muted-foreground">{error ? `上次检查：${checkedLabel}` : checkedLabel}</span>
								</div>

								<div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/70 pt-4 xl:grid-cols-3">
									<div><div className="text-[11px] text-muted-foreground">账号</div><div className="mt-1 text-sm font-medium">{connection.accountName ?? "—"}</div></div>
									<div><div className="text-[11px] text-muted-foreground">身份</div><div className="mt-1 text-sm font-medium">{connection.identity ?? "—"}</div></div>
									<div><div className="text-[11px] text-muted-foreground">CLI 版本</div><div className="mt-1 font-mono text-sm">{connection.version ? `v${connection.version}` : connection.actions?.some(action => action.id === "install-cli") ? "未安装" : "—"}</div></div>
									{connection.userAuthorization ? <div><div className="text-[11px] text-muted-foreground">用户授权</div><div className={`mt-1 text-sm font-medium ${connection.userAuthorization === "authorized" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{connection.userAuthorization === "authorized" ? "已授权" : connection.userAuthorization === "expired" ? "已过期" : "未授权"}</div></div> : null}
								</div>
								{connection.message ? <p className="mt-3 text-xs text-muted-foreground">{connection.message}</p> : null}
								{connection.actions?.length ? (
									<div className="mt-4 flex flex-wrap gap-2 border-t border-border/70 pt-4">
										{connection.actions.map((action) => (
											<Button key={action.id} type="button" size="sm" disabled={loading || Boolean(error)} onClick={() => onAction(connection, action)}>{action.label}</Button>
										))}
									</div>
								) : null}
							</article>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

export function ExtensionsPane() {
	// tab 由 URL 查询参数驱动（/extensions?tab=skills|templates|mcp|plugins|connections）：刷新、
	// 浏览器前进/后退都保持当前分类；无参数时按冻结原型进入 Skills。
	// 静态导出不能用动态段，与
	// /agents/config?name= 同一约定。
	const searchParams = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();
	const rawTab = searchParams.get("tab");
	const view: ExtensionView = rawTab === "skills" || rawTab === "templates" || rawTab === "mcp" || rawTab === "plugins" || rawTab === "connections" ? rawTab : "skills";
	const setView = (key: ExtensionView) => {
		if (key !== view) router.push(`${pathname}?tab=${key}`, { scroll: false });
	};
	const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
	const [pluginError, setPluginError] = useState<string | null>(null);
	const pluginRequestId = useRef(0);
	const [skillsError, setSkillsError] = useState<string | null>(null);
	const skillsViewLoaded = useRef(false);
	const [templatesError, setTemplatesError] = useState<string | null>(null);
	const templatesViewLoaded = useRef(false);
	const [mcpAdapterVersion, setMcpAdapterVersion] = useState<string | null>(null);
	const [mcpError, setMcpError] = useState<string | null>(null);
	const mcpViewLoaded = useRef(false);
	const [query, setQuery] = useState("");
	const [pluginKind, setPluginKind] = useState<PluginKindFilter>("all");
	const [installPath, setInstallPath] = useState("");
	const [installPin, setInstallPin] = useState("");
	const [installCopy, setInstallCopy] = useState(false);
	const [installing, setInstalling] = useState(false);
	const installingRef = useRef(false);
	const [installOpen, setInstallOpen] = useState(false);
	const [developerMode, setDeveloperModeState] = useState(false);
	const [developerModeLoaded, setDeveloperModeLoaded] = useState(false);
	const [developerWarningOpen, setDeveloperWarningOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	// 慢接口（尤其连接探测）完成前优先展示上次已知数量，避免刷新时徽标
	// 消失和 Tab 文案位移。首次无缓存时仍保留一个固定尺寸的加载徽标。
	const [tabCounts, setTabCounts] = useState<ExtensionTabCounts>({
		skills: null,
		templates: null,
		mcp: null,
		plugins: null,
		connections: null,
	});
	const [connections, setConnections] = useState<ExtensionConnectionStatus[] | null>(null);
	const [connectionsLoading, setConnectionsLoading] = useState(false);
	const [connectionsError, setConnectionsError] = useState<string | null>(null);
	const connectionsRequestId = useRef(0);
	const [pendingConnectionAction, setPendingConnectionAction] = useState<{
		connection: ExtensionConnectionStatus;
		action: ExtensionConnectionAction;
	} | null>(null);
	const [connectionActionBusy, setConnectionActionBusy] = useState(false);
	const [authorizationAction, setAuthorizationAction] = useState<{ connection: ExtensionConnectionStatus; actionId: string } | null>(null);
	const onConnectionAction = (connection: ExtensionConnectionStatus, action: ExtensionConnectionAction) => {
		if (action.kind === "authorization") setAuthorizationAction({ connection, actionId: action.id });
		else setPendingConnectionAction({ connection, action });
	};
	const updateTabCount = useCallback((key: ExtensionView, value: number) => {
		setTabCounts((current) => current[key] === value ? current : { ...current, [key]: value });
		persistTabCount(key, value);
	}, []);
	const updateMcpCount = useCallback((count: number) => {
		mcpViewLoaded.current = true;
		setMcpError(null);
		updateTabCount("mcp", count);
	}, [updateTabCount]);
	const reportMcpError = useCallback((message: string) => setMcpError(message), []);
	const updateSkillsCount = useCallback((count: number) => {
		skillsViewLoaded.current = true;
		setSkillsError(null);
		updateTabCount("skills", count);
	}, [updateTabCount]);
	const reportSkillsError = useCallback((message: string) => setSkillsError(message), []);
	const updateTemplatesCount = useCallback((count: number) => {
		templatesViewLoaded.current = true;
		setTemplatesError(null);
		updateTabCount("templates", count);
	}, [updateTabCount]);
	const reportTemplatesError = useCallback((message: string) => setTemplatesError(message), []);

	// 静态预渲染的首个 state 不含 localStorage；hydration 会复用它而不会重跑
	// lazy initializer。绘制前补入缓存，避免用户看到一段时间的空计数。
	useIsomorphicLayoutEffect(() => {
		const cached = cachedTabCounts();
		setTabCounts((current) => {
			const next = { ...current };
			let changed = false;
			for (const key of ["skills", "templates", "mcp", "plugins", "connections"] as const) {
				if (next[key] === null && cached[key] !== undefined) {
					next[key] = cached[key]!;
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, []);
	const filteredEntries = useMemo(() => {
		if (!entries) return null;
		const needle = query.trim().toLowerCase();
		return entries.filter((entry) => {
			if (pluginKind !== "all" && entry.manifest.kind !== pluginKind) return false;
			if (!needle) return true;
			const contribution = entry.manifest.kind === "connector" ? entry.manifest.connector : entry.manifest.capability;
			return [entry.manifest.displayName, entry.manifest.id, contribution.displayName, contribution.id]
				.some((value) => value.toLowerCase().includes(needle));
		});
	}, [entries, pluginKind, query]);
	const mcpAdapterMatches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return !needle || ["mcp", "pi-mcp-adapter", "mcp server"].some((value) => value.includes(needle));
	}, [query]);
	const showMcpAdapter = pluginKind !== "connector" && mcpAdapterMatches;

	const refreshPlugins = useCallback(() => {
		const requestId = ++pluginRequestId.current;
		void Promise.allSettled([listExtensionCatalog("connector"), listExtensionCatalog("capability")])
			.then(([connectorResult, capabilityResult]) => {
				if (requestId !== pluginRequestId.current) return;
				const failures = [
					...(connectorResult.status === "rejected" ? [`Connector：${connectorResult.reason instanceof Error ? connectorResult.reason.message : String(connectorResult.reason)}`] : []),
					...(capabilityResult.status === "rejected" ? [`Capability：${capabilityResult.reason instanceof Error ? capabilityResult.reason.message : String(capabilityResult.reason)}`] : []),
				];
				setEntries((current) => connectorResult.status === "rejected" && capabilityResult.status === "rejected" && current === null ? null : [
					...(connectorResult.status === "fulfilled" ? connectorResult.value : current?.filter((entry) => entry.manifest.kind === "connector") ?? []),
					...(capabilityResult.status === "fulfilled" ? capabilityResult.value : current?.filter((entry) => entry.manifest.kind === "capability") ?? []),
				]);
				setPluginError(failures.length ? failures.join("；") : null);
				if (connectorResult.status === "fulfilled" && capabilityResult.status === "fulfilled") updateTabCount("plugins", connectorResult.value.length + capabilityResult.value.length + 1);
				else setTabCounts((current) => ({ ...current, plugins: null }));
			});
	}, [updateTabCount]);

	const refreshConnections = useCallback(() => {
		const requestId = ++connectionsRequestId.current;
		setConnectionsLoading(true);
		setConnectionsError(null);
		listExtensionConnections()
			.then((nextConnections) => {
				if (requestId !== connectionsRequestId.current) return;
				setConnections(nextConnections);
				setConnectionsError(null);
				updateTabCount("connections", nextConnections.length);
			})
			.catch((err: unknown) => {
				if (requestId !== connectionsRequestId.current) return;
				setConnectionsError(err instanceof Error ? err.message : String(err));
				setTabCounts((current) => ({ ...current, connections: null }));
			})
			.finally(() => { if (requestId === connectionsRequestId.current) setConnectionsLoading(false); });
	}, [updateTabCount]);

	const executeConnectionAction = async () => {
		if (!pendingConnectionAction) return;
		if (connectionsLoading || connectionsError) {
			toast.error("连接状态尚未确认，请重新检查后再执行操作");
			return;
		}
		connectionsRequestId.current += 1;
		setConnectionsLoading(false);
		setConnectionActionBusy(true);
		try {
			const updated = await runExtensionConnectionAction(
				pendingConnectionAction.connection,
				pendingConnectionAction.action.id,
			);
			setConnections((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? [updated]);
			setConnectionsError(null);
			toast.success(`${pendingConnectionAction.action.label}已完成`);
			setPendingConnectionAction(null);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setConnectionActionBusy(false);
		}
	};

	// 插件数量属于顶层导航信息，不能依赖当前是否打开插件视图；否则刷新
	// /extensions?tab=skills 或 MCP 时 entries 会一直为空，计数徽标随之消失。
	useEffect(() => {
		void refreshPlugins();
		listMcpServers()
			.then((catalog) => {
				if (!mcpViewLoaded.current) {
					setMcpAdapterVersion(catalog.adapter.version);
					setMcpError(null);
					updateTabCount("mcp", catalog.servers.length);
				}
			})
			.catch((err: unknown) => {
				if (!mcpViewLoaded.current) {
					setMcpError(err instanceof Error ? err.message : String(err));
					setTabCounts((current) => ({ ...current, mcp: null }));
				}
			});
		const connectionsTimer = setTimeout(refreshConnections, 0);
		return () => clearTimeout(connectionsTimer);
	}, [refreshPlugins, refreshConnections, updateTabCount]);

	// 挂载即拉一次（tab 徽标要在进入 skills 视图前就有数），此后每次
	// 切到 skills 视图重新对齐。
	useEffect(() => {
		listSkillLibrary()
			.then(({ skills }) => {
				if (!skillsViewLoaded.current) {
					setSkillsError(null);
					updateTabCount("skills", skills.length);
				}
			})
			.catch((err: unknown) => {
				if (!skillsViewLoaded.current) {
					setSkillsError(err instanceof Error ? err.message : String(err));
					setTabCounts((current) => ({ ...current, skills: null }));
				}
			});
	}, [updateTabCount, view]);

	useEffect(() => {
		let active = true;
		listTemplateLibrary().then(({ templates }) => {
			if (active && !templatesViewLoaded.current) {
				setTemplatesError(null);
				updateTabCount("templates", templates.length);
			}
		}).catch((err: unknown) => {
			if (active && !templatesViewLoaded.current) {
				setTemplatesError(err instanceof Error ? err.message : String(err));
				setTabCounts(current => ({ ...current, templates: null }));
			}
		});
		return () => { active = false; };
	}, [updateTabCount, view]);

	useEffect(() => {
		getDeveloperMode()
			.then(setDeveloperModeState)
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
			.finally(() => setDeveloperModeLoaded(true));
	}, []);

	const applyDeveloperMode = async (enabled: boolean) => {
		try {
			setDeveloperModeState(await setDeveloperMode(enabled));
			setDeveloperWarningOpen(false);
			refreshPlugins();
			toast.success(enabled ? "开发者模式已开启" : "开发者模式已关闭，本地插件已停止加载");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	};

	const handleInstall = async () => {
		if (!installPath.trim() || pluginError || entries === null || installingRef.current) return;
		installingRef.current = true;
		setInstalling(true);
		try {
			const entry = await installExtension({
				path: installPath.trim(),
				...(installPin.trim() ? { versionPin: installPin.trim() } : {}),
				mode: installCopy ? "copy" : "link",
			});
			toast.success(`「${entry.manifest.displayName}」已安装（kind=${entry.manifest.kind}）`);
			setInstallPath("");
			setInstallPin("");
			setInstallCopy(false);
			setInstallOpen(false);
			// 安装的 kind 由 manifest 决定；插件视图统一展示 Connector 与 Capability。
			router.replace(`${pathname}?tab=plugins`, { scroll: false });
			refreshPlugins();
		} catch (err) {
			if (err instanceof TypeError) {
				toast.warning("安装请求结果未确认；请先核对插件列表，再决定是否重试");
				refreshPlugins();
			} else {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		} finally {
			installingRef.current = false;
			setInstalling(false);
		}
	};

	return (
		<div className="ops-page flex h-full flex-col">
			{developerMode ? (
				<div className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
					<ShieldAlertIcon className="size-3.5" />
					开发者模式已开启：本地插件代码与服务端同进程执行，拥有当前用户权限。
				</div>
			) : null}
			<header className="ops-page-header ops-extensions-header">
				<div>
					<h1 className="ops-page-title">扩展</h1>
					<p className="ops-page-subtitle">统一管理 Skills、提示词模板、MCP、插件和连接状态</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant={developerMode ? "secondary" : "outline"}
						disabled={!developerModeLoaded || installing}
						onClick={() => developerMode ? void applyDeveloperMode(false) : setDeveloperWarningOpen(true)}
					>
						<ShieldAlertIcon className="size-4" />
						开发者模式{developerMode ? "：开" : "：关"}
					</Button>
					{developerMode && view === "plugins" ? (
						<Button type="button" size="sm" disabled={entries === null || Boolean(pluginError)} onClick={() => setInstallOpen(true)}>
							<PackageIcon className="size-4" />
							安装本地插件
						</Button>
					) : null}
					{view === "skills" ? <Button type="button" size="sm" className="ops-mobile-skill-import" onClick={() => setImportOpen(true)}><UploadIcon className="size-3.5" />导入 Skill</Button> : null}
				</div>
			</header>
			<nav className="ops-tabs px-7" role="tablist" aria-label="扩展类型">
				{([
					["skills", "Skills", "任务方法与工作流"],
					["templates", "提示词模板", "可复用的提示词内容"],
					["mcp", "MCP", "外部工具、数据与服务"],
					["plugins", "插件", "连接插件与能力插件"],
					["connections", "连接状态", "外部系统与账号登录状态"],
				] as const).map(([key, label, description]) => (
					<button
						key={key}
						type="button"
						onClick={() => setView(key)}
						role="tab"
						aria-selected={view === key}
						className={`ops-tab ${view === key ? "active" : ""}`}
					>
						<span>{label}</span>
						<span
							className={`tab-count ${(key === "plugins" && pluginError) || (key === "connections" && connectionsError) || (key === "mcp" && mcpError) || (key === "skills" && skillsError) || (key === "templates" && templatesError) ? "text-destructive" : tabCounts[key] === null ? "is-loading" : ""}`}
							data-count-key={key}
							suppressHydrationWarning
						>
							{(key === "plugins" && pluginError) || (key === "connections" && connectionsError) || (key === "mcp" && mcpError) || (key === "skills" && skillsError) || (key === "templates" && templatesError) ? "!" : tabCounts[key]}
						</span>
						<span className="sr-only">{description}</span>
					</button>
				))}
			</nav>
			<div className="ops-page-scroll mx-auto w-full max-w-[1180px] flex-1 overflow-y-auto px-7 pb-10">
				{view === "skills" ? (
					<SkillsLibraryView onCountChange={updateSkillsCount} onLoadError={reportSkillsError} importOpen={importOpen} setImportOpen={setImportOpen} />
				) : view === "templates" ? (
					<TemplateLibraryView onCountChange={updateTemplatesCount} onLoadError={reportTemplatesError} />
				) : view === "mcp" ? (
					<McpServersView onCountChange={updateMcpCount} onLoadError={reportMcpError} />
				) : view === "connections" ? (
					<ConnectionsView
						connections={connections}
						loading={connectionsLoading}
						error={connectionsError}
						onRefresh={refreshConnections}
						onAction={onConnectionAction}
					/>
				) : pluginError && entries === null ? (
					<div role="alert" className="ops-empty-state mx-auto mt-16 max-w-xl">
						<div className="text-sm font-medium">插件目录加载失败</div>
						<p className="mt-2 text-sm text-muted-foreground">{pluginError}</p>
						<Button type="button" size="sm" variant="outline" className="mt-4" onClick={refreshPlugins}><RefreshCwIcon className="size-4" />重新加载</Button>
					</div>
				) : entries === null ? (
					<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : (
					<div className="py-8">
						{pluginError ? <div role="alert" className="mb-5 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-xs text-destructive"><strong>插件目录不完整</strong><p className="mt-1">{pluginError}。下方可能包含上次成功读取的条目；重新加载确认前仅供查看。</p><Button type="button" size="sm" variant="outline" className="mt-3" onClick={refreshPlugins}><RefreshCwIcon className="size-3.5" />重新加载</Button></div> : null}
						<div className="mb-5 flex items-end justify-between gap-5">
							<div><h2 className="text-base font-medium tracking-tight">插件</h2><p className="mt-1 text-xs text-muted-foreground">扩充智能体的连接方式与运行能力</p></div>
							<label className="ops-extension-search"><SearchIcon className="size-4" /><Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件" aria-label="搜索插件" /></label>
						</div>
						<div className="ops-plugin-filters" role="group" aria-label="插件类型">
							{([ ["all", "全部"], ["connector", "连接插件"], ["capability", "能力插件"] ] as const).map(([kind, label]) => (
								<button key={kind} type="button" className="ops-plugin-filter" aria-pressed={pluginKind === kind} onClick={() => setPluginKind(kind)}>{label}</button>
							))}
						</div>
						{showMcpAdapter || (filteredEntries && filteredEntries.length > 0) ? <div className="ops-extension-list">
							{showMcpAdapter ? <ManagedMcpPluginRow version={mcpAdapterVersion} /> : null}
							{(filteredEntries ?? []).map((entry) => <EntryCard
								key={entry.manifest.id}
								entry={entry}
								catalogUnconfirmed={Boolean(pluginError)}
								connection={connections?.find((connection) => connection.extensionId === entry.manifest.id)}
								connectionChecking={connectionsLoading}
								connectionError={connectionsError}
								onChanged={refreshPlugins}
								onConnectionAction={onConnectionAction}
							/>)}
						</div> : <div className="ops-empty-state"><div className="text-sm font-medium">没有匹配的插件</div><p className="mt-2 text-sm text-muted-foreground">试试插件名称、标识或能力名称。</p></div>}
					</div>
				)}
			</div>

			{authorizationAction ? <ConnectionAuthorizationDialog connection={authorizationAction.connection} actionId={authorizationAction.actionId} onClose={() => setAuthorizationAction(null)} onCompleted={refreshConnections} /> : null}

			<Dialog
				open={pendingConnectionAction !== null}
				onOpenChange={(open) => { if (!open && !connectionActionBusy) setPendingConnectionAction(null); }}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{pendingConnectionAction?.action.confirmation?.title ?? pendingConnectionAction?.action.label}</DialogTitle>
						<DialogDescription>
							{pendingConnectionAction?.action.confirmation?.description ?? pendingConnectionAction?.action.description}
						</DialogDescription>
					</DialogHeader>
					{connectionActionBusy ? (
						<div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
							<LoaderIcon className="size-4 shrink-0 animate-spin text-primary" />
							<div><div className="font-medium">正在安装飞书官方 CLI…</div><p className="mt-0.5 text-xs text-muted-foreground">正在通过 npm 下载并校验，请保持网络连接。</p></div>
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={connectionActionBusy} onClick={() => setPendingConnectionAction(null)}>取消</Button>
						<Button type="button" disabled={connectionActionBusy || connectionsLoading || Boolean(connectionsError)} onClick={() => void executeConnectionAction()}>
							{connectionActionBusy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							{connectionActionBusy ? "正在安装" : pendingConnectionAction?.action.confirmation?.confirmLabel ?? "继续"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 安装对话框：从本地目录读取 pudding-extension.json */}
			<Dialog open={installOpen} onOpenChange={(open) => { if (!open && installingRef.current) return; setInstallOpen(open); }}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>安装插件</DialogTitle>
						<DialogDescription>
							从本地目录安装：读取目录下的 pudding-extension.json，校验 kind / engines / permissions 后注册。默认本地链接（不复制源码）；勾选复制安装则作为用户包复制进数据目录。
						</DialogDescription>
					</DialogHeader>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">插件目录路径（服务端本机路径）</span>
						<Input
							value={installPath}
							disabled={installing}
							onChange={(e) => setInstallPath(e.target.value)}
							placeholder="/abs/path/to/extension"
							className="font-mono text-xs"
						/>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={installCopy} disabled={installing} onChange={(e) => setInstallCopy(e.target.checked)} />
						<span className="text-muted-foreground">复制安装（用户包，不随源目录变化）</span>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">固定版本（可选）</span>
						<Input value={installPin} disabled={installing} onChange={(e) => setInstallPin(e.target.value)} placeholder="如 0.9.1" className="font-mono text-xs" />
					</label>
					<DialogFooter>
						<Button type="button" variant="ghost" disabled={installing} onClick={() => setInstallOpen(false)}>
							取消
						</Button>
						<Button type="button" disabled={installing || !installPath.trim()} onClick={() => void handleInstall()}>
							{installing ? <LoaderIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
							安装
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={developerWarningOpen} onOpenChange={setDeveloperWarningOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>开启开发者模式？</DialogTitle>
						<DialogDescription>
							本地插件代码尚未运行在隔离的插件宿主中。开启后，插件可以读取文件、环境变量和凭证，也可能启动进程或访问网络。只加载你信任并已审查的代码。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setDeveloperWarningOpen(false)}>取消</Button>
						<Button type="button" variant="destructive" onClick={() => void applyDeveloperMode(true)}>我了解风险，开启</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
