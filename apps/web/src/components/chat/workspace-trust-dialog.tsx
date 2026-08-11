"use client";

import { useState } from "react";
import { ShieldQuestionIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { putWorkspaceTrust } from "@/lib/api";
import type { WorkspaceRecord, WorkspaceResourceKind } from "@/lib/types";

const KIND_LABELS: Array<{ kind: WorkspaceResourceKind; label: string; count: (w: WorkspaceRecord) => number }> = [
	{ kind: "context", label: "上下文文件（AGENTS.md / CLAUDE.md）", count: (w) => w.resources.contextFiles },
	{ kind: "skills", label: "技能（.pi/skills）", count: (w) => w.resources.skills },
	{ kind: "prompts", label: "提示词模板（.pi/prompts）", count: (w) => w.resources.prompts },
];

/** 外部项目是否含可注入资源（没有就不弹信任卡）。 */
export function hasInjectableResources(workspace: WorkspaceRecord): boolean {
	return workspace.resources.contextFiles + workspace.resources.skills + workspace.resources.prompts > 0;
}

/** 是否需要先弹信任卡：外部项目、含可注入资源、且尚未决定。 */
export function needsTrustDecision(workspace: WorkspaceRecord | undefined | null): boolean {
	return Boolean(workspace && !workspace.managed && workspace.trust.state === "pending" && hasInjectableResources(workspace));
}

/**
 * Workspace 信任卡（迁移方案 §7.2）：展示规范化路径、Git Root、资源类型
 * 与数量（不展示正文），用户选择信任（可勾选放行的资源类别）、拒绝或暂不
 * 决定。信任决定只保存在服务端用户 Home。
 */
export function WorkspaceTrustDialog({
	workspace,
	onDecided,
	onCancel,
}: {
	workspace: WorkspaceRecord | null;
	/** 信任/拒绝/暂不决定后回调（携带最新记录；暂不决定为原记录）。 */
	onDecided: (workspace: WorkspaceRecord) => void;
	/** 关掉且不做任何决定（放弃触发它的操作）。 */
	onCancel: () => void;
}) {
	if (!workspace) return null;
	// key 按项目重置勾选状态（从既有 approvedResources 草稿初始化）。
	return <TrustDialogBody key={workspace.id} workspace={workspace} onDecided={onDecided} onCancel={onCancel} />;
}

function TrustDialogBody({
	workspace,
	onDecided,
	onCancel,
}: {
	workspace: WorkspaceRecord;
	onDecided: (workspace: WorkspaceRecord) => void;
	onCancel: () => void;
}) {
	const [approved, setApproved] = useState<Record<WorkspaceResourceKind, boolean>>(() => {
		const current = workspace.trust.approvedResources;
		return {
			context: current ? current.includes("context") : true,
			skills: current ? current.includes("skills") : true,
			prompts: current ? current.includes("prompts") : true,
		};
	});
	const [saving, setSaving] = useState(false);

	const decide = async (state: "trusted" | "denied" | "pending") => {
		setSaving(true);
		try {
			let next = workspace;
			if (state !== "pending") {
				const result = await putWorkspaceTrust(workspace.id, {
					state,
					approvedResources: KIND_LABELS.filter(({ kind }) => approved[kind]).map(({ kind }) => kind),
				});
				next = result.workspace;
				if (result.dirtySessions > 0) {
					toast.info(`已标记 ${result.dirtySessions} 个活跃会话，当前轮结束后自动重建`);
				}
			}
			onDecided(next);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onCancel()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<ShieldQuestionIcon className="size-4" />
						信任这个项目吗？
					</DialogTitle>
					<DialogDescription>
						该项目包含可注入到 Agent 提示词的资源。批准前，这些内容不会进入任何会话。
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3 text-sm">
					<div className="flex flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2.5 text-xs">
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">项目</span>
							<span className="font-medium">{workspace.name}</span>
						</div>
						<div className="flex justify-between gap-2">
							<span className="shrink-0 text-muted-foreground">规范化路径</span>
							<code className="truncate font-mono">{workspace.canonicalPath}</code>
						</div>
						{workspace.gitRoot ? (
							<div className="flex justify-between gap-2">
								<span className="shrink-0 text-muted-foreground">Git 仓库根</span>
								<code className="truncate font-mono">{workspace.gitRoot}</code>
							</div>
						) : null}
					</div>
					<div className="flex flex-col gap-1.5">
						<span className="text-xs text-muted-foreground">放行哪些资源类别（数量来自服务端扫描，不含正文）：</span>
						{KIND_LABELS.map(({ kind, label, count }) => (
							<label key={kind} className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={approved[kind]}
									disabled={count(workspace) === 0}
									onChange={(e) => setApproved((prev) => ({ ...prev, [kind]: e.target.checked }))}
									className="size-4 accent-foreground"
								/>
								<span>{label}</span>
								<span className="ml-auto text-xs text-muted-foreground">{count(workspace)} 个</span>
							</label>
						))}
					</div>
				</div>
				<DialogFooter>
					<Button type="button" variant="ghost" disabled={saving} onClick={() => void decide("pending")}>
						暂不决定
					</Button>
					<Button type="button" variant="outline" disabled={saving} onClick={() => void decide("denied")}>
						拒绝
					</Button>
					<Button type="button" disabled={saving} onClick={() => void decide("trusted")}>
						{saving ? "保存中…" : "信任"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
