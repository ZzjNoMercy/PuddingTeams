"use client";

import { useCallback, useEffect, useState } from "react";
import { BotIcon, FolderOpenIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createRoom, createWorkspace, listAgents, listRoomsWithContext, listWorkspaces } from "@/lib/api";
import type { AgentConfig, RoomSummary, WorkspaceRecord } from "@/lib/types";
import { DirectoryPickerDialog } from "./directory-picker-dialog";
import { WorkspaceTrustDialog, needsTrustDecision } from "./workspace-trust-dialog";
import { workspaceTrustSuffix } from "./workspace-trust-badge";

function createLabel(checked: Set<string>, directExists: boolean): string {
	if (checked.size === 0) return "发起对话";
	if (checked.size === 1) {
		return directExists ? "打开已有单聊" : "发起单聊";
	}
	return "发起群聊";
}

export function CreateWindowDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (room: RoomSummary, existed: boolean) => void;
}) {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [name, setName] = useState("");
	const [existed, setExisted] = useState<Set<string>>(new Set());
	const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
	const [workspaceMode, setWorkspaceMode] = useState<"none" | "recent" | "path" | "managed">("none");
	const [workspaceId, setWorkspaceId] = useState("");
	const [workspacePath, setWorkspacePath] = useState("");
	const [defaultCwdSnapshot, setDefaultCwdSnapshot] = useState("");
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
	const [trustCandidate, setTrustCandidate] = useState<WorkspaceRecord | null>(null);
	const [saving, setSaving] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		Promise.all([listAgents(), listRoomsWithContext()])
			.then(async ([a, roomContext]) => ({ a, ...roomContext, workspaces: await listWorkspaces() }))
			.then(({ a, rooms, defaultCwdSnapshot, workspaces }) => {
				if (cancelled) return;
				const enabled = a.filter((x) => x.enabled !== false && !x.pinned);
				setAgents(enabled);
				setWorkspaces(workspaces);
				setWorkspaceId("");
				setDefaultCwdSnapshot(defaultCwdSnapshot);
				setExisted(
					new Set(
						rooms
							.filter((r) => r.type === "direct")
							.map((r) => `${r.members[0]?.name ?? ""}:${r.workspace?.id ?? `cwd:${r.cwdSnapshot}`}`),
					),
				);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				toast.error(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const toggle = useCallback((name: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}, []);

	const createRoomFinal = useCallback(
		async (selectedWorkspaceId?: string) => {
			const members = [...checked];
			const { room, existed: hit } = await createRoom({
				type: members.length === 1 ? "direct" : "group",
				members,
				workspaceId: selectedWorkspaceId,
				name: name.trim() || undefined,
			});
			toast.success(hit ? "已有与该 worker 的单聊，已打开" : "对话已发起");
			onCreated?.(room, hit);
			onOpenChange(false);
		},
		[checked, name, onCreated, onOpenChange],
	);

	const handleCreate = useCallback(async () => {
		if (checked.size === 0) return;
		setSaving(true);
		try {
			let workspace: WorkspaceRecord | undefined;
			if (workspaceMode === "recent") {
				workspace = workspaces.find((item) => item.id === workspaceId);
			} else if (workspaceMode === "path") {
				workspace = await createWorkspace({ path: workspacePath.trim() });
			} else if (workspaceMode === "managed") {
				workspace = await createWorkspace({ managed: true, name: name.trim() || "临时项目" });
			}
			// 信任门（§7.2）：含可注入资源的外部项目先弹信任卡，再建窗口。
			if (workspace && needsTrustDecision(workspace)) {
				setTrustCandidate(workspace);
				return;
			}
			await createRoomFinal(workspace?.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [checked, name, workspaces, workspaceMode, workspaceId, workspacePath, createRoomFinal]);

	return (
		<>
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Reset so the next open starts from a fresh, loading state
				// (never set state synchronously inside the effect).
				if (!next) {
					setAgents([]);
					setChecked(new Set());
					setName("");
					setExisted(new Set());
					setWorkspaces([]);
					setWorkspaceMode("none");
					setWorkspaceId("");
					setWorkspacePath("");
					setDefaultCwdSnapshot("");
					setDirectoryPickerOpen(false);
					setTrustCandidate(null);
					setLoading(true);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>发起对话</DialogTitle>
				</DialogHeader>
				{loading ? (
					<div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : (
					<div className="flex min-w-0 flex-col gap-4">
						<p className="text-xs text-muted-foreground">
							选 1 个 worker 发起单聊，选 2 个及以上发起群聊。solo（与 pi manager 对话）是置顶单例，始终存在，不用创建。
						</p>
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">对话名（可选）</span>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="默认按成员显示（如「与 echo 单聊」）"
							/>
						</label>
						<div className="flex flex-col gap-2">
							<span className="text-sm text-muted-foreground">项目</span>
							<div className="grid grid-cols-4 gap-1 rounded-md bg-muted p-1 text-xs">
								{(["none", "recent", "path", "managed"] as const).map((mode) => (
									<button
										key={mode}
										type="button"
										onClick={() => setWorkspaceMode(mode)}
										className={`rounded px-2 py-1.5 ${workspaceMode === mode ? "bg-background font-medium shadow-sm" : "text-muted-foreground"}`}
									>
										{mode === "none" ? "不选项目" : mode === "recent" ? "最近项目" : mode === "path" ? "服务端路径" : "临时项目"}
									</button>
								))}
							</div>
							{workspaceMode === "none" ? (
								<p className="text-xs text-muted-foreground">保持原有聊天行为，manager 与 worker 使用平台默认运行目录。</p>
							) : workspaceMode === "recent" ? (
								<select
									value={workspaceId}
									onChange={(e) => setWorkspaceId(e.target.value)}
									className="h-9 rounded-md border bg-background px-2 text-sm"
								>
									<option value="">选择项目</option>
									{workspaces.map((workspace) => (
										<option key={workspace.id} value={workspace.id} disabled={!workspace.available}>
											{workspace.name} — {workspace.rootPath}{workspace.available ? "" : "（路径失效）"}
											{workspaceTrustSuffix(workspace.trust)}
										</option>
									))}
								</select>
							) : workspaceMode === "path" ? (
								<div className="flex gap-2">
									<Input
										value={workspacePath}
										onChange={(e) => setWorkspacePath(e.target.value)}
										placeholder="选择文件夹或输入绝对目录"
										className="min-w-0 font-mono text-xs"
									/>
									<Button type="button" variant="outline" onClick={() => setDirectoryPickerOpen(true)}>
										<FolderOpenIcon className="size-4" />
										浏览…
									</Button>
								</div>
							) : (
								<p className="text-xs text-muted-foreground">由平台创建独立目录，适合临时协作。</p>
							)}
							<p className="text-xs text-muted-foreground">项目可选；选择后决定 manager 与所有 worker 的 cwd，并隔离它们的 Session。</p>
						</div>
						<div className="flex flex-col gap-1">
							<span className="text-sm text-muted-foreground">成员</span>
							{agents.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									没有启用的 worker。请先在「智能体」页注册并启用。
								</p>
							) : (
								<div className="flex flex-col gap-1">
									{agents.map((agent) => {
						const contextId = workspaceMode === "none" ? `cwd:${defaultCwdSnapshot}` : workspaceMode === "recent" ? workspaceId : undefined;
										const alreadyDirect = contextId !== undefined && existed.has(`${agent.name}:${contextId}`);
										return (
											<label
												key={agent.name}
												className="flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 hover:bg-muted"
											>
												<input
													type="checkbox"
													checked={checked.has(agent.name)}
													onChange={() => toggle(agent.name)}
													className="size-4 accent-foreground"
												/>
												<BotIcon className="size-4 shrink-0 text-muted-foreground" />
												<span className="shrink-0 font-mono text-sm">{agent.name}</span>
												<span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
													{agent.description}
												</span>
												{alreadyDirect ? (
													<span className="shrink-0 text-xs text-muted-foreground/60">已有单聊</span>
												) : null}
											</label>
										);
									})}
								</div>
							)}
						</div>
					</div>
				)}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button
						type="button"
						onClick={handleCreate}
						disabled={
							loading || checked.size === 0 || saving ||
							(workspaceMode === "recent" && !workspaceId) ||
							(workspaceMode === "path" && !workspacePath.trim())
						}
					>
						{saving
							? "发起中…"
							: createLabel(
									checked,
							checked.size === 1 && existed.has(`${[...checked][0]}:${workspaceMode === "none" ? `cwd:${defaultCwdSnapshot}` : workspaceId}`),
								)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
		<DirectoryPickerDialog
			open={directoryPickerOpen}
			initialPath={workspacePath || defaultCwdSnapshot}
			onOpenChange={setDirectoryPickerOpen}
			onSelect={(path) => setWorkspacePath(path)}
		/>
		{trustCandidate ? (
			<WorkspaceTrustDialog
				workspace={trustCandidate}
				onCancel={() => setTrustCandidate(null)}
				onDecided={(workspace) => {
					setTrustCandidate(null);
					void createRoomFinal(workspace.id).catch((err: unknown) =>
						toast.error(err instanceof Error ? err.message : String(err)),
					);
				}}
			/>
		) : null}
		</>
	);
}
