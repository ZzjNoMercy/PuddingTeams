"use client";

import { Suspense } from "react";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { KnowledgeConnectWizard } from "@/features/knowledge/connect-wizard";

// 静态导出（output: "export"）不支持动态段；?plan=<planId> 深链恢复走查询参数，
// useSearchParams 必须包在 Suspense 里（与 /knowledge、/agents/config 一致）。
export default function KnowledgeConnectPage() {
	return (
		<div className="desktop-app-frame m1-app-shell m1-knowledge-shell h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="knowledge" />
				</div>
				<Suspense>
					<KnowledgeConnectWizard />
				</Suspense>
			</div>
		</div>
	);
}
