"use client";

import { useCallback, useEffect, useState } from "react";
import { BotIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createRoom, listAgents, listRooms } from "@/lib/api";
import type { AgentConfig, RoomSummary } from "@/lib/types";

function createLabel(checked: Set<string>, existed: Set<string>): string {
	if (checked.size === 0) return "发起对话";
	if (checked.size === 1) {
		const name = [...checked][0]!;
		return existed.has(name) ? "打开已有单聊" : "发起单聊";
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
	const [saving, setSaving] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		Promise.all([listAgents(), listRooms()])
			.then(([a, rooms]) => {
				if (cancelled) return;
				const enabled = a.filter((x) => x.enabled !== false);
				setAgents(enabled);
				setExisted(new Set(rooms.filter((r) => r.type === "direct").map((r) => r.members[0]?.name ?? "")));
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

	const handleCreate = useCallback(async () => {
		if (checked.size === 0) return;
		setSaving(true);
		try {
			const members = [...checked];
			const { room, existed: hit } = await createRoom({
				type: members.length === 1 ? "direct" : "group",
				members,
				name: name.trim() || undefined,
			});
			toast.success(hit ? "已有与该 worker 的单聊，已打开" : "对话已发起");
			onCreated?.(room, hit);
			onOpenChange(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [checked, name, onCreated, onOpenChange]);

	return (
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
					<div className="flex flex-col gap-4">
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
						<div className="flex flex-col gap-1">
							<span className="text-sm text-muted-foreground">成员</span>
							{agents.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									没有启用的 worker。请先在「智能体」页注册并启用。
								</p>
							) : (
								<div className="flex flex-col gap-1">
									{agents.map((agent) => {
										const alreadyDirect = existed.has(agent.name);
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
					<Button type="button" onClick={handleCreate} disabled={loading || checked.size === 0 || saving}>
						{saving ? "发起中…" : createLabel(checked, existed)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
