"use client";

import { useCallback, useEffect, useState } from "react";
import { BotIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getRoom, listAgents, updateRoom } from "@/lib/api";
import type { AgentConfig, RoomSummary } from "@/lib/types";

export function RoomConfigDialog({
	sessionId,
	open,
	onOpenChange,
	onSaved,
}: {
	sessionId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved?: (room: RoomSummary) => void;
}) {
	const [state, setState] = useState<{
		sessionId: string;
		room: RoomSummary;
		name: string;
		agents: AgentConfig[];
		checked: Set<string>;
	} | null>(null);
	const [saving, setSaving] = useState(false);

	// loading = we haven't loaded *this* session yet (or fetch is in flight).
	const loading = !state || state.sessionId !== sessionId;

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		Promise.all([getRoom(sessionId), listAgents()])
			.then(([r, a]) => {
				if (cancelled) return;
				const enabled = a.filter((x) => x.enabled !== false);
				// Undefined room.agents means "all enabled" — materialize the
				// current effective membership so saving is predictable.
				setState({
					sessionId,
					room: r,
					name: r.name,
					agents: enabled,
					checked: new Set(
						enabled.filter((x) => r.members.some((m) => m.name === x.name)).map((x) => x.name),
					),
				});
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				toast.error(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [open, sessionId]);

	const toggle = useCallback((name: string) => {
		setState((prev) => {
			if (!prev) return prev;
			const next = new Set(prev.checked);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return { ...prev, checked: next };
		});
	}, []);

	const handleSave = useCallback(async () => {
		if (!state) return;
		setSaving(true);
		try {
			await updateRoom(sessionId, {
				name: state.name.trim() || undefined,
				agents: [...state.checked],
			});
			toast.success("房间已保存");
			onSaved?.({
				sessionId,
				name: state.name.trim() || state.room.firstMessage || "新对话",
				firstMessage: state.room.firstMessage,
				modifiedAt: state.room.modifiedAt,
				agents: [...state.checked],
				members: state.agents.filter((a) => state.checked.has(a.name)),
				sessions: state.room.sessions,
				activeSession: state.room.activeSession || sessionId,
			});
			onOpenChange(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [sessionId, state, onSaved, onOpenChange]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{state && state.room.members.length === 0 ? "添加成员" : "房间设置"}
					</DialogTitle>
				</DialogHeader>
				{loading || !state ? (
					<div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{state.room.members.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								给这个对话添加 worker：选 1 个变成单聊，选 2 个及以上变成群聊。去掉所有成员即回到与 pi manager 的 solo 对话。
							</p>
						) : null}
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">房间名</span>
							<Input
								value={state.name}
								onChange={(e) => setState({ ...state, name: e.target.value })}
								placeholder="默认取第一条消息"
							/>
						</label>
						<div className="flex flex-col gap-1">
							<span className="text-sm text-muted-foreground">
								成员（勾选的 worker 才能被 manager 派活）
							</span>
							{state.agents.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									没有启用的 worker。请先在「智能体」页注册并启用。
								</p>
							) : (
								<div className="flex flex-col gap-1">
									{state.agents.map((agent) => (
										<label
											key={agent.name}
											className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
										>
											<input
												type="checkbox"
												checked={state.checked.has(agent.name)}
												onChange={() => toggle(agent.name)}
												className="size-4 accent-foreground"
											/>
											<BotIcon className="size-4 shrink-0 text-muted-foreground" />
											<span className="font-mono text-sm">{agent.name}</span>
											<span className="ml-auto truncate text-xs text-muted-foreground">
												{agent.description}
											</span>
										</label>
									))}
								</div>
							)}
						</div>
					</div>
				)}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button type="button" onClick={handleSave} disabled={loading || !state || saving}>
						{saving ? "保存中…" : "保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
