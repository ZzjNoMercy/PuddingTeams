"use client";

import { NavRail } from "@/components/chat/nav-rail";
import { ExtensionsPane } from "@/components/agents/extensions-pane";

export default function ExtensionsPage() {
	return (
		<div className="flex h-dvh">
			<NavRail view="extensions" />
			<main className="flex min-w-0 flex-1 flex-col bg-background">
				<ExtensionsPane />
			</main>
		</div>
	);
}
