"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRightIcon, CableIcon, CheckCircle2Icon, FileArchiveIcon, FolderOpenIcon, LoaderIcon, PackageIcon, RefreshCwIcon, SearchIcon, ShieldAlertIcon, SparklesIcon, TrashIcon, UploadIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	ApiConflictError,
	getDeveloperMode,
	installExtension,
	importSkillResource,
	importSkillsZip,
	listExtensionCatalog,
	listSkillLibrary,
	pickWorkspaceDirectory,
	setDeveloperMode,
	uninstallExtension,
	updateExtension,
} from "@/lib/api";
import type { CatalogEntry, ConflictRun, SkillEntry } from "@/lib/types";

/**
 * Extension 接入目录（§10.1）：kind=connector 与 kind=capability 分开的目录
 * 视图，不混在同一选择器。安装 / 更新 / 卸载是彼此独立的动作；卸载 409 时
 * 如实展示引用它的 agents / 进行中 runs。
 */

type ExtensionView = "skills" | "mcp" | "plugins";

const SOURCE_LABELS: Record<string, string> = {
	builtin: "内置来源",
	trusted: "可信来源",
	external: "外部来源",
};

/** 安装来源三态（文档 §8）：builtin 代码内嵌 / bundled 随发行物 / user 复制安装 / local-link 开发者链接。 */
const ORIGIN_LABELS: Record<CatalogEntry["origin"], string> = {
	builtin: "平台内置",
	bundled: "随产品预置",
	user: "用户安装",
	"local-link": "开发者本地链接",
};

function EntryCard({ entry, onChanged }: { entry: CatalogEntry; onChanged: () => void }) {
	const { manifest } = entry;
	const router = useRouter();
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const [updatePath, setUpdatePath] = useState("");
	const [updatePin, setUpdatePin] = useState(entry.versionPin ?? "");
	const [confirmUninstall, setConfirmUninstall] = useState(false);
	const [conflict, setConflict] = useState<{ message: string; agents: string[]; runs: ConflictRun[] } | null>(null);
	const [busy, setBusy] = useState(false);
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
	const openAgentList = () => {
		setDetailsOpen(false);
		router.push("/agents");
	};

	const handleUpdate = async () => {
		setBusy(true);
		try {
			await updateExtension(manifest.id, {
				...(updatePath.trim() ? { path: updatePath.trim() } : {}),
				...(updatePin.trim() ? { versionPin: updatePin.trim() } : {}),
			});
			toast.success(`「${manifest.id}」已更新`);
			setUpdateOpen(false);
			onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleUninstall = async () => {
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
						<div className="truncate text-sm font-semibold">{manifest.displayName}</div>
						<code className="truncate font-mono text-[11px] text-muted-foreground">{manifest.id}</code>
					</div>
					<p className="mt-1 truncate text-xs text-muted-foreground" title={description}>{description}</p>
				</div>
				<div className="ops-extension-meta">
					<span className={entry.loaded ? "text-foreground" : "text-destructive"}>{entry.loaded ? "已加载" : "加载失败"}</span>
					<span>插件 v{entry.version} · {usage}</span>
				</div>
				<Button type="button" size="sm" variant="secondary" onClick={() => setDetailsOpen(true)}>查看</Button>
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
										? `已完成插件安装。绑定到 ${compatibleTargets} 后方可生效；CLI 版本将在绑定探测后显示。`
										: "已完成插件安装。创建或编辑 Worker 时选择该连接插件并完成配置后即可使用。"
									: "请先处理下方加载错误，再进行绑定。"}</p>
							</div>
						</div>

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
									<div><strong>{manifest.kind === "capability" ? `绑定「${manifest.displayName}」` : `选择「${manifest.displayName}」`}</strong><p>{isLarkCli ? "保持默认 auto 即可：它会先找本机 CLI，找不到再用托管版。添加后点「探测」，若未登录就执行页面给出的登录命令。" : manifest.kind === "capability" ? "在扩展配置中添加它，保存后执行一次环境探测；若未登录，按提示完成认证。" : "填写命令、凭据等必需配置，保存并通过连接探测。"}</p></div>
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
							{entry.origin === "local-link" || entry.origin === "user" ? <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => { setDetailsOpen(false); setConfirmUninstall(true); }}><TrashIcon className="size-3.5" />卸载</Button> : null}
						</div>
						<div className="extension-detail-actions">
							{entry.origin === "local-link" || entry.origin === "user" ? <Button type="button" variant="outline" onClick={() => { setDetailsOpen(false); setUpdatePin(entry.versionPin ?? ""); setUpdateOpen(true); }}>更新</Button> : null}
							<Button type="button" variant="ghost" onClick={() => setDetailsOpen(false)}>关闭</Button>
							<Button type="button" disabled={!entry.loaded} onClick={openAgentList}>去智能体绑定<ArrowRightIcon className="size-3.5" /></Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 更新对话框 */}
			<Dialog open={updateOpen} onOpenChange={setUpdateOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>更新「{manifest.id}」</DialogTitle>
						<DialogDescription>
							本地链接从原路径（或指定新路径）重读；用户包必须指定新来源目录重新复制。固定版本时新版本必须与 pin 一致。
						</DialogDescription>
					</DialogHeader>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">扩展目录路径（留空 = 原安装路径）</span>
						<Input value={updatePath} onChange={(e) => setUpdatePath(e.target.value)} className="font-mono text-xs" />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">固定版本（留空 = 不固定）</span>
						<Input value={updatePin} onChange={(e) => setUpdatePin(e.target.value)} placeholder="如 0.9.1" className="font-mono text-xs" />
					</label>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setUpdateOpen(false)}>
							取消
						</Button>
						<Button type="button" disabled={busy} onClick={() => void handleUpdate()}>
							{busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							更新
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* 卸载确认 */}
			<Dialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>卸载「{manifest.id}」</DialogTitle>
						<DialogDescription>
							卸载后模块注册与安装记录被移除；引用它的历史 Agent 绑定保留，调用时将提示不可用（不静默回退）。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setConfirmUninstall(false)}>
							取消
						</Button>
						<Button type="button" variant="destructive" disabled={busy} onClick={() => void handleUninstall()}>
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
									{run.delegationId} · {run.agentId ?? "—"} · {run.status} · 窗口 {run.windowId}
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

function SkillsLibraryView() {
	const [skills, setSkills] = useState<SkillEntry[] | null>(null);
	const [query, setQuery] = useState("");
	const [importPath, setImportPath] = useState("");
	const [importOpen, setImportOpen] = useState(false);
	const [importing, setImporting] = useState(false);
	const [zipInput, setZipInput] = useState<HTMLInputElement | null>(null);
	const filteredSkills = useMemo(() => {
		if (!skills) return null;
		const needle = query.trim().toLowerCase();
		if (!needle) return skills;
		return skills.filter((skill) => [skill.name, skill.description]
			.some((value) => value?.toLowerCase().includes(needle)));
	}, [query, skills]);

	const refresh = useCallback(async () => {
		try {
			const { skills: nextSkills } = await listSkillLibrary();
			setSkills(nextSkills);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		const timer = window.setTimeout(() => void refresh(), 0);
		return () => window.clearTimeout(timer);
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
					<Button type="button" size="sm" onClick={() => setImportOpen(true)}><UploadIcon className="size-3.5" />导入 Skill</Button>
				</div>
			</div>
			{skills === null ? (
				<div className="flex items-center justify-center gap-2 pt-12 text-sm text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />加载中…</div>
			) : skills.length === 0 ? (
				<div className="ops-empty-state"><div className="text-sm font-medium">资源库还没有 Skill</div><p className="mt-2 text-sm text-muted-foreground">导入包含 SKILL.md 的目录或 zip 文件后，会在这里统一查看。</p></div>
			) : filteredSkills && filteredSkills.length === 0 ? (
				<div className="ops-empty-state"><div className="text-sm font-medium">没有匹配的 Skill</div><p className="mt-2 text-sm text-muted-foreground">试试 Skill 名称或描述中的关键词。</p></div>
			) : (
				<div className="skills-library-list">
					{filteredSkills?.map((skill) => {
						return <div key={skill.name} className="skills-library-row flex flex-wrap items-center gap-3 px-4 py-3">
							<div className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><SparklesIcon className="size-4" /></div>
							<div className="min-w-0 flex-1"><div className="truncate font-mono text-sm">{skill.name}</div><div className="truncate text-xs text-muted-foreground">{skill.description || "无描述"}</div></div>
						</div>;
					})}
				</div>
			)}
			<Dialog open={importOpen} onOpenChange={setImportOpen}>
				<DialogContent>
					<DialogHeader><DialogTitle>导入 Skill</DialogTitle><DialogDescription>导入后写入 pi 全局 Skills 目录，与 pi CLI 共享。启用范围仍按 Agent 配置的作用域决定。</DialogDescription></DialogHeader>
					<div className="flex flex-col gap-3">
						<div className="flex gap-2"><Input value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/path/to/skill-dir 或 skills.zip" className="font-mono text-xs" /><Button type="button" variant="outline" onClick={() => void pickSkillDirectory()}><FolderOpenIcon className="size-3.5" />选择目录</Button><Button type="button" variant="outline" onClick={() => zipInput?.click()}><FileArchiveIcon className="size-3.5" />选择 zip</Button></div>
						<input ref={setZipInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importZip(file); }} />
					</div>
					<DialogFooter><Button type="button" variant="ghost" onClick={() => setImportOpen(false)}>取消</Button><Button type="button" disabled={importing || !importPath.trim()} onClick={() => void importSkill()}>{importing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}导入</Button></DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function ExtensionsPane() {
	// tab 由 URL 查询参数驱动（/extensions?tab=skills|mcp|plugins）：刷新、
	// 浏览器前进/后退都保持当前分类；静态导出不能用动态段，与
	// /agents/config?name= 同一约定。
	const searchParams = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();
	const rawTab = searchParams.get("tab");
	const view: ExtensionView = rawTab === "skills" || rawTab === "mcp" || rawTab === "plugins" ? rawTab : "plugins";
	const setView = (key: ExtensionView) => router.replace(`${pathname}?tab=${key}`, { scroll: false });
	const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
	const [query, setQuery] = useState("");
	const [installPath, setInstallPath] = useState("");
	const [installPin, setInstallPin] = useState("");
	const [installCopy, setInstallCopy] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [installOpen, setInstallOpen] = useState(false);
	const [developerMode, setDeveloperModeState] = useState(false);
	const [developerModeLoaded, setDeveloperModeLoaded] = useState(false);
	const [developerWarningOpen, setDeveloperWarningOpen] = useState(false);
	// Skills tab 计数：进 skills 视图时随子视图一起刷新（子视图内部增删后
	// 回到其他 tab 再回来即同步，与插件计数的 refresh 语义一致）。
	const [skillCount, setSkillCount] = useState<number | null>(null);
	const filteredEntries = useMemo(() => {
		if (!entries) return null;
		const needle = query.trim().toLowerCase();
		if (!needle) return entries;
		return entries.filter((entry) => {
			const contribution = entry.manifest.kind === "connector" ? entry.manifest.connector : entry.manifest.capability;
			return [entry.manifest.displayName, entry.manifest.id, contribution.displayName, contribution.id]
				.some((value) => value.toLowerCase().includes(needle));
		});
	}, [entries, query]);

	const refreshPlugins = useCallback(() => {
		Promise.all([listExtensionCatalog("connector"), listExtensionCatalog("capability")])
			.then(([connectors, capabilities]) => setEntries([...connectors, ...capabilities]))
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
	}, []);

	// 插件数量属于顶层导航信息，不能依赖当前是否打开插件视图；否则刷新
	// /extensions?tab=skills 或 MCP 时 entries 会一直为空，计数徽标随之消失。
	useEffect(() => {
		void refreshPlugins();
	}, [refreshPlugins]);

	// 挂载即拉一次（tab 徽标要在进入 skills 视图前就有数），此后每次
	// 切到 skills 视图重新对齐。
	useEffect(() => {
		listSkillLibrary()
			.then(({ skills }) => setSkillCount(skills.length))
			.catch(() => undefined);
	}, [view]);

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
		if (!installPath.trim()) return;
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
			setView("plugins");
			refreshPlugins();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
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
			<header className="ops-page-header">
				<div>
					<h1 className="ops-page-title">扩展</h1>
					<p className="ops-page-subtitle">统一管理 Skills、MCP 和插件</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant={developerMode ? "secondary" : "outline"}
						disabled={!developerModeLoaded}
						onClick={() => developerMode ? void applyDeveloperMode(false) : setDeveloperWarningOpen(true)}
					>
						<ShieldAlertIcon className="size-4" />
						开发者模式{developerMode ? "：开" : "：关"}
					</Button>
					{developerMode && view === "plugins" ? (
						<Button type="button" size="sm" onClick={() => setInstallOpen(true)}>
							<PackageIcon className="size-4" />
							安装本地插件
						</Button>
					) : null}
				</div>
			</header>
			<nav className="ops-tabs px-7" role="tablist" aria-label="扩展类型">
				{([
					["skills", "Skills", "任务方法与工作流"],
					["mcp", "MCP", "外部工具、数据与服务"],
					["plugins", "插件", "连接插件与能力插件"],
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
						{key === "plugins" && entries ? <span className="tab-count">{entries.length}</span> : null}
						{key === "skills" && skillCount !== null ? <span className="tab-count">{skillCount}</span> : null}
						{/* MCP 尚未接入可执行 server（规划中），计数恒 0。 */}
						{key === "mcp" ? <span className="tab-count">0</span> : null}
						<span className="sr-only">{description}</span>
					</button>
				))}
			</nav>
			<div className="ops-page-scroll mx-auto w-full max-w-[1180px] flex-1 overflow-y-auto px-7 pb-10">
				{view === "skills" ? (
					<SkillsLibraryView />
				) : view === "mcp" ? (
					<div className="ops-empty-state mx-auto mt-16 max-w-xl"><div className="text-sm font-medium">MCP 规划中</div><p className="mt-2 text-sm text-muted-foreground">MCP 用于连接外部工具、数据与服务；当前协议尚未接入可执行的 MCP Server，因此暂不提供伪配置动作。</p></div>
				) : entries === null ? (
					<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : entries.length === 0 ? (
					<div className="pt-20 text-center text-sm text-muted-foreground">
						还没有已安装插件。开启开发者模式后，可从本地目录安装连接插件或能力插件。
					</div>
				) : (
					<div className="py-8">
						<div className="mb-5 flex items-end justify-between gap-5">
							<div><h2 className="text-base font-semibold tracking-tight">插件</h2><p className="mt-1 text-xs text-muted-foreground">扩充智能体的连接方式与运行能力</p></div>
							<label className="ops-extension-search"><SearchIcon className="size-4" /><Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件" aria-label="搜索插件" /></label>
						</div>
						{filteredEntries && filteredEntries.length > 0 ? <div className="ops-extension-list">
							{filteredEntries.map((entry) => <EntryCard key={entry.manifest.id} entry={entry} onChanged={refreshPlugins} />)}
						</div> : <div className="ops-empty-state"><div className="text-sm font-medium">没有匹配的插件</div><p className="mt-2 text-sm text-muted-foreground">试试插件名称、标识或能力名称。</p></div>}
					</div>
				)}
			</div>

			{/* 安装对话框：从本地目录读取 pudding-extension.json */}
			<Dialog open={installOpen} onOpenChange={setInstallOpen}>
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
							onChange={(e) => setInstallPath(e.target.value)}
							placeholder="/abs/path/to/extension"
							className="font-mono text-xs"
						/>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={installCopy} onChange={(e) => setInstallCopy(e.target.checked)} />
						<span className="text-muted-foreground">复制安装（用户包，不随源目录变化）</span>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">固定版本（可选）</span>
						<Input value={installPin} onChange={(e) => setInstallPin(e.target.value)} placeholder="如 0.9.1" className="font-mono text-xs" />
					</label>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setInstallOpen(false)}>
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
