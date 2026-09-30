"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createRoom, listAgents, listWorkspaces, RoomCreationOperationConflictError, RoomSelectionStaleError, WorkerDisabledError } from "@/lib/api";
import { clearGroupCreationOperation, groupCreationFingerprint, reserveGroupCreationOperation } from "@/lib/group-creation-operation";
import { agentDisplayName, type AgentConfig, type RoomSummary, type WorkspaceRecord } from "@/lib/types";
import { WorkerAvatar } from "./worker-avatar";

const DESIGN_ORDER = ["pi-a", "pi-b", "puddingclaw", "claude-code", "codex"];
const DESIGN_DESCRIPTIONS: Record<string, string> = {
	"pi-a": "本地研发与文件处理",
	"pi-b": "独立复核与质量检查",
	puddingclaw: "企业数据分析、指标查询与 NL2SQL",
	"claude-code": "复杂代码任务与长上下文分析",
	codex: "代码实现、调试与工程协作",
};

function createLabel(count: number): string {
	return count > 1 ? "创建群聊" : "打开单聊";
}

export function CreateWindowDialog({
	open,
	onOpenChange,
	onCreated,
	initialWorkspaceId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (room: RoomSummary, existed: boolean) => void;
	initialWorkspaceId?: string | null;
}) {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
	const [workspaceId, setWorkspaceId] = useState("");
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const closeDialog = useCallback(() => {
		setAgents([]);
		setWorkspaces([]);
		setWorkspaceId("");
		setChecked(new Set());
		setLoading(true);
		setLoadError(null);
		onOpenChange(false);
	}, [onOpenChange]);
	const retryLoad = () => {
		setLoading(true);
		setLoadError(null);
		setLoadAttempt((value) => value + 1);
	};

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void Promise.all([listAgents(), listWorkspaces()])
			.then(([items, availableWorkspaces]) => {
				if (cancelled) return;
				setAgents(items.filter((agent) => agent.enabled !== false && !agent.pinned));
				setWorkspaces(availableWorkspaces);
				setWorkspaceId(initialWorkspaceId ?? "");
			})
			.catch((error: unknown) => {
				if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, initialWorkspaceId, loadAttempt]);

	const sortedAgents = useMemo(() => [...agents].sort((left, right) => {
		const leftIndex = DESIGN_ORDER.indexOf(left.name);
		const rightIndex = DESIGN_ORDER.indexOf(right.name);
		if (leftIndex === -1 && rightIndex === -1) return left.name.localeCompare(right.name);
		if (leftIndex === -1) return 1;
		if (rightIndex === -1) return -1;
		return leftIndex - rightIndex;
	}), [agents]);
	const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
	const workspaceUnavailable = Boolean(workspaceId && !selectedWorkspace?.available);

	const toggle = useCallback((name: string) => {
		setChecked((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}, []);

	const handleCreate = useCallback(async () => {
		if (checked.size === 0 || workspaceUnavailable || loading || loadError || savingRef.current) return;
		savingRef.current = true;
		setSaving(true);
		const members = [...checked];
		const group = members.length > 1;
		const fingerprint = group ? groupCreationFingerprint(members, workspaceId) : "";
		let storage: Storage | null = null;
		try { storage = window.sessionStorage; } catch { /* Same-tab memory fallback. */ }
		const operationId = group ? reserveGroupCreationOperation(fingerprint, storage) : undefined;
		try {
			const { room, existed } = await createRoom({
				type: members.length === 1 ? "direct" : "group",
				members,
				...(workspaceId ? { workspaceId } : {}),
			}, operationId);
			if (operationId) clearGroupCreationOperation(fingerprint, operationId, storage);
			toast.success(existed ? group ? "已创建的群聊，已打开" : "已有与该 Worker 的单聊，已打开" : group ? "群聊已创建" : "单聊已打开");
			onCreated?.(room, existed);
			closeDialog();
		} catch (error) {
			if (operationId && error instanceof RoomCreationOperationConflictError) clearGroupCreationOperation(fingerprint, operationId, storage);
			toast.error(error instanceof Error ? error.message : String(error));
			if (error instanceof WorkerDisabledError || error instanceof RoomSelectionStaleError) {
				try {
					const [items, currentWorkspaces] = await Promise.all([listAgents(), listWorkspaces()]);
					const current = items.filter((agent) => agent.enabled !== false && !agent.pinned);
					const available = new Set(current.map((agent) => agent.name));
					setAgents(current);
					setWorkspaces(currentWorkspaces);
					setChecked((selected) => new Set([...selected].filter((name) => available.has(name))));
				} catch (refreshError) {
					setLoadError(refreshError instanceof Error ? refreshError.message : String(refreshError));
				}
			}
		} finally {
			savingRef.current = false;
			setSaving(false);
		}
	}, [checked, closeDialog, loadError, loading, onCreated, workspaceId, workspaceUnavailable]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) onOpenChange(true);
				else if (!savingRef.current) closeDialog();
			}}
		>
			<DialogContent
				className="home-create-dialog"
				overlayClassName="home-create-overlay"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					(event.currentTarget as HTMLElement).focus();
				}}
			>
				<DialogHeader className="home-create-head">
					<DialogTitle>发起对话</DialogTitle>
					<p>选择一位 Worker 发起单聊，或选择多位创建群聊。</p>
				</DialogHeader>

				{loading ? (
					<div className="home-create-loading">
						<LoaderIcon className="animate-spin" />
						加载中…
					</div>
				) : loadError ? (
					<div className="home-create-empty" role="alert">
						<p>无法加载 Worker 或工作空间：{loadError}</p>
						<Button type="button" variant="outline" onClick={retryLoad}>重新加载</Button>
					</div>
				) : agents.length === 0 ? (
					<p className="home-create-empty">没有启用的 Worker，请先在「智能体」页添加。</p>
				) : (
					<>
						<label className="home-create-workspace">
							<span>工作空间</span>
							<select value={workspaceId} disabled={saving} onChange={(event) => setWorkspaceId(event.target.value)}>
								<option value="">默认工作目录</option>
								{workspaceId && !selectedWorkspace ? <option value={workspaceId} disabled>原工作空间已移除，请重新选择</option> : null}
								{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id} disabled={!workspace.available}>{workspace.name}{workspace.available ? "" : "（目录不可用）"}</option>)}
							</select>
							<small>单聊按 Worker 与工作空间复用；群聊在所选工作空间中创建。</small>
							{workspaceUnavailable ? <small role="alert">此工作空间目录不可用，请重新选择。</small> : null}
						</label>
						<div className="home-worker-picker">
							{sortedAgents.map((agent) => {
							const selected = checked.has(agent.name);
							return (
								<button
									key={agent.name}
									type="button"
									disabled={saving}
									aria-pressed={selected}
									onClick={() => toggle(agent.name)}
									className={`home-worker-choice ${selected ? "is-selected" : ""}`}
								>
									<WorkerAvatar name={agent.name} size={32} />
									<span className="home-worker-choice-copy">
										<strong>{agentDisplayName(agent)}</strong>
										<span>{DESIGN_DESCRIPTIONS[agent.name] ?? agent.description}</span>
									</span>
								</button>
							);
							})}
						</div>
					</>
				)}

				<DialogFooter className="home-create-footer">
					<Button type="button" variant="secondary" disabled={saving} onClick={closeDialog}>取消</Button>
					<Button type="button" disabled={loading || Boolean(loadError) || checked.size === 0 || workspaceUnavailable || saving} onClick={handleCreate}>
						{saving ? "发起中…" : createLabel(checked.size)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
