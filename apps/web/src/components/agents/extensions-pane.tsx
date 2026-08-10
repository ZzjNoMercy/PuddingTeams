"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderIcon, PackageIcon, RefreshCwIcon, ShieldAlertIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	ApiConflictError,
	getDeveloperMode,
	installExtension,
	listExtensionCatalog,
	setDeveloperMode,
	uninstallExtension,
	updateExtension,
} from "@/lib/api";
import type { CatalogEntry, ConflictRun } from "@/lib/types";

/**
 * Extension 接入目录（§10.1）：kind=connector 与 kind=capability 分开的目录
 * 视图，不混在同一选择器。安装 / 更新 / 卸载是彼此独立的动作；卸载 409 时
 * 如实展示引用它的 agents / 进行中 runs。
 */

type Kind = "connector" | "capability";

const SOURCE_LABELS: Record<string, string> = {
	builtin: "内置来源",
	trusted: "可信来源",
	external: "外部来源",
};

function EntryCard({ entry, onChanged }: { entry: CatalogEntry; onChanged: () => void }) {
	const { manifest } = entry;
	const [updateOpen, setUpdateOpen] = useState(false);
	const [updatePath, setUpdatePath] = useState("");
	const [updatePin, setUpdatePin] = useState(entry.versionPin ?? "");
	const [confirmUninstall, setConfirmUninstall] = useState(false);
	const [conflict, setConflict] = useState<{ message: string; agents: string[]; runs: ConflictRun[] } | null>(null);
	const [busy, setBusy] = useState(false);

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
		<div className="flex flex-col gap-2 rounded-lg bg-muted p-4">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium">{manifest.displayName}</div>
					<code className="font-mono text-xs text-muted-foreground">{manifest.id}</code>
				</div>
				<Badge variant={entry.loaded ? "secondary" : "destructive"}>{entry.loaded ? "已加载" : "加载失败"}</Badge>
			</div>

			{/* 目录信息：来源 / 权限 / 版本范围 / 将注册的能力 */}
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge variant="outline">
					{entry.origin === "builtin" ? "平台内置" : entry.origin === "bundled" ? "随产品预置" : "开发者本地安装"}
				</Badge>
				<Badge variant="outline">{SOURCE_LABELS[manifest.source] ?? manifest.source}</Badge>
				<Badge variant="outline">
					v{entry.version}
					{entry.versionPin ? `（固定 ${entry.versionPin}）` : ""}
				</Badge>
				<Badge variant="outline">引擎：{manifest.engines.puddingteams}</Badge>
			</div>
			{manifest.permissions && manifest.permissions.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					<span>权限：</span>
					{manifest.permissions.map((p) => (
						<Badge key={p} variant="secondary">
							{p}
						</Badge>
					))}
				</div>
			) : null}
			<div className="text-xs text-muted-foreground">发布者：{manifest.publisher}</div>

			{manifest.kind === "connector" ? (
				<div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
					<span>
						Connector：<code className="font-mono">{manifest.connector.id}</code>（{manifest.connector.displayName}）
					</span>
					<span>
						transport：{manifest.connector.supportedTransports.join(" / ")}（默认 {manifest.connector.defaultTransport}）
					</span>
					{manifest.connector.supportedUpstreamVersions ? (
						<span>上游版本范围：{manifest.connector.supportedUpstreamVersions}</span>
					) : null}
				</div>
			) : (
				<div className="flex flex-col gap-1 text-xs text-muted-foreground">
					<span>
						Capability：<code className="font-mono">{manifest.capability.id}</code>（{manifest.capability.displayName}）
					</span>
					{manifest.capability.tools.length > 0 ? (
						<div className="flex flex-wrap gap-1">
							{manifest.capability.tools.map((tool) => (
								<Badge key={tool.name} variant="outline" title={tool.description}>
									{tool.name}
								</Badge>
							))}
						</div>
					) : null}
					{manifest.capability.compatibleConnectors ? (
						<span>兼容 Connector：{manifest.capability.compatibleConnectors.join(" / ")}</span>
					) : (
						<span>兼容 Connector：未声明（视为兼容全部）</span>
					)}
				</div>
			)}

			{entry.loadError ? <p className="text-xs text-destructive">{entry.loadError}</p> : null}

			{/* 安装 / 更新 / 卸载是不同动作；builtin 不可卸载、不走安装流程 */}
			{entry.origin === "local" ? (
				<div className="mt-auto flex items-center gap-1 pt-1">
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => {
							setUpdatePin(entry.versionPin ?? "");
							setUpdateOpen(true);
						}}
					>
						更新
					</Button>
					<Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirmUninstall(true)}>
						<TrashIcon className="size-3.5" />
						卸载
					</Button>
				</div>
			) : (
				<p className="mt-auto pt-1 text-xs text-muted-foreground/70">平台内置，不可卸载。</p>
			)}

			{/* 更新对话框 */}
			<Dialog open={updateOpen} onOpenChange={setUpdateOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>更新「{manifest.id}」</DialogTitle>
						<DialogDescription>从原路径（或指定新路径）重读 manifest 与模块；固定版本时新版本必须与 pin 一致。</DialogDescription>
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
		</div>
	);
}

export function ExtensionsPane() {
	const [kind, setKind] = useState<Kind>("connector");
	const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
	const [installPath, setInstallPath] = useState("");
	const [installPin, setInstallPin] = useState("");
	const [installing, setInstalling] = useState(false);
	const [installOpen, setInstallOpen] = useState(false);
	const [developerMode, setDeveloperModeState] = useState(false);
	const [developerModeLoaded, setDeveloperModeLoaded] = useState(false);
	const [developerWarningOpen, setDeveloperWarningOpen] = useState(false);

	const refresh = useCallback(() => {
		listExtensionCatalog(kind)
			.then(setEntries)
			.catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
	}, [kind]);

	// kind 切换时清空旧列表（渲染期间重置），effect 只负责拉取。
	const [prevKind, setPrevKind] = useState(kind);
	if (kind !== prevKind) {
		setPrevKind(kind);
		setEntries(null);
	}

	useEffect(() => {
		refresh();
	}, [refresh]);

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
			refresh();
			toast.success(enabled ? "开发者模式已开启" : "开发者模式已关闭，本地 Extension 已停止加载");
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
			});
			toast.success(`「${entry.manifest.displayName}」已安装（kind=${entry.manifest.kind}）`);
			setInstallPath("");
			setInstallPin("");
			setInstallOpen(false);
			// 安装的 kind 由 manifest 决定；若与当前页签不同则切过去。
			if (entry.manifest.kind !== kind) setKind(entry.manifest.kind);
			else refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setInstalling(false);
		}
	};

	return (
		<div className="flex h-full flex-col">
			{developerMode ? (
				<div className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
					<ShieldAlertIcon className="size-3.5" />
					开发者模式已开启：本地 Extension 代码与 Server 同进程执行，拥有当前用户权限。
				</div>
			) : null}
			<header className="flex items-center justify-between px-4 py-2">
				<div className="flex items-center gap-1">
					{(["connector", "capability"] as Kind[]).map((k) => (
						<button
							key={k}
							type="button"
							onClick={() => setKind(k)}
							className={`rounded-md px-3 py-1 text-sm transition-colors ${
								kind === k ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground"
							}`}
						>
							{k === "connector" ? "Connector 扩展" : "Capability 扩展"}
						</button>
					))}
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
					{developerMode ? (
						<Button type="button" size="sm" onClick={() => setInstallOpen(true)}>
							<PackageIcon className="size-4" />
							安装本地扩展
						</Button>
					) : null}
				</div>
			</header>
			<div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 pb-4">
				{entries === null ? (
					<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : entries.length === 0 ? (
					<div className="pt-20 text-center text-sm text-muted-foreground">
						{kind === "capability" ? "还没有 Capability Extension。点击「安装扩展」从本地目录安装。" : "没有 Connector Extension。"}
					</div>
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{entries.map((entry) => (
							<EntryCard key={entry.manifest.id} entry={entry} onChanged={refresh} />
						))}
					</div>
				)}
			</div>

			{/* 安装对话框：从本地目录读取 pudding-extension.json */}
			<Dialog open={installOpen} onOpenChange={setInstallOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>安装扩展</DialogTitle>
						<DialogDescription>
							从本地目录安装：读取目录下的 pudding-extension.json，校验 kind / engines / permissions 后注册。安装后可在目录查看来源、权限与版本范围。
						</DialogDescription>
					</DialogHeader>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">扩展目录路径（服务端本机路径）</span>
						<Input
							value={installPath}
							onChange={(e) => setInstallPath(e.target.value)}
							placeholder="/abs/path/to/extension"
							className="font-mono text-xs"
						/>
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
							本地代码 Extension 尚未运行在隔离 Extension Host 中。开启后，Extension 可以读取文件、环境变量和凭证，也可能启动进程或访问网络。只加载你信任并已审查的代码。
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
