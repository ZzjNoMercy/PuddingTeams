"use client";

import { Suspense } from "react";
import { NavRail } from "@/components/chat/nav-rail";
import { ExtensionsPane } from "@/components/agents/extensions-pane";
import { DesktopTitlebar } from "@/components/desktop-titlebar";

export default function ExtensionsPage() {
	return (
		<div className="desktop-app-frame h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="extensions" />
				</div>
				<main className="flex min-w-0 flex-1 flex-col bg-background">
					{/* ExtensionsPane 用 useSearchParams 读 ?tab=，静态导出要求 Suspense 包裹 */}
					<Suspense>
						<ExtensionsPane />
					</Suspense>
				</main>
			</div>
		</div>
	);
}
