"use client";

import { Suspense } from "react";
import { NavRail } from "@/components/chat/nav-rail";
import { ExtensionsPane } from "@/components/agents/extensions-pane";

export default function ExtensionsPage() {
	return (
		<div className="flex h-dvh">
			<NavRail view="extensions" />
			<main className="flex min-w-0 flex-1 flex-col bg-background">
				{/* ExtensionsPane 用 useSearchParams 读 ?tab=，静态导出要求 Suspense 包裹 */}
				<Suspense>
					<ExtensionsPane />
				</Suspense>
			</main>
		</div>
	);
}
