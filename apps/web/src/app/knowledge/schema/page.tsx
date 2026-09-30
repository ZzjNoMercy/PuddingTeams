"use client";

import { Suspense } from "react";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { KnowledgeSchemaPage } from "@/features/knowledge/schema-page";

// 静态导出：?vault=<id> / ?preset=<id> 走查询参数，useSearchParams 需 Suspense 包裹。
export default function KnowledgeSchemaRoute() {
	return (
		<div className="desktop-app-frame m1-app-shell m1-knowledge-shell h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="knowledge" />
				</div>
				<Suspense>
					<KnowledgeSchemaPage />
				</Suspense>
			</div>
		</div>
	);
}
