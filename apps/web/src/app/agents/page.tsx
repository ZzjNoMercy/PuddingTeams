"use client";

import { AgentsPane } from "@/components/agents/agents-pane";
import { NavRail } from "@/components/chat/nav-rail";

export default function AgentsPage() {
	return (
		<div className="flex h-dvh">
			<NavRail view="agents" />
			<main className="flex min-w-0 flex-1 flex-col bg-background">
				<AgentsPane />
			</main>
		</div>
	);
}
