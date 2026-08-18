"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createRoom, listAgents } from "@/lib/api";
import { agentDisplayName, type AgentConfig, type RoomSummary } from "@/lib/types";
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
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (room: RoomSummary, existed: boolean) => void;
}) {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [saving, setSaving] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		listAgents()
			.then((items) => {
				if (cancelled) return;
				setAgents(items.filter((agent) => agent.enabled !== false && !agent.pinned));
			})
			.catch((error: unknown) => {
				if (!cancelled) toast.error(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const sortedAgents = useMemo(() => [...agents].sort((left, right) => {
		const leftIndex = DESIGN_ORDER.indexOf(left.name);
		const rightIndex = DESIGN_ORDER.indexOf(right.name);
		if (leftIndex === -1 && rightIndex === -1) return left.name.localeCompare(right.name);
		if (leftIndex === -1) return 1;
		if (rightIndex === -1) return -1;
		return leftIndex - rightIndex;
	}), [agents]);

	const toggle = useCallback((name: string) => {
		setChecked((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}, []);

	const handleCreate = useCallback(async () => {
		if (checked.size === 0) return;
		setSaving(true);
		try {
			const members = [...checked];
			const { room, existed } = await createRoom({
				type: members.length === 1 ? "direct" : "group",
				members,
			});
			toast.success(existed ? "已有与该 Worker 的单聊，已打开" : members.length > 1 ? "群聊已创建" : "单聊已打开");
			onCreated?.(room, existed);
			onOpenChange(false);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}, [checked, onCreated, onOpenChange]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setAgents([]);
					setChecked(new Set());
					setLoading(true);
				}
				onOpenChange(next);
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
				) : agents.length === 0 ? (
					<p className="home-create-empty">没有启用的 Worker，请先在「智能体」页添加。</p>
				) : (
					<div className="home-worker-picker">
						{sortedAgents.map((agent) => {
							const selected = checked.has(agent.name);
							return (
								<button
									key={agent.name}
									type="button"
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
				)}

				<DialogFooter className="home-create-footer">
					<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>取消</Button>
					<Button type="button" disabled={loading || checked.size === 0 || saving} onClick={handleCreate}>
						{saving ? "发起中…" : createLabel(checked.size)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
