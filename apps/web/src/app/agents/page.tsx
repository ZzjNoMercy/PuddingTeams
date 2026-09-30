"use client";

import { AgentsPane } from "@/components/agents/agents-pane";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";

export default function AgentsPage() {
	return (
		<div className="desktop-app-frame m1-app-shell h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="agents" />
				</div>
				<main className="m1-ops-main flex min-w-0 flex-1 flex-col">
					<SectionTopbar title="智能体" />
					<AgentsPane />
				</main>
			</div>
		</div>
	);
}
