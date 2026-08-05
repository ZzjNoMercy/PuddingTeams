"use client";

import { useState } from "react";
import { SettingsIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { SessionSummary } from "@/lib/types";

export function SessionList({
	sessions,
	selectedId,
	onSelect,
	onNew,
	onDelete,
	creating,
}: {
	sessions: SessionSummary[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
	creating: boolean;
}) {
	const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);

	return (
		<div className="flex h-full w-64 shrink-0 flex-col bg-muted/50">
			<div className="p-3">
				<Button type="button" onClick={onNew} disabled={creating} className="w-full">
					{creating ? "创建中…" : "+ 新对话"}
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{sessions.length === 0 ? (
					<p className="px-2 py-6 text-center text-xs text-muted-foreground">
						还没有对话
					</p>
				) : (
					sessions.map((s) => (
						<div
							key={s.id}
							className={`group relative mb-0.5 rounded-md ${
								s.id === selectedId
									? "bg-accent text-accent-foreground"
									: "hover:bg-muted"
							}`}
						>
							<button
								type="button"
								onClick={() => onSelect(s.id)}
								className="w-full px-2 py-2 pr-7 text-left"
							>
								<div className="truncate text-sm font-medium">
									{s.firstMessage || "新对话"}
								</div>
								<div className="mt-0.5 text-xs text-muted-foreground">
									{new Date(s.modifiedAt).toLocaleString()}
								</div>
							</button>
							<button
								type="button"
								aria-label="删除对话"
								onClick={() => setPendingDelete(s)}
								className="absolute top-2 right-1.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
							>
								<XIcon className="size-3.5" />
							</button>
						</div>
					))
				)}
			</div>

			<div className="p-2">
				<button
					type="button"
					onClick={() => setSettingsOpen(true)}
					className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
				>
					<SettingsIcon className="size-4" />
					设置
				</button>
			</div>

			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

			<Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除对话</DialogTitle>
						<DialogDescription>
							确定删除「{pendingDelete?.firstMessage || "新对话"}」吗？该对话的历史记录将一并删除，无法恢复。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingDelete(null)}>
							取消
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								if (pendingDelete) onDelete(pendingDelete.id);
								setPendingDelete(null);
							}}
						>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
