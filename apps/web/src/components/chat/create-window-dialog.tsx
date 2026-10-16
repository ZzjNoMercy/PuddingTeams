"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createRoom, createRoomSession, getRoom, switchRoomWorkspace, listAgents, listWorkspaces, RoomCreationOperationConflictError, RoomSelectionStaleError, WorkerDisabledError } from "@/lib/api";
import { clearGroupCreationOperation, groupCreationFingerprint, reserveGroupCreationOperation } from "@/lib/group-creation-operation";
import { agentDisplayName, type AgentConfig, type RoomSummary, type WorkspaceRecord } from "@/lib/types";
import { ManagerAvatar, WorkerAvatar } from "./worker-avatar";

const DESIGN_ORDER = ["pi-a", "pi-b", "puddingclaw", "claude-code", "codex"];
const DESIGN_DESCRIPTIONS: Record<string, string> = {
	"pi-a": "本地研发与文件处理",
	"pi-b": "独立复核与质量检查",
	puddingclaw: "企业数据分析、指标查询与 NL2SQL",
	"claude-code": "复杂代码任务与长上下文分析",
	codex: "代码实现、调试与工程协作",
};

function createLabel(group: boolean): string {
	return group ? "创建群聊" : "打开单聊";
}

export function CreateWindowDialog({
	open,
	onOpenChange,
	onCreated,
	initialWorkspaceId,
	initialAgentId,
	newSessionOnExisting = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (room: RoomSummary, existed: boolean) => void;
	initialWorkspaceId?: string | null;
	initialAgentId?: string;
	newSessionOnExisting?: boolean;
}) {
	const [conversationType, setConversationType] = useState<"direct" | "group">("direct");
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
				setAgents(items.filter((agent) => agent.enabled !== false && (!agent.pinned || newSessionOnExisting)));
				setWorkspaces(availableWorkspaces);
				setWorkspaceId(initialWorkspaceId ?? "");
				setConversationType("direct");
				setChecked(new Set(initialAgentId && items.some(agent => agent.name === initialAgentId && agent.enabled !== false) ? [initialAgentId] : []));
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
	}, [open, initialWorkspaceId, initialAgentId, newSessionOnExisting, loadAttempt]);

	const sortedAgents = useMemo(() => agents.filter(agent => conversationType === "direct" || !agent.pinned).sort((left, right) => {
		if (left.name === "manager") return -1;
		if (right.name === "manager") return 1;
		const leftIndex = DESIGN_ORDER.indexOf(left.name);
		const rightIndex = DESIGN_ORDER.indexOf(right.name);
		if (leftIndex === -1 && rightIndex === -1) return left.name.localeCompare(right.name);
		if (leftIndex === -1) return 1;
		if (rightIndex === -1) return -1;
		return leftIndex - rightIndex;
	}), [agents, conversationType]);
	const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
	const workspaceUnavailable = Boolean(workspaceId && !selectedWorkspace?.available);

	const toggle = useCallback((name: string) => {
		setChecked((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else {
				if (conversationType === "direct") next.clear();
				next.add(name);
			}
			return next;
		});
	}, [conversationType]);

	const handleCreate = useCallback(async () => {
		if (checked.size < (conversationType === "group" ? 2 : 1) || workspaceUnavailable || loading || loadError || savingRef.current) return;
		savingRef.current = true;
		setSaving(true);
		const members = [...checked];
		const group = conversationType === "group";
		const fingerprint = group ? groupCreationFingerprint(members, workspaceId) : "";
		let storage: Storage | null = null;
		try { storage = window.sessionStorage; } catch { /* Same-tab memory fallback. */ }
		const operationId = group ? reserveGroupCreationOperation(fingerprint, storage) : undefined;
		try {
			if (!group && members[0] === "manager") {
				let room = await getRoom("solo");
				let needsSession = true;
				if ((room.workspace?.id ?? "") !== workspaceId) {
					const switched = await switchRoomWorkspace(room.id, workspaceId || null, "in_place");
					room = switched.room;
					// A first visit already creates the target context's first Session.
					needsSession = switched.restored;
				}
				if (needsSession) await createRoomSession(room.id);
				onCreated?.(await getRoom(room.id), true);
				toast.success("聊天已创建");
				closeDialog();
				return;
			}
			const created = await createRoom({
				type: conversationType,
				members,
				...(workspaceId ? { workspaceId } : {}),
			}, operationId);
			let room = created.room;
			const existed = created.existed;
			if (newSessionOnExisting && existed && !group) {
				await createRoomSession(room.id);
				room = await getRoom(room.id);
			}
			if (operationId) clearGroupCreationOperation(fingerprint, operationId, storage);
			toast.success(newSessionOnExisting && !group ? "聊天已创建" : existed ? group ? "已创建的群聊，已打开" : "已有与该 Worker 的单聊，已打开" : group ? "群聊已创建" : "单聊已打开");
			onCreated?.(room, existed);
			closeDialog();
		} catch (error) {
			if (operationId && error instanceof RoomCreationOperationConflictError) clearGroupCreationOperation(fingerprint, operationId, storage);
			toast.error(error instanceof Error ? error.message : String(error));
			if (error instanceof WorkerDisabledError || error instanceof RoomSelectionStaleError) {
				try {
					const [items, currentWorkspaces] = await Promise.all([listAgents(), listWorkspaces()]);
					const current = items.filter((agent) => agent.enabled !== false && (!agent.pinned || newSessionOnExisting));
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
	}, [conversationType, checked, closeDialog, loadError, loading, onCreated, workspaceId, workspaceUnavailable, newSessionOnExisting]);

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
					<DialogTitle>{newSessionOnExisting ? "新建聊天" : "发起对话"}</DialogTitle>
					<p>{conversationType === "group" ? "由 Manager 负责对话，选择可委派 Worker 范围，至少两位。" : newSessionOnExisting ? "选择 Agent 与项目，开始一个新聊天。" : "选择一位 Worker 发起单聊。"}</p>
					<div className="flex gap-2" role="group" aria-label="对话负责人">
						<Button type="button" variant={conversationType === "direct" ? "default" : "outline"} onClick={() => { setConversationType("direct"); setChecked(new Set()); }}>{newSessionOnExisting ? "Agent 单聊" : "Worker 单聊"}</Button>
						<Button type="button" variant={conversationType === "group" ? "default" : "outline"} onClick={() => { setConversationType("group"); setChecked(new Set()); }}>Manager 群聊</Button>
					</div>
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
							<small>{newSessionOnExisting ? "聊天保存在所选项目下；Agent 视图和项目视图展示同一份聊天。" : "单聊按 Worker 与工作空间复用；群聊在所选工作空间中创建，Worker 选择只限制委派范围。"}</small>
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
									{agent.name === "manager" ? <ManagerAvatar size={32} /> : <WorkerAvatar name={agent.name} size={32} />}
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
					<Button type="button" disabled={loading || Boolean(loadError) || checked.size < (conversationType === "group" ? 2 : 1) || workspaceUnavailable || saving} onClick={handleCreate}>
						{saving ? "发起中…" : newSessionOnExisting && conversationType === "direct" ? "创建聊天" : createLabel(conversationType === "group")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
