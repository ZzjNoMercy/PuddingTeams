"use client";

import { Badge } from "@/components/ui/badge";
import type { WorkspaceTrust, WorkspaceTrustState } from "@/lib/types";

const LABELS: Record<WorkspaceTrustState, string> = {
	pending: "待信任",
	trusted: "已信任",
	denied: "已拒绝",
};

/** Workspace 信任状态 badge（迁移方案 §7）：pending=警示、trusted=实底、denied=危险。 */
export function WorkspaceTrustBadge({ trust }: { trust: WorkspaceTrust }) {
	if (trust.state === "trusted") {
		return <Badge variant="secondary">{LABELS.trusted}</Badge>;
	}
	if (trust.state === "denied") {
		return (
			<Badge variant="outline" className="border-destructive/50 text-destructive">
				{LABELS.denied}
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="border-amber-500/60 text-amber-600 dark:text-amber-400">
			{LABELS.pending}
		</Badge>
	);
}

/** 最近项目下拉等纯文本场景的信任后缀。 */
export function workspaceTrustSuffix(trust: WorkspaceTrust): string {
	return trust.state === "trusted" ? "" : `（${LABELS[trust.state]}）`;
}
