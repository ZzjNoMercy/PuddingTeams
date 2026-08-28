"use client";

import { AgentsPane } from "@/components/agents/agents-pane";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";

export default function AgentsPage() {
	return (
		<div className="desktop-app-frame h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="agents" />
				</div>
				<main className="flex min-w-0 flex-1 flex-col bg-background">
					<AgentsPane />
				</main>
			</div>
		</div>
	);
}
